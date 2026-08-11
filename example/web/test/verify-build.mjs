/**
 * web/test/verify-build.mjs — run the same 37 assertions against the PRODUCTION
 * build. Started by `bun run verify:build`, which builds first.
 *
 * The API must already be up (`bun run api`); the preview server is started and
 * stopped here, because a server left running from a previous build serves that
 * build — the failure then looks like a code change that did not take.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PREVIEW_PORT ?? '8011'
const UI   = `http://localhost:${PORT}`

const preview = spawn(process.execPath, [join(HERE, 'preview.mjs')], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, PREVIEW_PORT: PORT },
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
