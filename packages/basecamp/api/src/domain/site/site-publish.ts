// src/domain/site/site-publish.ts — a static site's live release, and an owner's
// Publish of a draft into it (`IDEAS/owner-editing.md` 1.4).
//
// **`releaseSite` is the one way a site goes live.** A developer's Deploy of a
// static `git` App (`deployment-run`'s Build and deploy) and an owner's Publish
// both send `/site/publish` to the App's placement, where Outpost builds and
// deploys in throwaway containers (`FJS-D1251`) with the workspace's
// Cloudflare account (`FJS-D1252`). The commit it answers is recorded on the
// release, and that commit is what the next publish measures from.
//
// **A publish refuses by name, on the release's own steps** — Validate,
// Merge, Build and deploy, Advance branch — so the refusal is in the record
// and on the deploy-failed notice the workspace gets:
//   - no release recorded: what is live is unknown (`FJS-D1339`);
//   - the site's branch has commits the last release did not ship, each
//     named with its author (`FJS-D1229`);
//   - the draft and the branch changed the same lines;
//   - the build or the upload failed, in the machine's words.
//
// **The branch moves last.** The merge commit is pushed to the draft and built
// from there; only a deploy that succeeded moves the site's branch to it, so a
// failed build leaves the branch where the last release left it and the next
// publish is not refused over the owner's own merge.
//
// The publish runs as the app: its publisher holds a grant on one site and
// need be a member of nothing (`FJS-D1230`), and `drafts.publish` read that
// grant before it queued the release.

import type { App } from '@frontierjs/junction'
import { cloudflareFor } from './site-preview.ts'
import { advanceBase, mergeDraft, unreleased, type Author, type GitSite } from './site-checkout.ts'
import { finishRelease, recordStep, startRelease } from '../release/release-record.ts'
import { notifyPeople, workspaceMembers } from '../notification/notify.ts'
import { isGit } from '../release/app-source.ts'
import { resolveExecutor, isExecutor, BUILD_TIMEOUT_MS } from '../../providers/executor.ts'

/** The steps of a publish, in order. */
export const PUBLISH_STEPS = ['Validate', 'Merge', 'Build and deploy', 'Advance branch']

/** What a publish's release carries in its snapshot beyond the source. */
export interface PublishSnapshot {
  source:    GitSite['source']
  draft:     string
  publisher: { userId: string } & Author
}

const sys = (app: App): any => (app.db as any).asSystem()

/**
 * `branch` at `commit` built and deployed as the live site. Throws in the
 * words that refused it; answers a note instead of a URL from the stub
 * executor, which issues nothing.
 */
export async function releaseSite(app: App, appId: string, workspaceId: string, source: GitSite['source'], branch: string, commit: string):
  Promise<{ commit: string, url: string | null, note?: string }> {
  const cloudflare = await cloudflareFor(app, workspaceId)
  if ('refused' in cloudflare) throw new Error(cloudflare.refused)
  const executor = await resolveExecutor(app, appId)
  if (!isExecutor(executor)) throw new Error(executor.reason)

  const reply = await executor.call('/site/publish', {
    app_id: appId, source: { kind: 'git', ...source }, branch, commit,
    cloudflare: { token: cloudflare.token, account_id: cloudflare.accountId },
  }, { timeoutMs: BUILD_TIMEOUT_MS })
  if (reply.error) throw new Error(reply.error.message)
  if (reply.data?.stubbed) return { commit, url: null, note: String(reply.data.note ?? 'stub executor — nothing was deployed') }
  return { commit: String(reply.data?.commit_sha ?? commit), url: reply.data?.url ? String(reply.data.url) : null }
}

/** The commit the App's last successful release shipped, or null when none recorded one. */
export async function releasedCommit(app: App, appId: string): Promise<string | null> {
  const row = await sys(app).deployment.findFirst({
    where:   { appId, status: 'success', commitSha: { not: null } },
    orderBy: { finishedAt: 'desc' },
    select:  { commitSha: true },
  })
  return row?.commitSha ?? null
}

