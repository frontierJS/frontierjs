// ─── autopilot.js — ~/.fli/autopilot.json, the loops' schedule, read once ────
//
// IDEAS/autopilot.md: the loops this repo already has (`scripts/fix-loop.mjs`,
// `frame-loop.mjs`) run on a schedule a person writes. The file is fli's and
// machine-local, beside the logs, never a Basecamp setting: a checkout can sit
// on another host from a Basecamp, and the caps must hold with Basecamp down.
// The scripts read it themselves on `--source autopilot` (`scripts/headless.mjs`)
// and the Basecamp Atlas draws it as the Switch; two readers of one file
// disagree the day one learns a field, so this is the only one.
//
// ── The shape ────────────────────────────────────────────────────────────────
//
//   {
//     "on": false,
//     "day": { "attempts": 20, "dollars": 20 },
//     "entries": [
//       { "loop": "fix",   "cron": "0 1 * * *", "caps": { "rows": 6, "lanes": 2, "budget": 5, "sev": "S3,S4", "model": "sonnet" } },
//       { "loop": "frame", "cron": "0 0 * * *", "caps": { "rows": 2, "max": 4, "budget": 5 } }
//     ],
//     "stressors": { "dir": "../fjs-prototypes", "apps": ["serpgrid"] }
//   }
//
// An entry's caps ARE the script's own flags (`--rows`, `--lanes`, …), never a
// new one (FJS-D1777, FJS-D1778). `model` is a ceiling: `sonnet` pins that
// rung and `opus` leaves the ladder as it is. `day` is the file's own cap, read
// by the script before each attempt and by the tick job before each start. No
// cap has a default (FJS-D1778): one not set is listed in `missing`, and Turn
// On is refused while anything is.
//
// Plain ESM, node or bun; imports nothing from `scripts/`.

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir }      from 'node:os'
import { join }         from 'node:path'

import { MAX_BRANCH } from './ports.js'

export const SCHEDULE_FILE = join(homedir(), '.fli', 'autopilot.json')

/** The one value `--source` takes: a scheduled run is a hand run in the log plus this field. */
export const SOURCE = 'autopilot'

/** A lane is a linked worktree, and ports.js has this many port blocks for them. */
export const MAX_LANES = MAX_BRANCH

const int    = (v, min = 1) => Number.isInteger(v) && v >= min
const money  = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const SEV    = /^S[1-4](,S[1-4])*$/
const MODELS = ['sonnet', 'opus']

/**
 * The loops autopilot runs, each with the caps its script takes. `check`
 * answers why a value is refused, or nothing. `rungs` is the most budgets one
 * row can spend: a ladder's second rung is capped at twice the first.
 */
export const LOOPS = {
  fix: {
    script: 'scripts/fix-loop.mjs',
    caps: {
      rows:   { check: v => int(v) ? null : 'a whole number of rows, at least 1' },
      lanes:  { check: v => int(v) && v <= MAX_LANES ? null : `a whole number of lanes, 1 to ${MAX_LANES}` },
      budget: { check: v => money(v) ? null : 'dollars per session, above 0' },
      sev:    { check: v => typeof v === 'string' && SEV.test(v) ? null : 'severities as the script takes them, like S3,S4' },
      model:  { check: v => MODELS.includes(v) ? null : `one of ${MODELS.join(', ')}` },
    },
    rungs: caps => caps.model === 'sonnet' ? 1 : 3,
  },
  frame: {
    script: 'scripts/frame-loop.mjs',
    caps: {
      rows:   { check: v => int(v) ? null : 'a whole number of papers, at least 1' },
      max:    { check: v => int(v) ? null : 'a whole number of questions per paper, at least 1' },
      budget: { check: v => money(v) ? null : 'dollars per session, above 0' },
    },
    rungs: () => 3,
  },
}

const CRON_FIELD = /^(\*|[0-9]+)(-[0-9]+)?(\/[0-9]+)?(,(\*|[0-9]+)(-[0-9]+)?(\/[0-9]+)?)*$/

