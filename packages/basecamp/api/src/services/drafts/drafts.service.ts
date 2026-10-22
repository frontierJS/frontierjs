// src/services/drafts/drafts.service.ts
// An owner's drafts of a static site, which /sites/ reads and writes
// (`IDEAS/owner-editing.md` 1.2, `FJS-D1227`).
//
// **Takes no workspace.** An editor holds a grant on one site and need be a
// member of nothing (`FJS-D1230`). Every method names an App, and the caller's
// own `AppEditor` row for it is the authority: read on the caller's client,
// where the row policy admits only their own. The App is then read through
// asSystem(), since a holder with no membership has no claim to scope it by;
// the grant read before it is what confines that read.
//
//   GET  /drafts  sites  the sites the caller may edit, with their role
//   GET  /drafts  list   { appId } — the site's open drafts, newest first
//   POST /drafts  open   { appId, name } — a draft branched from the site's branch
//   GET  /drafts  files  { appId, draft } — the markdown an owner may edit on it
//   GET  /drafts  read   { appId, draft, path } — one file as a form, with the blob a save names
//   POST /drafts  save   { appId, draft, path, blob, body?, values?, message? } — one commit, pushed
//   POST /drafts  save   { appId, draft, path, text: { line, old, next } } — the words clicked on the preview, swapped
//   POST /drafts  arrange { appId, draft, path, blob, act, line? } — a list entry on that line, or the
//                         collection item `path` is, moved earlier or later, copied or removed
//   POST /drafts  photo  { appId, draft, path, blob, key, alt, photo? } — a front-matter photo's words, and with
//                         `photo` (a file) a new photo beside the old one, one commit
//   POST /drafts  preview { appId, draft } — build its preview again
//   POST /drafts  ask     { appId, draft, request } — a model's edit of the draft's content, run as a job
//   GET  /drafts  asked   { appId, draft } — the draft's last ask, and while it waits, the lines it changes
//   POST /drafts  keep    { appId, draft } — that ask's changes as one commit on the draft
//   POST /drafts  discard { appId, draft } — that ask's changes dropped
//   POST /drafts  undo    { appId, draft } — the kept ask's commit reverted on the draft
//   POST /drafts  publish { appId, draft } — merge, build, deploy (the `publish` grant)
//   GET  /drafts  history { appId } — the site's live releases, newest first, each with what it shipped
//   POST /drafts  revert  { appId, release } — a draft undoing one publish
//   POST /drafts  handoff { appId, returnTo, challenge } — a one-time code for the site's preview
//   POST /drafts  redeem  { appId, code, verifier } — that code, for a key reaching only drafts
//
// Opening a draft and every save that changes a file queue its preview
// (`core/site-preview.ts`), and `list` answers each draft's last one, and
// its last ask (`core/site-ask.ts`): a model's run over a copy of the draft's
// content, which leaves a tree and commits nothing until the owner keeps it.
//
// Publish writes a `Deployment` through asSystem() — the publisher may be a
// member of nothing, so the release is the app's, confined by the grant read
// here — and `core/site-publish.ts` runs it. Every refusal past the grant is
// a failed step on that release, so `list` answers the site's last publish.
//
// What an owner may write is site-kit's rule (`FJS-D1226`), asked here by
// path and again of the file the edit produces.
//
// A text edit carries no blob: the preview was built from some earlier head,
// and the old words found in the block its stamp names are the check that the
// edit still means what the owner saw (`@frontierjs/toolbelt/textedit`). A
// stamp inside the front matter names a value a block drew (`FJS-D1231`), and
// is site-kit's `field` edit of the value written on that line.
//
// Arrange is the lists (`FJS-D1403`–`FJS-D1405`): with a `line`, the entry of
// a front-matter list written there (a menu's link); without one, the file
// itself as an item of its collection, whose reorder writes `order:` on each
// item it moves, all in one commit.
//
// A photo is a front-matter value naming one of the site's raster photos
// (`FJS-D1407`), its words the path's `?text=` (`FJS-D1406`). An upload is
// re-encoded here (`core/site-photo.ts`, `FJS-D1408`) and lands in the folder
// of the photo it replaces, named for the upload; the old file stays, since
// another page or a template may still name it.
//
// **A preview signs in through a handoff** (`FJS-D1357`). Its Edit button
// sends the person to /sites/<id>/edit/, which calls `handoff` with the
// preview's address and a PKCE challenge; the address must be one this site's
// previews were recorded at, or a code would go to whoever asked. `redeem` is
// the preview's POST of code and verifier, from that same origin, and answers
// an API key scoped to `drafts` that lapses in hours. Each method still reads
// the grant, so a key outliving its grant reaches nothing.
//
// History is derived: the App's successful releases, and git's diff between
// each and the one before it. Revert takes the `edit` grant, since it only
// opens a draft and Publish is still the publish grant's; it undoes an owner's
// publish and never a developer's deploy, whose files are the developer's.

