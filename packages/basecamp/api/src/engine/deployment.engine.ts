// src/engine/deployment.engine.ts
// Deployment Engine — drives the step pipeline for each deploy.
//
// Lifecycle:
//   Caravan dispatches 'deployment:run'
//   → Engine picks it up, transitions pending → building
//   → For each step, calls the outpost via Conduit, updates step status
//   → On completion, marks success/failed, pushes WS update
//
// Outpost protocol (Conduit → outpost:<server-id>):
//   POST /pull         { image }                    → pull image
//   POST /deploy       { deployment_id, image, cfg } → start container
//   POST /stop         { container_id }              → stop old container
//   POST /health-check { url }                       → HTTP ping
//   POST /exec         { command }                   → run shell command
//
// Reliability: jobs are persisted in Caravan's SQLite store before execution.
// A Basecamp restart resets in-flight jobs to pending — no stuck deploys.

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

export function createDeploymentEngine(app: BasecampApp) {

  // asSystem(): the engine runs on Caravan's thread, not a request's. There is
  // no caller to scope to, and advancing a deployment is the engine's job —
  // the service layer deliberately refuses those writes.
  const db  = app.data.asSystem()
  const log = app.logger.child('deploy-engine')

  // ── Channel push ──────────────────────────────────────────────────
  // A Channel's method is `send(event, data)`. This used to call `ch.publish()`
  // behind a `if (!ch?.publish) return` guard — publish() is on the MANAGER,
  // not on a channel, so the guard was true every single time and the engine
  // pushed nothing, ever, without a line in the log. The deployments screen
  // showed a release frozen at 'pending' until it was reloaded.
  async function pushUpdate(deployId: string, workspaceId: string): Promise<void> {
    const manager = (app as unknown as Record<string, unknown>).channels as
      { channel: (n: string) => { send?: (e: string, d: unknown) => void } | undefined } | undefined

    const ch = manager?.channel?.(`workspace:${workspaceId}`)
    if (!ch?.send) return

    // The whole row, not a projection. A client that assigns an event payload
    // over the record it is rendering loses every field the projection omits —
    // the same trap `setVariable` had when it answered `{ id, variables }`.
    const row = await db.deployment.findUnique({ where: { id: deployId } })
    if (row) ch.send('deployments patched', row)
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

  // ── Server resolution ─────────────────────────────────────────────
  async function resolveServer(appId: string): Promise<string | null> {
    const placements = await db.appServer.findMany({
      where:   { appId },
      include: { server: true },
      orderBy: { replicaIndex: 'asc' },
    })
    return placements.find((p: any) => p.server?.status === 'online')?.serverId ?? null
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

    const serverId    = await resolveServer(deploy.appId)
    const outpostTarget = serverId ? `outpost:${serverId}` : null
    // configSnapshot is a Json column — already an object, never JSON.parse'd.
    const config      = deploy.configSnapshot ?? {}

    log.info('deployment starting', {
      id:        deploymentId,
      service:   service.name,
      steps:     steps.length,
      outpost:     outpostTarget ?? 'none',
    })

    try {
      for (const step of steps) {
        await startStep(step.id)
        await pushUpdate(deploymentId, deploy.workspaceId)

        await runStep(step, { deploy, service, config, outpostTarget })

        await setStepStatus(step.id, 'success')
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

  async function runStep(
    step:  StepRow,
    ctx:   { deploy: DeploymentRow; service: ServiceRow; config: Record<string, unknown>; outpostTarget: string | null }
  ): Promise<void> {
    const { deploy, service, outpostTarget } = ctx
    const name = step.name.toLowerCase()

    if (!outpostTarget) {
      // No outpost — log only, don't fail (supports local/stub mode)
      log.debug(`step skipped — no outpost`, { step: step.name })
      return
    }

    if (name.includes('pull')) {
      const result = await app.conduit.send({
        target: outpostTarget,
        method: 'POST',
        path:   '/pull',
        body:   { image: deploy.toImage ?? service.name },
      })
      if (result.error) throw new Error(`Pull failed: ${result.error.message}`)

    } else if (name.includes('stop')) {
      await app.conduit.send({
        target: outpostTarget,
        method: 'POST',
        path:   '/stop',
        body:   { app_id: deploy.appId },
      })
      // Non-fatal — previous container may not exist on first deploy

    } else if (name.includes('start') || name.includes('deploy')) {
      const result = await app.conduit.send({
        target: outpostTarget,
        method: 'POST',
        path:   '/deploy',
        body:   {
          deployment_id: deploy.id,
          image:         deploy.toImage ?? service.name,
          config:        service.config ?? {},   // Json columns — already objects
          source:        service.source ?? {},
        },
      })
      if (result.error) throw new Error(`Deploy failed: ${result.error.message}`)

    } else if (name.includes('health')) {
      // Poll health check up to 10 times with 3s between attempts
      let healthy = false
      for (let i = 0; i < 10; i++) {
        const result = await app.conduit.send({
          target:     outpostTarget,
          method:     'POST',
          path:       '/health-check',
          body:       { app_id: deploy.appId },
          timeout_ms: 5_000,
        })
        if (!result.error && (result.data as Record<string, unknown>)?.healthy) {
          healthy = true
          break
        }
        await new Promise(r => setTimeout(r, 3_000))
      }
      if (!healthy) throw new Error('Health check failed after 10 attempts')

    } else {
      // Build, migration, CDN steps etc. — forward to outpost as generic exec
      const result = await app.conduit.send({
        target: outpostTarget,
        method: 'POST',
        path:   '/exec',
        body:   { step: step.name, deployment_id: deploy.id },
      })
      if (result.error) throw new Error(`Step '${step.name}' failed: ${result.error.message}`)
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

  // ── Register Caravan handler ──────────────────────────────────────
  function register(): void {
    app.jobs.handle<{ deployment_id: string }>('deployment:run', async (job) => {
      await runDeployment(job.data.deployment_id)
    }, {
      queue:       'deployments',
      maxAttempts: 1,   // deploys are not retried automatically — re-trigger manually
    })

    log.info('deployment engine registered')
  }

  return { register, runDeployment }
}
