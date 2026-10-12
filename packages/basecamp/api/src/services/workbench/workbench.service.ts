// src/services/workbench/workbench.service.ts
// The workbench — a Claude Code chat per pinned checkout (`core/workbench.ts`).
//
// No model and nothing in the database: a pin names a folder on the machine
// this API runs on. Offered only where `git.localRepos` is (LOCAL_MACHINE=1,
// never under NODE_ENV=production), and at ADMINISTRATOR like it — and a run
// here is more than a listing: it is Claude Code with every permission, in that
// folder, as the operator's own account.
//
//   GET  /workbench               pins        the pins, each with its git state and run status
//   GET  /workbench               status      every pin's run status — the grid's poll, no git
//   GET  /workbench/:id           transcript  { chat? } — one chat, the shown one by default, folded from its log, with the checkout's checks and review
//   GET  /workbench/:id           diff        the checkout's working tree against HEAD, a branch's against its base
//   GET  /workbench/:id           runnables   `fli dev` per app and every package.json script (`core/workbench-run.ts`)
//   GET  /workbench/:id           output      { row } — the tail of what a started row wrote
//   POST /workbench               pin         { path }
//   POST /workbench/:id           send        { prompt, chat? } — queued behind a run in the same chat, refused while another chat runs
//   POST /workbench/:id           check       the checkout's own `fli done`, now
//   POST /workbench/:id           review      a read-only Claude Code session over the tree, now
//   POST /workbench/:id           fork        { slug?, preview? } — a branch: the tree snapshotted into a worktree, pinned, its copy list and install run;
//                                             with preview, Open: a preview Environment and its rows (`core/preview.ts`), routed to the branch's web port
//   POST /workbench/:id           freeze      a preview's web/ built and released by digest; the hostname serves the build
//   POST /workbench/:id           thaw        a preview's hostname routed back to the branch's dev server
//   POST /workbench/:id           land        a branch's work into its parent's tree, uncommitted
//   POST /workbench/:id           archive     { discard? } — a branch's worktree removed, its git branch kept;
//                                             a preview is RETIRED first — off the machine, its Environment removed
//   POST /workbench/:id           fresh       a new chat, shown — or the shown one, when it is still empty
//   POST /workbench/:id           select      { chat } — the chat shown
//   POST /workbench/:id           close       { chat } — forgotten here, what it cost kept; Claude Code keeps the session
//   POST /workbench/:id           stop · seen · unpin
//   POST /workbench/:id           configure   { name?, budget?, hooks?, review?, copy?, preview? }
//   POST /workbench/:id           run         { row } — started detached by row id, never by command
//   POST /workbench/:id           halt        { row } — stopped, its process group with it; on one already stopped, forgotten
//
// A pin is no workspace's, but a preview's settings name a project and a
// machine that are: both are read in the CALLER's workspace when set and again
// before a preview is cut, so a branch is never cut for rows the caller could
// not write.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { existsSync }              from 'node:fs'
import { dirname }                 from 'node:path'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { localMachineRefusal }     from '../../core/env.ts'
import { describeRepo }            from '../../core/local-git.ts'
import { doneScript }              from '../../core/workbench.ts'
import { openPreview, freezePreview, thawPreview, retirePreview, type Opened, type PreviewSettings } from '../../core/preview.ts'
import { db, ws }                  from '../../core/resource.ts'
import type { BasecampApp }        from '../../basecamp.types.ts'

const READS  = ['pins', 'status', 'transcript', 'diff', 'runnables', 'output']
const WRITES = ['pin', 'unpin', 'configure', 'send', 'stop', 'fresh', 'select', 'close', 'seen', 'check', 'review', 'fork', 'freeze', 'thaw', 'land', 'archive', 'run', 'halt']

