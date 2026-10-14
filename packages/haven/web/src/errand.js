// src/errand.js — `#errand` in the terminal: what the tavern's runner carries
// in (`components/Runner.mesa`). A browser takes `errand.browser.js`.
//
// The errand comes from a command on THIS machine, `HAVEN_ERRAND`, run through
// `sh -c` and printing one errand as JSON, `{ id, title, url }`, or nothing.
// Haven knows no source: the command is a `basecamp … --jq` today and a
// `claude -p` tomorrow. Unset, no runner comes. An installed Haven runs on
// every machine that walks in, and without the opt-in it would run a
// stranger's `basecamp` on each.
//
// A delivered errand is kept in `~/.fli/haven/errands.json` for a day, beside
// `key.json`, so the same ticket does not send the boy in on every visit.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const ERRANDS_FILE = join(homedir(), '.fli', 'haven', 'errands.json')

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

/** The errand to carry in, or null: no command, nothing printed, or delivered within the day. */
export async function nextErrand({ signal, cmd = process.env.HAVEN_ERRAND, file = ERRANDS_FILE, now = Date.now() } = {}) {
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
