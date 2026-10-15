// src/errand.js — `#errand` in the terminal: what the tavern's runner carries
// in (`components/Runner.mesa`). A browser takes `errand.browser.js`.
//
// The errand comes from a command on THIS machine, run through `sh -c` and
// printing one errand as JSON, `{ id, title, url }`, or nothing. The command
// is `HAVEN_ERRAND`, else the contents of `~/.fli/haven/errand`, set once.
// Haven knows no source: the command is a `basecamp … --jq` today and a
// `claude -p` tomorrow. Neither set, no runner comes. An installed Haven runs
// on every machine that walks in, and without the opt-in it would run a
// stranger's `basecamp` on each.
//
// The bar's board (`components/Bar.mesa`) is the same opt-in a second time:
// `HAVEN_BAR`, else `~/.fli/haven/bar`, a command printing a list of
// `{ text, when? }` — the member's latest activity, newest first —
// read when a figure sits on a stool.
//
// A delivered errand is kept in `~/.fli/haven/errands.json` for a day, beside
// `key.json`, so the same ticket does not send the boy in on every visit.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const ERRANDS_FILE = join(homedir(), '.fli', 'haven', 'errands.json')
export const COMMAND_FILE = join(homedir(), '.fli', 'haven', 'errand')
export const BAR_FILE = join(homedir(), '.fli', 'haven', 'bar')

const DAY = 24 * 60 * 60 * 1000

// A `claude -p` takes tens of seconds; the route leaving aborts it sooner.
const run = (cmd, signal) => new Promise((resolve, reject) => {
  execFile('sh', ['-c', cmd], { signal, timeout: 120_000, maxBuffer: 1 << 20 }, (err, out) => (err ? reject(err) : resolve(out)))
})

/** The ids delivered within the last day, `{ [id]: iso }`; an unreadable file is none. */
function delivered(file, now) {
  try {
    const all = JSON.parse(readFileSync(file, 'utf8')).delivered ?? {}
    return Object.fromEntries(Object.entries(all).filter(([, at]) => now - Date.parse(at) < DAY))
  } catch {
    return {}
  }
}

/** An env var, else the one line in a file; '' when neither. */
function optIn(env, file) {
  if (env) return env
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/** This machine's opt-in: `HAVEN_ERRAND`, else the one line in `~/.fli/haven/errand`; '' when neither. */
export const errandCommand = ({ env = process.env.HAVEN_ERRAND, file = COMMAND_FILE } = {}) => optIn(env, file)

/** The bar's opt-in: `HAVEN_BAR`, else the one line in `~/.fli/haven/bar`; '' when neither. */
export const barCommand = ({ env = process.env.HAVEN_BAR, file = BAR_FILE } = {}) => optIn(env, file)

/** The errand to carry in, or null: no command, nothing printed, or delivered within the day. */
export async function nextErrand({ signal, cmd = errandCommand(), file = ERRANDS_FILE, now = Date.now() } = {}) {
  if (!cmd) return null
  const out = String(await run(cmd, signal)).trim()
  if (!out || out === 'null') return null
  const e = JSON.parse(out)
  if (e?.id == null || !e.title) throw new Error(`HAVEN_ERRAND printed no { id, title }: ${out.slice(0, 80)}`)
  const id = String(e.id)
  if (delivered(file, now)[id]) return null
  return { id, title: String(e.title), url: e.url ? String(e.url) : '' }
}

/** Remember this errand as delivered, so the runner does not bring it again today. */
export function markDelivered(id, { file = ERRANDS_FILE, now = Date.now() } = {}) {
  const keep = delivered(file, now)
  keep[id] = new Date(now).toISOString()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ delivered: keep }, null, 2) + '\n')
}

/** The board's rows, `{ text, when }` newest first, or null when this machine opted into none. A row with no text, or output that is no list, throws. */
export async function barActivity({ signal, cmd = barCommand() } = {}) {
  if (!cmd) return null
  const out = String(await run(cmd, signal)).trim()
  const rows = out ? JSON.parse(out) : []
  if (!Array.isArray(rows) || rows.some((r) => !r?.text)) throw new Error(`HAVEN_BAR printed no list of { text }: ${out.slice(0, 80)}`)
  return rows.map((r) => ({ text: String(r.text), when: r.when ? String(r.when) : '' }))
}

// ─── a home's board ─────────────────────────────────────────────────────────
//
// The third opt-in: `HAVEN_HOME`, else `~/.fli/haven/home`, a command printing
// one board — `{ home, pins, inbox, pings, due }` (`components/HomeBoard.mesa`,
// `scripts/basecamp-home.mjs` the one source so far). The board names the home
// it hangs in, and is drawn in that home alone: every member's machine runs its
// own command, so without the name a visitor's account would paint itself onto
// the host's walls.

export const HOME_FILE = join(homedir(), '.fli', 'haven', 'home')

/** The home board's opt-in: `HAVEN_HOME`, else the one line in `~/.fli/haven/home`; '' when neither. */
export const homeCommand = ({ env = process.env.HAVEN_HOME, file = HOME_FILE } = {}) => optIn(env, file)

const HOME_MS = 60_000
let held = null

const text = (v) => (v == null ? '' : String(v))
const listOf = (v, row) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object').map(row) : [])

/** A board as printed, its rows cut to the fields the board draws; output with no `home` slug throws. */
export function readBoard(out) {
  const b = out ? JSON.parse(out) : null
  if (!b || typeof b !== 'object' || !/^[a-z]+$/.test(b.home ?? '')) throw new Error(`HAVEN_HOME printed no { home, … }: ${String(out).slice(0, 80)}`)
  const line = (r) => ({ project: text(r.project), who: text(r.who), text: text(r.text), when: text(r.when), unread: !!r.unread })
  return {
    home:  b.home,
    pins:  listOf(b.pins, (r) => ({ name: text(r.name), when: text(r.when), fresh: Number(r.fresh) || 0 })).filter((r) => r.name),
    inbox: listOf(b.inbox, line).filter((r) => r.text),
    pings: listOf(b.pings, line).filter((r) => r.text),
    due:   listOf(b.due, (r) => ({ project: text(r.project), text: text(r.text), when: text(r.when) })).filter((r) => r.text),
  }
}

/**
 * This machine's board, or null when it opted into none. Held `HOME_MS`, so the
 * lane's mailboxes and the home behind them ask the command once between them;
 * a failure is not held, so the next scene asks again.
 */
export function homeBoard({ signal, cmd = homeCommand(), now = Date.now() } = {}) {
  if (!cmd) return Promise.resolve(null)
  if (held && held.cmd === cmd && now - held.at < HOME_MS) return held.board
  const board = run(cmd, signal).then((out) => readBoard(String(out).trim()))
  held = { cmd, at: now, board }
  board.catch(() => { if (held?.board === board) held = null })
  return board
}
