
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
//   POST /build        { app_id, source, image }          → { digest, commit_sha, exposed_port }; a git source, built on the machine that runs it
//   POST /deploy      { deployment_id, image, digest, hosts, paths, … } → { digest, swap, swap_reason }, once healthy;
//                      a release that fails puts the previous container back (FJS-1765)
//   POST /stop         { app_id }                          → container and route gone (sent by apps.remove, never by a release)
//   POST /route        { app_id, hosts, paths?, port? }            → Caddy re-routed, no restart (sent by domain:dns;
//                                                            `port` only by a preview's Open, domain/workbench/workbench-preview.ts)
//   POST /volume/restore { app_id, url, sha256, overwrite, run_id } → the copy put back over a stopped volume (a rollback)
//   POST /volume/restore/began { app_id, run_id }          → { began }; asked at the close of a rollback this process died in
//   POST /health-check { app_id, digest }                  → { healthy }
//   POST /exec         { step, deployment_id }             → run the step
//   POST /backup       { app_id, upload_url? }             → the volume archived before the swap; sent by jobs/app-backup-run.job.ts, never from here
//   POST /image/export { app_id, image, digest?, upload_url } → { bytes, sha256, uploaded }; the release's image in the replica bucket, sent by jobs/release-image-export.job.ts after a success
//
// A static app built from git speaks one route, `POST /site/publish`
// { app_id, source, branch, commit, cloudflare } → { commit_sha, url }.
//
// An app whose source is `inline` speaks a second, shorter protocol. It has no
// image, so none of the routes above apply to it:
//   POST /static/publish  { app_id, files }          → { digest }
//   POST /static/activate { app_id, slug, digest, hosts } → { digest }; the hostnames
//                                                     routed to the static origin
//   POST /static/retire   { app_id, slug }           → off the air and off every hostname
//                                                     (sent by apps.remove and a preview's Retire)
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
// A run a restart cut off is replayed by caravan, and the replay finds its
// release `building` and fails it rather than running half a release again
// (`FJS-3850`); a release nothing is left running is failed by
// `sweepStuckReleases` (`FJS-3861`).

import { defineJob }       from '@frontierjs/caravan'
import { resolveExecutor, isExecutor, PULL_TIMEOUT_MS, BUILD_TIMEOUT_MS, DEPLOY_TIMEOUT_MS, ACTIVATE_TIMEOUT_MS } from '../providers/executor.ts'
import type { Executor }    from '../providers/executor.ts'
import { notifyPeople, workspaceMembers } from '../domain/notification/notify.ts'
import { runsAsCaller }         from '../domain/job/job-context.ts'
import domainDns                from './domain-dns.job.ts'
import ingressDns, { ownRecordHolders } from './ingress-dns.job.ts'
import { syncReplicasOn }       from './replicate-sync.job.ts'
import releaseImageExport   from './release-image-export.job.ts'
import { isInline, isGit, inlineFilesFor } from '../domain/release/app-source.ts'
import { siteBranch } from '../domain/site/site-checkout.ts'
import { gitCredential } from '../providers/source/index.ts'
import { healthBudgetS, HEALTH_INTERVAL_S, HEALTH_CHECK_TIMEOUT_S } from '@frontierjs/outpost/swap'
import { releaseSite } from '../domain/site/site-publish.ts'
import { cloudflareFor } from '../domain/site/site-preview.ts'
import { SITE_STEP, WEB_BUILD_STEP, WEB_RELEASE_STEP, INTERRUPTED, releaseStatus, pushRow } from '../domain/release/release-record.ts'
import { frontsOf, type Front } from '../domain/release/fronting.ts'
import { publishStatic, overPublishLimit, type PublishFile } from '../domain/release/static-publish.ts'
import { releaseEnv } from '../domain/release/variables.ts'
import { runtimeFor, routedHosts, routedPaths, routedRedirects, routeRemovals, noindexHosts, markRunning, type Runtime } from '../domain/release/runtime.ts'
import { takeAppBackup, destinationFor, releaseCopyOf, restoreSourceOf, VOLUME_RESTORE_TIMEOUT_MS } from './app-backup-run.job.ts'
import { pushIngressCert } from './ingress-cert.job.ts'
import type { App }         from '@frontierjs/junction'
import type { StepStatus, DeploySwap } from '#db/schema.d.ts'

// Row shapes come from the schema now, not from hand-written mirrors of it.
// The old DeploymentRow / ServiceRow / StepRow / ServiceServerRow interfaces
// described snake_case columns with JSON-as-string fields — three claims the
// schema contradicts. `any` here is honest until litestone's generated types
// are wired in (`litestone types`), which is the real fix.

type DeploymentRow = any
type StepRow       = any
/** web/ written onto a static App's machine, waiting for its release. */
type HeldWeb       = { front: Front; digest: string }
type ServiceRow    = any

/** How `/deploy` replaced the live container. Nothing from a reply that names
 *  no swap, such as the stub's, rather than a guess at stop-first. */
type Swapped = { swap?: DeploySwap; swapReason?: string | null }
function swapOf(data: Record<string, unknown> | undefined): Swapped {
  const swap = data?.swap === 'start-first' ? 'startFirst' : data?.swap === 'stop-first' ? 'stopFirst' : null
  if (!swap) return {}
  return { swap, swapReason: typeof data?.swap_reason === 'string' ? data.swap_reason : null }
}

