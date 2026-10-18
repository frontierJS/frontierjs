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
//   POST /drafts  preview { appId, draft } — build its preview again
//
// Opening a draft and every save that changes a file queue its preview
// (`core/site-preview.ts`), and `list` answers each draft's last one.
//
// What an owner may write is site-kit's rule (`FJS-D1226`), asked here by
// path and again of the file the edit produces.

import { createService, BadRequest, Conflict, NotFound, Unauthorized, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { applyEdit, formOf, pathRefusal } from '@frontierjs/site-kit/editable'
import { db } from '../../core/resource.ts'
import { isGit } from '../../core/app-source.ts'
import {
  CheckoutError, StaleDraft, draftFiles, listDrafts, openDraft, readDraftFile, saveDraftFile, type GitSite,
} from '../../core/site-checkout.ts'
import { markPreview, previewStatuses } from '../../core/site-preview.ts'
import { dispatchPreview } from '../../jobs/site-preview.job.ts'
import { keyScope } from '../api-keys/scopes.ts'

const sys = (): any => $.db.asSystem()
const me  = (): string | undefined => ($.me as { userId?: string } | null | undefined)?.userId

const ARGS = ['appId', 'draft', 'path'] as const

/** A named argument, off the body or, on a GET, the query. */
function arg(name: string): string {
  const v = (($.data ?? {}) as Record<string, unknown>)[name] ?? ($.reserved as Record<string, unknown>)[name]
  if (typeof v !== 'string' || !v) throw new BadRequest(`${name} is required`)
  return v
}

function signedIn(): void {
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

function editablePath(): string {
  const path = arg('path')
  const refused = pathRefusal(path) ?? (path.endsWith('.md') ? null : `${path} is a photo, and photos are not edited here yet`)
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
    { method: 'preview', gate: LEVELS.VISITOR },
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
    const drafts = await checkout(() => listDrafts(site))
    return { drafts: drafts.map(d => ({ ...d, preview: previews[d.name] ?? null })) }
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
    try {
      return { path, blob: file.blob, head: file.head, ...formOf(file.text) }
    } catch (err) {
      throw new BadRequest(`${path} does not read, so a developer fixes it first: ${(err as Error).message}`)
    }
  },

  async save() {
    const site  = await grantedSite()
    const draft = arg('draft')
    const path  = editablePath()
    const data  = ($.data ?? {}) as { blob?: unknown, body?: unknown, values?: unknown, message?: unknown }
    if (typeof data.blob !== 'string' || !data.blob) throw new BadRequest('blob is required — the file as you read it')
    if (data.body !== undefined && typeof data.body !== 'string') throw new BadRequest('body is the file\'s text below its front matter')
    if (data.values !== undefined && (typeof data.values !== 'object' || data.values === null || Array.isArray(data.values)))
      throw new BadRequest('values maps a front-matter key to its new value')

    const file = await checkout(() => readDraftFile(site, draft, path))
    if (file.blob !== data.blob) throw new Conflict(`${path} changed on this draft since you opened it — open it again`)
    const edit = applyEdit(file.text, { body: data.body as string | undefined, values: data.values as Record<string, unknown> | undefined })
    if ('refused' in edit) throw new BadRequest(edit.refused)

    const user = await sys().user.findFirst({ where: { id: me() } })
    const message = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : `Edit ${path}`
    const saved = await checkout(() => saveDraftFile(site, draft, { path, blob: file.blob, text: edit.text, message },
      { name: user?.name || user?.email, email: user?.email }))
    const changed = saved.blob !== file.blob
    if (changed) await queuePreview(site.id, draft, saved.commit)
    return { path, ...saved, changed }
  },

  hooks: {
    before: { all: [signedIn] },
  },
})
