// ─── haven-worker.mjs — the hook that seats a session in Haven ─────────────
//
// On every tool started and answered, a permission prompt, a stop, a prompt
// submitted and the session's end, this session is written for Haven's
// workshop and kitchen to draw on this machine's screen (`IDEAS/haven.md`
// Phase 11): at the bench of the package it edited, inside a tool or
// writing, its hand raised while it waits on you, its last words once it
// stops. What is written and where is `recordWorker` in
// `packages/haven/web/src/lib/hash/workers.js`, which the workshop also reads; this
// file only hands it the hook's input. `.claude/settings.json` runs it `async`
// so a session never waits on it — but SessionEnd, which the exiting
// process would not stay for.
//
// It must never break a session: every failure exits 0 with nothing printed.

import { readFileSync }  from 'node:fs'
import { join }          from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const root  = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  const { recordWorker } = await import(pathToFileURL(join(root, 'packages', 'haven', 'web', 'src', 'lib', 'hash', 'workers.js')).href)
  recordWorker(input, { root })
} catch {}
