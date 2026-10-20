// src/core/site-preview.ts — a draft's review link: the branch built with
// `--preview` and uploaded as a version of the site's Worker, aliased by the
// draft's name (`IDEAS/owner-editing.md` 1.3, `FJS-D1221`, `FJS-D1222`).
//
// **Nothing here builds.** A build runs the repository's own code, so it runs
// on the machine the App is placed on, in Outpost's throwaway containers
// (`FJS-D1251`); this file decides what to send and records what came back.
//
// **The credential is the workspace's Cloudflare account** (`FJS-D1252`): the
// one its ingress zone names, or the only one it holds, with the account id
// read off that zone, because wrangler uploads under `/accounts/<id>/` and is
// handed the id rather than left to guess it. The token travels in the command body to the machine
// and nowhere else; it is never stored on the status.
//
// **A preview's state is a file beside the clone**, `<SITES_DIR>/<appId>.previews.json`,
// as a workbench run's is under WORKBENCH_DIR: what was last built, its link,
// and why the last attempt failed. Losing it loses only the link, which the
// next save makes again; the branch is the draft and the Worker holds the bytes.
//
// **A save during a build is not lost.** The job's `unique` key makes a second
// dispatch a no-op while one runs, so the run builds the draft's head, then
// reads the head again and goes round once more if a save moved it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftBranch, listDrafts, sitesDir, type GitSite } from './site-checkout.ts'
import { createSecretResolver } from './credentials.ts'
import { resolveExecutor, isExecutor, BUILD_TIMEOUT_MS } from '../providers/executor.ts'
import { edgeConnectorFor } from '../providers/edge/index.ts'
import { targetFor } from '../providers/compute/index.ts'
import { sendVia, tokenRef } from '../providers/compute/accounts.ts'
import { isGit } from './app-source.ts'
import type { App } from '@frontierjs/junction'

export interface PreviewStatus {
  /** `queued` and `building` name the commit on its way; `ready` and `failed` the last one tried. */
  state:  'queued' | 'building' | 'ready' | 'failed'
  commit: string
  at:     string
  /** The aliased link, from the last build that uploaded — kept while the next one builds. */
  url:    string | null
  /** The commit `url` shows. */
  built:  string | null
  error:  string | null
}

// The same draft built twice round, at most, before the next save's own
// dispatch takes over: a draft saved faster than it builds is not a loop.
const ROUNDS = 3

const fileOf = (appId: string, root: string) => join(root, `${appId}.previews.json`)

export function previewStatuses(appId: string, root = sitesDir()): Record<string, PreviewStatus> {
  const file = fileOf(appId, root)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** One draft's status changed, the rest kept. Written whole and renamed, so a reader never sees half. */
export function markPreview(appId: string, draft: string, patch: Partial<PreviewStatus> & { state: PreviewStatus['state'] },
  root = sitesDir()): PreviewStatus {
  const all  = previewStatuses(appId, root)
  const prev = all[draft]
  const next: PreviewStatus = {
    commit: prev?.commit ?? '', url: prev?.url ?? null, built: prev?.built ?? null,
    ...patch, at: new Date().toISOString(), error: patch.error ?? null,
  }
  all[draft] = next
  mkdirSync(root, { recursive: true })
  const file = fileOf(appId, root)
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2))
  renameSync(`${file}.tmp`, file)
  return next
}

