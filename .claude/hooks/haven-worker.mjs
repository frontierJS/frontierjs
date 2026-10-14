// ─── haven-worker.mjs — the PostToolUse hook that seats a session in Haven ──
//
// After an Edit, Write or NotebookEdit, this session is written at the bench
// of the package it edited, for Haven's workshop to draw on this machine's
// screen (`IDEAS/haven.md` 11.2). What is written and where is
// `recordWorker` in `packages/haven/web/src/workers.js`, which the workshop
// also reads; this file only hands it the hook's input.
//
// It must never break a session: every failure exits 0 with nothing printed.

import { readFileSync }  from 'node:fs'
import { join }          from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const root  = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  const { recordWorker } = await import(pathToFileURL(join(root, 'packages', 'haven', 'web', 'src', 'workers.js')).href)
  recordWorker(input, { root })
} catch {}