/** Five fields of numbers, ranges, steps and lists; whether it ever fires is the tick job's parser. */
export function cronShape(line) {
  const fields = typeof line === 'string' ? line.trim().split(/\s+/) : []
  return fields.length === 5 && fields.every(f => CRON_FIELD.test(f))
}

/** The flags an entry hands its script, `--source autopilot` last. */
export function flagsOf(entry) {
  const out = []
  for (const [cap, value] of Object.entries(entry.caps ?? {})) {
    if (cap === 'model') { if (value !== 'opus') out.push('--model', String(value)); continue }
    out.push(`--${cap}`, String(value))
  }
  return [...out, '--source', SOURCE]
}

/** The most one run of the entry can spend: rows × budget × the rungs a row may climb. */
export function worstCost(entry) {
  const { rows, budget } = entry.caps ?? {}
  if (!int(rows) || !money(budget)) return null
  return +(rows * budget * LOOPS[entry.loop].rungs(entry.caps)).toFixed(2)
}

/**
 * The file, checked: `{ file, exists, on, day, entries, stressors, missing }`,
 * each entry with its `flags` and `worst`. A missing file is one with nothing
 * set. A file that is not JSON, an unknown loop or cap, a cap of the wrong
 * shape, or an entry whose worst run is over the day's cap THROWS, naming the
 * entry: a schedule half read would run half of what was written.
 */
export function readSchedule({ file = SCHEDULE_FILE } = {}) {
  let text
  try { text = readFileSync(file, 'utf8') }
  catch { return { file, exists: false, on: false, day: null, entries: [], stressors: null, missing: ['day.attempts', 'day.dollars'] } }

  let raw
  try { raw = JSON.parse(text) } catch (err) { throw new Error(`${file} is not JSON: ${err.message}`) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} holds ${Array.isArray(raw) ? 'a list' : typeof raw}, not an object`)
  if (raw.on !== undefined && typeof raw.on !== 'boolean') throw new Error(`${file}: "on" is ${JSON.stringify(raw.on)}, not true or false`)

  const missing = []
  let day = null
  if (raw.day !== undefined) {
    if (!raw.day || typeof raw.day !== 'object') throw new Error(`${file}: "day" is not an object of attempts and dollars`)
    for (const key of Object.keys(raw.day)) if (!['attempts', 'dollars'].includes(key)) throw new Error(`${file}: day.${key} is not a day cap; the day caps are attempts and dollars`)
    if (raw.day.attempts !== undefined && !int(raw.day.attempts)) throw new Error(`${file}: day.attempts is ${JSON.stringify(raw.day.attempts)}, not a whole number of attempts above 0`)
    if (raw.day.dollars !== undefined && !money(raw.day.dollars)) throw new Error(`${file}: day.dollars is ${JSON.stringify(raw.day.dollars)}, not dollars above 0`)
    day = { attempts: raw.day.attempts ?? null, dollars: raw.day.dollars ?? null }
  }
  if (day?.attempts == null) missing.push('day.attempts')
  if (day?.dollars == null) missing.push('day.dollars')

  if (raw.entries !== undefined && !Array.isArray(raw.entries)) throw new Error(`${file}: "entries" is not a list`)
  const entries = (raw.entries ?? []).map((e, i) => {
    const where = `${file}: entry ${i + 1}`
    if (!e || typeof e !== 'object') throw new Error(`${where} is not an object of loop, cron and caps`)
    const loop = LOOPS[e.loop]
    if (!loop) throw new Error(`${where}: '${e.loop}' is not a loop autopilot runs; it runs ${Object.keys(LOOPS).join(', ')}`)
    if (!cronShape(e.cron)) throw new Error(`${where} (${e.loop}): cron ${JSON.stringify(e.cron)} is not five fields of numbers, ranges, steps and lists`)
    const caps = e.caps ?? {}
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new Error(`${where} (${e.loop}): "caps" is not an object`)
    for (const [cap, value] of Object.entries(caps)) {
      const known = loop.caps[cap]
      if (!known) throw new Error(`${where} (${e.loop}): '${cap}' is not a cap ${e.loop} takes; it takes ${Object.keys(loop.caps).join(', ')}`)
      const why = known.check(value)
      if (why) throw new Error(`${where} (${e.loop}): ${cap} is ${JSON.stringify(value)}, not ${why}`)
    }
    for (const cap of Object.keys(loop.caps)) if (!(cap in caps)) missing.push(`entries[${i}].caps.${cap}`)

    const entry = { loop: e.loop, cron: e.cron.trim(), caps: { ...caps } }
    const worst = worstCost(entry)
    if (day?.attempts != null && int(caps.rows) && caps.rows > day.attempts)
      throw new Error(`${where} (${e.loop}): ${caps.rows} rows in one run is over the day's ${day.attempts} attempts`)
    if (day?.dollars != null && worst != null && worst > day.dollars)
      throw new Error(`${where} (${e.loop}): its worst run is $${worst} (${caps.rows} rows × $${caps.budget} × ${loop.rungs(caps)} rung${loop.rungs(caps) === 1 ? '' : 's'}), over the day's $${day.dollars}`)
    return { ...entry, flags: flagsOf(entry), worst }
  })

  let stressors = null
  if (raw.stressors !== undefined) {
    const s = raw.stressors
    if (!s || typeof s !== 'object' || typeof s.dir !== 'string' || !Array.isArray(s.apps) || !s.apps.every(a => typeof a === 'string' && /^[\w.-]+$/.test(a)))
      throw new Error(`${file}: "stressors" is not { dir, apps: [names] }`)
    stressors = { dir: s.dir, apps: [...s.apps] }
  }

  return { file, exists: true, on: raw.on === true, day, entries, stressors, missing }
}