/** Why a preview cannot be uploaded for this workspace, or the token and account to upload with. */
export async function cloudflareFor(app: App, workspaceId: string):
  Promise<{ token: string, accountId: string } | { refused: string }> {
  const sys = (app.db as any).asSystem()
  const ws  = await sys.workspace.findFirst({
    where: { id: workspaceId }, select: { ingressAccountId: true, ingressZoneId: true },
  }) as { ingressAccountId: string | null, ingressZoneId: string | null } | null
  const accounts = await sys.secret.findMany({
    where: { workspaceId, kind: 'provider_key', providerKind: 'cloudflare' }, select: { id: true, name: true },
  }) as { id: string, name: string }[]

  const chosen = accounts.find(a => a.id === ws?.ingressAccountId) ?? (accounts.length === 1 ? accounts[0] : null)
  if (!chosen) return {
    refused: accounts.length
      ? `this workspace holds ${accounts.length} Cloudflare accounts and its ingress zone names none of them — set the ingress zone on /dns/`
      : 'this workspace holds no Cloudflare account — connect one on /secrets/ to upload its sites',
  }

  const connector = edgeConnectorFor('cloudflare')!
  const send = sendVia(app, targetFor('cloudflare', chosen.id))
  let accountId: string | null
  try {
    const zone = ws?.ingressAccountId === chosen.id && ws.ingressZoneId
      ? await connector.zone(send, ws.ingressZoneId)
      : (await connector.zones(send))[0]
    accountId = zone?.account ?? null
  } catch (err) {
    return { refused: `Cloudflare refused account ${chosen.name}: ${(err as Error).message}` }
  }
  if (!accountId) return { refused: `account ${chosen.name} opens no zone, so its account id is unknown` }

  const token = await createSecretResolver(app.db as any).get(tokenRef(chosen.id))
  if (typeof token !== 'string' || !token) return { refused: `account ${chosen.name} holds no token` }
  return { token, accountId }
}

/**
 * Build the draft's head as a preview, and again while a save moves it — after
 * a failure too, since the save may be the fix. Every failure is written to the
 * status in the words that refused it; none throws, because a retry of the
 * same commit would only repeat it.
 */
export async function buildDraftPreview(app: App, appId: string, draft: string, root = sitesDir()): Promise<PreviewStatus | null> {
  const named = draftBranch(draft)
  if ('refused' in named) return null
  const row = await (app.db as any).asSystem().app.findFirst({ where: { id: appId } })
  if (!row || row.type !== 'static' || !isGit(row.source)) return null
  const site: GitSite = { id: row.id, source: row.source }

  let tried: string | null = null
  let status: PreviewStatus | null = null
  for (let round = 0; round < ROUNDS; round++) {
    const head = (await listDrafts(site, root).catch(() => [])).find(d => d.branch === named.branch)?.head
    if (!head || head === tried) return status
    tried = head
    markPreview(appId, named.slug, { state: 'building', commit: head }, root)
    const outcome = await buildOnce(app, appId, row.workspaceId, site, named, head)
    status = 'error' in outcome
      ? markPreview(appId, named.slug, { state: 'failed', commit: head, error: outcome.error }, root)
      : markPreview(appId, named.slug, { state: 'ready', commit: outcome.commit, built: outcome.commit, url: outcome.url }, root)
    if (!('error' in outcome)) tried = outcome.commit
  }
  return status
}

/** One build of `head`, as the link it made or the words that refused it. */
async function buildOnce(app: App, appId: string, workspaceId: string, site: GitSite, named: { branch: string, slug: string }, head: string):
  Promise<{ commit: string, url: string } | { error: string }> {
  const cloudflare = await cloudflareFor(app, workspaceId)
  if ('refused' in cloudflare) return { error: cloudflare.refused }
  const executor = await resolveExecutor(app, appId)
  if (!isExecutor(executor)) return { error: executor.reason }

  const reply = await executor.call('/site/preview', {
    app_id: appId, source: site.source, branch: named.branch, alias: named.slug,
    cloudflare: { token: cloudflare.token, account_id: cloudflare.accountId },
  }, { timeoutMs: BUILD_TIMEOUT_MS })
  if (reply.error) return { error: reply.error.message }
  if (reply.data?.stubbed) return { error: String(reply.data.note ?? 'stub executor — nothing was built') }
  return { commit: String(reply.data?.commit_sha ?? head), url: String(reply.data?.url) }
}
