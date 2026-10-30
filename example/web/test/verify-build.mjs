/**
 * web/test/verify-build.mjs — run verify.mjs's assertions against the PRODUCTION
 * build. Started by `bun run verify:build`, which builds first.
 *
 * verify.mjs starts its own API on the test tier, and the preview proxies to
 * THAT one rather than to a dev API on 8110, so it runs beside `bun run api`.
 * The preview server is started and stopped here, because a server left
 * running from a previous build serves that build — the failure then looks
 * like a code change that did not take.
 */

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portFor } from '@frontierjs/cli/core/ports.js'
import { PORTS } from './lib/preflight.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PREVIEW_PORT ?? String(await portFor(import.meta.url, 'fe', { env: 'dev', service: 1 }))
const UI   = `http://localhost:${PORT}`
const API  = process.env.FRONTIER_API_URL ?? `http://localhost:${PORTS.apiTest}`

// A preview left from another checkout would serve ITS build to verify.mjs (FJS-740).
let busy = false
try { await fetch(UI, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
if (busy) {
  console.error(`port ${PORT} already answers — refusing to test whatever holds it instead of this build`)
  process.exit(1)
}

const preview = spawn(process.execPath, [join(HERE, 'preview.mjs')], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, PREVIEW_PORT: PORT, FRONTIER_API_URL: API },
})

const stop = () => { try { preview.kill() } catch {} }
process.on('exit', stop)
process.on('SIGINT', () => { stop(); process.exit(130) })

// Wait for it to answer rather than sleeping a guessed interval.
let up = false
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(UI)).ok } catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!up) {
  console.error(`preview never came up on ${UI}`)
  stop()
  process.exit(1)
}

const drive = spawn(process.execPath, [join(HERE, 'verify.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, UI_URL: UI },
})

drive.on('exit', (code) => { stop(); process.exit(code ?? 1) })