import { createService, BadRequest, Conflict, Forbidden, NotFound, Unauthorized, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { ACTS, applyEdit, applyPhoto, arrangeCollection, collectionOf, formOf, pathRefusal, photoName } from '@frontierjs/site-kit/editable'
import { byOrder } from '@frontierjs/site-kit/collection'
import { parseFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { locateText } from '@frontierjs/toolbelt/textedit'
import { db } from '../../core/resource.ts'
import { isGit } from '../../core/app-source.ts'
import {
  CheckoutError, StaleDraft, commitTree, diffTree, draftFiles, listDrafts, openDraft, readDraftFile, readDraftFolder,
  revertDraft, revertOnDraft, saveDraftFile, saveDraftFiles, shipped, type Author, type FileChange, type GitSite,
} from '../../core/site-checkout.ts'
import { PhotoRefused, reencodePhoto } from '../../core/site-photo.ts'
import { isSitePreviewOrigin, markPreview, previewStatuses } from '../../core/site-preview.ts'
import { dispatchPreview } from '../../jobs/site-preview.job.ts'
import { dispatchAsk } from '../../jobs/site-ask.job.ts'
import { ASK_MAX_REQUEST, NO_KEY, askBusy, askStatuses, dropAsk, markAsk, queueAsk, type AskStatus } from '../../core/site-ask.ts'
import { env } from '../../core/env.ts'
import { dispatchPublish } from '../../jobs/site-publish.job.ts'
import { PUBLISH_STEPS, type PublishSnapshot } from '../../core/site-publish.ts'
import { keyScope } from '../api-keys/scopes.ts'
import { maskToken } from '../api-keys/api-keys.service.ts'

const sys = (): any => $.db.asSystem()
const me  = (): string | undefined => ($.me as { id?: string } | null | undefined)?.id

const ARGS = ['appId', 'draft', 'path'] as const

/** Releases `history` answers — a site's recent past, which is what an owner undoes. */
const HISTORY = 20

/** How long a preview's key works: a sitting, not a standing credential. */
const EDIT_KEY_MS = 8 * 60 * 60 * 1000

const EDIT_SCOPES = Object.values(keyScope('drafts'))

type Handoffs = Required<Pick<import('@frontierjs/junction').IAuth, 'issueHandoff' | 'redeemHandoff' | 'createApiKey'>>

function handoffs(): Handoffs {
  const auth = $.app.auth
  if (typeof auth?.issueHandoff !== 'function' || typeof auth.redeemHandoff !== 'function')
    throw new BadRequest('the configured auth provider has no handoff, so a preview cannot sign in')
  return auth as unknown as Handoffs
}

const SPENT = 'That sign-in has been used or has run out — press Edit on the preview again'

/** A named argument, off the body or, on a GET, the query. */
function arg(name: string): string {
  const v = (($.data ?? {}) as Record<string, unknown>)[name] ?? ($.reserved as Record<string, unknown>)[name]
  if (typeof v !== 'string' || !v) throw new BadRequest(`${name} is required`)
  return v
}

function signedIn(): void {
  // The preview's redemption is how it gets a session at all.
  if ($.method === 'redeem') return
  if (!me()) throw new Unauthorized('Sign in to edit a site')
}

/** The site the caller holds a grant on, or a 404 that says nothing about one they do not. */
async function grantedSite(): Promise<GitSite & { role: string }> {
  const appId = arg('appId')
  const grant = await db().appEditor.findFirst({ where: { appId, userId: me() } })
  const app   = grant && await sys().app.findFirst({ where: { id: appId } })
  if (!app || app.type !== 'static' || !isGit(app.source)) throw new NotFound(`No site '${appId}' you may edit`)
  return { id: app.id, source: app.source, role: grant.role }
}

/** A refusal from git or from the draft, as the status a screen can act on. */
async function checkout<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof StaleDraft)    throw new Conflict(err.message)
    if (err instanceof CheckoutError) throw new BadRequest(err.message)
    throw err
  }
}

