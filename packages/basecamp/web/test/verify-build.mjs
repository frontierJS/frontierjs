/**
 * web/test/verify-build.mjs — probe the PRODUCTION build.
 *
 * `bun run verify` drives the DEV server, where Vite injects nothing into
 * `index.html` — so the one artefact that reaches a user was the one artefact
 * nothing tested (`FJS-085`). It cost this app a **completely blank page**,
 * shipped and unnoticed: `web/index.html` mentioned the body tag inside a
 * comment, Vite injects the built `<script>` and `<link>` at the first textual
 * match without skipping comments, and both landed *inside* the comment. The
 * build exited 0, `dist/index.html` looked right, and the page loaded no
 * JavaScript and no CSS with an empty console. It happened in `example/` first
 * and was fixed there; nobody checked here.
 *
 * Two layers, because either alone would have missed it:
 *
 *   1. **The file.** Strip every comment from `dist/index.html`, then require a
 *      `<script>` and a stylesheet `<link>` to survive. A regex over the raw
 *      file passes on exactly the broken output — the tags ARE there, they are
 *      just commented out.
 *   2. **The page.** Load it in a real browser and require that it rendered
 *      something, fetched its own JS, and logged no errors. A file can be
 *      well-formed and still throw on first execution.
 *
 * This deliberately does NOT re-run all 150 assertions against the build the
 * way `example`'s verify-build does. Those need an empty database and a full
 * setup run; this answers the narrower question that was actually unasked —
 * *does the built page come up at all* — and answers it in seconds.
 *
 *   bun run verify:build      # builds, then runs this
 *
 * It starts the API and the preview server itself and stops them at the end.
 * Needs Chrome on PATH (or $FJS_CHROME).
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG  = join(HERE, '../..')
const DIST = join(PKG, 'web/dist/client')

const API_PORT = 8120
const PORT     = Number(process.env.PREVIEW_PORT ?? 5311)
const UI       = `http://localhost:${PORT}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
const results  = []
let browser = null

function check(name, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want
  results.push({ name, ok })
  console.log(ok ? `  ok    ${name}` : `  FAIL  ${name}\n        got:  ${JSON.stringify(got)?.slice(0, 300)}`)
}

async function cleanup() {
  for (const c of children) { try { c.kill() } catch {} }
  await browser?.close()
}

// This file starts an API, a preview server and a Chrome, none of them children
// of the shell. Without these, a `timeout`, a Ctrl-C or a throw from any check
// leaves all three alive and the next run meets a port it cannot have.
let quitting = false
function stop(reason, code = 1) {
  if (quitting) return
  quitting = true
  console.error(`\n  ${reason} — stopping the servers this run started\n`)
  cleanup().then(() => process.exit(code))
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal))
process.on('uncaughtException',  e => { console.error(e); stop('uncaught error') })
process.on('unhandledRejection', e => { console.error(e); stop('unhandled rejection') })

// ─── 1. The file ──────────────────────────────────────────────────────────
// Comments stripped FIRST. The whole trap is that the tags exist in the file
// and are inert, so anything that greps the raw text passes on the failure.
const html = await readFile(join(DIST, 'index.html'), 'utf8').catch(() => null)
if (html == null) {
  console.error(`\n  No ${join(DIST, 'index.html')} — run \`bun run build:web\` first.\n`)
  process.exit(1)
}

const live = html.replace(/<!--[\s\S]*?-->/g, '')
check('the built page has a <script> outside any comment', /<script[^>]+src=/i.test(live), true)
check('…and a stylesheet <link> outside any comment',
  /<link[^>]+rel=["']?stylesheet/i.test(live), true)
check('the body tag is not written inside a comment — the trap itself',
  /<!--[\s\S]*?<body[\s\S]*?-->/i.test(html), false)
// index.html has no <head> tag, which HTML allows; an injector anchored on the
// literal tag wrote nothing and every reader on a picked theme saw the default
// first (FJS-1775).
check('the theme script is in the page, ahead of the stylesheet',
  live.indexOf('sierra-theme'), i => i > 0 && i < live.search(/<link[^>]+rel=["']?stylesheet/i))

// ─── 2. The page ──────────────────────────────────────────────────────────
children.push(spawn('bun', ['api/index.ts'], { cwd: PKG, stdio: 'ignore' }))
children.push(spawn(process.execPath, [join(HERE, 'preview.mjs')], {
  stdio: 'ignore',
  env: { ...process.env, PREVIEW_PORT: String(PORT), API_URL: `http://localhost:${API_PORT}` },
}))

let up = false
for (let i = 0; i < 80 && !up; i++) {
  try { up = (await fetch(UI)).ok } catch { await sleep(250) }
}
if (!up) {
  console.error(`\n  preview never came up on ${UI}\n`)
  await cleanup()
  process.exit(1)
}

browser = await openChrome({ windowSize: '1280,800' }).catch(async (e) => {
  console.error(`\n  ${e.message}\n`)
  await cleanup()
  process.exit(1)
})
const send = browser.cmd

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.value
}

await send('Page.navigate', { url: UI + '/' })
await sleep(1200)
// Errors are collected from the moment the page has a document, so a throw
// during the app's own boot is caught rather than raced past.
await evaluate(`window.__errs = []; addEventListener('error', e => window.__errs.push(String(e.message)))`)
await sleep(2500)

check('the built page renders something',
  await evaluate(`document.body.innerText.trim().length`), n => n > 0)
check('…and it is the app, not a bare fallback',
  await evaluate(`!!document.querySelector('main')`), true)
check('the entry script actually executed',
  await evaluate(`performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).length`),
  n => n > 0)
check('…and so did the stylesheet',
  await evaluate(`document.styleSheets.length`), n => n > 0)
check('no uncaught errors on boot', await evaluate(`JSON.stringify(window.__errs)`), '[]')

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`)
await cleanup()
process.exit(failed.length ? 1 : 0)
