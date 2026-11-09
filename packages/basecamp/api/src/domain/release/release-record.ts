// src/domain/release/release-record.ts — the writes that move a Deployment through its
// run: started, each step, finished. One owner for two callers.
//
// `deployments.startRun`/`stepStatus`/`finishRun` call these at the CALLER's
// standing, after `deployInScope` has confined the row to their workspace. A
// site publish (`domain/site/site-publish.ts`) calls them as the app: its publisher
// holds a grant on one site and need be a member of nothing (`FJS-D1230`),
// so there is no standing to read the row at, and the grant read by
// `drafts.publish` is what confined it. Either way the writes are system:
// `DeploymentStep` is update-at-SYSTEM, the schema saying a step's outcome is
// what the machine reported.

import type { App } from '@frontierjs/junction'
import { announce } from '../../core/channels.ts'
import { adoptContainerPort } from './runtime.ts'
import type { DeploySwap } from '#db/schema.d.ts'

/**
 * The step that replaces what is serving. A release that stopped at or before
 * it left the previous one answering, so the App's status stays what it was; a
 * release that fails after it has broken what is live (`FJS-1691`). A list
 * without one has no such moment, and any failure is the App's.
 */
export const SWAP_STEPS = new Set(['Start container', 'Activate', 'Build and deploy'])

/**
 * An API App's `site/`, published after its release (`IDEAS/site-hosting.md`
 * step 9). The one step whose failure leaves the release a success: the API
 * it follows is live, and the last site is still serving.
 */
export const SITE_STEP = 'Publish site'

/**
 * An API App's web/, built from the commit its image was and written onto
 * each static App in front of it BEFORE the swap, so a failed build fails
 * the release with the old API still serving; released as each static App's
 * own Deployment after the health check (`FJS-D1979`, `FJS-D1980`). A failure
 * of the second leaves the release a success, as `SITE_STEP`'s does.
 */
export const WEB_BUILD_STEP   = 'Build web'
export const WEB_RELEASE_STEP = 'Release web'

type Row = Record<string, any>

const sys = (app: App): any => (app.db as any).asSystem()

/** The whole row, announced. A client assigning an event payload over the
 *  record it renders loses every field a projection omits. */
export async function pushRow(app: App, id: string): Promise<Row | null> {
  const row = await sys(app).deployment.findUnique({ where: { id } })
  if (row) await announce(app, row.workspaceId, 'Deployment', 'deployments patched', row)
  return row
}

export const INTERRUPTED = 'interrupted — Basecamp restarted mid-release'

/** The release of those named that began replacing what serves, if one did. */
async function swapBegun(app: App, ids: string[]): Promise<string | null> {
  if (!ids.length) return null
  const steps = await sys(app).deploymentStep.findMany({
    where: { deploymentId: { in: ids }, name: { in: [...SWAP_STEPS] } } }) as Row[]
  return steps.find(s => s.startedAt != null)?.deploymentId ?? null
}

// `/deploy` runs to its end with its caller gone, so the screen must not read
// as though a release stopped here left the last one serving.
async function unanswered(app: App, id: string, error: string): Promise<string> {
  return await swapBegun(app, [id]) ? `${error}. The machine may have finished it, so this release may be what is serving` : error
}

/**
 * A release since `live` that began replacing what serves and did not succeed.
 * It may be what is serving, so starting `live` again may put older bytes over
 * it (`FJS-4129`). A failure the machine answered reads the same here: the row
 * cannot tell them apart, and a wrong guess restarts the app on the wrong bytes.
 */
export async function swapBegunSince(app: App, live: Row): Promise<string | null> {
  const since = await sys(app).deployment.findMany({
    where:  { appId: live.appId, status: { in: ['failed', 'cancelled'] }, finishedAt: { gt: live.finishedAt } },
    select: { id: true } }) as { id: string }[]
  return swapBegun(app, since.map(d => d.id))
}

