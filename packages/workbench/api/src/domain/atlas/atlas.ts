// src/domain/atlas/atlas.ts
// The workspace's registers — `ISSUES.md`, `DECISIONS.md`, `IDEAS/` — as the
// /atlas/ screen reads and writes them, and what is handed to Claude Code
// when a person brings one of them to the workbench.
//
// Nothing here parses a register. The records are fli's `collectRegisterAtlas`
// (which reads through `registers.js`, `decisions.js` and `next.js`), a ruling
// is fli's `decide`, and a row is filed by Claude running `fli register:file`
// — so this screen, `fli next`, `fli decide` and `register:check` cannot
// disagree about what a row says.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir }               from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath }         from 'node:url'

import { runningOf, readTick, type Entry, type Running, type Tick } from './autopilot-run.ts'

// ─── fli ──────────────────────────────────────────────────────────────────────

export type Link = { label: string, href: string, edit: string }
export type At   = { file: string, line: number | null, href: string, edit: string }

export type Issue = {
  id: string, aliases: string[], pkg: string[], title: string, status: string,
  severity: string, verified: string, closed: boolean, body: string, refs: string[],
  blockedBy: string[], rank: { n: number | null, score: number, terms: string[] } | null,
  links: Link[], at: At,
}
export type Ruling = {
  id: string | null, date: string, section: string, title: string, status: string,
  supersededBy: string | null, body: string, refs: string[], links: Link[], at: At,
}
export type Question = {
  id: string, source: string, question: string, state: 'ruled' | 'decidable' | 'open',
  options: { letter: string, text: string }[], recommend: { letter: string, qualifier: string | null, why: string } | null,
  paper: string | null, at: At,
}
export type Idea = {
  id: string, title: string, status: string, dated: string, body: string,
  refs: string[], questions: number, links: Link[], at: At,
}
export type Atlas = {
  name: string, prefix: string | null, dir: string, sources: string[], sections: string[],
  ready: string[], blocked: string[],
  issues: Issue[], rulings: Ruling[], ideas: Idea[], questions: Question[],
}

type Decided = { ok: true, ruling: string, pick: string, closed: string | null, files: string[] } | { ok: false, reason: string }

type Option    = { letter: string, text: string }
type Recommend = { letter: string, qualifier: string | null, why: string }
export type Asked = {
  id: string, file: string, line: number, question: string, body: string,
  options: Option[], recommend: Recommend | null, paper: { id: string, status: string } | null,
}
type AskEvent =
  | { type: 'session', id: string } | { type: 'text', text: string } | { type: 'tool', text: string }
  | { type: 'result', ok: boolean, stop: string | null, cost: number | null } | { type: 'error', text: string }

export type Fli = {
  collectRegisterAtlas: (root: string) => Atlas
  findRegisterRoot:     (start: string) => string | null
  registerLayout:       (root: string) => { dir: string }
  decide: (o: { root: string, id: string, pick: string, why: string, section: string }) => Decided
  openDecisions:  (root: string) => { decidable: Asked[], open: Asked[] }
  rulingSections: (root: string) => string[]
  runAsk: (o: { root: string, prompt: string, session?: string | null, bin?: string, onEvent: (e: AskEvent) => void }) =>
    { error: string } | { child: unknown, done: Promise<number | null> }
  collect: (o: { root: string }) => unknown
  dataOf:  (model: unknown, o: { root: string }) => RingsData
  readLoopLog: (o: { logDir?: string, root: string, since?: number | string, until?: number | string }) => LoopLog
  readLog:      (file: string) => LogLine[]
  readSchedule: (o?: { file?: string, root?: string }) => Schedule
  writeSwitch: (o: { on: boolean }) => Schedule
  applyArgv: (dir: string, file: string) => string[]
  spentToday:   (lines: LogLine[], o?: { now?: Date }) => Spent
  overDayCap:   (day: Schedule['day'], spent: Spent) => string | null
  logFiles:     (dir?: string) => string[]
  LOOPS:        Record<string, { script: string | null, log: string }>
  parsePlan:   (text: string, o: { file: string }) => ParsedPlan
  phaseOf:     (plan: ParsedPlan, step: PlanStep) => { n: string, title: string } | null
}

