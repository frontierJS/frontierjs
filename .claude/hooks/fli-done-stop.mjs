// ─── fli-done-stop.mjs — the Stop hook in front of "this is finished" ────────
//
// Runs `fli done`'s report when an agent is about to stop, and keeps it working
// when the tree holds an unfinished item of its own it has not been shown yet.
// The verdict — when to build the report, when to block, what counts as shown
// and whose an item is — is `stopVerdict` in `packages/cli/core/done.js`, where
// it is tested; this file only gathers the tree's identity, the files the
// session edited (`editedIn`, off its own transcript), and writes the state.
//
// The state is one file per session, `<git dir>/fli-done-stop/<session>.json`.
// The tree is shared by every session in it, so one file shared by all let a
// stop in one session mark another's items shown, and its fingerprint skip the
// other's next report. A file a day old is deleted by the next stop.
//
// It must never break a session: every failure exits 0 with nothing printed.
// `stop_hook_active` is set when the agent is already continuing because a Stop
// hook blocked, so this answers nothing then and cannot hold a session in a loop.
//
// `FLI_DONE_STOP=off` in the environment skips it whole. `scripts/headless.mjs`
// sets it: the fix and frame skills run `fli done` themselves as a step.
//
// One report at a time. `fli done` fans out into the surface check, the
// typecheck and the cli suite, and several sessions stopping together ran
// three of them at once and pinned every core. `<state dir>/.lock` holds the
// pid of the run in progress; a stop that finds a live one skips, and answers
// nothing, rather than queue. A lock whose pid is gone, or older than the
// longest run should take, is stale and taken over.
//
// A session that has edited a file under `packages/haven/` is skipped as well.
// Haven makes new files on most steps, each a `layout-named` item, so every stop
// there was a fresh report and a block for one more turn; a Haven session runs
// `fli done` itself at the end of a step.

import { execFileSync }                                                     from 'node:child_process'
import { createHash }                                                       from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join }                                                 from 'node:path'
import { pathToFileURL }                                                    from 'node:url'

const KEEP_MS = 24 * 60 * 60 * 1000
const LOCK_MS = 15 * 60 * 1000

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// True when this process now holds the lock; false when a live run holds it.
function takeLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true } catch {}
    let pid = NaN, age = Infinity
    try { pid = Number(readFileSync(lock, 'utf8')); age = Date.now() - statSync(lock).mtimeMs } catch { continue }
    if (alive(pid) && age < LOCK_MS) return false
    try { rmSync(lock) } catch {}
  }
  return false
}

try {
  if (process.env.FLI_DONE_STOP === 'off') process.exit(0)
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  if (input.stop_hook_active) process.exit(0)

  const cwd  = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const git  = (...argv) => execFileSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const root = git('rev-parse', '--show-toplevel').trim()
  const done = join(root, 'packages', 'cli', 'core', 'done.js')
  if (!existsSync(done)) process.exit(0)

  const { runDone, stopVerdict, editedIn } = await import(pathToFileURL(done).href)

  // An unreadable transcript is null: every unfinished item blocks, as before.
  let edited = null
  try { edited = editedIn(readFileSync(input.transcript_path, 'utf8'), root) } catch {}
  if (edited?.some(f => f.startsWith('packages/haven/'))) process.exit(0)

  const head     = git('rev-parse', 'HEAD').trim()
  const gitDir   = git('rev-parse', '--git-dir').trim()
  const stateDir = join(isAbsolute(gitDir) ? gitDir : join(cwd, gitDir), 'fli-done-stop')
  const session  = String(input.session_id ?? '').replace(/[^\w-]/g, '') || 'unknown'
  const stateFile = join(stateDir, `${session}.json`)

  // An untracked file's content is in no diff, so its size and mtime stand in.
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)
    .map(f => { try { const s = statSync(join(root, f)); return `${f}:${s.size}:${s.mtimeMs}` } catch { return f } })
  const fingerprint = createHash('sha1')
    .update(git('status', '--porcelain')).update(git('diff', 'HEAD')).update(untracked.join('\n'))
    .digest('hex')

  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}

  if (!stopVerdict({ state, head, fingerprint, edited }).run) process.exit(0)

  mkdirSync(stateDir, { recursive: true })
  const lock = join(stateDir, '.lock')
  if (!takeLock(lock)) process.exit(0)
  let report
  try { report = await runDone(root) } finally { try { rmSync(lock) } catch {} }
  const verdict = stopVerdict({ state, head, fingerprint, edited, report })
  writeFileSync(stateFile, JSON.stringify(verdict.state))
  for (const name of readdirSync(stateDir)) {
    const f = join(stateDir, name)
    if (name === '.lock') continue
    try { if (Date.now() - statSync(f).mtimeMs > KEEP_MS) rmSync(f) } catch {}
  }
  if (verdict.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }))
} catch {}

process.exit(0)
