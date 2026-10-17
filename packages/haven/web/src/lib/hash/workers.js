// src/workers.js — `#workers` in the terminal: the Claude sessions working
// on THIS machine, which the workshop draws at their packages' benches
// (`components/Workers.mesa`, `IDEAS/haven.md` Phase 11). A browser takes
// `workers.browser.js`.
//
// A session is one file, `~/.fli/haven/workers/<session>.json`, written by
// the hook in `.claude/hooks/haven-worker.mjs` on each event Claude Code
// hands it, through `recordWorker()` — so the shape has one owner, this file.
// An edit seats the session at its bench; a permission prompt raises its
// hand; a stop leaves its last words; anything else means it is working
// again. Every field read is in the hook's documented input — Claude's
// transcripts say the same and were not used: their shape is Claude Code's
// to change.
//
// Nothing here is sent. A worker is drawn on the screen of the machine whose
// directory it is in, the way the tavern's runner is.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

export const WORKERS_DIR = join(homedir(), '.fli', 'haven', 'workers')

/** A session with no event for this long has left its bench — unless it is asking, since then it is waiting on you. */
export const QUIET_MS = 10 * 60 * 1000

// A file left by a session that ended without a SessionEnd (a killed
// terminal) is deleted by the next write, so the directory does not grow
// with every session the machine has run, and a hand left raised comes down.
const KEEP_MS = 24 * 60 * 60 * 1000

/**
 * The notifications a session is stopped on until you answer: a permission
 * prompt, or a question put to you. `idle_prompt` is not one — it follows a
 * stop, whose last words already say the session is done.
 */
export const ASKS = new Set(['permission_prompt', 'worker_permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])

/** The most of a session's last reply kept: its first line that says something. */
export const WORDS = 160

/** The first line of `text` with words in it, markdown's marks stripped, cut to WORDS. */
export function lastWords(text) {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/^[\s#>|*-]+/, '').replace(/[*`]/g, '').trim()).find(Boolean) ?? ''
  return line.length > WORDS ? `${line.slice(0, WORDS - 1)}…` : line
}

/** The bench a file is edited at: `packages/<name>/…` is `<name>`, `example/…` is `example`, the rest of the repo is `frontierjs`; outside the repo, none. */
export function benchOf(file, root) {
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return null
  const [top, name, ...rest] = rel.split(sep)
  if (top === 'packages' && rest.length) return name
  if (top === 'example') return 'example'
  return 'frontierjs'
}

/** One session's file, or null when there is none or it is torn. */
function readOne(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * Record one hook event for this session. `input` is the hook's stdin:
 * `session_id`, `hook_event_name` (a `PostToolUse` when absent), and per
 * event `tool_input.file_path` (`notebook_path` for a notebook),
 * `notification_type` and `message`, `last_assistant_message`, `cwd`.
 *
 * - An edit inside `root` seats the session at that file's bench, and clears
 *   any hand or last words: it is working.
 * - A Notification in ASKS raises its hand; any other notification is
 *   ignored, since an `idle_prompt` after a stop would wipe the last words.
 * - A Stop leaves its last words.
 * - SessionEnd removes the file.
 * - Anything else — another tool, a prompt submitted — lowers the hand and
 *   drops the words of an existing worker: the prompt was answered.
 *
 * A session that has edited nothing yet is seated where it was started, so a
 * hand raised before the first edit is still drawn. Outside `root`, nothing.
 */
export function recordWorker(input, { root, dir = WORKERS_DIR, now = Date.now() } = {}) {
  const session = String(input?.session_id ?? '').replace(/[^\w-]/g, '')
  if (!session || !root) return null
  const file = join(dir, `${session}.json`)
  const event = input.hook_event_name ?? 'PostToolUse'
  if (event === 'SessionEnd') { rmSync(file, { force: true }); return null }
  if (event === 'Notification' && !ASKS.has(input.notification_type)) return null

  const at = new Date(now).toISOString()
  const was = readOne(file)
  const working = { ...was }
  delete working.asking
  delete working.said
  const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path
  const edited = event === 'PostToolUse' && path ? benchOf(path, root) : null
  // Where it was started is the bench a file in its working directory would be at.
  const started = () => (was ? working : { session, bench: benchOf(join(input.cwd || root, '.session'), root), file: '', at: '' })

  let worker
  if (edited) worker = { session, bench: edited, file: relative(root, path), at, seen: at }
  else if (event === 'Notification') worker = { ...started(), seen: at, asking: { why: String(input.message || input.notification_type), at } }
  else if (event === 'Stop') worker = { ...started(), seen: at, said: { text: lastWords(input.last_assistant_message), at } }
  else if (was) worker = { ...working, seen: at }
  if (!worker?.bench) return null

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(worker) + '\n')
  for (const name of readdirSync(dir)) {
    const f = join(dir, name)
    try { if (now - statSync(f).mtimeMs > KEEP_MS) rmSync(f) } catch {}
  }
  return worker
}

const stamped = (o, key) => (o && typeof o === 'object' && o[key] ? { [key]: String(o[key]), at: Date.parse(o.at) } : null)

/**
 * Every session heard from within QUIET_MS, or asking, oldest session id
 * first: `{ session, bench, file, at, seen, asking, said }` — `at` the last
 * edit (null before one), `seen` the last event, `asking` `{ why, at }` and
 * `said` `{ text, at }` or null. An unreadable file is no worker.
 */
export function readWorkers({ dir = WORKERS_DIR, now = Date.now() } = {}) {
  let names
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const name of names) {
    const w = readOne(join(dir, name))
    if (!w?.session || !w.bench) continue
    const seen = Date.parse(w.seen ?? w.at)
    const asking = stamped(w.asking, 'why')
    if (!asking && !(now - seen <= QUIET_MS)) continue
    out.push({ session: String(w.session), bench: String(w.bench), file: String(w.file ?? ''), at: w.at ? Date.parse(w.at) : null, seen, asking, said: stamped(w.said, 'text') })
  }
  return out
}
