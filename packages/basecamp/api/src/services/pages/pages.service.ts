// src/services/pages/pages.service.ts
// The pages fli writes about this workspace — the rings, the work map, the
// vocabulary, the codegraph, the atlas — listed, regenerated and opened, with
// the fli tools beside them and whether each one is up.
//
// No model and nothing in the database. The rows are `runnables()` from fli's
// own core, read over the workspace this API runs in, and a regenerate is
// `children.js`'s `startRow` — the inventory and the process table `fli gui`
// uses, so the two screens cannot list different pages or run a different
// command for one. Offered where the workbench is (LOCAL_MACHINE=1, never under
// NODE_ENV=production) and at ADMINISTRATOR like it: a regenerate runs a
// command on this machine.
//
//   GET  /pages            list     the rows, each with its state and when its file was written
//   GET  /pages/:id        view     { html } — the page, looked up by row id and never by path
//   GET  /pages/:id        output   the tail of the run this API started
//   POST /pages/:id        start    run the row's generator, or start the tool
//   POST /pages/:id        stop     stop what this API started, and nothing else

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                 from '@frontierjs/litestone'
import { statSync }               from 'node:fs'
import { dirname, join }          from 'node:path'
import { fileURLToPath }          from 'node:url'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { localMachineRefusal }    from '../../core/env.ts'
import type { BasecampApp }       from '../../basecamp.types.ts'

const READS  = ['list', 'view', 'output']
const WRITES = ['start', 'stop']

// A tool is a server somebody opens; a page is a file somebody opens. Every
// other row (a suite, a drive, a task) is `fli gui`'s and not this screen's.
const SHOWN = (r: Row) => r.kind === 'tool' || !!r.page

type Row = {
  kind: string, id: string, name: string, dir: string, start: string | null,
  argv: string[] | null, port: number | null, open: string | null,
  page?: string | null, source: string,
}
type Fli = {
  runnables:  (root: string) => Row[]
  probeState: (rows: Row[], o: { childOf: (id: string) => unknown, lastOf: (id: string) => unknown }) => Promise<Record<string, any>>
  readPage:   (root: string, row: Row) => string | null
  startRow:   (row: Row, o: { root: string, fliRoot: string }) => { ok: true, pid: number } | { ok: false, status: number, error: string }
  stopRow:    (id: string, o: { name: string }) => { ok: true } | { ok: false, status: number, error: string }
  childOf:    (id: string) => unknown
  lastOf:     (id: string) => unknown
  outputOf:   (id: string) => string[]
  findWorkspaceRoot: (start: string) => string | null
}

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where this screen is offered at all.
let fli: Promise<Fli> | null = null
const loadFli = () => fli ??= Promise.all([
  import('@frontierjs/cli/core/runnables.js'),
  import('@frontierjs/cli/core/children.js'),
  import('@frontierjs/cli/core/utils.js'),
]).then(([r, c, u]) => ({ ...r, ...c, ...u }) as unknown as Fli)

// The inventory walks the tree (~130ms here) and the page polls while a
// generator runs; state is never cached, because a stale state shows a server
// that is down as up.
const ROWS_TTL_MS = 5000

export function createPagesService(app: BasecampApp) {
  let cached: { at: number, rows: Row[] } | null = null

  async function workspace() {
    const refused = localMachineRefusal()
    if (refused) throw new NotFound(`Pages are ${refused}`)
    const f    = await loadFli()
    // From this file rather than the cwd, so `bun run api` from any directory
    // describes the workspace this Basecamp is part of.
    const root = f.findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)))
    if (!root) throw new NotFound('Pages are offered inside a FrontierJS workspace, and this API is not running in one')
    return { f, root }
  }

  async function rows() {
    const { f, root } = await workspace()
    if (!cached || Date.now() - cached.at > ROWS_TTL_MS) cached = { at: Date.now(), rows: f.runnables(root).filter(SHOWN) }
    return { f, root, rows: cached.rows }
  }

  async function row() {
    const ctx = await rows()
    const id  = String($.id ?? '')
    const r   = ctx.rows.find(x => x.id === id)
    if (!r) throw new NotFound(`No page or tool '${id}'`)
    return { ...ctx, row: r }
  }

  function writtenAt(root: string, r: Row): number | null {
    if (!r.page) return null
    try { return statSync(join(root, r.page)).mtimeMs } catch { return null }
  }

  return createService({
    name: 'pages',
    reservedQuery: [...WORKSPACE_QUERY],

    methods: [
      ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
      ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
    ],

    async list() {
      const { f, root, rows: list } = await rows()
      const state = await f.probeState(list, { childOf: f.childOf, lastOf: f.lastOf })
      return {
        root,
        rows: list.map(r => ({
          id: r.id, kind: r.kind, name: r.name, start: r.start, port: r.port, open: r.open,
          page: r.page ?? null, source: r.source,
          writtenAt: writtenAt(root, r),
          state: state[r.id] ?? { state: 'unknown' },
        })),
      }
    },

    async view() {
      const { f, root, row: r } = await row()
      const html = f.readPage(root, r)
      if (html == null) throw new NotFound(r.page ? `${r.page} is not written — generate it with \`${r.start}\`` : `${r.name} is not a page`)
      return { id: r.id, html }
    },

    async output() {
      const { f, row: r } = await row()
      // `children.js` runs with FORCE_COLOR for `fli gui`, which renders it;
      // this screen prints text, where an escape is a box and `[33m`.
      return { id: r.id, lines: f.outputOf(r.id).map(l => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')) }
    },

    async start() {
      const { f, root, row: r } = await row()
      const out = f.startRow(r, { root, fliRoot: join(root, 'packages', 'cli') })
      if (!out.ok) throw new BadRequest(out.error)
      return { id: r.id, pid: out.pid }
    },

    async stop() {
      const { f, row: r } = await row()
      const out = f.stopRow(r.id, { name: r.name })
      if (!out.ok) throw new BadRequest(out.error)
      return { id: r.id }
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
