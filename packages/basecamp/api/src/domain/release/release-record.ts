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

type Row = Record<string, any>

const sys = (app: App): any => (app.db as any).asSystem()

/** The whole row, announced. A client assigning an event payload over the
 *  record it renders loses every field a projection omits. */
export async function pushRow(app: App, id: string): Promise<Row | null> {
  const row = await sys(app).deployment.findUnique({ where: { id } })
  if (row) await announce(app, row.workspaceId, 'Deployment', 'deployments patched', row)
  return row
}

/** The release moved to `building`, with its steps and its App — or why it is not runnable. */
export async function startRelease(app: App, deploy: Row) {
  // Not runnable is not an error: a release already terminal has been
  // retried, cancelled or finished by another attempt.
  if (!['pending', 'building'].includes(deploy.status))
    return { runnable: false as const, status: deploy.status as string }

  const startedAt = new Date().toISOString()
  await sys(app).deployment.update({ where: { id: deploy.id }, data: { status: 'building', startedAt } })
  const steps  = await sys(app).deploymentStep.findMany({ where: { deploymentId: deploy.id }, orderBy: { position: 'asc' } })
  const target = await sys(app).app.findUnique({ where: { id: deploy.appId } })
  await pushRow(app, deploy.id)
  return { runnable: true as const, deploy, steps, app: target, startedAt }
}

/** One step's status. `digest` and `commit` are what the machine reported
 *  running; `containerPort` is what its Dockerfile said, for an App that
 *  stores none. */
export async function recordStep(app: App, deploy: Row, { stepId, status, output, digest, commit, containerPort }:
  { stepId: string, status: string, output?: string, digest?: string, commit?: string, containerPort?: number }) {
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
