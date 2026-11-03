// src/services/atlas/atlas.service.ts
// The workspace's registers — what is wrong, what is settled, what is waiting
// on the owner — read on one screen, ruled on there, and handed to Claude Code
// in the workbench to be discussed, filed, framed or fixed.
//
// No model and nothing in the database: the records are fli's own readers over
// the workspace this API runs in (`domain/atlas/atlas.ts`). Gated at
// ADMINISTRATOR like the workbench — `decide` writes two tracked files and `discuss` runs
// Claude Code with every permission in that checkout.
//
//   GET  /atlas          overview  every open row, open question and ruling, without bodies
//   GET  /atlas          rings     the project half of `fli ws:atlas --as=rings`: documents, invariants and proof, ring counts
//   GET  /atlas          autopilot the project's loops as a town: lanes, attempts in the last day, Registry and Council tables, papers with an open box, the Dock, the last CI run
//   GET  /atlas/:id      record    every record holding that id, whole
//   POST /atlas          discuss   { text, intent, branch? } — a workbench send to this checkout or a new branch of it
//   POST /atlas/:id      decide    { pick, why?, section } — fli's own `decide`
//   GET  /atlas          queue     every question with lettered options, in `fli decide`'s order, with its prose
//   POST /atlas/:id      explain   { ask? } — Claude, read-only, on one of them; a follow-up resumes its session
//   GET  /atlas/:id      explanation  what that run has said so far
//   POST /atlas/:id      run       entry :id (1-based) of ~/.fli/autopilot.json started now, its caps as the script's flags
//   POST /atlas/:id      turn      :id `on` or `off` — the file's switch; On is refused until every cap is set


import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { env } from '../../core/env.ts'
import { branchName }              from '../../domain/workbench/workbench-branch.ts'
import { startEntry }              from '../../domain/atlas/autopilot-run.ts'
import { inProcess }               from '../../domain/atlas/autopilot-post.ts'
import {
  loadFli, registerRoot, readAtlas, readRings, readAutopilot, forgetAtlas, recordsFor, composePrompt, branchSlug,
  readQueue, explain, explanationOf,
} from '../../domain/atlas/atlas.ts'

const READS  = ['overview', 'rings', 'autopilot', 'record', 'queue', 'explanation']
const WRITES = ['discuss', 'decide', 'explain', 'run', 'turn']

async function workspace() {
  const root = await registerRoot()
  if (!root) throw new NotFound('No package.json above this API declares `registers`, so there are none to show')
  return root
}

const body = () => ($.data ?? {}) as Record<string, unknown>

export default createService({
  name: 'atlas',

  methods: [
    ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
    ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
  ],

  async rings() {
    return readRings(await workspace())
  },

  async autopilot() {
    return readAutopilot(await workspace())
  },

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

  async queue() {
    return readQueue(await workspace())
  },

  async explain() {
    const root = await workspace()
    const id   = String($.id ?? '')
    const q    = (await readQueue(root)).questions.find(x => x.id === id)
    if (!q) throw new NotFound(`'${id}' is not a question with options waiting on a ruling`)
    const out = await explain(root, q, { ask: body().ask, bin: env.CLAUDE_BIN })
    if ('refused' in out) throw new Conflict(out.refused)
    return out
  },

  async explanation() {
    await workspace()
    return explanationOf(String($.id ?? ''))
  },

  // The loop holds the day's cap itself (`scripts/headless.mjs`); asking here
  // first turns a run that would exit on its first line into a refusal with
  // the reason, before a lane is opened for it.
  async run() {
    const root = await workspace()
    const f    = await loadFli()
    const n    = Number($.id)
    if (!Number.isInteger(n) || n < 1) throw new BadRequest(`'${$.id}' is not an entry number; the first entry is 1`)
    let schedule
    try { schedule = f.readSchedule({ root }) } catch (err) { throw new Conflict((err as Error).message) }
    if (!schedule.exists) throw new Conflict(`${schedule.file} does not exist, so there is no entry to run`)
    const over = f.overDayCap(schedule.day, f.spentToday(f.logFiles().flatMap(l => f.readLog(l))))
    if (over) throw new Conflict(`Refused: ${over}`)
    const out = startEntry(root, f.LOOPS, schedule.entries, n - 1, $.app.workbench.shellEnv(), { inProcess: inProcess($.app, root, $.db) })
    if ('refused' in out) throw new Conflict(out.refused)
    return { entry: n, ...out.started }
  },

  async turn() {
    await workspace()
    const f = await loadFli()
    if ($.id !== 'on' && $.id !== 'off') throw new BadRequest(`'${$.id}' is not a switch position; it is on or off`)
    try { return { on: f.writeSwitch({ on: $.id === 'on' }).on } }
    catch (err) { throw new Conflict((err as Error).message) }
  },

  async discuss() {
    const root  = await workspace()
    const input = body()
    const out   = composePrompt(await readAtlas(root), input)
    if ('refused' in out) throw new BadRequest(out.refused)

    const wb     = $.app.workbench
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
    const out  = f.decide({
      root,
      id:      String($.id ?? ''),
      pick:    String(b.pick ?? ''),
      why:     String(b.why ?? ''),
      section: String(b.section ?? ''),
    })
    if (!out.ok) throw new BadRequest(out.reason)
    forgetAtlas()
    return out
  },

})