/** The release moved to `building`, with its steps and its App — or why it is not runnable. */
export async function startRelease(app: App, deploy: Row) {
  // A row already `building` is a run that died: caravan reclaims a job whose
  // worker stopped and replays it, and a second run of half a release on the
  // machine is not a retry (`FJS-3850`). It is failed rather than resumed.
  if (deploy.status === 'building') {
    await finishRelease(app, deploy, { status: 'failed', error: await unanswered(app, deploy.id, INTERRUPTED), stepId: await runningStep(app, deploy.id) })
    return { runnable: false as const, status: 'failed', interrupted: true }
  }
  // Not runnable is not an error: a release already terminal has been
  // retried, cancelled or finished by another attempt.
  if (deploy.status !== 'pending')
    return { runnable: false as const, status: deploy.status as string }

  // A compare-and-swap from `pending`, the model's `build` move: two runs of
  // one release that both read `pending` start it once, and a cancel that
  // landed since the read wins.
  const startedAt = new Date().toISOString()
  const moved = await sys(app).deployment.update({ where: { id: deploy.id, status: 'pending' }, data: { status: 'building', startedAt } })
    .catch(() => null)
  if (!moved) {
    const now = await sys(app).deployment.findFirst({ where: { id: deploy.id }, select: { status: true } })
    return { runnable: false as const, status: (now?.status ?? 'gone') as string }
  }
  const steps  = await sys(app).deploymentStep.findMany({ where: { deploymentId: deploy.id }, orderBy: { position: 'asc' } })
  const target = await sys(app).app.findUnique({ where: { id: deploy.appId } })
  await pushRow(app, deploy.id)
  return { runnable: true as const, deploy, steps, app: target, startedAt }
}

async function runningStep(app: App, deploymentId: string): Promise<string | undefined> {
  const step = await sys(app).deploymentStep.findFirst({ where: { deploymentId, status: 'running' }, select: { id: true } })
  return step?.id
}

/** The release's status as it stands, read past the caller's own copy of the row. */
export async function releaseStatus(app: App, id: string): Promise<string | null> {
  const row = await sys(app).deployment.findFirst({ where: { id }, select: { status: true } })
  return row?.status ?? null
}

/** The App's release that is queued or building, if it has one. */
export async function inFlightRelease(app: App, appId: string): Promise<{ id: string, status: string } | null> {
  return await sys(app).deployment.findFirst({
    where: { appId, status: { in: ['pending', 'building'] } }, select: { id: true, status: true } })
}

/**
 * The longest a release can legitimately run: each long Outpost command's own
 * bound end to end, and a margin for the short steps between them. A release
 * `pending` or `building` past it with no live job behind it has nothing that
 * will ever finish it.
 */
export const RELEASE_BOUND_MS = 15 * 60_000 + 30_000 + 30 * 60_000 + 30_000 + 32 * 60_000 + 15 * 60_000

/**
 * Fail every release stuck `pending` or `building` that caravan holds no live
 * job for (`FJS-3861`): a job given up on, a dispatch that never landed, a
 * queue file lost with a restore. Without this the row reads as in flight
 * forever, and `create` refuses every release of the App behind it.
 */
export async function sweepStuckReleases(app: App, now = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - RELEASE_BOUND_MS).toISOString()
  const stuck = await sys(app).deployment.findMany({
    where: { status: { in: ['pending', 'building'] }, queuedAt: { lt: cutoff } } }) as Row[]
  if (!stuck.length) return []

  const jobs = (app as any).jobs
  const live = new Set<string>()
  for (const status of ['pending', 'running'])
    for (const job of jobs.list({ queue: 'deployments', status, limit: 10_000 }) as { data: string }[]) {
      try { live.add(JSON.parse(job.data).deployment_id) } catch { /* not a release's job */ }
    }

  const failed: string[] = []
  for (const row of stuck) {
    if (live.has(row.id)) continue
    await finishRelease(app, row, {
      status: 'failed', stepId: await runningStep(app, row.id),
      error: await unanswered(app, row.id, 'No job was left running this release, so it was failed — start another'),
    })
    failed.push(row.id)
  }
  return failed
}

/** One step's status. `digest`, `commit` and `swap` are what the machine
 *  reported running; `containerPort` is what its Dockerfile said, for an App
 *  that stores none. */
