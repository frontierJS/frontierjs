// ─── loop-log.js — the loops' logs and the lanes directory, read once ────────
//
// `fix-loop`, `frame-loop`, `stress-loop`, `feed-loop` and Workbench's `post` append one jsonl line per event
// to ~/.fli (the names are `autopilot.js`'s `LOOPS`), and `fix-loop --lanes`
// keeps a worktree, a lock and a patch directory per lane beside them. `scripts/loop-review.mjs` and the Basecamp Atlas API both read
// them, and two readers pairing a finished attempt with its `started` line
// disagree the day one of them learns a new field. This is the only one.
//
// ── What a line means ────────────────────────────────────────────────────────
//
// A `started` line names its `lane`; one written before the loops did carries
// the row alone, and its lane is known only from the line that finishes it
// (`cwd` is the lane's worktree). A `harvest` line carries `lane` and `row`
// and no outcome. A row started and never finished (a killed run) stays a
// `started` line forever, so "busy" is read from the lane's lock, whose pid
// is alive, and not from the log alone. `source: 'autopilot'` marks a
// scheduled run; a hand run names none. A stress line names `app` and `step`
// (its `id` is the two joined) and a finished one carries `filed`, the
// register ids its session added, which is how the day's filed rows are
// counted against the stress cap. A post line names the question `id` and is
// `asked`, then `ruled` or `refused` (a ruling carries `ruling`, a refusal
// `why`); it costs nothing. A feed line names its `feeder` and, when
// finished, `filed` and `amended` the same way; it costs nothing.
//
// Plain ESM, node or bun. Imports nothing from `scripts/`: this package is
// published and `scripts/` imports from it.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { basename, join }                                  from 'node:path'
import { stateDir }                                        from './paths.js'

import { LOOPS } from './autopilot.js'

const DAY_MS = 864e5
const LANES  = 5

/** Entries of a jsonl file, in order; a line that does not parse is skipped, and a missing file is []. */
export function readLog(file) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

/**
 * Every finished attempt in `entries`: a line with an outcome other than
 * `started` and a `cost`. `startedAt` is the `at` of the last earlier
 * `started` line for the same id, which an attempt older than that line lacks.
 */
export function finishedAttempts(entries) {
  const out = []
  for (const [i, e] of entries.entries()) {
    if (e.outcome === 'started' || e.cost === undefined) continue
    const start = entries.slice(0, i).findLast(s => s.id === e.id && s.outcome === 'started')
    out.push({ ...e, startedAt: start?.at })
  }
  return out
}

const ms = (v, fallback) => {
  if (v === undefined || v === null) return fallback
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : fallback
}

const short = e => {
  const { report, usage, phases, sessionId, ...rest } = e
  const tail = report ? ' · ' + report.trim().split('\n').filter(Boolean).at(-1) : ''
  return JSON.stringify(rest) + tail
}

const withSource = (e, ev) => e.source ? { ...ev, source: e.source } : ev

const alive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }

// The headings under which scripts/loop-review.mjs names what repeats across
// sessions; the rest of its report is cost and outcome tables. Renaming one
// there drops its lines here silently, which packages/cli/test/loop-log.test.js
// is the only check on.
const REPEAT_HEADINGS = ['Files most sessions read', 'Calls that fail', 'The same call twice in one session', 'Denied tool calls']
const REPEAT_LINES_PER_HEADING = 2

/** The review's top-level bullets under each repeat heading, as `heading: bullet`, two per heading. */
export function repeatedIn(text) {
  const out = []
  let heading = null, taken = 0
  for (const line of text.split('\n')) {
    const h = /^##+ (.+)$/.exec(line)
    if (h) { heading = REPEAT_HEADINGS.includes(h[1].trim()) ? h[1].trim() : null; taken = 0; continue }
    if (!heading || taken >= REPEAT_LINES_PER_HEADING || !line.startsWith('- ')) continue
    out.push(`${heading}: ${line.slice(2).trim()}`)
    taken++
  }
  return out
}

/**
 * The town's raw material: the last 24 hours ending at `until` (default now),
 * or from `since` when one is given. `root` names the repo whose lanes these
 * are (`<logDir>/lanes/<basename(root)>-N`); `logDir` defaults to ~/.fli.
 */
