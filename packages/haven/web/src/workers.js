// src/workers.js — `#workers` in the terminal: the Claude sessions editing
// on THIS machine, which the workshop draws at their packages' benches
// (`components/Workers.mesa`, `IDEAS/haven.md` Phase 11). A browser takes
// `workers.browser.js`.
//
// A session is one file, `~/.fli/haven/workers/<session>.json`, written by
// the `PostToolUse` hook in `.claude/hooks/haven-worker.mjs` after every
// edit through `recordWorker()` — so the shape has one owner, this file.
// Claude's own transcripts say the same and were not used: their shape is
// Claude Code's to change.
//
// Nothing here is sent. A worker is drawn on the screen of the machine whose
// directory it is in, the way the tavern's runner is.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

export const WORKERS_DIR = join(homedir(), '.fli', 'haven', 'workers')

/** A session with no edit for this long has left its bench. */
export const QUIET_MS = 10 * 60 * 1000

// A file left by a session that ended is deleted by the next write, so the
// directory does not grow with every session the machine has run.
const KEEP_MS = 24 * 60 * 60 * 1000

/** The bench a file is edited at: `packages/<name>/…` is `<name>`, `example/…` is `example`, the rest of the repo is `frontierjs`; outside the repo, none. */
export function benchOf(file, root) {
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return null
  const [top, name, ...rest] = rel.split(sep)
  if (top === 'packages' && rest.length) return name
  if (top === 'example') return 'example'
  return 'frontierjs'
}

/**
 * Write this session at the bench of the file it just edited. `input` is the
 * hook's stdin: `session_id`, and `tool_input.file_path` — `notebook_path`
 * for a notebook. A file outside `root` writes nothing, so the session stays
 * at the bench it was last seen at.
 */
export function recordWorker(input, { root, dir = WORKERS_DIR, now = Date.now() } = {}) {
  const session = String(input?.session_id ?? '').replace(/[^\w-]/g, '')
  const path = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path
  if (!session || !path || !root) return null
  const bench = benchOf(path, root)
  if (!bench) return null
  const worker = { session, bench, file: relative(root, path), at: new Date(now).toISOString() }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${session}.json`), JSON.stringify(worker) + '\n')
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    try { if (now - statSync(file).mtimeMs > KEEP_MS) rmSync(file) } catch {}
  }
  return worker
}

/** Every session that edited within QUIET_MS, oldest session id first; an unreadable file is no worker. */
export function readWorkers({ dir = WORKERS_DIR, now = Date.now() } = {}) {
  let names
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const name of names) {
    try {
      const w = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const at = Date.parse(w.at)
      if (w.session && w.bench && now - at <= QUIET_MS) out.push({ session: String(w.session), bench: String(w.bench), file: String(w.file ?? ''), at })
    } catch {}
  }
  return out
}