/** Queue the draft's preview, and say so unless a build is already on it. */
async function queuePreview(appId: string, draft: string, head: string): Promise<void> {
  await dispatchPreview($.app, appId, draft)
  if (previewStatuses(appId)[draft]?.state !== 'building') markPreview(appId, draft, { state: 'queued', commit: head })
}

/** The site's last publish, as /sites/ shows it: its state, the draft, and each step's words. */
async function lastPublish(appId: string) {
  const row = await sys().deployment.findFirst({ where: { appId, trigger: 'publish' }, orderBy: { queuedAt: 'desc' } })
  if (!row) return null
  const steps = await sys().deploymentStep.findMany({ where: { deploymentId: row.id }, orderBy: { position: 'asc' } })
  return {
    id: row.id, status: row.status, draft: (row.configSnapshot as PublishSnapshot).draft, commit: row.commitSha,
    author: row.author, at: row.finishedAt ?? row.startedAt ?? row.queuedAt,
    steps: steps.map((s: { name: string, status: string, output: string | null }) => ({ name: s.name, status: s.status, output: s.output })),
  }
}

/** The caller as a commit names them. */
async function author(): Promise<Author> {
  const user = await sys().user.findFirst({ where: { id: me() } })
  return { name: user?.name || user?.email, email: user?.email }
}

const ASK_STATE: Record<AskStatus['state'], string> = {
  queued: 'is still running', running: 'is still running', ready: 'is waiting to be kept or discarded',
  failed: 'kept nothing', kept: 'is kept', undone: 'was kept and undone',
}

/** The draft's last ask, in one of `states`, or a refusal saying what it is instead. */
function askIn(appId: string, states: AskStatus['state'][]): { draft: string, ask: AskStatus } {
  const draft = arg('draft')
  const ask = askStatuses(appId)[draft]
  if (!ask) throw new NotFound(`there is no ask on ${draft}`)
  if (!states.includes(ask.state)) throw new Conflict(`the ask on ${draft} ${ASK_STATE[ask.state]}`)
  return { draft, ask }
}

/** A kept ask's commit message: the owner's words, the first line as its subject. */
function askMessage(request: string): string {
  const first = request.split('\n')[0].trim()
  const subject = `Asked: ${first.length > 60 ? first.slice(0, 59) + '…' : first}`
  return subject.slice(7) === request ? subject : `${subject}\n\n${request}`
}

/** A save's `text`, the words a click on the preview changed, or null when the save is a form's. */
function textEdit(data: { body?: unknown, values?: unknown, text?: unknown }): { line: number, old: string, next: string } | null {
  if (data.text === undefined) return null
  const t = data.text as { line?: unknown, old?: unknown, next?: unknown } | null
  if (typeof t !== 'object' || t === null || !Number.isInteger(t.line) || typeof t.old !== 'string' || typeof t.next !== 'string')
    throw new BadRequest('text is { line, old, next } — the stamp\'s line, the words the page showed, and the new words')
  if (data.body !== undefined || data.values !== undefined) throw new BadRequest('a save is a text edit or a form, not both')
  return { line: t.line as number, old: t.old, next: t.next }
}

function editablePath(): string {
  const path = arg('path')
  const refused = pathRefusal(path) ?? (path.endsWith('.md') ? null : `${path} is a photo, which changes through the page that shows it`)
  if (refused) throw new BadRequest(refused)
  return path
}