type LoopEvent = {
  t: string, kind: 'row' | 'question' | 'paper', id: string, from: string, to: string, label: string,
  cost: number | null, log: string, turns?: number | null, minutes?: number | null,
  sev?: string, model?: string, effort?: string, source?: string,
}
type LoopLane = {
  id: string, dir: string, exists: boolean, attemptsToday: number, closedToday: number, spendToday: number, busy: boolean,
  last: { row: string, outcome: string, at: string, model?: string, effort?: string, cost?: number, turns?: number } | null,
}
/** `loop-log.js`'s read of the fix-loop and frame-loop logs and the lanes directory. */
export type LoopLog = {
  window: { start: string, end: string }
  attempts: Array<Record<string, unknown> & { id: string, outcome: string, startedAt?: string }>
  events: LoopEvent[]
  counts: Record<string, number>
  spend: number
  lanes: LoopLane[]
  frame: { linesToday: number, lastAt: string | null, lastDay: string | null, total: number, framedAllTime: number }
  stress: { linesToday: number, lastAt: string | null, total: number, tickedAllTime: number, filedToday: number }
  dock: { patches: Array<{ file: string, row: string | null, at: string | null, files: number, added: number, removed: number }>, dirs: string[], harvestsToday: number, filesHarvestedToday: number }
  review: { modified: string, head: string[], repeated: string[] } | null
}
type LogLine = Record<string, unknown>
type Spent   = { attempts: number, dollars: number }
/** `autopilot.js`'s read of ~/.fli/autopilot.json, every cap checked. */
type Schedule = {
  file: string, exists: boolean, on: boolean, missing: string[]
  day: { attempts: number | null, dollars: number | null } | null
  entries: Entry[]
  stressors: { dir: string, apps: string[] } | null
}
type PlanStep = { id: string, title: string, box: 'open' | 'done' | 'dropped', phase: string }
type ParsedPlan = {
  title: string | null, status: string | null, steps: PlanStep[], next: PlanStep | null,
  phases: Array<{ n: string, title: string }>,
}

type Row = Array<string | number | boolean | null>
type RingsData = {
  base: string | null
  docs: Array<{ file: string, claim: string, outline: Array<[string, string]> }>
  invariants: Row[], checks: Row[], snapshots: Row[], drives: Row[], proves: Row[], ciPhases: Row[]
  decisions: Array<{ title: string, rows: Row[] }>
  decCount: number
  severities: Array<{ key: string, name: string, tone: string }>
  issues: Row[]
  closedCount: number
  byPkg: unknown[]
  ideas: { count: number, byStatus: Array<{ status: string, count: number }>, waves: unknown[] }
}
/** The project half of `fli ws:atlas --as=rings`, each document with the link that opens it. */
export type Rings = Omit<RingsData, 'docs'> & { docs: Array<RingsData['docs'][number] & { edit: string }> }

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the screen is offered at all.
let fli: Promise<Fli> | null = null
export const loadFli = () => fli ??= Promise.all([
  import('@frontierjs/cli/core/repo-map.js'),
  import('@frontierjs/cli/core/repo-rings.js'),
  import('@frontierjs/cli/core/register-atlas.js'),
  import('@frontierjs/cli/core/registers.js'),
  import('@frontierjs/cli/core/decide.js'),
  import('@frontierjs/cli/core/decisions.js'),
  import('@frontierjs/cli/core/ask-claude.js'),
  import('@frontierjs/cli/core/loop-log.js'),
  import('@frontierjs/cli/core/plan.js'),
  import('@frontierjs/cli/core/autopilot.js'),
]).then(mods => Object.assign({}, ...mods) as unknown as Fli)