export async function recordStep(app: App, deploy: Row, { stepId, status, output, digest, commit, containerPort, swap, swapReason }:
  { stepId: string, status: string, output?: string, digest?: string, commit?: string, containerPort?: number,
    swap?: DeploySwap, swapReason?: string | null }) {
  // Addressed by the deployment as well as the step, so a step id from
  // another release cannot be moved through here.
  await sys(app).deploymentStep.updateMany({
    where: { id: stepId, deploymentId: deploy.id },
    data:  {
      status,
      ...(output !== undefined ? { output } : {}),
      ...(status === 'running'
        ? { startedAt: new Date().toISOString(), finishedAt: null }
        : { finishedAt: new Date().toISOString() }),
    },
  })

  // A later step's digest wins: /deploy names the bytes that were started
  // where /pull names the bytes that were fetched, and a release records
  // what RAN. A site release's bytes are named by the commit it built.
  const ran: Row = {}
  if (digest && digest !== deploy.builtImage) ran.builtImage = digest
  if (commit && commit !== deploy.commitSha)  ran.commitSha  = commit
  if (swap) Object.assign(ran, { swap, swapReason: swapReason ?? null })
  if (Object.keys(ran).length) await sys(app).deployment.update({ where: { id: deploy.id }, data: ran })
  // On the App, never the snapshot, which is @immutable: a rollback to this
  // release reads the App's for a snapshot that holds none (`runtimeFor`).
  if (containerPort != null) await adoptContainerPort(app.db, deploy.appId, containerPort)

  await pushRow(app, deploy.id)
  return { stepId, status }
}

/** The release finished: its row, the steps it left behind, the App's status and the event. */
export async function finishRelease(app: App, deploy: Row, { status, error, startedAt, stepId }:
  { status: 'success' | 'failed', error?: string, startedAt?: string, stepId?: string }) {
  // A release cancelled while its build was in flight stays cancelled: no
  // move leaves `cancelled`, for the system client either (`FJS-D502`), and
  // a late answer from the runner must not put the app back to running.
  const now = await sys(app).deployment.findFirst({ where: { id: deploy.id }, select: { status: true } })
  if (now?.status === 'cancelled') {
    await pushRow(app, deploy.id)
    return { id: deploy.id, status: 'cancelled' }
  }

  const finishedAt = Date.now()
  const startedMs  = startedAt ? Date.parse(startedAt)
                   : deploy.startedAt ? Date.parse(String(deploy.startedAt))
                   : finishedAt

  await sys(app).deployment.update({
    where: { id: deploy.id },
    data:  { status, finishedAt: new Date(finishedAt).toISOString(), durationMs: finishedAt - startedMs },
  })

  // The reason goes on the step the release stopped at — the release row
  // has no column for it, and the step's output is what the screen shows.
  if (status === 'failed' && stepId && error)
    await sys(app).deploymentStep.updateMany({
      where: { id: stepId, deploymentId: deploy.id },
      data:  { status: 'failed', output: error, finishedAt: new Date(finishedAt).toISOString() },
    })

  // A step still running died with the release. One still pending never ran,
  // and marking it `failed` read as though the health check had failed
  // when the release stopped two steps earlier (`FJS-1683`).
  if (status === 'failed') {
    await sys(app).deploymentStep.updateMany({ where: { deploymentId: deploy.id, status: 'running' }, data: { status: 'failed' } })
    await sys(app).deploymentStep.updateMany({ where: { deploymentId: deploy.id, status: 'pending' }, data: { status: 'skipped' } })
  }

  // Read after the step writes above, so a swap step the release died on
  // reads `failed` rather than `running`.
  const swap = status === 'failed'
    ? (await sys(app).deploymentStep.findMany({ where: { deploymentId: deploy.id } }))
        .find((s: { name: string }) => SWAP_STEPS.has(s.name))
    : undefined
  const replaced = !swap || swap.status === 'success'

  if (deploy.appId && replaced)
    await sys(app).app.update({ where: { id: deploy.appId }, data: { status: status === 'success' ? 'running' : 'error' } })

  await pushRow(app, deploy.id)
  return { id: deploy.id, status }
}