export default createService({
  name:  'drafts',
  scope: keyScope('drafts'),
  reservedQuery: [...ARGS],
  // VISITOR, the standing of a signed-in person in no workspace: the grant
  // each method reads is what refuses, and a level cannot say which site.
  methods: [
    { method: 'sites', read: true, gate: LEVELS.VISITOR },
    { method: 'list',  read: true, gate: LEVELS.VISITOR },
    { method: 'files', read: true, gate: LEVELS.VISITOR },
    { method: 'read',  read: true, gate: LEVELS.VISITOR },
    { method: 'open',  gate: LEVELS.VISITOR },
    { method: 'save',  gate: LEVELS.VISITOR },
    { method: 'arrange', gate: LEVELS.VISITOR },
    { method: 'photo',   gate: LEVELS.VISITOR },
    { method: 'preview', gate: LEVELS.VISITOR },
    { method: 'ask',     gate: LEVELS.VISITOR },
    { method: 'asked',   read: true, gate: LEVELS.VISITOR },
    { method: 'keep',    gate: LEVELS.VISITOR },
    { method: 'discard', gate: LEVELS.VISITOR },
    { method: 'undo',    gate: LEVELS.VISITOR },
    { method: 'publish', gate: LEVELS.VISITOR },
    { method: 'history', read: true, gate: LEVELS.VISITOR },
    { method: 'revert',  gate: LEVELS.VISITOR },
    { method: 'handoff', gate: LEVELS.VISITOR },
    { method: 'redeem',  gate: LEVELS.STRANGER },
  ],

  async sites() {
    const grants = await db().appEditor.findMany({ where: { userId: me() } })
    if (!grants.length) return { sites: [] }
    const role = new Map(grants.map((g: { appId: string, role: string }) => [g.appId, g.role]))
    const apps = await sys().app.findMany({ where: { id: [...role.keys()] }, orderBy: { name: 'asc' } })
    return {
      sites: apps
        .filter((a: { type: string, source: unknown }) => a.type === 'static' && isGit(a.source))
        .map((a: { id: string, name: string, slug: string, source: GitSite['source'] }) => ({
          id: a.id, name: a.name, slug: a.slug, repo: a.source.repo, role: role.get(a.id),
        })),
    }
  },

  async list() {
    const site = await grantedSite()
    const previews = previewStatuses(site.id)
    const asks     = askStatuses(site.id)
    const drafts = await checkout(() => listDrafts(site))
    return {
      drafts: drafts.map(d => ({ ...d, preview: previews[d.name] ?? null, ask: asks[d.name] ?? null })),
      published: await lastPublish(site.id),
    }
  },

  async publish() {
    const site  = await grantedSite()
    if (site.role !== 'publish') throw new Forbidden('Publishing this site takes the publish grant — ask whoever runs it to publish, or to grant it')
    const draft = arg('draft')
    const found = (await checkout(() => listDrafts(site))).find(d => d.name === draft)
    if (!found) throw new NotFound(`no draft named ${draft} — it may have been published or deleted`)

    const app = await sys().app.findFirst({ where: { id: site.id } })
    const running = await sys().deployment.findFirst({ where: { appId: site.id, status: { in: ['pending', 'building'] } } })
    if (running) throw new Conflict(`a release of this site is already ${running.status} — publish once it finishes`)
    const previous = await sys().deployment.findFirst({ where: { appId: site.id, status: 'success' }, orderBy: { finishedAt: 'desc' } })

    const user = await sys().user.findFirst({ where: { id: me() } })
    const publisher = { userId: me()!, name: user?.name || user?.email, email: user?.email }
    const snapshot: PublishSnapshot = { source: site.source, draft: found.name, publisher }
    const release = await sys().deployment.create({ data: {
      workspaceId: app.workspaceId, appId: site.id, environmentId: app.environmentId,
      trigger: 'publish', branch: site.source.branch ?? null, commitMessage: `Publish ${found.name}`,
      author: publisher.name, triggeredBy: publisher.userId, previousDeploymentId: previous?.id ?? null,
      configSnapshot: snapshot,
    } })
    await sys().deploymentStep.createMany({
      data: PUBLISH_STEPS.map((name, position) => ({ deploymentId: release.id, position, name, status: 'pending' })),
    })
    await dispatchPublish($.app, site.id, release.id)
    return { draft: found.name, published: await lastPublish(site.id) }
  },

  async history() {
    const site = await grantedSite()
    const rows = await sys().deployment.findMany({
      where: { appId: site.id, status: 'success', commitSha: { not: null } }, orderBy: { finishedAt: 'desc' }, limit: HISTORY + 1,
    })
    const ranges = rows.slice(0, HISTORY).map((r: { commitSha: string }, i: number) => ({ from: rows[i + 1]?.commitSha ?? null, to: r.commitSha }))
    const changes = await checkout(() => shipped(site, ranges))
    return {
      releases: rows.slice(0, HISTORY).map((r: any, i: number) => ({
        id: r.id, trigger: r.trigger, draft: r.trigger === 'publish' ? (r.configSnapshot as PublishSnapshot).draft : null,
        by: r.author, at: r.finishedAt, commit: r.commitSha, ...changes[i], revertable: r.trigger === 'publish',
      })),
    }
  },

  async revert() {
    const site = await grantedSite()
    const id   = arg('release')
    const row  = await sys().deployment.findFirst({ where: { id, appId: site.id } })
    if (!row || row.status !== 'success' || !row.commitSha) throw new NotFound(`no release '${id}' of this site went live`)
    if (row.trigger !== 'publish') throw new BadRequest('that release was a developer\'s deploy, and its files are theirs — Revert undoes a publish')
    const draft = (row.configSnapshot as PublishSnapshot).draft
    const by    = await author()
    const opened = await checkout(() => revertDraft(site, row.commitSha, `revert ${draft}`, by, `Revert ${draft}`, pathRefusal))
    await queuePreview(site.id, opened.name, opened.head)
    return opened
  },

  async handoff() {
    // A key that could hand itself on would renew itself for as long as it was
    // used, and a support episode or an agent would mint past its own end.
    const user = $.user as { authMethod?: string, support?: unknown } | null
    if (user?.authMethod === 'apiKey') throw new Forbidden('A preview signs in from basecamp itself, not with a key')
    if (user?.support || $.transport === 'mcp') throw new Forbidden('A preview signs in as the person at the screen, not for somebody else')
    const site = await grantedSite()
    let back: URL
    try { back = new URL(arg('returnTo')) } catch { throw new BadRequest('returnTo is not an address') }
    if (!isSitePreviewOrigin(site.id, back.origin))
      throw new BadRequest(`${back.origin} is not a preview of this site — open Edit from the draft's own preview link`)
    const { code } = await handoffs().issueHandoff(me()!, { challenge: arg('challenge'), audience: back.origin, scopes: EDIT_SCOPES })
      .catch((err: Error) => { throw new BadRequest(err.message) })
    back.hash = `fjs-edit=${encodeURIComponent(code)}`
    return { redirect: back.toString() }
  },

  async redeem() {
    const appId = arg('appId')
    const held  = await handoffs().redeemHandoff(arg('code'), arg('verifier'))
    // The page that made the challenge redeems it; a code carried anywhere else is spent for nothing.
    const origin = ($.caller?.headers as Record<string, string> | undefined)?.origin
    if (!held || origin !== held.audience) throw new Unauthorized(SPENT)
    const grant = await sys().appEditor.findFirst({ where: { appId, userId: held.userId } })
    const app   = grant && await sys().app.findFirst({ where: { id: appId } })
    if (!app) throw new Unauthorized(SPENT)

    const user = await sys().user.findFirst({ where: { id: held.userId } })
    const expiresAt = new Date(Date.now() + EDIT_KEY_MS).toISOString()
    // Named for where it was made, so the workspace's API keys list says what it is.
    const name = `Editing ${app.name} on ${new URL(held.audience).host} · ${crypto.randomUUID().slice(0, 8)}`
    const { key, id } = await handoffs().createApiKey(held.userId, { name, scopes: held.scopes, expiresAt: new Date(expiresAt) })
    await sys().apiKey.create({ data: {
      workspaceId: app.workspaceId, userId: held.userId, credentialId: id, name,
      tokenHint: maskToken(key),
      scopes: held.scopes, expiresAt, createdBy: held.userId,
    } })
    return { key, expiresAt, editor: { name: user?.name || user?.email }, site: { id: app.id, name: app.name }, role: grant.role }
  },

  async open() {
    const site   = await grantedSite()
    const opened = await checkout(() => openDraft(site, ($.data as { name?: unknown } | undefined)?.name))
    await queuePreview(site.id, opened.name, opened.head)
    return opened
  },

  async preview() {
    const site  = await grantedSite()
    const draft = arg('draft')
    const found = (await checkout(() => listDrafts(site))).find(d => d.name === draft)
    if (!found) throw new NotFound(`no draft named ${draft} — it may have been published or deleted`)
    await queuePreview(site.id, found.name, found.head)
    return { draft: found.name, preview: previewStatuses(site.id)[found.name] ?? null }
  },

  async ask() {
    const site    = await grantedSite()
    const draft   = arg('draft')
    const request = String((($.data ?? {}) as { request?: unknown }).request ?? '').trim()
    if (!request) throw new BadRequest('Say what to change')
    if (request.length > ASK_MAX_REQUEST) throw new BadRequest(`An ask is at most ${ASK_MAX_REQUEST} characters`)
    if (!env.ANTHROPIC_API_KEY) throw new BadRequest(NO_KEY)
    const found = (await checkout(() => listDrafts(site))).find(d => d.name === draft)
    if (!found) throw new NotFound(`no draft named ${draft} — it may have been published or deleted`)
    if (askBusy(askStatuses(site.id)[found.name])) throw new Conflict('an ask is already running on this draft — wait for it to finish')
    const ask = queueAsk(site.id, found.name, { request, by: me() ?? null, commit: found.head })
    await dispatchAsk($.app, site.id, found.name)
    return { draft: found.name, ask }
  },

  async asked() {
    const site = await grantedSite()
    const { draft, ask } = askIn(site.id, Object.keys(ASK_STATE) as AskStatus['state'][])
    if (ask.state !== 'ready') return { draft, ask, diff: null }
    return { draft, ask, diff: await checkout(() => diffTree(site, ask.commit!, ask.tree!)) }
  },

  async keep() {
    const site = await grantedSite()
    const { draft, ask } = askIn(site.id, ['ready'])
    if (!ask.files.length) throw new BadRequest('that ask changed nothing, so there is nothing to keep')
    const by = await author()
    const saved = await checkout(() => commitTree(site, draft, { tree: ask.tree!, head: ask.commit!, message: askMessage(ask.request) }, by))
    markAsk(site.id, draft, { state: 'kept', kept: saved.commit })
    await queuePreview(site.id, draft, saved.commit)
    return { draft, commit: saved.commit, files: ask.files.map(f => f.path) }
  },

  async discard() {
    const site = await grantedSite()
    const { draft } = askIn(site.id, ['ready', 'failed', 'undone'])
    dropAsk(site.id, draft)
    return { draft }
  },

  async undo() {
    const site = await grantedSite()
    const { draft, ask } = askIn(site.id, ['kept'])
    const by = await author()
    const saved = await checkout(() => revertOnDraft(site, draft, ask.kept!, by, `Undo ${askMessage(ask.request).split('\n')[0]}`, pathRefusal))
    markAsk(site.id, draft, { state: 'undone' })
    await queuePreview(site.id, draft, saved.commit)
    return { draft, commit: saved.commit }
  },

  async files() {
    const site  = await grantedSite()
    const draft = arg('draft')
    const files = await checkout(() => draftFiles(site, draft))
    return { files: files.filter(p => p.endsWith('.md') && pathRefusal(p) === null) }
  },

  async read() {
    const site  = await grantedSite()
    const draft = arg('draft')
    const path  = editablePath()
    const file  = await checkout(() => readDraftFile(site, draft, path))
    const folder = collectionOf(path)
    try {
      const form = formOf(file.text)
      if (!folder) return { path, blob: file.blob, head: file.head, ...form }
      const items = (await checkout(() => readDraftFolder(site, draft, folder)))
        .map((f) => ({ path: f.path, frontmatter: parseFrontmatter(f.text).frontmatter }))
        .sort(byOrder)
      const collection = { folder, index: items.findIndex((f) => f.path === path), count: items.length }
      return { path, blob: file.blob, head: file.head, ...form, collection }
    } catch (err) {
      throw new BadRequest(`${path} does not read, so a developer fixes it first: ${(err as Error).message}`)
    }
  },

  async save() {
    const site  = await grantedSite()
    const draft = arg('draft')
    const path  = editablePath()
    const data  = ($.data ?? {}) as { blob?: unknown, body?: unknown, values?: unknown, text?: unknown, message?: unknown }
    const swap  = textEdit(data)
    if (!swap && (typeof data.blob !== 'string' || !data.blob)) throw new BadRequest('blob is required — the file as you read it')
    if (data.body !== undefined && typeof data.body !== 'string') throw new BadRequest('body is the file\'s text below its front matter')
    if (data.values !== undefined && (typeof data.values !== 'object' || data.values === null || Array.isArray(data.values)))
      throw new BadRequest('values maps a front-matter key to its new value')

    const file = await checkout(() => readDraftFile(site, draft, path))
    if (!swap && file.blob !== data.blob) throw new Conflict(`${path} changed on this draft since you opened it — open it again`)
    let body = data.body as string | undefined
    const { body: was } = splitFrontmatter(file.text)
    const off = file.text.length - was.length
    const field = swap && swap.line < file.text.slice(0, off).split('\n').length ? swap : undefined
    if (swap && !field) {
      const at = locateText(file.text, { ext: 'md', ...swap })
      if (at.why !== undefined) throw new BadRequest(`Those words cannot be changed on their own here: ${at.why}`)
      body = was.slice(0, at.start - off) + at.text + was.slice(at.end - off)
    }
    const edit = applyEdit(file.text, { body, values: data.values as Record<string, unknown> | undefined, field })
    if ('refused' in edit) throw new BadRequest(edit.refused)

    const message = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : `Edit ${path}`
    const by = await author()
    const saved = await checkout(() => saveDraftFile(site, draft, { path, blob: file.blob, text: edit.text, message }, by))
    const changed = saved.blob !== file.blob
    if (changed) await queuePreview(site.id, draft, saved.commit)
    return { path, ...saved, changed }
  },

  async arrange() {
    const site  = await grantedSite()
    const draft = arg('draft')
    const path  = editablePath()
    const data  = ($.data ?? {}) as { blob?: unknown, act?: unknown, line?: unknown }
    if (typeof data.blob !== 'string' || !data.blob) throw new BadRequest('blob is required — the file as you read it')
    if (typeof data.act !== 'string' || !ACTS.includes(data.act)) throw new BadRequest(`act is one of ${ACTS.join(', ')}`)
    if (data.line !== undefined && !Number.isInteger(data.line)) throw new BadRequest('line is the file line of the list entry')
    const act = data.act
    const by = await author()
    const verb = { earlier: 'Move', later: 'Move', copy: 'Copy', remove: 'Remove' }[act]
    const where = act === 'earlier' ? ' earlier' : act === 'later' ? ' later' : ''

    if (data.line !== undefined) {
      const file = await checkout(() => readDraftFile(site, draft, path))
      if (file.blob !== data.blob) throw new Conflict(`${path} changed on this draft since you opened it — open it again`)
      const line = data.line as number
      const entry = formOf(file.text).entries.filter((e) => e.line <= line && line <= e.end).pop()
      const edit = applyEdit(file.text, { entry: { line, act } })
      if ('refused' in edit) throw new BadRequest(edit.refused)
      const saved = await checkout(() => saveDraftFile(site, draft,
        { path, blob: file.blob, text: edit.text, message: `${verb} '${entry?.label ?? 'an entry'}'${where} in ${path}` }, by))
      const changed = saved.blob !== file.blob
      if (changed) await queuePreview(site.id, draft, saved.commit)
      return { path, ...saved, changed }
    }

    const folder = collectionOf(path)
    if (!folder) throw new BadRequest(`${path} is not an item of a collection, so it is arranged by its entries' lines`)
    const files = await checkout(() => readDraftFolder(site, draft, folder))
    const mine = files.find((f) => f.path === path)
    if (!mine) throw new BadRequest(`${path} is not on the draft ${draft}`)
    if (mine.blob !== data.blob) throw new Conflict(`${path} changed on this draft since you opened it — open it again`)
    const plan = arrangeCollection(files.map((f) => ({ path: f.path, source: f.text })), { path, act })
    if ('refused' in plan) throw new BadRequest(plan.refused)
    for (const w of plan.writes) {
      const refused = pathRefusal(w.path)
      if (refused) throw new BadRequest(refused)
    }
    const blobOf = new Map(files.map((f) => [f.path, f.blob]))
    const saved = await checkout(() => saveDraftFiles(site, draft, {
      files: plan.writes.map((w) => ({ path: w.path, blob: blobOf.get(w.path) ?? null, text: w.text })),
      message: `${verb} ${path.slice(folder.length + 1)}${where} in ${folder.slice(folder.lastIndexOf('/') + 1)}`,
    }, by))
    const changed = plan.writes.length > 0
    if (changed) await queuePreview(site.id, draft, saved.commit)
    return { path: plan.path ?? path, commit: saved.commit, changed, ...(plan.path ? { copy: plan.path } : {}) }
  },

  async photo() {
    const site  = await grantedSite()
    const draft = arg('draft')
    const path  = editablePath()
    const key   = arg('key')
    const data  = ($.data ?? {}) as { blob?: unknown, alt?: unknown, photo?: unknown }
    if (typeof data.blob !== 'string' || !data.blob) throw new BadRequest('blob is required — the file as you read it')
    if (typeof data.alt !== 'string') throw new BadRequest('alt is the words saying what the photo shows')
    if (data.photo !== undefined && !(data.photo instanceof Blob)) throw new BadRequest('photo is the file to upload')

    const file = await checkout(() => readDraftFile(site, draft, path))
    if (file.blob !== data.blob) throw new Conflict(`${path} changed on this draft since you opened it — open it again`)
    const was = formOf(file.text).keys.find((k) => k.key === key)?.photo
    if (!was) throw new BadRequest(`${key} is not one of the site's photos that this form writes`)

    const writes: FileChange[] = []
    let src: string | undefined
    if (data.photo) {
      const upload = data.photo as File
      const shot = await reencodePhoto(new Uint8Array(await upload.arrayBuffer())).catch((err) => {
        throw err instanceof PhotoRefused ? new BadRequest(err.message) : err
      })
      const folder = was.file.slice(0, was.file.lastIndexOf('/'))
      const taken = new Set(await checkout(() => draftFiles(site, draft)))
      const name = photoName(upload.name, shot.ext, (n) => taken.has(`${folder}/${n}`))
      const refused = pathRefusal(`${folder}/${name}`)
      if (refused) throw new BadRequest(refused)
      src = was.src.slice(0, was.src.lastIndexOf('/') + 1) + name
      writes.push({ path: `${folder}/${name}`, blob: null, text: shot.bytes })
    }
    const edit = applyPhoto(file.text, { key, alt: data.alt, src })
    if ('refused' in edit) throw new BadRequest(edit.refused)
    writes.push({ path, blob: file.blob, text: edit.text })

    const by = await author()
    const saved = await checkout(() => saveDraftFiles(site, draft, {
      files: writes, message: src ? `Photo for ${key} in ${path}` : `Words for the photo ${key} in ${path}`,
    }, by))
    const changed = saved.commit !== file.head
    if (changed) await queuePreview(site.id, draft, saved.commit)
    return { path, commit: saved.commit, changed, ...(src ? { photo: writes[0].path } : {}) }
  },

  hooks: {
    before: { all: [signedIn] },
  },
})