/** The register root this Workbench sits in, found from this file rather than the cwd. */
export async function registerRoot(): Promise<string | null> {
  const f = await loadFli()
  return f.findRegisterRoot(dirname(fileURLToPath(import.meta.url)))
}

// ─── the read, cached on the files ────────────────────────────────────────────
//
// A read is ~3s here: `rankNext` walks git history for every row. The cache is
// keyed on the register files' mtimes, so a row Claude files in the workbench
// shows on the next poll; the TTL is for the ranking, whose git half moves
// without any register file changing.

const RANK_TTL_MS = 5 * 60_000

function signature(root: string, dir: string): string {
  const stamp = (p: string) => { try { return statSync(p).mtimeMs } catch { return 0 } }
  const parts = ['ISSUES.md', 'ISSUES_ARCHIVE.md', 'DECISIONS.md', 'IDEAS', 'IDEAS/shipped'].map(n => stamp(join(dir, n)))
  // A paper edited in place moves its own mtime and not the directory's, and
  // a shipped paper can still hold a question nobody ruled.
  for (const sub of ['IDEAS', 'IDEAS/shipped']) {
    try { for (const n of readdirSync(join(dir, sub))) parts.push(stamp(join(dir, sub, n))) } catch {}
  }
  return `${root}|${parts.join(',')}`
}

let cached: { sig: string, at: number, atlas: Atlas } | null = null

export async function readAtlas(root: string): Promise<Atlas> {
  const f   = await loadFli()
  const dir = join(root, cached?.atlas.dir ?? '.')
  const sig = signature(root, dir)
  if (cached && cached.sig === sig && Date.now() - cached.at < RANK_TTL_MS) return cached.atlas
  const atlas = f.collectRegisterAtlas(root)
  cached = { sig: signature(root, join(root, atlas.dir)), at: Date.now(), atlas }
  return atlas
}

// The rings read the whole tree (~1s), and ride the same signature: a document
// edited outside the registers shows when the TTL lapses.
let ringsCached: { sig: string, at: number, rings: Rings } | null = null

export async function readRings(root: string): Promise<Rings> {
  const f   = await loadFli()
  const sig = signature(root, join(root, f.registerLayout(root).dir))
  if (ringsCached && ringsCached.sig === sig && Date.now() - ringsCached.at < RANK_TTL_MS) return ringsCached.rings
  const d = f.dataOf(f.collect({ root }), { root })
  const rings: Rings = {
    base:        d.base,
    docs:        d.docs.map(doc => ({ ...doc, edit: `vscode://file${join(root, doc.file)}` })),
    invariants:  d.invariants,
    checks:      d.checks,
    snapshots:   d.snapshots,
    drives:      d.drives,
    proves:      d.proves,
    ciPhases:    d.ciPhases,
    decisions:   d.decisions.filter(s => s.rows.length),
    decCount:    d.decCount,
    severities:  d.severities,
    issues:      d.issues,
    closedCount: d.closedCount,
    byPkg:       d.byPkg,
    ideas:       { count: d.ideas.count, byStatus: d.ideas.byStatus, waves: d.ideas.waves },
  }
  ringsCached = { sig, at: Date.now(), rings }
  return rings
}

// ─── the town ─────────────────────────────────────────────────────────────────
//
// IDEAS/autopilot.md draws the project's loops as a town. Nothing here holds
// state: the logs are `loop-log.js`'s, the Registry and Council are the Atlas
// the cache above already holds (not `fli next`, which would rank again), and
// a paper's boxes are `plan.js`'s. The logs move on every attempt, so they are
// read on every call; the papers move with the register signature, and read
// only when it does.

