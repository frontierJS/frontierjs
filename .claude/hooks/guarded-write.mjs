// ─── guarded-write.mjs — decision-rules in front of a write to a guarded file ─
//
// Which calls count and what the hook says are `guardedWrite` in
// `packages/cli/core/guarded-write.js`, where they are tested; this file only
// prints. A hint and never a block, and it must never break a session: every
// failure exits 0 with nothing printed.

import { readFileSync }  from 'node:fs'
import { join }          from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const root  = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  const { guardedWrite } = await import(pathToFileURL(join(root, 'packages', 'cli', 'core', 'guarded-write.js')).href)
  const context = guardedWrite(input)
  if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }))
} catch {}
