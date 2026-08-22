import { $ } from '@frontierjs/junction'
// src/jobs/deployment-run.job.ts
// Drives the step pipeline for one deploy. Dispatched as `deployment:run`.
//
// Lifecycle:
//   The service dispatches this job
//   → the handler picks it up, transitions pending → building
//   → For each step, calls the outpost via Conduit, updates step status
//   → On completion, marks success/failed, pushes WS update
//
// Outpost protocol (Conduit → outpost:<server-id>). Every reply may carry a
// `digest`, and that is the whole of what makes a release addressable:
//   POST /pull         { image }                          → { digest }
//   POST /deploy       { deployment_id, image, digest, … } → { digest }
//   POST /stop         { app_id }                          → stop old container
//   POST /health-check { app_id, digest }                  → { healthy }
//   POST /exec         { step, deployment_id }             → run the step
//
// WHO speaks it is `providers/executor.ts` — a registered outpost, or the named
// stub, or a refusal. This file no longer has a path where nothing is sent and
// the step is marked `success` anyway (FJS-257).
//
// A tag is not an identity: two servers at the same commit hold two images with
// the same name and different bytes, and nothing compares them. So the digest an
// executor reports is recorded on `Deployment.builtImage`, the deploy is
// addressed by it where one is known, and a release that cannot say which bytes
// ran says `null` rather than a plausible-looking tag (IDEAS/deploy-plane.md §a).
//
// Reliability: jobs are persisted in Caravan's SQLite store before execution.
// A Basecamp restart resets in-flight jobs to pending — no stuck deploys.

import { defineJob }       from '@frontierjs/caravan'
import { resolveExecutor, isExecutor } from '../providers/executor.ts'
import type { Executor }    from '../providers/executor.ts'
import { appFrom }         from './context.ts'
import { announce }        from '../channels.ts'
import type { BasecampApp } from '../basecamp.types.ts'
import type { StepStatus } from '../../../db/schema.d.ts'

// Row shapes come from the schema now, not from hand-written mirrors of it.
// The old DeploymentRow / ServiceRow / StepRow / ServiceServerRow interfaces
// described snake_case columns with JSON-as-string fields — three claims the
// schema contradicts. `any` here is honest until litestone's generated types
// are wired in (`litestone types`), which is the real fix.

type DeploymentRow = any
type StepRow       = any
type ServiceRow    = any