export function createWorkbenchService(app: BasecampApp) {
  // Read per call: services are built inside createApp, before app.ts claims it.
  const wb = () => app.workbench

  function offered() {
    const refused = localMachineRefusal()
    if (refused) throw new NotFound(`The workbench is ${refused}`)
  }

  function pinned() {
    offered()
    const p = wb().getPin(String($.id ?? ''))
    if (!p) throw new NotFound(`No pinned checkout '${$.id}'`)
    return p
  }

  const body = () => ($.data ?? {}) as Record<string, unknown>

  /** A preview branch: what Open made, and the settings of the checkout it
   *  was forked from. */
  function previewOf(p: ReturnType<typeof pinned>): { opened: Opened, settings: PreviewSettings } {
    const parent = p.from ? wb().getPin(p.from) : null
    if (!p.opened?.appId || !p.opened.environmentId) throw new Conflict(`${p.name} is not a preview — fork one with { preview: true }`)
    if (!parent?.preview) throw new Conflict(`${p.name}'s checkout no longer carries preview settings`)
    return { opened: p.opened as Opened, settings: parent.preview }
  }

  async function previewTargetsHere(s: Pick<PreviewSettings, 'projectId' | 'serverId'>) {
    if (!await db().project.findFirst({ where: { id: s.projectId, workspaceId: ws() } }))
      throw new NotFound(`Project '${s.projectId}' not found in this workspace`)
    if (s.serverId && !await db().server.findFirst({ where: { id: s.serverId, workspaceId: ws() } }))
      throw new NotFound(`Server '${s.serverId}' not found in this workspace`)
  }

  return createService({
    name: 'workbench',
    reservedQuery: [...WORKSPACE_QUERY],

    methods: [
      ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
      ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
    ],

    async pins() {
      offered()
      const pins = wb().readPins()
      return {
        dir:  wb().dir,
        pins: await Promise.all(pins.map(async p => {
          // A renamed or deleted folder: git there answers nothing, and every
          // run is refused, so the screen says so instead of a blank card.
          const missing = !existsSync(p.path)
          return {
            ...p,
            missing,
            git:    missing ? null : await describeRepo(dirname(p.path), p.path),
            checkable: !missing && !!doneScript(p.path),
            status: await wb().status(p),
          }
        })),
      }
    },

    async status() {
      offered()
      return { status: await wb().statuses() }
    },

    async transcript() {
      const p = pinned()
      const t = await wb().transcript(p.id, body().chat)
      if (!t) throw new NotFound(`${p.name} has no chat '${body().chat}'`)
      return t
    },

    async diff() {
      const p = pinned()
      return wb().diff(p.id)
    },

    async runnables() {
      const p = pinned()
      return wb().runnables(p.id)
    },

    async output() {
      const p = pinned()
      const out = wb().output(p.id, body().row)
      if (!out) throw new NotFound(`Nothing called '${body().row}' was started in ${p.name}`)
      return out
    },

    async run() {
      const p = pinned()
      const r = await wb().run(p.id, body().row)
      if ('refused' in r) throw new Conflict(r.refused)
      return r
    },

    async halt() {
      const p = pinned()
      const r = wb().halt(p.id, body().row)
      if ('refused' in r) throw new NotFound(r.refused)
      return r
    },

    async pin() {
      offered()
      const r = wb().pin(body().path)
      if ('refused' in r) throw new BadRequest(r.refused)
      return r.pin
    },

    async unpin() {
      const p = pinned()
      const r = wb().unpin(p.id)
      if (r) throw new Conflict(r.refused)
      return { id: p.id }
    },

    async fork() {
      const p = pinned()
      const preview = body().preview === true
      if (preview && p.preview) await previewTargetsHere(p.preview)
      const r = await wb().fork(p.id, { slug: body().slug, preview })
      if ('refused' in r) throw new Conflict(r.refused)
      if (!preview) return r.pin
      const b = r.pin
      try {
        const opened = await openPreview(app, p.preview!, { slug: b.branch!.slice('wb/'.length), branch: b.branch!, port: b.opened!.port })
        return wb().recordOpened(b.id, opened)
      } catch (e) {
        await wb().archive(b.id, { discard: true })
        throw new Conflict(`Open failed, so the branch was archived (${b.branch} is kept): ${(e as Error).message}`)
      }
    },

    async freeze() {
      const p = pinned()
      const { opened, settings } = previewOf(p)
      try { return await freezePreview(app, settings, { path: p.path, branch: p.branch!, appId: opened.appId }) }
      catch (e) {
        if ((e as { code?: number }).code) throw e
        throw new Conflict(`Freeze failed, and the hostname still serves what it did: ${(e as Error).message}`)
      }
    },

    async thaw() {
      const p = pinned()
      const { opened, settings } = previewOf(p)
      const { port, hosts, ...route } = await thawPreview(app, settings, opened)
      if (!route.ok) throw new Conflict(`The hostnames were not routed back: ${route.why}`)
      return { hosts, port, route }
    },

    async land() {
      const p = pinned()
      const r = wb().land(p.id)
      if ('refused' in r) throw new Conflict(r.refused, { files: r.files ?? [] })
      return r
    },

    async archive() {
      const p = pinned()
      const refused = wb().archiveRefusal(p.id, { discard: body().discard })
      if (refused) throw new Conflict(refused.refused, { pending: refused.pending ?? 0 })
      // Before the worktree goes and its port with it: a route left dialing a
      // released port serves whichever branch claims that port next.
      const retired = p.opened?.environmentId ? await retirePreview(app, p.opened as Opened) : null
      const r = await wb().archive(p.id, { discard: body().discard })
      if ('refused' in r) throw new Conflict(r.refused, { pending: r.pending ?? 0 })
      return retired ? { ...r, retired } : r
    },

    async configure() {
      const p = pinned()
      const asked = body().preview
      if (asked && typeof asked === 'object' && !Array.isArray(asked) && (asked as Record<string, unknown>).projectId)
        await previewTargetsHere({
          projectId: String((asked as Record<string, unknown>).projectId),
          serverId:  ((asked as Record<string, unknown>).serverId as string | null | undefined) || null,
        })
      const r = wb().configure(p.id, body())
      if ('refused' in r) throw new BadRequest(r.refused)
      return r
    },

    async send() {
      const p = pinned()
      const r = await wb().send(p.id, String(body().prompt ?? ''), body().chat)
      if ('refused' in r) throw new BadRequest(r.refused)
      return r
    },

    async check() {
      const p = pinned()
      const r = wb().check(p.id)
      if ('refused' in r) throw new Conflict(r.refused)
      return r
    },

    async review() {
      const p = pinned()
      const r = await wb().review(p.id)
      if ('refused' in r) throw new Conflict(r.refused)
      return r
    },

    async stop() {
      const p = pinned()
      return { stopped: wb().stop(p.id) }
    },

    async fresh() {
      const p = pinned()
      return wb().fresh(p.id)
    },

    async select() {
      const p = pinned()
      const r = wb().select(p.id, body().chat)
      if ('refused' in r) throw new NotFound(r.refused)
      return r
    },

    async close() {
      const p = pinned()
      const r = await wb().close(p.id, body().chat)
      if ('refused' in r) throw new Conflict(r.refused)
      return r
    },

    async seen() {
      const p = pinned()
      return wb().seen(p.id)
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
