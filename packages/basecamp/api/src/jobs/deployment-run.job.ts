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
//   POST /deploy       { deployment_id, image, digest, hosts, … } → { digest }
//   POST /stop         { app_id }                          → stop old container, drop its route
//   POST /route        { app_id, hosts }                   → Caddy re-routed, no restart (sent by domain:dns)
//   POST /health-check { app_id, digest }                  → { healthy }
//   POST /exec         { step, deployment_id }             → run the step
//
// An app whose source is `inline` speaks a second, shorter protocol. It has no
// image, so none of the routes above apply to it:
//   POST /static/publish  { app_id, files }          → { digest }
//   POST /static/activate { app_id, slug, digest }   → { digest }
//   POST /static/health   { app_id, digest }         → { healthy }
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
import { notifyPeople, workspaceMembers } from '../core/notify.ts'
import { runsAsCaller }         from './context.ts'
import domainDns                from './domain-dns.job.ts'
import { isInline, inlineFilesFor } from '../core/app-source.ts'
import { releaseEnv } from '../core/variables.ts'
import { runtimeOf, routedHosts, markRunning, type Runtime } from '../core/runtime.ts'
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

/** How the release's container starts — the snapshot's, falling back to the
 *  app's columns only for a release that recorded none. */
function runtimeFor(snapshot: Record<string, unknown>, service: Record<string, unknown>): Runtime {
  return (snapshot.runtime as Runtime | undefined) ?? runtimeOf(service)
}

