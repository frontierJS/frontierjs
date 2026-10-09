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
//   GET  /workbench/:id           transcript  one chat, folded from its log
//   POST /workbench               pin         { path }
//   POST /workbench/:id           send        { prompt } — queued behind a run in progress
//   POST /workbench/:id           stop · fresh · seen · unpin
//   POST /workbench/:id           configure   { name?, budget?, hooks? }

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { dirname }                 from 'node:path'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { env, localMachineRefusal } from '../../core/env.ts'
import { describeRepo }            from '../../core/local-git.ts'
import { createWorkbench }         from '../../core/workbench.ts'
import type { BasecampApp }        from '../../basecamp.types.ts'

const READS  = ['pins', 'status', 'transcript']
const WRITES = ['pin', 'unpin', 'configure', 'send', 'stop', 'fresh', 'seen']

export function createWorkbenchService(app: BasecampApp) {
  const wb = createWorkbench({ dir: env.WORKBENCH_DIR || undefined, bin: env.CLAUDE_BIN, env })

  function offered() {
    const refused = localMachineRefusal()
    if (refused) throw new NotFound(`The workbench is ${refused}`)
  }

  function pinned() {
    offered()
    const p = wb.getPin(String($.id ?? ''))
    if (!p) throw new NotFound(`No pinned checkout '${$.id}'`)
    return p
  }

  const body = () => ($.data ?? {}) as Record<string, unknown>

  return createService({
    name: 'workbench',
    reservedQuery: [...WORKSPACE_QUERY],

    methods: [
      ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
      ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
    ],

    async pins() {
      offered()
      const pins = wb.readPins()
      return {
        dir:  wb.dir,
        pins: await Promise.all(pins.map(async p => ({
          ...p,
          git:    await describeRepo(dirname(p.path), p.path),
          status: await wb.status(p),
        }))),
      }
    },

    async status() {
      offered()
      return { status: await wb.statuses() }
    },

    async transcript() {
      const p = pinned()
      return wb.transcript(p.id)
    },

    async pin() {
      offered()
      const r = wb.pin(body().path)
      if ('refused' in r) throw new BadRequest(r.refused)
      return r.pin
    },

    async unpin() {
      const p = pinned()
      wb.unpin(p.id)
      return { id: p.id }
    },

    async configure() {
      const p = pinned()
      const r = wb.configure(p.id, body())
      if ('refused' in r) throw new BadRequest(r.refused)
      return r
    },

    async send() {
      const p = pinned()
      const r = await wb.send(p.id, String(body().prompt ?? ''))
      if ('refused' in r) throw new BadRequest(r.refused)
      return r
    },

    async stop() {
      const p = pinned()
      return { stopped: wb.stop(p.id) }
    },

    async fresh() {
      const p = pinned()
      const r = wb.fresh(p.id)
      if (r && 'refused' in r) throw new Conflict(r.refused as string)
      return r
    },

    async seen() {
      const p = pinned()
      return wb.seen(p.id)
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