export function readLoopLog({ logDir = stateDir(), root, since, until } = {}) {
  const name  = root ? basename(root) : 'frontierjs'
  const end   = ms(until, Date.now())
  const start = ms(since, end - DAY_MS)
  const within = e => { const t = Date.parse(e.at); return t > start && t <= end }

  const fix    = readLog(join(logDir, LOOPS.fix.log))
  const frame  = readLog(join(logDir, LOOPS.frame.log))
  const stress = readLog(join(logDir, LOOPS.stress.log))
  const feed   = readLog(join(logDir, LOOPS.feed.log))
  const post   = readLog(join(logDir, LOOPS.post.log))
  const lanesDir = join(logDir, 'lanes')

  const laneOf = e => {
    const m = new RegExp(`lanes/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)`).exec(e?.cwd ?? '')
    if (m) return `lane.${m[1]}`
    return Number.isInteger(e?.lane) ? `lane.${e.lane}` : null
  }

  // ── fix-loop lines → row events ──
  const day    = fix.filter(within)
  const events = []
  const counts = { started: 0, closed: 0, blocked: 0, failed: 0, busy: 0, corrected: 0, harvest: 0, other: 0 }
  day.forEach((e, i) => {
    const t = e.at
    if (e.harvest) {
      counts.harvest++
      const w = e.harvest.written?.length ?? 0, c = e.harvest.conflicts?.length ?? 0
      events.push(withSource(e, { t, kind: 'row', id: e.row, from: `lane.${e.lane}`, to: 'dock', label: `harvest ${w} file${w === 1 ? '' : 's'}${c ? `, ${c} conflict` : ''}`, cost: null, log: short(e) }))
      return
    }
    const o = e.outcome
    counts[o in counts ? o : 'other']++
    if (o === 'started') {
      const finish = day.slice(i + 1).find(x => x.id === e.id && x.outcome && x.outcome !== 'started')
      const lane   = laneOf(e) ?? laneOf(finish) ?? 'lane.1'
      events.push(withSource(e, { t, kind: 'row', id: e.id, from: 'registry.ready', to: lane, label: `started · ${e.severity} · ${e.model}·${e.effort}`, cost: null, sev: e.severity, model: e.model, effort: e.effort, log: short(e) }))
      return
    }
    const lane = laneOf(e) ?? 'lane.1'
    const base = { t, kind: 'row', id: e.id, from: lane, cost: e.cost ?? null, turns: e.turns ?? null, minutes: e.minutes ?? null, sev: e.severity, model: e.model, effort: e.effort, log: short(e) }
    const push = ev => events.push(withSource(e, ev))
    if (o === 'closed') push({ ...base, to: 'dock', label: 'closed' })
    else if (o === 'blocked') {
      push({ ...base, to: 'registry.blocked', label: 'blocked' })
      push({ t, kind: 'question', id: e.id, from: 'registry.blocked', to: 'council.open', label: 'filed a ruling', cost: null, log: short(e) })
    } else if (o === 'busy') push({ ...base, to: 'registry.busy', label: 'busy: tree held' })
    else if (o === 'failed') push({ ...base, to: 'registry.ready', label: 'failed, back to ready' })
    else if (o === 'corrected') push({ ...base, to: 'registry.ready', label: 'corrected: marker misread' })
    else push({ ...base, to: 'registry.ready', label: o })
  })
  const fixEvents = [...events]

  // ── frame-loop lines → paper and question events ──
  const frameDay = frame.filter(within)
  for (const e of frameDay) {
    if (e.outcome === 'started') { events.push(withSource(e, { t: e.at, kind: 'paper', id: e.id, from: 'plans', to: 'framing', label: `framing ${e.questions?.length ?? 0} question(s)`, cost: null, log: short(e) })); continue }
    for (const [q, out] of Object.entries(e.outcomes ?? {})) {
      events.push(withSource(e, { t: e.at, kind: 'question', id: q, from: 'framing', to: out === 'framed' ? 'council.bench' : out === 'settled' ? 'council.wall' : 'council.open', label: out, cost: e.cost ?? null, log: short(e) }))
    }
  }

  // ── stress-loop lines → site and filed-row events ──
  // A step goes from the Plan office to the Proving ground and back; each row
  // its session filed is a crate from the ground to the Registry, or a question
  // to the Council when the id is a D.
  const stressDay = stress.filter(within)
  const isQ = row => /-D\d+$/.test(row)
  for (const e of stressDay) {
    const id = e.id ?? `${e.app} ${e.step}`
    if (e.outcome === 'started') { events.push(withSource(e, { t: e.at, kind: 'paper', id, from: 'plans', to: 'proving', label: `stress ${id} · ${e.model}·${e.effort}`, cost: null, log: short(e) })); continue }
    events.push(withSource(e, { t: e.at, kind: 'paper', id, from: 'proving', to: 'plans', label: e.outcome, cost: e.cost ?? null, turns: e.turns ?? null, minutes: e.minutes ?? null, log: short(e) }))
    for (const row of e.filed ?? []) events.push(withSource(e, { t: e.at, kind: isQ(row) ? 'question' : 'row', id: row, from: 'proving', to: isQ(row) ? 'council.open' : 'registry.ready', label: `filed by stress ${id}`, cost: null, log: short(e) }))
  }

  // ── feed-loop lines → filed-row events ──
  // A feeder runs no session and moves nothing on the map but what it filed:
  // each row a crate from the Proving ground, where CI's gate stands, to the Registry.
  const feedDay = feed.filter(within)
  for (const e of feedDay) {
    for (const row of e.filed ?? []) events.push(withSource(e, { t: e.at, kind: isQ(row) ? 'question' : 'row', id: row, from: 'proving', to: isQ(row) ? 'council.open' : 'registry.ready', label: `filed by the ${e.feeder} feeder`, cost: null, log: short(e) }))
  }
  // ── post-loop lines → question events ──
  // An ask is a question out of the Council's bench to the Post, and what comes
  // back is a ruling to the wall or a refusal to the bench it left.
  const postDay = post.filter(within)
  for (const e of postDay) {
    if (typeof e.id !== 'string') continue // a refused reply that named no question
    const [from, to] = e.outcome === 'asked' ? ['council.bench', 'post'] : e.outcome === 'ruled' ? ['post', 'council.wall'] : ['post', 'council.bench']
    events.push(withSource(e, { t: e.at, kind: 'question', id: e.id, from, to, label: e.outcome, cost: null, log: short(e) }))
  }
  events.sort((a, b) => a.t.localeCompare(b.t))

  // A frame line's cost repeats on each of its question events, so spend is
  // summed from the lines: summing events would count a four-question line four times.
  const attempts = finishedAttempts(fix).filter(within)
  const spend    = +[...attempts, ...frameDay.filter(e => e.outcome !== 'started'), ...stressDay.filter(e => e.outcome !== 'started')].reduce((s, e) => s + (e.cost ?? 0), 0).toFixed(2)

  // ── lanes ──
  const dirs = existsSync(lanesDir) ? readdirSync(lanesDir) : []
  const lanes = []
  for (let n = 1; n <= LANES; n++) {
    const id   = `lane.${n}`
    const mine = fix.filter(e => laneOf(e) === id)
    const last = mine.filter(e => e.outcome && e.outcome !== 'started').at(-1)
    const evs  = fixEvents.filter(e => e.from === id || e.to === id)
    const cost = evs.filter(e => e.from === id && e.cost != null).reduce((s, e) => s + e.cost, 0)

    // The log's reading: this lane's newest line is a start nothing has finished.
    const tail = mine.at(-1)
    const logBusy = !!tail && tail.outcome === 'started' && !fix.some(x => x.id === tail.id && x.outcome && x.outcome !== 'started' && x.at > tail.at)
    // The lock's reading: fix-loop writes its pid, and a killed run leaves a dead one.
    let lockBusy = false
    try { lockBusy = alive(Number(readFileSync(join(lanesDir, `${name}-${n}.lock`), 'utf8'))) } catch {}

    lanes.push({
      id, dir: `${name}-${n}`, exists: dirs.includes(`${name}-${n}`),
      last: last ? { row: last.id, outcome: last.outcome, at: last.at, model: last.model, effort: last.effort, cost: last.cost, turns: last.turns } : null,
      attemptsToday: evs.filter(e => e.to === id).length,
      closedToday: evs.filter(e => e.from === id && e.label === 'closed').length,
      spendToday: +cost.toFixed(2),
      busy: logBusy || lockBusy,
    })
  }

  // ── frame, dock, review ──
  const lastFrameAt = frame.at(-1)?.at ?? null
  const patchDir = join(lanesDir, 'patches')
  const all = existsSync(patchDir) ? readdirSync(patchDir) : []
  const patches = all.filter(f => f.endsWith('.patch')).map(file => {
    let at = null, text = ''
    try { at = statSync(join(patchDir, file)).mtime.toISOString(); text = readFileSync(join(patchDir, file), 'utf8') } catch {}
    const lines = text.split('\n')
    return {
      file, row: /[A-Za-z]+-D?\d+/.exec(file)?.[0] ?? null, at,
      files:   lines.filter(l => l.startsWith('diff --git ')).length,
      added:   lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
      removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
    }
  })
  const reviewFile = join(logDir, 'fix-loop-review.md')
  let review = null
  if (existsSync(reviewFile)) {
    const text = readFileSync(reviewFile, 'utf8')
    review = { modified: statSync(reviewFile).mtime.toISOString(), head: text.split('\n').filter(l => l.trim()).slice(0, 14), repeated: repeatedIn(text) }
  }

  return {
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    attempts,
    events,
    counts: { events: events.length, fixLines: day.length, frameLines: frameDay.length, stressLines: stressDay.length, feedLines: feedDay.length, postLines: postDay.length, ...counts, spend },
    spend,
    lanes,
    frame: { linesToday: frameDay.length, lastAt: lastFrameAt, lastDay: lastFrameAt ? lastFrameAt.slice(0, 10) : null, total: frame.length, framedAllTime: frame.filter(e => e.outcome === 'framed').length },
    stress: {
      linesToday: stressDay.length, lastAt: stress.at(-1)?.at ?? null, total: stress.length,
      tickedAllTime: stress.filter(e => e.outcome === 'ticked').length,
      filedToday: stressDay.reduce((s, e) => s + (e.filed?.length ?? 0), 0),
    },
    dock: {
      patches, dirs: all.filter(f => !f.endsWith('.patch')),
      harvestsToday: counts.harvest,
      filesHarvestedToday: day.filter(e => e.harvest).reduce((s, e) => s + (e.harvest.written?.length ?? 0), 0),
    },
    review,
  }
}