type Crate = { id: string, pkg: string, severity: string, title: string }
type Table = { count: number, bySeverity: Record<string, number>, top: Crate[] }
export type PlanCard = {
  id: string, title: string | null, status: string | null, steps: number, done: number,
  next: { id: string, title: string } | null, phase: string | null,
}
/** A Dock patch with its register row and the command that applies it in the main tree (FJS-D1779). */
export type DockPatch = LoopLog['dock']['patches'][number] & {
  title: string | null, severity: string | null, status: string | null
  last: { outcome: string, model?: string, cost?: number, at: string } | null
  apply: string
}
export type Autopilot = Omit<LoopLog, 'dock'> & {
  dock: LoopLog['dock'] & { patches: DockPatch[] }
  registry: { ready: Table, blocked: Table, busy: { count: number }, closedToday: number }
  council: {
    open: number, decidable: number, ruled: number,
    bench: Array<{ id: string, question: string, recommend: string, paper: string | null }>,
  }
  plans: { papers: PlanCard[], stressors: PlanCard[] }
  ci: { header: string, verdict: string, green: boolean, phases: string[], failures: string[] } | null
  switch: {
    file: string, exists: boolean, on: boolean, refused: string | null, missing: string[]
    day: Schedule['day'], spent: Spent, cap: string | null
    entries: Array<Entry & { running: Running | null }>
    tick: Tick | null
  }
}

export const FLI_DIR = () => join(homedir(), '.fli')
const READY_TOP = 40
const BENCH_TOP = 12

function planCard(f: Fli, file: string, id: string): PlanCard | null {
  let plan: ParsedPlan
  try { plan = f.parsePlan(readFileSync(file, 'utf8'), { file }) } catch { return null }
  const phase = plan.next ? f.phaseOf(plan, plan.next) : null
  return {
    id, title: plan.title, status: plan.status, steps: plan.steps.length,
    done: plan.steps.filter(x => x.box !== 'open').length,
    next:  plan.next ? { id: plan.next.id, title: String(plan.next.title).slice(0, 140) } : null,
    phase: phase ? `Phase ${phase.n} — ${phase.title}` : null,
  }
}

let papersCached: { sig: string, papers: PlanCard[] } | null = null

function readPapers(f: Fli, root: string, atlas: Atlas): PlanCard[] {
  const sig = signature(root, join(root, atlas.dir))
  if (papersCached?.sig === sig) return papersCached.papers
  const papers = atlas.ideas
    .filter(i => !i.at.file.includes('/shipped/'))
    .map(i => planCard(f, join(root, i.at.file), i.id))
    .filter((p): p is PlanCard => !!p?.next)
  papersCached = { sig, papers }
  return papers
}

/** The schedule through its one reader; a file it refuses is the refusal and no entries, drawn as such. */
function readSwitch(f: Fli, root: string): { schedule: Schedule | null, refused: string | null } {
  try { return { schedule: f.readSchedule({ root }), refused: null } } catch (err) { return { schedule: null, refused: (err as Error).message } }
}

/** The stressors the schedule lists, each `<dir>/<app>/PLAN.md`; a missing one is skipped. */
function readStressors(f: Fli, root: string, s: Schedule['stressors']): PlanCard[] {
  if (!s) return []
  const dir = isAbsolute(s.dir) ? s.dir : join(root, s.dir)
  const out: PlanCard[] = []
  for (const app of s.apps) {
    const file = join(dir, app, 'PLAN.md')
    if (!existsSync(file)) continue
    const card = planCard(f, file, app)
    if (card) out.push(card)
  }
  return out
}