/** Run the queued publish `deploymentId`, step by step, and tell the workspace and the publisher how it ended. */
export async function runPublish(app: App, deploymentId: string): Promise<{ status: string }> {
  const deploy = await sys(app).deployment.findUnique({ where: { id: deploymentId } })
  if (!deploy || deploy.trigger !== 'publish') return { status: 'missing' }
  const opened = await startRelease(app, deploy)
  if (!opened.runnable) return { status: opened.status }

  const snap  = deploy.configSnapshot as PublishSnapshot
  const site: GitSite = { id: deploy.appId, source: snap.source }
  const steps = new Map((opened.steps as { id: string, name: string }[]).map(s => [s.name, s.id]))
  const row   = opened.app as { name?: string, type?: string, source?: unknown, environmentId?: string } | null
  let current: string | undefined

  const run = async (name: string, fn: () => Promise<{ output: string, commit?: string }>) => {
    current = steps.get(name)
    if (!current) throw new Error(`the release has no ${name} step`)
    await recordStep(app, deploy, { stepId: current, status: 'running' })
    const done = await fn()
    await recordStep(app, deploy, { stepId: current, status: 'success', output: done.output, commit: done.commit })
  }

  try {
    if (!row || row.type !== 'static' || !isGit(row.source)) throw new Error('this App is no longer a static site built from git')
    let checked = ''
    await run('Validate', async () => {
      const released = await releasedCommit(app, deploy.appId)
      if (!released) throw new Error(`no release of this site is recorded, so what is live is unknown — a developer deploys it from basecamp first`)
      const { base, head, commits } = await unreleased(site, released)
      if (commits.length) throw new Error(`${base} has ${commits.length} commit${commits.length === 1 ? '' : 's'} the live site does not: `
        + commits.map(c => `${c.id.slice(0, 7)} by ${c.author} (${c.subject})`).join('; ')
        + ` — ${[...new Set(commits.map(c => c.author))].join(' and ')} deploys ${commits.length === 1 ? 'it' : 'them'} first`)
      checked = head
      return { output: `${base} is at ${head.slice(0, 7)}, the live release` }
    })

    let merged!: Awaited<ReturnType<typeof mergeDraft>>
    await run('Merge', async () => {
      merged = await mergeDraft(site, snap.draft, snap.publisher, `Publish ${snap.draft}`, checked)
      await sys(app).deployment.update({ where: { id: deploy.id }, data: { branch: merged.base } })
      return { output: `${merged.draft.branch} into ${merged.base} as ${merged.commit.slice(0, 7)}: ${merged.paths.join(', ')}`, commit: merged.commit }
    })

    await run('Build and deploy', async () => {
      const live = await releaseSite(app, deploy.appId, deploy.workspaceId, snap.source, merged.draft.branch, merged.commit)
      // The branch moves only past a deploy, and the stub deployed nothing.
      if (live.note) throw new Error(`${live.note}, so ${merged.base} stays where it was`)
      return { output: `live at ${live.url ?? 'the site\'s own domain'} (${live.commit.slice(0, 7)})`, commit: live.commit }
    })

    await run('Advance branch', async () => {
      const { draftKept } = await advanceBase(site, merged)
      return { output: `${merged.base} is at ${merged.commit.slice(0, 7)}; ${draftKept
        ? `${merged.draft.branch} is kept, since a save landed on it during the publish`
        : `${merged.draft.branch} is removed`}` }
    })
    current = undefined

    await finishRelease(app, deploy, { status: 'success', startedAt: opened.startedAt })
    await tell(app, 'DeploySuccess', deploy, row)
    return { status: 'success' }
  } catch (err) {
    const reason = (err as Error).message ?? 'unknown error'
    await finishRelease(app, deploy, { status: 'failed', error: reason, stepId: current, startedAt: opened.startedAt })
    const step = [...steps].find(([, id]) => id === current)?.[0]
    await tell(app, 'DeployFailed', deploy, row, { reason, step })
    return { status: 'failed' }
  }
}

/**
 * The workspace, which holds the developer a refusal names. Not the publisher,
 * who may be a member of nothing and whose notice would link a screen they
 * cannot open; /sites/ shows them the outcome.
 */
async function tell(app: App, kind: string, deploy: any, row: { name?: string, environmentId?: string } | null, extra: Record<string, unknown> = {}) {
  const env = row?.environmentId ? await sys(app).environment.findFirst({ where: { id: row.environmentId } }) : null
  await notifyPeople(app, kind, await workspaceMembers(app, deploy.workspaceId), {
    deploymentId: deploy.id, appName: row?.name ?? 'a site', environment: env?.name ?? 'an environment', ...extra,
  })
}
