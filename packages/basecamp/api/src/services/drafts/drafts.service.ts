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
//   POST /drafts  publish { appId, draft } — merge, build, deploy (the `publish` grant)
//   GET  /drafts  history { appId } — the site's live releases, newest first, each with what it shipped
//   POST /drafts  revert  { appId, release } — a draft undoing one publish
//
// Opening a draft and every save that changes a file queue its preview
// (`core/site-preview.ts`), and `list` answers each draft's last one.
//
// Publish writes a `Deployment` through asSystem() — the publisher may be a
// member of nothing, so the release is the app's, confined by the grant read
// here — and `core/site-publish.ts` runs it. Every refusal past the grant is
// a failed step on that release, so `list` answers the site's last publish.
//
// What an owner may write is site-kit's rule (`FJS-D1226`), asked here by
// path and again of the file the edit produces.
//
// History is derived: the App's successful releases, and git's diff between
// each and the one before it. Revert takes the `edit` grant, since it only
// opens a draft and Publish is still the publish grant's; it undoes an owner's
// publish and never a developer's deploy, whose files are the developer's.

import { createService, BadRequest, Conflict, Forbidden, NotFound, Unauthorized, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { applyEdit, formOf, pathRefusal } from '@frontierjs/site-kit/editable'
import { db } from '../../core/resource.ts'
import { isGit } from '../../core/app-source.ts'
import {
  CheckoutError, StaleDraft, draftFiles, listDrafts, openDraft, readDraftFile, revertDraft, saveDraftFile, shipped, type GitSite,
} from '../../core/site-checkout.ts'
import { markPreview, previewStatuses } from '../../core/site-preview.ts'
import { dispatchPreview } from '../../jobs/site-preview.job.ts'
import { dispatchPublish } from '../../jobs/site-publish.job.ts'
import { PUBLISH_STEPS, type PublishSnapshot } from '../../core/site-publish.ts'
import { keyScope } from '../api-keys/scopes.ts'

const sys = (): any => $.db.asSystem()
const me  = (): string | undefined => ($.me as { userId?: string } | null | undefined)?.userId

const ARGS = ['appId', 'draft', 'path'] as const

/** Releases `history` answers — a site's recent past, which is what an owner undoes. */
const HISTORY = 20

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
    { method: 'publish', gate: LEVELS.VISITOR },
    { method: 'history', read: true, gate: LEVELS.VISITOR },
    { method: 'revert',  gate: LEVELS.VISITOR },
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
    return { drafts: drafts.map(d => ({ ...d, preview: previews[d.name] ?? null })), published: await lastPublish(site.id) }
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
    const user  = await sys().user.findFirst({ where: { id: me() } })
    const opened = await checkout(() => revertDraft(site, row.commitSha, `revert ${draft}`,
      { name: user?.name || user?.email, email: user?.email }, `Revert ${draft}`, pathRefusal))
    await queuePreview(site.id, opened.name, opened.head)
    return opened
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