/** `.cache/ci-last.txt` as `fli ci` leaves it. */
function readCi(root: string): Autopilot['ci'] {
  let lines: string[]
  try { lines = readFileSync(join(root, '.cache', 'ci-last.txt'), 'utf8').split('\n') } catch { return null }
  const verdict = lines.find(l => /CI (failed|passed)/.test(l)) ?? ''
  return {
    header:   (lines.find(l => l.startsWith('#')) ?? '').replace(/^#\s*/, ''),
    verdict:  verdict.trim(),
    green:    /passed/.test(verdict),
    phases:   lines.filter(l => /^\s+[✓✗]\s/.test(l)).map(l => l.trim()),
    failures: lines.filter(l => /^✗ /.test(l)).map(l => l.trim()),
  }
}

export async function readAutopilot(root: string): Promise<Autopilot> {
  const f     = await loadFli()
  const atlas = await readAtlas(root)
  const loop  = f.readLoopLog({ root })

  const byId  = new Map(atlas.issues.map(i => [i.id, i]))
  const table = (ids: string[], top: number): Table => {
    const rows = ids.map(id => byId.get(id)).filter((r): r is Issue => !!r)
    const bySeverity: Record<string, number> = {}
    for (const r of rows) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1
    return {
      count: rows.length, bySeverity,
      top: rows.slice(0, top).map(r => ({ id: r.id, pkg: r.pkg.join(', '), severity: r.severity, title: r.title })),
    }
  }

  const asked = (state: Question['state']) => atlas.questions.filter(q => q.state === state)
  const decidable = asked('decidable')
  const { schedule, refused } = readSwitch(f, root)
  const spent = f.spentToday(f.logFiles(FLI_DIR()).flatMap(l => f.readLog(l)))

  // A transcript's usage and report ride on every log line; the town needs
  // neither, and forty of them would be most of the payload.
  const attempts = loop.attempts.map(({ usage, report, sessionId, ...rest }) => rest)

  // The newest finished attempt at the row, which is what the patch holds.
  const lastOf = (row: string | null) => {
    const a = row ? loop.attempts.filter(x => x.id === row && x.outcome !== 'started').at(-1) : null
    return a ? { outcome: a.outcome, model: a.model as string | undefined, cost: a.cost as number | undefined, at: a.at as string } : null
  }
  const patches: DockPatch[] = loop.dock.patches.map(p => {
    const issue = p.row ? byId.get(p.row) : null
    return {
      ...p, title: issue?.title ?? null, severity: issue?.severity ?? null, status: issue?.status ?? null, last: lastOf(p.row),
      apply: f.applyArgv(root, `~/.fli/lanes/patches/${p.file}`).join(' '),
    }
  })

  return {
    ...loop,
    attempts,
    dock: { ...loop.dock, patches },
    registry: {
      ready:       table(atlas.ready, READY_TOP),
      blocked:     table(atlas.blocked, READY_TOP),
      busy:        { count: loop.lanes.filter(l => l.busy).length },
      closedToday: loop.events.filter(e => e.label === 'closed').length,
    },
    council: {
      open: asked('open').length, decidable: decidable.length, ruled: asked('ruled').length,
      bench: decidable.filter(q => q.recommend).slice(0, BENCH_TOP)
        .map(q => ({ id: q.id, question: q.question, recommend: q.recommend!.letter, paper: q.paper })),
    },
    plans: { papers: readPapers(f, root, atlas), stressors: readStressors(f, root, schedule?.stressors ?? null) },
    ci:    readCi(root),
    switch: {
      file:    '~/.fli/autopilot.json',
      exists:  schedule?.exists ?? refused !== null,
      on:      schedule?.on === true,
      refused, missing: schedule?.missing ?? [],
      day:     schedule?.day ?? null,
      spent,
      cap:     schedule ? f.overDayCap(schedule.day, spent) : null,
      entries: (schedule?.entries ?? []).map((e, i) => ({ ...e, running: runningOf(i) })),
      tick:    readTick(),
    },
  }
}

export function forgetAtlas() { cached = null; ringsCached = null; papersCached = null }

// ─── the queue ────────────────────────────────────────────────────────────────
//
// /atlas/decide/ is `fli decide`'s walk on a phone: the questions with
// lettered options, in the walk's order, one card each. Read off fli's
// `openDecisions` rather than the atlas, because a card needs the prose the
// question is argued in and the atlas's ranking (3s, git history) is nothing
// a card shows. A question an existing ruling settles is the walk's alone —
// confirming one is `fli decide --by`, which this screen does not offer.

export type Queued = {
  id: string, question: string, body: string, options: Option[], recommend: Recommend | null,
  paper: string | null, status: string, file: string, line: number,
}
export type Queue = { sections: string[], questions: Queued[], open: number }

let queued: { sig: string, queue: Queue } | null = null

export async function readQueue(root: string): Promise<Queue> {
  const f   = await loadFli()
  const sig = signature(root, f.registerLayout(root).dir)
  if (queued?.sig === sig) return queued.queue
  const queue = f.openDecisions(root)
  const out: Queue = {
    sections: f.rulingSections(root),
    open:     queue.open.length,
    questions: queue.decidable.map(q => ({
      id: q.id, question: q.question, body: q.body, options: q.options, recommend: q.recommend,
      paper: q.paper?.id ?? null, status: q.paper?.status ?? '', file: q.file, line: q.line,
    })),
  }
  queued = { sig, queue: out }
  return out
}

// ─── Claude explains a question ───────────────────────────────────────────────
//
// fli's `runAsk`, the read-only ask: `claude -p` with Read, Grep, Glob and a
// Bash allow-list, hooks off, a $2 budget — the argv keeps it read-only, not
// the prompt. Not the workbench: a send there joins the checkout's own chat,
// queues behind whatever it is running, and answers on another screen.
//
// Held in this process only. A restart loses an explanation, which costs one
// press; storing it would be a copy of a reply about files that move.

export type Turn = { ask: string | null, text: string, steps: number, doing: string }
export type Explanation = {
  id: string, state: 'working' | 'done' | 'error', turns: Turn[], cost: number, error: string | null, startedAt: string,
}

// Each run is a separate claude process on this laptop, and a swipe is cheap.
export const EXPLAINING_MAX = 3
const FOLLOW_MAX = 2000

const explanations = new Map<string, Explanation & { session: string | null }>()

export function explanationOf(id: string): Explanation | null {
  const held = explanations.get(id)
  if (!held) return null
  const { session, ...shown } = held
  return { ...shown, turns: held.turns.map(t => ({ ...t })) }
}

export function explainPrompt(q: Queued): string {
  return [
    'I am ruling on the open questions in this workspace one at a time, from my phone, and pressed "explain" on this one before picking.',
    '',
    `${q.id} — ${q.file}:${q.line}`,
    `**${q.question}** ${q.body}`.trim(),
    ...q.options.map(o => `- **${o.letter}** — ${o.text}`),
    q.recommend ? `- **Recommend ${q.recommend.qualifier ?? q.recommend.letter}** — ${q.recommend.why}` : '- No recommendation is written.',
    '',
    'You are read-only: Read, Grep, Glob, and git, rg and ls in Bash. Read the question where it is argued and what it cites — rulings in DECISIONS.md, rows in ISSUES.md, the code it names. Then explain, for someone choosing in the next minute:',
    '1. What is actually being decided, in two or three plain sentences.',
    '2. Each option: what changes if I pick it, what it costs, what it rules out.',
    '3. Whether the recommendation still holds against the code as it is now — cite file:line where it matters — and what would change your mind.',
    'Under 300 words. No preamble and no headings; the reply renders on a narrow card.',
  ].join('\n')
}

/**
 * Start explaining `q`, or ask a follow-up in the same session. A question
 * already being explained answers what it has so far rather than starting a
 * second run; one already explained answers that, until a follow-up asks
 * more. A press after a failed run starts over.
 */
export async function explain(root: string, q: Queued, input: { ask?: unknown, bin?: string }): Promise<Explanation | { refused: string }> {
  const follow = String(input.ask ?? '').trim()
  const was    = explanations.get(q.id)
  if (was?.state === 'working')            return explanationOf(q.id)!
  if (was?.state === 'done' && !follow)    return explanationOf(q.id)!
  const held = was?.state === 'error' && !follow ? undefined : was
  if (follow.length > FOLLOW_MAX) return { refused: `that is ${follow.length} characters; ${FOLLOW_MAX} is the limit` }
  const running = [...explanations.values()].filter(e => e.state === 'working').length
  if (running >= EXPLAINING_MAX) return { refused: `Claude is already explaining ${running} questions — wait for one to finish` }

  const f     = await loadFli()
  const entry: Explanation & { session: string | null } = held
    ?? { id: q.id, state: 'working', turns: [], cost: 0, error: null, startedAt: new Date().toISOString(), session: null }
  const turn: Turn = { ask: follow || null, text: '', steps: 0, doing: '' }
  const resume = held?.session ?? null
  const prompt = resume ? follow : follow ? `${explainPrompt(q)}\n\nAnd specifically: ${follow}` : explainPrompt(q)

  const run = f.runAsk({ root, prompt, session: resume, bin: input.bin, onEvent: e => {
    if (e.type === 'session') entry.session = e.id
    // Text before a tool call is narration ("let me read the paper"); the
    // last text block is the answer.
    if (e.type === 'text')    turn.text = e.text
    if (e.type === 'tool')    { turn.steps++; turn.doing = e.text }
    if (e.type === 'result' && !e.ok) entry.error = `Claude stopped before finishing (${e.stop ?? 'unknown'})`
    if (e.type === 'result')  entry.cost += e.cost ?? 0
    if (e.type === 'error')   entry.error = e.text
  } })
  if ('error' in run) return { refused: run.error }

  entry.state = 'working'
  entry.error = null
  entry.turns.push(turn)
  explanations.set(q.id, entry)
  run.done.then(code => { entry.state = entry.error || code ? 'error' : 'done' })
  return explanationOf(q.id)!
}

/** Every record holding `id`, of every kind — a ruling and the question it answered share one. */
export function recordsFor(atlas: Atlas, id: string) {
  const key = id.toLowerCase()
  const is  = (x: string | null | undefined) => !!x && x.toLowerCase() === key
  return {
    issues:    atlas.issues.filter(r => is(r.id) || r.aliases.some(is)),
    rulings:   atlas.rulings.filter(r => is(r.id)),
    questions: atlas.questions.filter(q => is(q.id)),
    ideas:     atlas.ideas.filter(i => is(i.id)),
  }
}

/** The ids `text` names that the registers hold, in the order they are written. */
export function namedIds(atlas: Atlas, text: string): string[] {
  const out  = new Set<string>()
  const word = atlas.prefix ? new RegExp(`\\b${atlas.prefix}-D?\\d+\\b`, 'gi') : null
  for (const m of word ? text.matchAll(word) : []) out.add(m[0].toUpperCase())
  // A paper's question id is `paper:slug`, which no prefix pattern reaches.
  for (const q of atlas.questions) if (q.state !== 'ruled' && text.includes(q.id)) out.add(q.id)
  return [...out].filter(id => {
    const r = recordsFor(atlas, id)
    return r.issues.length + r.rulings.length + r.questions.length + r.ideas.length > 0
  })
}

// ─── what Claude is handed ────────────────────────────────────────────────────

export const INTENTS = ['discuss', 'file', 'fix', 'frame'] as const
export type Intent = typeof INTENTS[number]

const TEXT_MAX = 20_000

/** One line per record, so Claude starts at the row rather than searching for it. */
function cite(atlas: Atlas, id: string): string[] {
  const r = recordsFor(atlas, id)
  const at = (a: At) => `${a.file}${a.line ? `:${a.line}` : ''}`
  return [
    ...r.issues.map(i => `- ${i.id} — issue, ${i.closed ? 'closed' : `${i.severity}, ${i.status}`} (${at(i.at)}): ${i.title}`),
    ...r.questions.map(q => `- ${q.id} — question, ${q.state} (${at(q.at)}): ${q.question}`),
    ...r.rulings.map(d => `- ${d.id} — ruling ${d.date}${d.status ? `, ${d.status}` : ''} (${at(d.at)}): ${d.title}`),
    ...r.ideas.map(i => `- ${i.id} — paper, ${i.status} (${at(i.at)}): ${i.title}`),
  ]
}

/**
 * The prompt for one send, or a refusal a person can act on.
 *
 * `fix` and `frame` are the repo's own skills, so the loop they run is the one
 * `fix:loop` and `frame:loop` run and not a second description of it here.
 * Each takes exactly one id, of the kind it works on.
 */
export function composePrompt(atlas: Atlas, input: { text?: unknown, intent?: unknown }): { prompt: string, ids: string[] } | { refused: string } {
  const text   = String(input.text ?? '').trim()
  const intent = String(input.intent ?? 'discuss') as Intent
  if (!INTENTS.includes(intent)) return { refused: `'${intent}' is not one of ${INTENTS.join(', ')}` }
  if (!text)                     return { refused: 'paste an issue, a question or an id first' }
  if (text.length > TEXT_MAX)    return { refused: `that is ${text.length} characters; ${TEXT_MAX} is the limit` }

  const ids   = namedIds(atlas, text)
  const notes = (id: string) => text.replace(id, '').trim()

  if (intent === 'fix') {
    const open = ids.filter(id => recordsFor(atlas, id).issues.some(i => !i.closed))
    if (open.length !== 1) return { refused: open.length ? `fix takes one open row, and this names ${open.join(', ')}` : 'fix takes the id of an open row — paste one, or discuss it first' }
    const rest = notes(open[0])
    return { ids, prompt: `/fix-next ${open[0]} --ask${rest ? `\n\nFrom the person who sent it:\n\n${rest}` : ''}` }
  }

  if (intent === 'frame') {
    const open = ids.filter(id => recordsFor(atlas, id).questions.some(q => q.state !== 'ruled'))
    if (open.length !== 1) return { refused: open.length ? `frame takes one open question, and this names ${open.join(', ')}` : 'frame takes the id of an open question' }
    const rest = notes(open[0])
    return { ids, prompt: `/frame-next ${open[0]}${rest ? `\n\nFrom the person who sent it:\n\n${rest}` : ''}` }
  }

  const named = ids.flatMap(id => cite(atlas, id))
  const head  = [
    text,
    '',
    '---',
    `Sent from Workbench's Atlas screen. The text above is about this workspace's registers — ISSUES.md, DECISIONS.md and IDEAS/ — and may be a row that exists or one that does not yet.`,
    ...(named.length ? ['', 'Records it names:', ...named] : []),
    '',
    'First place it: an existing row (read it at its line), a ruling that already settles it, or new. Search with `fli register:find <terms>` before calling it new — a duplicate is the likeliest outcome.',
  ]

  const tail = intent === 'file' ? [
    'Then write it down, and nothing else:',
    '- New: `fli register:file --sev <S1-S4|decision> --area <package> --title "…" --detail "…"`. Severity from the table headers in ISSUES.md; the detail cites file:line.',
    '- Already a row: `fli register:amend <id> --detail "…"` only where this adds a fact the row lacks.',
    '- Already settled by a ruling: write nothing and name the ruling.',
    'Change no source file. End with the id you wrote and one line on why that severity.',
  ] : [
    'Then talk it through with me. Change no file — not the registers, not the source — until I say which way.',
    '1. Does it still reproduce? Read the code and cite file:line, saying still present, looks fixed or unclear.',
    '2. What already governs it — the rulings and rows it cites, and the realm hazard skill where one applies.',
    '3. End with the options you see, lettered, a recommendation and why, and the next step each would be: file it, amend the row, frame it as a question, or fix it.',
  ]

  return { ids, prompt: [...head, ...tail].join('\n') }
}

/** A branch name for a send, from the first id it names. */
export function branchSlug(ids: string[], taken: (slug: string) => boolean): string {
  const base = (ids[0] ?? 'discuss').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'discuss'
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    if (!taken(slug)) return slug
  }
  return `${base}-${Date.now().toString(36)}`
}
