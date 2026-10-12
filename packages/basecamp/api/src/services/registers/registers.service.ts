// src/services/registers/registers.service.ts
// The workspace's registers — what is wrong, what is settled, what is waiting
// on the owner — read on one screen, ruled on there, and handed to Claude Code
// in the workbench to be discussed, filed, framed or fixed.
//
// No model and nothing in the database: the records are fli's own readers over
// the workspace this API runs in (`core/registers.ts`). Offered where the
// workbench is (LOCAL_MACHINE=1, never under NODE_ENV=production) and at
// ADMINISTRATOR like it — `decide` writes two tracked files and `discuss` runs
// Claude Code with every permission in that checkout.
//
//   GET  /registers          overview  every open row, open question and ruling, without bodies
//   GET  /registers/:id      record    every record holding that id, whole
//   POST /registers          discuss   { text, intent, branch? } — a workbench send to this checkout or a new branch of it
//   POST /registers/:id      decide    { pick, why?, section } — fli's own `decide`, under the register guard

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { localMachineRefusal }     from '../../core/env.ts'
import { branchName }              from '../../core/workbench-branch.ts'
import {
  loadFli, registerRoot, readAtlas, forgetAtlas, recordsFor, composePrompt, branchSlug,
} from '../../core/registers.ts'
import type { BasecampApp }        from '../../basecamp.types.ts'

const READS  = ['overview', 'record']
const WRITES = ['discuss', 'decide']

export function createRegistersService(app: BasecampApp) {
  async function workspace() {
    const refused = localMachineRefusal()
    if (refused) throw new NotFound(`The registers are ${refused}`)
    const root = await registerRoot()
    if (!root) throw new NotFound('No package.json above this API declares `registers`, so there are none to show')
    return root
  }

  const body = () => ($.data ?? {}) as Record<string, unknown>

  return createService({
    name: 'registers',
    reservedQuery: [...WORKSPACE_QUERY],

    methods: [
      ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
      ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
    ],

    async overview() {
      const root  = await workspace()
      const atlas = await readAtlas(root)
      return {
        root,
        name:     atlas.name,
        prefix:   atlas.prefix,
        sources:  atlas.sources,
        sections: atlas.sections,
        // Bodies are the bulk — 1.2 MB for the open rows here — and a list
        // draws titles; `record` answers one whole.
        issues: atlas.issues.filter(i => !i.closed).map(i => ({
          id: i.id, pkg: i.pkg, title: i.title, status: i.status, severity: i.severity,
          verified: i.verified, blockedBy: i.blockedBy, rank: i.rank,
        })),
        questions: atlas.questions.filter(q => q.state !== 'ruled').map(q => ({
          id: q.id, source: q.source, question: q.question, state: q.state, paper: q.paper,
          options: q.options.length, recommend: q.recommend?.letter ?? null,
        })),
        rulings: atlas.rulings.map(r => ({ id: r.id, date: r.date, section: r.section, title: r.title, status: r.status })),
        ideas:   atlas.ideas.map(i => ({ id: i.id, title: i.title, status: i.status, questions: i.questions })),
      }
    },

    async record() {
      const root  = await workspace()
      const id    = String($.id ?? '')
      const found = recordsFor(await readAtlas(root), id)
      if (!found.issues.length && !found.rulings.length && !found.questions.length && !found.ideas.length)
        throw new NotFound(`No register holds '${id}'`)
      return { id, ...found }
    },

    async discuss() {
      const root  = await workspace()
      const input = body()
      const out   = composePrompt(await readAtlas(root), input)
      if ('refused' in out) throw new BadRequest(out.refused)

      const wb     = app.workbench
      const pinned = wb.pin(root)
      if ('refused' in pinned) throw new Conflict(pinned.refused)
      let target = pinned.pin

      if (input.branch) {
        const slug   = branchSlug(out.ids, s => 'refused' in branchName(root, s))
        const forked = await wb.fork(target.id, { slug })
        if ('refused' in forked) throw new Conflict(forked.refused)
        // A branch resumes its parent's chat; a discussion starts its own.
        await wb.fresh(forked.pin.id)
        target = forked.pin
      }

      const sent = await wb.send(target.id, out.prompt)
      if ('refused' in sent) throw new BadRequest(sent.refused)
      return { pin: { id: target.id, name: target.name, branch: target.branch }, queued: sent.queued, ids: out.ids }
    },

    async decide() {
      const root = await workspace()
      const f    = await loadFli()
      const b    = body()
      const out  = f.withRegisterGuard(root, () => f.decide({
        root,
        id:      String($.id ?? ''),
        pick:    String(b.pick ?? ''),
        why:     String(b.why ?? ''),
        section: String(b.section ?? ''),
      }))
      if (!out.ok) throw new BadRequest(out.reason)
      forgetAtlas()
      return out
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