function runner(app: BasecampApp) {

  // asSystem(): a job runs on the queue's thread, not a request's. There is
  // no caller to scope to, and advancing a deployment is this job's —
  // the service layer deliberately refuses those writes.
  const db  = app.data.asSystem()
  const log = app.logger.child('deployment-run')

  // ── Channel push ──────────────────────────────────────────────────
  // A Channel's method is `send(event, data)`. This used to call `ch.publish()`
  // behind a `if (!ch?.publish) return` guard — publish() is on the MANAGER,
  // not on a channel, so the guard was true every single time and this
  // pushed nothing, ever, without a line in the log. The deployments screen
  // showed a release frozen at 'pending' until it was reloaded.
  async function pushUpdate(deployId: string, workspaceId: string): Promise<void> {
    // The whole row, not a projection. A client that assigns an event payload
    // over the record it is rendering loses every field the projection omits —
    // the same trap `setVariable` had when it answered `{ id, variables }`.
    const row = await db.deployment.findUnique({ where: { id: deployId } })
    if (row) announce(app, workspaceId, 'deployments patched', row)
  }

  // ── Step helpers ──────────────────────────────────────────────────
  // `StepStatus`, not `string`: the column is an enum with a CHECK behind it, so
  // a typo here is a constraint error at the end of a deploy rather than a
  // refusal at the call.
  async function setStepStatus(stepId: string, status: StepStatus, output?: string): Promise<void> {
    await db.deploymentStep.update({
      where: { id: stepId },
      data: {
        status,
        // Key presence, not `??`: only overwrite output when one was produced.
        ...(output !== undefined ? { output } : {}),
        finishedAt: status !== 'running' ? new Date().toISOString() : null,
      },
    })
  }

  async function startStep(stepId: string): Promise<void> {
    await db.deploymentStep.update({
      where: { id: stepId },
      data:  { status: 'running', startedAt: new Date().toISOString() },
    })
  }

  // ── Digest ────────────────────────────────────────────────────────
  // What an executor reports is only accepted in the one shape that identifies
  // bytes. Anything else — a tag, an empty string, a truncated id — is dropped
  // rather than stored, because a `builtImage` nobody can resolve is worse than
  // an empty one: it reads as an answer.
  function asDigest(value: unknown): string | null {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null
  }

  // ── Core runner ───────────────────────────────────────────────────
  async function runDeployment(deploymentId: string): Promise<void> {
    const deploy = await db.deployment.findUnique({ where: { id: deploymentId } })
    if (!deploy) { log.warn('deployment not found', { id: deploymentId }); return }

    if (!['pending', 'building'].includes(deploy.status)) {
      log.warn('deployment not in runnable state', { id: deploymentId, status: deploy.status })
      return
    }

    const startedAt = Date.now()
    await db.deployment.update({
      where: { id: deploymentId },
      data:  { status: 'building', startedAt: new Date(startedAt).toISOString() },
    })
    await pushUpdate(deploymentId, deploy.workspaceId)

    const steps = await db.deploymentStep.findMany({
      where:   { deploymentId },
      orderBy: { startedAt: 'asc' },
    })

    const service = await db.app.findUnique({ where: { id: deploy.appId } })
    if (!service) {
      await failDeploy(deploymentId, deploy.workspaceId, startedAt, 'App not found')
      return
    }

    // Asked again here, and not only in `deployments.create`: a placement can be
    // removed, and a machine can start draining, between the click and the job.
    const executor = await resolveExecutor(app, deploy.appId)
    if (!isExecutor(executor)) {
      // The release stops here, with the reason on the row. Every step stays
      // `pending` until failDeploy marks them failed — none of them is touched,
      // which is the difference from the behaviour this replaced.
      await failDeploy(deploymentId, deploy.workspaceId, startedAt, executor.reason)
      log.error('deployment refused — no executor', { id: deploymentId, reason: executor.reason })
      return
    }

    // configSnapshot is a Json column — already an object, never JSON.parse'd.
    const config = deploy.configSnapshot ?? {}

    log.info('deployment starting', {
      id:       deploymentId,
      service:  service.name,
      steps:    steps.length,
      executor: executor.kind,
      server:   executor.serverId,
    })

    try {
      // The digest travels down the steps: whatever /pull reported is what
      // /deploy is asked to start, and what /health-check is asked about.
      let digest: string | null = asDigest(deploy.builtImage)

      for (const step of steps) {
        await startStep(step.id)
        await pushUpdate(deploymentId, deploy.workspaceId)

        const result = await runStep(step, { deploy, service, config, executor, digest })

        // A later step's digest wins: /deploy names the bytes that were started,
        // where /pull names the bytes that were fetched, and a release records
        // what RAN.
        if (result.digest && result.digest !== digest) {
          digest = result.digest
          await db.deployment.update({ where: { id: deploymentId }, data: { builtImage: digest } })
        }

        await setStepStatus(step.id, 'success', result.output)
        await pushUpdate(deploymentId, deploy.workspaceId)
      }

      const finishedAt = Date.now()
      await db.deployment.update({
        where: { id: deploymentId },
        data: {
          status:     'success',
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
        },
      })

      await db.app.update({ where: { id: deploy.appId }, data: { status: 'running' } })

      app.events.emit('deployment:success', { id: deploymentId, workspace_id: deploy.workspaceId })
      await pushUpdate(deploymentId, deploy.workspaceId)
      log.info('deployment succeeded', { id: deploymentId, duration_ms: finishedAt - startedAt })

    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'unknown error'
      await failDeploy(deploymentId, deploy.workspaceId, startedAt, msg)
      log.error('deployment failed', { id: deploymentId, error: msg })
    }
  }

  // One step. Answers what to write on the row — the output a person reads,
  // and the digest the next step is addressed by — and throws to fail the
  // release, which is the only way a step ends as anything but `success`.
  async function runStep(
    step: StepRow,
    ctx:  {
      deploy:   DeploymentRow
      service:  ServiceRow
      config:   Record<string, unknown>
      executor: Executor
      digest:   string | null
    }
  ): Promise<{ output?: string; digest: string | null }> {
    const { deploy, service, executor, digest } = ctx
    const name  = step.name.toLowerCase()
    // The image as the app names it. The digest is what identifies bytes, but a
    // registry still needs a name to pull by, so both travel.
    const image = deploy.toImage ?? service.name

    // Said on every step of a stubbed release rather than once on the row: a
    // step list where each line reads 'no /deploy was issued' cannot be mistaken
    // for a release that shipped, and the row's status alone always could.
    const note = (reply: { data?: Record<string, unknown> }) =>
      reply.data?.stubbed ? String(reply.data.note ?? 'stub executor — nothing was issued') : undefined

    if (name.includes('pull')) {
      const reply = await executor.call('/pull', { image, digest })
      if (reply.error) throw new Error(`Pull failed: ${reply.error.message}`)
      return { output: note(reply), digest: asDigest(reply.data?.digest) ?? digest }

    } else if (name.includes('stop')) {
      const reply = await executor.call('/stop', { app_id: deploy.appId })
      // Non-fatal — a previous container may not exist on a first deploy.
      return { output: note(reply), digest }

    } else if (name.includes('start') || name.includes('deploy')) {
      const reply = await executor.call('/deploy', {
        deployment_id: deploy.id,
        image,
        digest,
        config:        service.config ?? {},   // Json columns — already objects
        source:        service.source ?? {},
      })
      if (reply.error) throw new Error(`Deploy failed: ${reply.error.message}`)
      return { output: note(reply), digest: asDigest(reply.data?.digest) ?? digest }

    } else if (name.includes('health')) {
      // Poll up to 10 times with 3s between attempts.
      let last: { data?: Record<string, unknown> } = {}
      for (let i = 0; i < 10; i++) {
        const reply = await executor.call('/health-check',
          { app_id: deploy.appId, digest }, { timeoutMs: 5_000 })
        last = reply
        if (!reply.error && reply.data?.healthy) return { output: note(reply), digest }
        await new Promise(r => setTimeout(r, 3_000))
      }
      throw new Error(`Health check failed after 10 attempts${last.data?.stubbed ? ' (stub executor)' : ''}`)

    } else {
      // Build, migration, CDN steps etc. — forwarded as a generic step.
      const reply = await executor.call('/exec', { step: step.name, deployment_id: deploy.id })
      if (reply.error) throw new Error(`Step '${step.name}' failed: ${reply.error.message}`)
      return { output: note(reply), digest: asDigest(reply.data?.digest) ?? digest }
    }
  }

  async function failDeploy(id: string, workspaceId: string, startedAt: number, error: string): Promise<void> {
    const finishedAt = Date.now()
    const deploy = await db.deployment.update({
      where: { id },
      data: {
        status:     'failed',
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
      },
    })

    // Any step still pending or running died with the deployment.
    await db.deploymentStep.updateMany({
      where: { deploymentId: id, status: { in: ['pending', 'running'] } },
      data:  { status: 'failed' },
    })

    if (deploy?.appId)
      await db.app.update({ where: { id: deploy.appId }, data: { status: 'error' } })

    app.events.emit('deployment:failed', { id, workspace_id: workspaceId, error })
    await pushUpdate(id, workspaceId)
  }

  return { runDeployment }
}

// ── The job ───────────────────────────────────────────────────────
// maxAttempts 1: a deploy is not retried automatically. Half of one that
// failed has already happened on the machine, and the way back is a person
// looking at the steps and triggering another.

export default defineJob<{ deployment_id: string }>('deployment:run', async (ctx) => {
  await runner(appFrom(ctx, 'deployment:run')).runDeployment(ctx.data.deployment_id)
}, {
  queue:       'deployments',
  maxAttempts: 1,
})