function runner(app: BasecampApp) {

  // No client here (`FJS-384`). A deploy runs as whoever asked for it, so the
  // service calls below resolve their membership in the workspace the queue
  // recorded — and a release in another one answers nothing rather than being
  // advanced by id. The writes themselves stay system inside those methods,
  // because `DeploymentStep` is update-at-SYSTEM.
  const deployments = app.service('deployments')
  const log         = app.logger.child('deployment-run')

  // ── Step writes ───────────────────────────────────────────────────
  // Through the service, which owns the row and announces the release after
  // each one — the push used to be a second call here and a step that moved
  // without it left the screen frozen at 'pending'.
  //
  // `StepStatus`, not `string`: the column is an enum with a CHECK behind it, so
  // a typo here is a constraint error at the end of a deploy rather than a
  // refusal at the call.
  async function step(
    deploymentId: string, stepId: string, status: StepStatus,
    extra: { output?: string; digest?: string | null } = {},
  ): Promise<void> {
    await deployments.call('stepStatus', deploymentId, {
      stepId, status,
      ...(extra.output !== undefined ? { output: extra.output } : {}),
      ...(extra.digest ? { digest: extra.digest } : {}),
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

  // ── Telling people ────────────────────────────────────────────────
  // Everybody in the workspace, and no narrowing by role: who WANTS to hear
  // about a release is a preference, and `NotificationPreference` is where a
  // person says so. Filtering by role here would be a second answer to a
  // question one model already owns, and the person who triggered the deploy is
  // not excluded for the same reason — they can turn it off.
  //
  // Failures are never swallowed into the deploy: `notifyPeople` catches per
  // recipient, and this whole call sits outside the try that fails the release,
  // because a release that succeeded and a mailer that did not are two facts.
  async function tellThem(kind: string, deploy: any, service: any, extra: Record<string, unknown> = {}) {
    const workspaceId = deploy.workspaceId as string | undefined
    if (!workspaceId) return
    const env = deploy.environmentId
      ? await (app.db as any).asSystem().environment.findFirst({ where: { id: deploy.environmentId } })
      : null
    await notifyPeople(app, kind, await workspaceMembers(app, workspaceId), {
      deploymentId: deploy.id,
      appName:      service?.name ?? 'an app',
      environment:  env?.name ?? 'an environment',
      release:      deploy.version ?? undefined,
      ...extra,
    })
  }

  // A release can land somewhere the App's ingress record does not name, and
  // until it is pushed the hostname sends people to where the App ran before.
  // One push per Domain: the first rewrites the ingress record and the rest
  // find it already true. Caught, because the release DID succeed — a queue
  // hiccup here must not reach failDeploy, and `/dns/` names what went stale.
  async function toZones(appId: string, deploymentId: string): Promise<void> {
    try {
      const domains = await app.db.asSystem().domain.findMany({ where: { appId }, select: { id: true } }) as { id: string }[]
      for (const d of domains)
        await app.jobs.dispatch(domainDns, { domainId: d.id }, { id: `dns:${d.id}:release:${deploymentId}` })
    } catch (err) {
      log.warn('release not pushed to its zones', { id: deploymentId, error: (err as Error).message })
    }
  }

  // ── Core runner ───────────────────────────────────────────────────
  async function runDeployment(deploymentId: string): Promise<void> {
    const startedAt = Date.now()

    // One call for the row, its steps and its app — and the refusal. A release
    // this actor may not reach, or one that has gone, throws here rather than
    // being advanced.
    let opened: { runnable: boolean; status?: string
                  deploy?: DeploymentRow; steps?: StepRow[]; app?: ServiceRow }
    try {
      opened = await deployments.call('startRun', deploymentId) as typeof opened
    } catch (err) {
      log.warn('deployment not startable', { id: deploymentId, error: (err as Error).message })
      return
    }

    if (!opened.runnable) {
      log.warn('deployment not in runnable state', { id: deploymentId, status: opened.status })
      return
    }

    const deploy  = opened.deploy as DeploymentRow
    const steps   = (opened.steps ?? []) as StepRow[]
    const service = opened.app as ServiceRow
    if (!service) {
      await failDeploy(deploymentId, startedAt, 'App not found')
      await tellThem('deploy_failed', deploy, null, { reason: 'App not found' })
      return
    }

    // Asked again here, and not only in `deployments.create`: a placement can be
    // removed, and a machine can start draining, between the click and the job.
    const executor = await resolveExecutor(app, deploy.appId)
    if (!isExecutor(executor)) {
      // The release stops here, with the reason on the row. Every step stays
      // `pending` until failDeploy marks them failed — none of them is touched,
      // which is the difference from the behavior this replaced.
      await failDeploy(deploymentId, startedAt, executor.reason)
      log.error('deployment refused — no executor', { id: deploymentId, reason: executor.reason })
      // A release refused before it started is still a release that failed, and
      // it is the one people most need telling about: nothing happened on the
      // machine, so there is no half-finished state on a screen to notice.
      await tellThem('deploy_failed', deploy, service, { reason: executor.reason })
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

      for (const s of steps) {
        await step(deploymentId, s.id, 'running')

        const result = await runStep(s, { deploy, service, config, executor, digest })

        // A later step's digest wins: /deploy names the bytes that were started,
        // where /pull names the bytes that were fetched, and a release records
        // what RAN. It travels with the step write rather than as a second one.
        if (result.digest && result.digest !== digest) digest = result.digest

        await step(deploymentId, s.id, 'success', { output: result.output, digest })
      }

      await deployments.call('finishRun', deploymentId, {
        status: 'success',
        startedAt: new Date(startedAt).toISOString(),
      })
      // The one write saying WHERE the app now runs — the ingress record's
      // addresses are read off it (`servingAddresses`), and a placement never
      // marked is a machine DNS must not send anybody to.
      await markRunning(app.db, deploy.appId, executor.serverId)
      await toZones(deploy.appId, deploymentId)
      log.info('deployment succeeded', { id: deploymentId, duration_ms: Date.now() - startedAt })
      await tellThem('deploy_success', deploy, service)

    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'unknown error'
      await failDeploy(deploymentId, startedAt, msg)
      log.error('deployment failed', { id: deploymentId, error: msg })
      await tellThem('deploy_failed', deploy, service, { reason: msg })
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

    // The bytes this release is FOR, which is the snapshot and never the app as
    // it stands now: `rollback` creates a release whose whole meaning is that
    // its snapshot differs from the app, and a runner reading the live row
    // would put the current files back under the old release's name.
    const source = ctx.config.source ?? service.source ?? {}
    if (isInline(source)) return runInlineStep(step, { ...ctx, source })
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
        // The container is named for the APP, and this line is what makes that
        // true: outpost falls back to the deployment id when it is absent, so
        // every release started a container called `fjs-<deployment>` while
        // `/stop`, `/health-check` and `/logs` — which all send `app_id` — asked
        // about `fjs-<app>`. The health check then failed on every release, the
        // next deploy stopped nothing and the containers accumulated one per
        // release, each of them unreachable by name (`FJS-920`).
        app_id:        deploy.appId,
        image,
        digest,
        // The snapshot, not the app. `rollback` exists to put back the config
        // that shipped with those bytes, and reading the live row here undid
        // exactly that — the old image with the new config is neither release.
        // Secrets become values here and nowhere earlier: the snapshot keeps
        // their ids, so a release record never holds the credential it shipped with.
        config: {
          ...runtimeFor(ctx.config, service),
          env: await releaseEnv(app.db as never, ctx.config as never),
        },
        source:        ctx.config.source ?? service.source ?? {},
        hosts:         await routedHosts(app.db, deploy.appId),
      })
      if (reply.error) throw new Error(`Deploy failed: ${reply.error.message}`)
      return { output: note(reply), digest: asDigest(reply.data?.digest) ?? digest }

    } else if (name.includes('health')) {
      // Poll up to 10 times with 3s between attempts. The path, where the app
      // names one, is asked of the port the release published.
      const { port, healthCheck } = runtimeFor(ctx.config, service)
      let last: { data?: Record<string, unknown> } = {}
      for (let i = 0; i < 10; i++) {
        const reply = await executor.call('/health-check',
          { app_id: deploy.appId, digest, port, path: healthCheck }, { timeoutMs: 5_000 })
        last = reply
        if (!reply.error && reply.data?.healthy) return { output: note(reply), digest }
        await new Promise(r => setTimeout(r, 3_000))
      }
      const why = last.data?.stubbed ? ' (stub executor)' : last.data?.reason ? ` — ${last.data.reason}` : ''
      throw new Error(`Health check failed after 10 attempts${why}`)

    } else {
      // Build, migration, CDN steps etc. — forwarded as a generic step.
      const reply = await executor.call('/exec', { step: step.name, deployment_id: deploy.id })
      if (reply.error) throw new Error(`Step '${step.name}' failed: ${reply.error.message}`)
      return { output: note(reply), digest: asDigest(reply.data?.digest) ?? digest }
    }
  }

  /**
   * One step of an inline release.
   *
   * Four calls, no docker, no registry, no build. The digest is read off the
   * bytes the machine WROTE and travels to `activate` and `health` from there —
   * a release that says which bytes are serving it is the only thing separating
   * this from "the files were sent and something is up".
   */
  async function runInlineStep(
    step: StepRow,
    ctx: {
      deploy:   DeploymentRow
      service:  ServiceRow
      executor: Executor
      digest:   string | null
      source:   unknown
    },
  ): Promise<{ output?: string; digest: string | null }> {
    const { deploy, service, executor, digest, source } = ctx
    const name  = step.name.toLowerCase()
    const files = inlineFilesFor(source)

    const note = (reply: { data?: Record<string, unknown> }) =>
      reply.data?.stubbed ? String(reply.data.note ?? 'stub executor — nothing was issued') : undefined

    if (name.includes('validate')) {
      // The snapshot, not the app. A release queued against an empty source is
      // a release with nothing to send, and it says so before anything leaves.
      if (!files.length) throw new Error('This release has no files — the source was empty when it was queued')
      const bytes = files.reduce((n: number, f: { content?: string }) => n + (f.content?.length ?? 0), 0)
      return { output: `${files.length} file(s), ${bytes} characters`, digest }
    }

    if (name.includes('upload')) {
      const reply = await executor.call('/static/publish', {
        app_id: deploy.appId,
        files,
      }, { timeoutMs: 60_000 })
      if (reply.error) throw new Error(`Upload failed: ${reply.error.message}`)

      const written = asDigest(reply.data?.digest)
      return {
        output: note(reply) ?? `${reply.data?.files ?? files.length} file(s), ${reply.data?.bytes ?? '?'} bytes written`,
        digest: written ?? digest,
      }
    }

    if (name.includes('activate')) {
      // The digest came back from the upload, so a release that cannot name its
      // bytes has nothing to activate. The stub is the one exception and it is
      // marked as such in every step's output: it reports no digest on purpose
      // rather than inventing one.
      if (!digest && executor.kind !== 'stub')
        throw new Error('The upload reported no digest, so there is nothing to make live')

      const reply = await executor.call('/static/activate', {
        app_id: deploy.appId,
        // The hostname label this app answers on where there is no domain
        // pointed at it yet, which is every app on the day it is pasted in.
        slug:   service.slug,
        digest,
      })
      if (reply.error) throw new Error(`Activate failed: ${reply.error.message}`)

      // The address the MACHINE says it is serving at, written into the step
      // an operator is already looking at. Assembling it here from a port and a
      // slug would be this process guessing at how a box it has never seen is
      // reached from outside.
      const at = reply.data?.url ? ` at ${reply.data.url}` : ''
      return { output: note(reply) ?? `serving ${digest}${at}`, digest: asDigest(reply.data?.digest) ?? digest }
    }

    if (name.includes('health')) {
      // Two attempts and a second between them, where a container gets ten over
      // thirty seconds: a symlink swap has either happened or it has not, and
      // polling a filesystem for half a minute only makes a broken release take
      // longer to say so.
      let last: { data?: Record<string, unknown>; error?: { message: string } } = {}
      for (let i = 0; i < 2; i++) {
        const reply = await executor.call('/static/health', { app_id: deploy.appId, digest }, { timeoutMs: 5_000 })
        last = reply
        if (!reply.error && reply.data?.healthy) return { output: note(reply), digest }
        await new Promise(r => setTimeout(r, 1_000))
      }
      // The machine's own sentence — "the live release is <other digest>" is a
      // different problem from "there is no index.html" and the operator can
      // act on exactly one of them.
      throw new Error(`Not serving: ${last.error?.message ?? last.data?.reason ?? 'the machine did not say why'}`)
    }

    // A step name nothing here answers. Acknowledged rather than failed, which
    // is what `/exec` already does for the container pipeline: a list that grew
    // a line is not a release that broke.
    return { output: `step '${step.name}' needs no work for an inline app`, digest }
  }

  // The release, the steps it left behind, the app's status and the event —
  // one call, because they are one fact and four writes that used to be able
  // to half-happen.
  async function failDeploy(id: string, startedAt: number, error: string): Promise<void> {
    await deployments.call('finishRun', id, {
      status: 'failed', error, startedAt: new Date(startedAt).toISOString(),
    })
  }

  return { runDeployment }
}

// ── The job ───────────────────────────────────────────────────────
// maxAttempts 1: a deploy is not retried automatically. Half of one that
// failed has already happened on the machine, and the way back is a person
// looking at the steps and triggering another.

export default defineJob<{ deployment_id: string }>('deployment:run', async (ctx) => {
  // Somebody asked for this release. The queue recorded them and the workspace.
  const { app } = runsAsCaller(ctx, 'deployment:run')
  await runner(app).runDeployment(ctx.data.deployment_id)
}, {
  queue:       'deployments',
  maxAttempts: 1,
})
