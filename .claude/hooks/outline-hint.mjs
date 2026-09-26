// ─── outline-hint.mjs — the PreToolUse hint in front of a wide read ─────────
//
// A Read with no limit, or a guessed `sed -n` window, on a file long enough
// that the guess costs more than the outline. Which calls count and what the
// hint says are `wideRead` and `outlineHint` in `packages/cli/core/outline.js`,
// where they are tested; this file only counts lines.
//
// A hint and never a block, and it must never break a session: every failure
// exits 0 with nothing printed.

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join }         from 'node:path'
import { pathToFileURL }            from 'node:url'

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const root  = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  const { wideRead, outlineHint } = await import(pathToFileURL(join(root, 'packages', 'cli', 'core', 'outline.js')).href)
  const path = wideRead(input)
  if (!path) process.exit(0)
  const file = isAbsolute(path) ? path : join(input.cwd || root, path)
  if (!existsSync(file)) process.exit(0)
  let lines = 0
  for (const byte of readFileSync(file)) if (byte === 10) lines++
  const hint = outlineHint(path, lines)
  if (hint) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hint } }))
} catch {}