// Whether a release may ask Outpost for start-first. Mirrors the conditions of
// its `checkSwap`: a route in front of a published port, no exposed port, and
// a health path to ask before the route moves.
function wantsStartFirst(
  service: Record<string, unknown>, runtime: Runtime, hosts: unknown[], paths: unknown[],
): boolean {
  return service.swap === 'startFirst' && service.hasExposedPort !== true
    && Boolean(runtime.port) && runtime.healthCheck != null && (hosts.length > 0 || paths.length > 0)
}

function runner(app: App) {

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
    extra: { output?: string; digest?: string | null; commit?: string; containerPort?: number } & Swapped = {},
  ): Promise<void> {
    await deployments.call('stepStatus', deploymentId, {
      stepId, status,
      ...(extra.output !== undefined ? { output: extra.output } : {}),
      ...(extra.digest ? { digest: extra.digest } : {}),
      ...(extra.commit ? { commit: extra.commit } : {}),
      ...(extra.containerPort != null ? { containerPort: extra.containerPort } : {}),
      ...(extra.swap ? { swap: extra.swap, swapReason: extra.swapReason ?? null } : {}),
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
    const env = service?.environmentId
      ? await (app.db as any).asSystem().environment.findFirst({ where: { id: service.environmentId } })
      : null
    await notifyPeople(app, kind, await workspaceMembers(app, workspaceId), {
      deploymentId: deploy.id,
      appName:      service?.name ?? 'an app',
      environment:  env?.name ?? 'an environment',
      release:      deploy.version ?? undefined,
      ...extra,
    }, workspaceId)
  }

  // A release can land somewhere the App's ingress record does not name, and
  // until it is pushed the hostname sends people to where the App ran before.
  // One push per Domain: the first rewrites the ingress record and the rest
  // find it already true. Caught, because the release DID succeed — a queue
  // hiccup here must not reach failDeploy, and `/dns/` names what went stale.
  async function toZones(appId: string, deploymentId: string): Promise<void> {
    try {
      const domains = await app.db!.asSystem().domain.findMany({ where: { appId }, select: { id: true } }) as { id: string }[]
      for (const d of domains)
        await app.jobs.dispatch(domainDns, { domainId: d.id }, { id: `dns:${d.id}:release:${deploymentId}` })
      if ((await ownRecordHolders(app, [appId])).length)
        await app.jobs.dispatch(ingressDns, { appId }, { id: `ingress:${appId}:release:${deploymentId}` })
    } catch (err) {
      log.warn('release not pushed to its zones', { id: deploymentId, error: (err as Error).message })
    }
  }

  // The slugs outpost spells the container's name from: `docker ps` on the box
  // reads `fjs--<project>-<env>-<app>-<id>`. Read off the rows rather than
  // carried on the snapshot, which holds the release's config and not where the
  // App lives. An App with no Environment is refused here, before the old
  // container is touched, because outpost refuses a deploy with no slug anyway.
  async function containerSlugs(service: any): Promise<{ project: string; environment: string; app_slug: string }> {
    const db  = app.db!.asSystem() as any
    const env = service.environmentId ? await db.environment.findFirst({ where: { id: service.environmentId } }) : null
    const project = env?.projectId ? await db.project.findFirst({ where: { id: env.projectId } }) : null
    if (!env?.slug || !project?.slug) throw new Error(`App ${service.slug} has no Environment and Project to name its container for`)
    return { project: project.slug, environment: env.slug, app_slug: service.slug }
  }

  // ── Core runner ───────────────────────────────────────────────────
  async function runDeployment(deploymentId: string): Promise<void> {
    const startedAt = Date.now()

    // One call for the row, its steps and its app — and the refusal. A release
    // this actor may not reach, or one that has gone, throws here rather than
    // being advanced.
    let opened: { runnable: boolean; status?: string; interrupted?: boolean
                  deploy?: DeploymentRow; steps?: StepRow[]; app?: ServiceRow }
    try {
      opened = await deployments.call('startRun', deploymentId) as typeof opened
    } catch (err) {
      log.warn('deployment not startable', { id: deploymentId, error: (err as Error).message })
      return
    }

    if (!opened.runnable) {
      log.warn('deployment not in runnable state', { id: deploymentId, status: opened.status, ...(opened.interrupted ? { interrupted: true } : {}) })
      if (opened.interrupted) await closeInterruptedRollback(deploymentId)
      return
    }

    const deploy  = opened.deploy as DeploymentRow
    const steps   = (opened.steps ?? []) as StepRow[]
    const service = opened.app as ServiceRow
    if (!service) {
      await failDeploy(deploymentId, startedAt, 'App not found')
      await tellThem('DeployFailed', deploy, null, { reason: 'App not found' })
      return
    }

    // Asked again here, and not only in `deployments.create`: a placement can be
    // removed, and a machine can start draining, between the click and the job.
    const executor = await resolveExecutor(app, deploy.appId)
    if (!isExecutor(executor)) {
      // The release stops here, with the reason on the step it would have run
      // first. None of them ran, which is the difference from the behavior
      // this replaced.
      await failDeploy(deploymentId, startedAt, executor.reason, steps[0]?.id)
      log.error('deployment refused — no executor', { id: deploymentId, reason: executor.reason })
      // A release refused before it started is still a release that failed, and
      // it is the one people most need telling about: nothing happened on the
      // machine, so there is no half-finished state on a screen to notice.
      await tellThem('DeployFailed', deploy, service, { reason: executor.reason })
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

    // The step a throw belongs to, read by the catch below. Cleared once it
    // lands, so a failure after the last step does not rewrite one that succeeded.
    let current: string | undefined
    let siteFailed: string | undefined
    let webFailed: string | undefined
    const web: HeldWeb[] = []

    // A cancel only writes the row; this is where it stops the run. Asked
    // before every step, because each one acts on the machine and a release
    // somebody cancelled must not go on to swap what is serving (`FJS-3848`).
    const cancelled = async () => (await releaseStatus(app, deploymentId)) === 'cancelled'

    // The wildcard goes to the machine before anything routes to it, so one
    // enrolled after the mint holds it before it serves. A failure is logged
    // and the release goes on: what is served is gated on the certificate being
    // there (`FJS-D1954`), not on this push.
    if (deploy.workspaceId) {
      const pushed = await pushIngressCert(app, executor, deploy.workspaceId as string)
      if (typeof pushed === 'object') log.warn('ingress certificate not pushed', { id: deploymentId, server: executor.serverId, error: pushed.failed })
      else if (pushed === 'old-outpost') log.warn('outpost too old to hold the ingress certificate', { id: deploymentId, server: executor.serverId })
    }

    try {
      // The digest travels down the steps: whatever /pull reported is what
      // /deploy is asked to start, and what /health-check is asked about.
      let digest: string | null = asDigest(deploy.builtImage)
      // The commit the image was built from, which is the site's.
      let commit: string | null = null

      for (const s of steps) {
        if (await cancelled()) {
          log.info('deployment cancelled — stopping before its next step', { id: deploymentId, step: s.name })
          return
        }
        current = s.id
        await step(deploymentId, s.id, 'running')

        let result: Awaited<ReturnType<typeof runStep>>
        try {
          result = await runStep(s, { deploy, service, config, executor, digest, commit, web })
        } catch (err) {
          if (s.name !== SITE_STEP && s.name !== WEB_RELEASE_STEP) throw err
          const why = (err as Error).message ?? 'unknown error'
          if (s.name === SITE_STEP) siteFailed = why
          else webFailed = why
          await step(deploymentId, s.id, 'failed', { output: why })
          current = undefined
          continue
        }
        if (result.commit) commit = result.commit

        // A later step's digest wins: /deploy names the bytes that were started,
        // where /pull names the bytes that were fetched, and a release records
        // what RAN. It travels with the step write rather than as a second one.
        if (result.digest && result.digest !== digest) digest = result.digest

        await step(deploymentId, s.id, 'success', {
          output: result.output, digest, commit: result.commit, containerPort: result.containerPort,
          swap: result.swap, swapReason: result.swapReason,
        })
        current = undefined
      }

      const finished = await deployments.call('finishRun', deploymentId, {
        status: 'success',
        startedAt: new Date(startedAt).toISOString(),
      }) as { status?: string }
      // Cancelled during the last step: the row stays cancelled, and nothing
      // below may announce it as live.
      if (finished?.status === 'cancelled') {
        log.info('deployment cancelled — its last step finished after the cancel', { id: deploymentId })
        return
      }

    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'unknown error'
      const status = await failDeploy(deploymentId, startedAt, msg, current)
      log.error('deployment failed', { id: deploymentId, error: msg })
      if (status !== 'cancelled') await afterward('notify', () => tellThem('DeployFailed', deploy, service, { reason: msg }))
      return
    }

    // After the release is recorded a success, and outside the try that fails
    // it: each of these is its own fact, and one throwing used to rewrite a
    // release that shipped as `failed` (`FJS-3852`).
    //
    // The one write saying WHERE the app now runs — the ingress record's
    // addresses are read off it (`servingAddresses`), and a placement never
    // marked is a machine DNS must not send anybody to.
    await afterward('mark running', () => markRunning(app.db, deploy.appId, executor.serverId))
    await toZones(deploy.appId, deploymentId)
    // A first release is what makes the volume a replica list skips until
    // it exists, so the machine is sent its list again.
    if (service?.replicaDestinationId) await afterward('sync replicas', () => syncReplicasOn(app, [executor.serverId]))
    // The image goes to the same bucket, so a copy can be served on a machine
    // that never held this release.
    if (service?.replicaDestinationId && deploy.toImage)
      await afterward('export image', () => app.jobs.dispatch(releaseImageExport,
        { deploymentId, serverId: executor.serverId }, { id: `image-export:${deploymentId}` }))
    log.info('deployment succeeded', { id: deploymentId, durationMs: Date.now() - startedAt,
      ...(siteFailed ? { site: siteFailed } : {}), ...(webFailed ? { web: webFailed } : {}) })
    await afterward('notify', () => tellThem('DeploySuccess', deploy, service,
      { ...(siteFailed ? { siteFailed } : {}), ...(webFailed ? { webFailed } : {}) }))

    async function afterward(what: string, fn: () => Promise<unknown>): Promise<void> {
      try { await fn() } catch (err) {
        log.warn(`release recorded, but ${what} failed`, { id: deploymentId, error: (err as Error).message })
      }
    }
  }

  async function isRollbackOfLive(rel: DeploymentRow): Promise<boolean> {
    if (rel.trigger !== 'rollback') return false
    const undone = rel.previousDeploymentId
      ? await (app.db as any).asSystem().deployment.findFirst({ where: { id: rel.previousDeploymentId }, select: { trigger: true } }) : null
    return undone?.trigger !== 'rollback'
  }

  // The `/deploy` body a release starts with. One builder for the release's own
  // Start step and for the put-back of the release a failed restore stopped, so
  // the two cannot start a container two ways.
  async function startBody(
    rel: DeploymentRow, config: Record<string, unknown>, service: ServiceRow,
    image: string, digest: string | null, build: string | null = rel.commitSha ?? null,
  ): Promise<Record<string, unknown>> {
    const runtime = runtimeFor(config, service)
    const hosts   = await routedHosts(app.db, rel.appId)
    const paths   = await routedPaths(app.db, rel.appId)
    const redirects = await routedRedirects(app.db, rel.appId)
    return {
      deployment_id: rel.id,
      // The container is found by the APP, and this line is what makes that
      // true: outpost falls back to the deployment id when it is absent, so
      // every release started a container for the deployment while `/stop`,
      // `/health-check` and `/logs` — which all send `app_id` — asked about
      // the app's. The health check then failed on every release, the next
      // deploy stopped nothing and the containers accumulated one per
      // release (`FJS-920`). The slugs only spell its name for `docker ps`.
      app_id:        rel.appId,
      ...await containerSlugs(service),
      image,
      digest,
      // The snapshot, not the app. `rollback` exists to put back the config
      // that shipped with those bytes, and reading the live row here undid
      // exactly that — the old image with the new config is neither release.
      // Secrets become values here and nowhere earlier: the snapshot keeps
      // their ids, so a release record never holds the credential it shipped with.
      config: {
        ...runtime,
        env: {
          ...await releaseEnv(app.db as never, config as never),
          // The commit the static App's bundle was stamped with (`FJS-D1969`).
          // Without it the API states no build, and a browser holding the
          // last release's bundle is never told it is stale (`FJS-D160`). After
          // the Variables, so a stored FJS_BUILD cannot name another commit.
          ...(build ? { FJS_BUILD: build } : {}),
        },
      },
      source:        config.source ?? service.source ?? {},
      hosts,
      paths,
      redirects,
      noindex:       await noindexHosts(app.db, rel.appId),
      removing:      await routeRemovals(app.db, rel.appId, { hosts, redirects, paths }),
      // The live App, as the hosts are: a rollback puts back old bytes, never
      // an exposure somebody has since withdrawn. The machine's firewall
      // drops a forwarded port this does not declare (FJS-D930).
      exposes_port:  service.hasExposedPort === true,
      // The live App's ask, as `exposes_port` is (`FJS-D1882`). It is sent only
      // where Outpost would accept it: `checkSwap` refuses a start-first that
      // has no route to follow the port or no health path to ask, and a release is not failed for a
      // setting. Outpost still reads the pivot and may answer stop-first.
      swap:          wantsStartFirst(service, runtime, hosts, paths) ? 'start-first' : 'stop-first',
      // A rollback's migrations are already recorded, so a failed one is put back
      // whatever the verdict says (`FJS-D2044`). Undoing a rollback goes forward
      // to the newer image over the volume the first one may have restored, so
      // that release migrates and is graded like any other (`FJS-4124`).
      rollback:      await isRollbackOfLive(rel),
    }
  }

  function imageOf(rel: DeploymentRow, source: unknown, service: ServiceRow): string {
    return rel.toImage ?? (isGit(source) ? `fjs-${rel.appId}:${rel.id}`.toLowerCase() : service.name)
  }

  // What was live is the release a rollback undoes, started from its own
  // record: its image, its digest and the config it shipped with.
  async function startPrevious(undone: string | null | undefined, service: ServiceRow, executor: Executor): Promise<string> {
    try {
      const live = undone
        ? await (app.db as any).asSystem().deployment.findFirst({ where: { id: undone } }) : null
      if (!live) return 'the app is stopped: the release that was live has no record to start it from'
      const liveConfig = (live.configSnapshot ?? {}) as Record<string, unknown>
      const liveSource = liveConfig.source ?? service.source ?? {}
      const started = await executor.call('/deploy', await startBody(
        live, liveConfig, service, imageOf(live, liveSource, service), asDigest(live.builtImage)),
        { timeoutMs: DEPLOY_TIMEOUT_MS })
      if (started.error) return `starting it again failed (${started.error.message}) — the app is stopped`
      return 'the previous release is running again'
    } catch (err) {
      return `starting the previous release again failed (${(err as Error).message}) — the app is stopped`
    }
  }

  // The close of a rollback the hub died in (`FJS-4116`, `FJS-D2039`). `Stop` removed
  // the container and the route, and only this process knew to start the release
  // again. A restore that never began leaves the volume as it was, so that release
  // starts; one that began, or that Outpost cannot be asked about, leaves the
  // volume in a state nothing may run on, and the app stays stopped.
  async function closeInterruptedRollback(deploymentId: string): Promise<void> {
    const sys = (app.db as any).asSystem()
    const deploy = await sys.deployment.findFirst({ where: { id: deploymentId } })
    if (!deploy || deploy.trigger !== 'rollback' || !deploy.previousDeploymentId) return
    const steps = await sys.deploymentStep.findMany({ where: { deploymentId } }) as StepRow[]
    const ran = (name: string) => steps.find(s => s.name === name)?.startedAt != null
    const stopped = steps.find(s => s.name === 'Stop container')
    if (!ran('Stop container') || !stopped || ran('Start container')) return

    const service = await sys.app.findUnique({ where: { id: deploy.appId } }) as ServiceRow | null
    const executor = service ? await resolveExecutor(app, deploy.appId) : null
    if (!service || !executor || !isExecutor(executor)) {
      log.error('interrupted rollback left the app stopped: no machine to ask', { id: deploymentId })
      return
    }

    let began: boolean | null = ran('Restore volume')
    if (began) {
      const reply = await executor.call('/volume/restore/began', { app_id: deploy.appId, run_id: deploymentId })
      began = reply.error ? null : reply.data?.began === true
    }
    const copy = await releaseCopyOf(app, deploy.appId, deploy.previousDeploymentId)
    const named = copy ? `put back the copy by hand: ${copy.location} (taken ${copy.finishedAt ?? copy.createdAt})` : 'put back the copy taken before the release this undoes'
    const said = began === false
      ? `The restore never began, so ${await startPrevious(deploy.previousDeploymentId, service, executor)}`
      : began
        ? `The restore had begun, so the volume is in an unknown state and the app stays stopped — ${named}`
        : `Whether the restore began could not be read, so the volume may be in an unknown state and the app stays stopped — ${named}`

    const at = steps.find(s => s.status === 'failed') ?? stopped
    await sys.deploymentStep.updateMany({ where: { id: at.id, deploymentId },
      data: { output: `${INTERRUPTED}. ${said}` } })
    await pushRow(app, deploymentId)
    log.warn('interrupted rollback closed', { id: deploymentId, began, said })
    if (!said.includes('running again')) await tellThem('DeployFailed', deploy, service, { reason: said })
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
      commit?:  string | null
      web?:     HeldWeb[]
    }
  ): Promise<{ output?: string; digest: string | null; commit?: string; containerPort?: number } & Swapped> {
    const { deploy, service, executor, digest } = ctx
    const name  = step.name.toLowerCase()

    // The bytes this release is FOR, which is the snapshot and never the app as
    // it stands now: `rollback` creates a release whose whole meaning is that
    // its snapshot differs from the app, and a runner reading the live row
    // would put the current files back under the old release's name.
    const source = ctx.config.source ?? service.source ?? {}
    if (isInline(source)) return runInlineStep(step, { ...ctx, source })
    if (service.kind === 'static' && isGit(source)) return runSiteStep(step, { ...ctx, source })
    if (step.name === SITE_STEP) return runAppSiteStep({ ...ctx, source })
    if (step.name === WEB_BUILD_STEP) return runWebBuild({ ...ctx, source, web: ctx.web ?? [] })
    if (step.name === WEB_RELEASE_STEP) return runWebRelease({ ...ctx, web: ctx.web ?? [] })
    // The image as the app names it. The digest is what identifies bytes, but a
    // registry still needs a name to pull by, so both travel.
    // A git release is named for itself: two builds of one app share nothing
    // but the repository, and a tag both write is a tag the older one loses.
    const image = imageOf(deploy, source, service)

    // Said on every step of a stubbed release rather than once on the row: a
    // step list where each line reads 'no /deploy was issued' cannot be mistaken
    // for a release that shipped, and the row's status alone always could.
    const note = (reply: { data?: Record<string, unknown> }) =>
      reply.data?.stubbed ? String(reply.data.note ?? 'stub executor — nothing was issued') : undefined

    if (name.includes('build')) {
      const reply = await executor.call('/build', {
        app_id: deploy.appId, source, image,
      }, { timeoutMs: BUILD_TIMEOUT_MS })
      if (reply.error) throw new Error(`Build failed: ${reply.error.message}`)
      const built = asDigest(reply.data?.digest)
      // A built image that cannot be named by its bytes cannot be started by
      // them, and /deploy would build a second time.
      if (!built && !reply.data?.stubbed) throw new Error('Build failed: the machine reported no image digest')
      // The full sha goes on the row (`FJS-3559`); the output line cuts it.
      const commit = typeof reply.data?.commit_sha === 'string' && reply.data.commit_sha ? reply.data.commit_sha : undefined
      const sha = commit?.slice(0, 7)
      // Which file it built with, since the App's own copy and the repository's
      // are both candidates and a release is read back to say which shipped.
      const file = typeof reply.data?.dockerfile === 'string' && reply.data.dockerfile ? ` with ${reply.data.dockerfile}` : ''
      // The file's last EXPOSE. An App that stores no container port takes it,
      // for this release's snapshot (read by the start step below) and the row
      // (`FJS-D1567`); one that states a number keeps it and the line says
      // where the two disagree, since the health check is about to.
      const exposed = typeof reply.data?.exposed_port === 'number' ? reply.data.exposed_port : null
      const runtime = runtimeFor(ctx.config, service)
      let ports = ''
      let containerPort: number | undefined
      if (exposed != null && runtime.containerPort == null) {
        ctx.config.runtime = { ...runtime, containerPort: exposed }
        containerPort = exposed
        ports = `, EXPOSE ${exposed}`
      } else if (exposed != null && Number(runtime.containerPort) !== exposed) {
        ports = `, EXPOSE ${exposed} where the App says ${runtime.containerPort}`
      }
      const output = note(reply) ?? (sha || file ? `built${sha ? ` ${sha}` : ''}${file}${ports}` : undefined)
      return { output, digest: built ?? digest, commit, containerPort }

    } else if (name.includes('pull')) {
      const reply = await executor.call('/pull', { image, digest }, { timeoutMs: PULL_TIMEOUT_MS })
      if (reply.error) throw new Error(`Pull failed: ${reply.error.message}`)
      return { output: note(reply), digest: asDigest(reply.data?.digest) ?? digest }


    } else if (name.includes('back up')) {
      // The copy before the swap (`FJS-D1496`). A first release has no
      // container and no volume on the machine yet, so there is nothing to
      // copy and the step says so; after that a refused copy fails the
      // release, because the new image migrates the volume forward and the
      // copy is the only way back. A stub took nothing, as on every step.
      if (!deploy.previousDeploymentId) return { output: 'first release — no volume on the machine yet', digest }
      const row = await takeAppBackup(app, {
        target: service, executor, destination: await destinationFor(app, service),
        kind: 'release', deploymentId: deploy.id, requestedBy: deploy.triggeredBy ?? null,
      })
      if (row.status !== 'success') {
        if (executor.kind === 'stub') return { output: 'stub executor — no backup was taken', digest }
        throw new Error(`Back up volume failed: ${row.error}`)
      }
      return { output: row.error ? `${row.location} — ${row.error}` : `copied to ${row.location}`, digest }

    } else if (name.includes('stop')) {
      // A rollback that restores the volume: Outpost refuses a data directory
      // a container holds, so the app stops here and `Start container` brings
      // it back (`FJS-D1796`).
      const reply = await executor.call('/stop', { app_id: deploy.appId })
      if (reply.error) throw new Error(`Stop failed: ${reply.error.message}`)
      return { output: note(reply) ?? 'the app is stopped so its volume can be put back', digest }

    } else if (name.includes('restore')) {
      // The copy the release this one undoes took before its own swap, found
      // by that release (`releaseCopyOf`), and put back over the volume.
      //
      // The app was stopped for this. A failure BEFORE the data directory was
      // written leaves the volume as it was, so the release that was live starts
      // again; one after it began leaves the volume half-restored, and starting
      // anything on it would run a release against files neither of them wrote.
      const undone = deploy.previousDeploymentId
      const copy = undone ? await releaseCopyOf(app, deploy.appId, undone) : null
      if (!copy) return restoreFailed('the copy taken before the release this undoes is gone', false)
      let reply
      try {
        const from = await restoreSourceOf(app, deploy.appId, copy.id)
        reply = await executor.call('/volume/restore', { app_id: deploy.appId, ...from, overwrite: true, run_id: deploy.id },
          { timeoutMs: VOLUME_RESTORE_TIMEOUT_MS })
      } catch (err) {
        return restoreFailed((err as Error).message, false)
      }
      if (reply.error) return restoreFailed(reply.error.message, reply.error.volumeTouched === true)
      return { output: note(reply) ?? `put back the copy taken ${copy.finishedAt ?? copy.createdAt} (${copy.location})`, digest }

      async function restoreFailed(why: string, touched: boolean): Promise<never> {
        if (touched)
          throw new Error(`Restore volume failed partway: ${why}. The volume is in an unknown state and the app stays stopped — put back the copy by hand: ${copy ? `${copy.location} (taken ${copy.finishedAt ?? copy.createdAt})` : 'the one taken before the release this undoes'}`)
        const back = await startPrevious(undone, service, executor)
        throw new Error(`Restore volume failed: ${why}. The volume is unchanged and ${back}`)
      }

    } else if (name.includes('start') || name.includes('deploy')) {
      // A git source's commit is the one /build answered, newer than the row read at the start.
      const reply = await executor.call('/deploy', await startBody(deploy, ctx.config, service, image, digest, ctx.commit ?? deploy.commitSha ?? null),
        { timeoutMs: DEPLOY_TIMEOUT_MS })
      if (reply.error) throw new Error(`Deploy failed: ${reply.error.message}`)
      return { output: note(reply), digest: asDigest(reply.data?.digest) ?? digest, ...swapOf(reply.data) }

    } else if (name.includes('health')) {
      // Polled at Outpost's interval until the release's healthTimeout, the
      // budget Outpost's swap waited, has passed: a deadline, not a count, or
      // an Outpost that hangs on each call stretches the wait by the call's
      // timeout every poll. The path, where the app names one, is asked of the
      // port the release published. The call outlives Outpost's own per-check
      // timeout, or a hung path reads as an unreachable machine.
      const { port, healthCheck, healthTimeout } = runtimeFor(ctx.config, service)
      const deadline = Date.now() + healthBudgetS((healthTimeout as number | undefined) ?? null) * 1000
      let last: { data?: Record<string, unknown> } = {}
      let polls = 0
      do {
        const reply = await executor.call('/health-check',
          { app_id: deploy.appId, digest, port, path: healthCheck }, { timeoutMs: HEALTH_CHECK_TIMEOUT_S * 1000 + 5_000 })
        last = reply
        polls++
        if (!reply.error && reply.data?.healthy) return { output: note(reply), digest }
        await new Promise(r => setTimeout(r, HEALTH_INTERVAL_S * 1000))
      } while (Date.now() < deadline)
      const why = last.data?.stubbed ? ' (stub executor)' : last.data?.reason ? ` — ${last.data.reason}` : ''
      throw new Error(`Health check failed after ${polls} polls${why}`)

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
      // a release with nothing to send, and it says so before anything leaves —
      // unless it names a digest, which is bytes the machine already holds.
      if (!files.length && digest) return { output: `the machine holds ${digest} already — nothing to upload`, digest }
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

      const hosts     = await routedHosts(app.db, deploy.appId)
      const paths     = await routedPaths(app.db, deploy.appId)
      const redirects = await routedRedirects(app.db, deploy.appId)
      const reply = await executor.call('/static/activate', {
        app_id: deploy.appId,
        // The hostname label this app answers on where there is no domain
        // pointed at it yet, which is every app on the day it is pasted in.
        slug:   service.slug,
        digest,
        // The live Domain rows, as `/deploy` sends them: a hostname deleted
        // since the last release drops out here.
        hosts,
        paths,
        redirects,
        noindex:       await noindexHosts(app.db, deploy.appId),
        removing:      await routeRemovals(app.db, deploy.appId, { hosts, redirects, paths }),
      }, { timeoutMs: ACTIVATE_TIMEOUT_MS })
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

  // A static site built from git (`domain/site/site-publish.ts`): the site's branch
  // at its head, built and deployed by the machine in one call, and the
  // commit it built recorded — what an owner's next publish measures from.
  async function runSiteStep(
    step: StepRow,
    ctx:  { deploy: DeploymentRow; digest: string | null; source: any },
  ): Promise<{ output?: string; digest: string | null; commit?: string }> {
    const { deploy, digest, source } = ctx
    const name = step.name.toLowerCase()
    const site = { id: deploy.appId, source, credential: await gitCredential(app, { workspaceId: deploy.workspaceId, repo: source.repo }) }

    if (name.includes('validate')) {
      const at = await siteBranch(site)
      return { output: `${at.branch} at ${at.head.slice(0, 7)}`, digest }
    }
    if (name.includes('build and deploy')) {
      const at   = await siteBranch(site)
      const live = await releaseSite(app, deploy.appId, deploy.workspaceId, source, at.branch, at.head)
      return { output: live.note ?? `live at ${live.url ?? 'the site\'s own domain'} (${live.commit.slice(0, 7)})`,
        digest, commit: live.note ? undefined : live.commit }
    }
    return { output: `step '${step.name}' needs no work for a static site`, digest }
  }

  // An API App's site/ (`IDEAS/site-hosting.md` step 9), from the commit the
  // image was built from, against a copy of the database the new release just
  // migrated, uploaded with the workspace's Cloudflare account (`FJS-D1252`).
  // The machine answers `skipped` for a commit with no site/ and for a Worker
  // with no deployment, whose first deploy is a person's (`FJS-D1688`).
  async function runAppSiteStep(
    ctx: { deploy: DeploymentRow; service: ServiceRow; config: Record<string, unknown>; executor: Executor; digest: string | null; commit?: string | null; source: any },
  ): Promise<{ output?: string; digest: string | null }> {
    const { deploy, executor, digest, source } = ctx
    const runtime    = runtimeFor(ctx.config, ctx.service)
    // Asked here and not refused here: a commit with no site/ needs no account.
    const cloudflare = await cloudflareFor(app, deploy.workspaceId)
    const reply = await executor.call('/site/publish', {
      // A real machine refuses a null commit by name; a stub's build names none.
      app_id: deploy.appId, source, branch: source.branch ?? 'main', commit: ctx.commit ?? null,
      ...('refused' in cloudflare ? {} : { cloudflare: { token: cloudflare.token, account_id: cloudflare.accountId } }),
      app: { volume_path: runtime.volumePath, env: await releaseEnv(app.db as never, ctx.config as never) },
    }, { timeoutMs: BUILD_TIMEOUT_MS })
    if (reply.error) throw new Error('refused' in cloudflare ? `${reply.error.message} — ${cloudflare.refused}` : reply.error.message)
    if (reply.data?.stubbed) return { output: String(reply.data.note ?? 'stub executor — nothing was published'), digest }
    if (reply.data?.skipped) return { output: String(reply.data.skipped), digest }
    return { output: `live at ${reply.data?.url ?? 'the site\'s own domain'}`, digest }
  }

  // An API App's static fronts (`FJS-D1979`), each built from its own surface
  // (`FJS-D2032`) at the commit 'Build image' built, once per surface, and
  // written through each front's own machine. Before the swap (`FJS-D1980`): a
  // throw here fails the release and the old API keeps serving with the old
  // page. Nothing is live until 'Release web'.
  async function runWebBuild(
    ctx: { deploy: DeploymentRow; service: ServiceRow; executor: Executor; digest: string | null; commit?: string | null; source: any; web: HeldWeb[] },
  ): Promise<{ output?: string; digest: string | null }> {
    const { deploy, service, executor, digest, source } = ctx
    // As the system, as `routedHosts` reads: the environment is the App's, which `startRun` confined.
    const fronts   = await frontsOf((app.db as any).asSystem(), { id: deploy.appId, environmentId: service.environmentId })
    const origins  = frontOrigins(fronts)
    const surfaces = [...new Set(fronts.map(f => f.surface))]
    const notes: string[] = []
    let built = 0
    for (const surface of surfaces.length ? surfaces : ['web' as const]) {
      const reply = await executor.call('/web/build', {
        // A real machine refuses a null commit by name; a stub's build names none.
        app_id: deploy.appId, source, commit: ctx.commit ?? null, surface,
        ...(surface === 'web'     && origins.widgets ? { widgets_url: origins.widgets } : {}),
        ...(surface === 'widgets' && origins.api     ? { api_url:     origins.api     } : {}),
      }, { timeoutMs: BUILD_TIMEOUT_MS })
      if (reply.error) throw new Error(`${surface}/ was not built: ${reply.error.message}`)
      if (reply.data?.stubbed) { notes.push(String(reply.data.note ?? `stub executor — ${surface}/ was not built`)); continue }
      if (reply.data?.skipped) { notes.push(String(reply.data.skipped)); continue }
      // An Outpost that predates the surface builds web/ whatever it is asked,
      // and web/'s files on the widget origin would release green.
      const answered = reply.data?.surface ?? 'web'
      if (answered !== surface) throw new Error(`${surface}/ was not built: the machine built ${answered}/ — its Outpost predates the surface`)
      const files = reply.data?.files as PublishFile[] | undefined
      if (!Array.isArray(files) || !files.length) throw new Error(`${surface}/ was built and the machine answered no files`)
      const over = overPublishLimit(files)
      if (over) throw new Error(`${surface}/ built ${over}`)
      built += files.length

      for (const front of fronts.filter(f => f.surface === surface)) {
        const out = await publishStatic(app, front.id, files)
        if ('refused' in out) throw new Error(`${surface}/ was not written for '${front.name}': ${out.refused}`)
        if ('stubbed' in out) { notes.push(`${front.name}: ${out.stubbed}`); continue }
        ctx.web.push({ front, digest: out.digest })
      }
    }
    const onto = ctx.web.map(h => `'${h.front.name}'`).join(', ')
    return { output: [...(built ? [`${built} files${onto ? ` written for ${onto}` : ''}`] : []), ...notes].join('; '), digest }
  }

  // The origins each bundle bakes (`FJS-D2034`). The API is reached through a
  // web front's Domain (`FJS-D1547`), so web/ is told no API origin; a widget
  // runs on a stranger's page and must be told it. web/ is told the widget
  // origin for its embed snippet.
  function frontOrigins(fronts: Front[]): { api?: string; widgets?: string } {
    const host = (surface: string) => fronts.find(f => f.surface === surface && f.domains[0]?.hostname)?.domains[0].hostname
    const api = host('web'), widgets = host('widgets')
    return { ...(api ? { api: `https://${api}` } : {}), ...(widgets ? { widgets: `https://${widgets}` } : {}) }
  }

  // Each static App's own release of the files 'Build web' wrote, recording the
  // commit the API was built from. After the health check, so the page goes
  // live beside the API it was built with.
  async function runWebRelease(
    ctx: { deploy: DeploymentRow; digest: string | null; commit?: string | null; web: HeldWeb[] },
  ): Promise<{ output?: string; digest: string | null }> {
    const { deploy, digest } = ctx
    if (!ctx.web.length) return { output: 'no web/ was written, so there is none to release', digest }
    const failed: string[] = []
    for (const { front, digest: built } of ctx.web) {
      try {
        await deployments.create({
          appId: front.id, builtImage: built, trigger: deploy.trigger ?? 'push',
          ...(ctx.commit ? { commitSha: ctx.commit } : {}), ...(deploy.branch ? { branch: deploy.branch } : {}),
        })
      } catch (err) {
        failed.push(`'${front.name}': ${(err as Error).message}`)
      }
    }
    if (failed.length) throw new Error(`web/ was not released for ${failed.join('; ')}`)
    return { output: `released for ${ctx.web.map(h => `'${h.front.name}'`).join(', ')}`, digest }
  }

  // The release, the steps it left behind, the app's status and the event —
  // one call, because they are one fact and four writes that used to be able
  // to half-happen.
  async function failDeploy(id: string, startedAt: number, error: string, stepId?: string): Promise<string | undefined> {
    const out = await deployments.call('finishRun', id, {
      status: 'failed', error, stepId, startedAt: new Date(startedAt).toISOString(),
    }) as { status?: string }
    return out?.status
  }

  return { runDeployment }
}

// ── The job ───────────────────────────────────────────────────────
// maxAttempts 1: a deploy is not retried automatically. Half of one that
// failed has already happened on the machine, and the way back is a person
// looking at the steps and triggering another.

export default defineJob<{ deployment_id: string }>({
  name:        'deployment:run',
  queue:       'deployments',
  maxAttempts: 1,
  handler: async (ctx) => {
    // Somebody asked for this release. The queue recorded them and the workspace.
    const { app } = runsAsCaller(ctx, 'deployment:run')
    await runner(app).runDeployment(ctx.data.deployment_id)
  },
})
