// ─── fli-done-stop.mjs — the Stop hook in front of "this is finished" ────────
//
// Runs `fli done`'s report when an agent is about to stop, and keeps it working
// when the tree holds an unfinished item it has not been shown yet. The verdict
// — when to build the report, when to block, what counts as already shown — is
// `stopVerdict` in `packages/cli/core/done.js`, where it is tested; this file
// only gathers the tree's identity and writes the state beside `.git`.
//
// It must never break a session: every failure exits 0 with nothing printed.
// `stop_hook_active` is set when the agent is already continuing because a Stop
// hook blocked, so this answers nothing then and cannot hold a session in a loop.
//
// `--baseline` records every item in the tree as shown and blocks nothing.
// `scripts/fix-loop.mjs` runs it before each session, because the shown state is
// the TREE's, not the session's: without it a headless fix is blocked, and pays
// a full-context turn, on an item another session made while it ran.

import { execFileSync }                                   from 'node:child_process'
import { createHash }                                     from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join }                               from 'node:path'
import { pathToFileURL }                                  from 'node:url'

const baseline = process.argv.includes('--baseline')

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  if (input.stop_hook_active) process.exit(0)

  const cwd  = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const git  = (...argv) => execFileSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const root = git('rev-parse', '--show-toplevel').trim()
  const done = join(root, 'packages', 'cli', 'core', 'done.js')
  if (!existsSync(done)) process.exit(0)

  const head   = git('rev-parse', 'HEAD').trim()
  const gitDir = git('rev-parse', '--git-dir').trim()
  const stateFile = join(isAbsolute(gitDir) ? gitDir : join(cwd, gitDir), 'fli-done-stop.json')

  // An untracked file's content is in no diff, so its size and mtime stand in.
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)
    .map(f => { try { const s = statSync(join(root, f)); return `${f}:${s.size}:${s.mtimeMs}` } catch { return f } })
  const fingerprint = createHash('sha1')
    .update(git('status', '--porcelain')).update(git('diff', 'HEAD')).update(untracked.join('\n'))
    .digest('hex')

  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}

  const { runDone, stopVerdict } = await import(pathToFileURL(done).href)
  if (!baseline && !stopVerdict({ state, head, fingerprint }).run) process.exit(0)

  const verdict = stopVerdict({ state, head, fingerprint, report: runDone(root) })
  writeFileSync(stateFile, JSON.stringify(verdict.state))
  if (verdict.block && !baseline) process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }))
} catch {}

process.exit(0)