/**
 * What the schedule has spent today, off the loops' log lines: an attempt is
 * a `started` line with `source: autopilot`, and the dollars are what the
 * finished ones cost. Today is the machine's calendar day, which is the day
 * the cron lines are written in.
 */
export function spentToday(lines, { now = new Date() } = {}) {
  const today = now.toDateString()
  const mine  = lines.filter(e => e.source === SOURCE && e.at && new Date(e.at).toDateString() === today)
  return {
    attempts: mine.filter(e => e.outcome === 'started').length,
    dollars:  +mine.reduce((s, e) => s + (typeof e.cost === 'number' ? e.cost : 0), 0).toFixed(2),
  }
}

/** Why one more attempt is over the day's cap, or null while it is under. */
export function overDayCap(day, spent) {
  if (!day) return 'no day cap is set'
  if (day.attempts == null || day.dollars == null) return `the day's ${day.attempts == null ? 'attempts' : 'dollars'} cap is not set`
  if (spent.attempts >= day.attempts) return `today's ${spent.attempts} attempts reach the day's cap of ${day.attempts}`
  if (spent.dollars >= day.dollars) return `today's $${spent.dollars} reaches the day's cap of $${day.dollars}`
  return null
}

/**
 * Turn the file's switch. On is refused while the file is missing or any cap
 * is unset (FJS-D1778), and a file the reader refuses is refused here first;
 * the rest of the file is written back as it was read. Off writes `false` and
 * nothing else: a run already going is the loop's own, and the tick job
 * starts nothing new while it reads false.
 */
export function writeSwitch({ file = SCHEDULE_FILE, on } = {}) {
  if (typeof on !== 'boolean') throw new Error(`the switch takes true or false, not ${JSON.stringify(on)}`)
  const before = readSchedule({ file })
  if (!before.exists) throw new Error(`${file} does not exist; write it with every cap set before turning it ${on ? 'on' : 'off'}`)
  if (on && before.missing.length) throw new Error(`Turn On waits on ${before.missing.length} cap${before.missing.length === 1 ? '' : 's'} not set: ${before.missing.join(', ')}`)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  // Whole or not at all: the owner edits this file by hand, and a half-written one reads as refused.
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...raw, on }, null, 2) + '\n')
  renameSync(`${file}.tmp`, file)
  return readSchedule({ file })
}
