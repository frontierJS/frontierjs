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
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG  = join(HERE, '../..')
const DIST = join(PKG, 'web/dist/client')

const CHROME   = process.env.FJS_CHROME ?? 'google-chrome'
const API_PORT = 8120
const PORT     = Number(process.env.PREVIEW_PORT ?? 5311)
const UI       = `http://localhost:${PORT}`
// Per run, never a fixed path — see verify.mjs for what a shared one costs.
const PROFILE  = mkdtempSync(join(tmpdir(), 'fjs-basecamp-build-'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
const results  = []
let chromePid = null                        // set once Chrome is spawned

function check(name, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want
  results.push({ name, ok })
  console.log(ok ? `  ok    ${name}` : `  FAIL  ${name}\n        got:  ${JSON.stringify(got)?.slice(0, 300)}`)
}

async function cleanup() {
  for (const c of children) { try { c.kill() } catch {} }
  await sleep(300)
  // A SIGTERM to the browser process leaves its zygote, GPU and renderer
  // children alive, reparented to init. Chrome runs in its own process group so
  // the group can be reaped here.
  if (chromePid) { try { process.kill(-chromePid, 'SIGKILL') } catch {} }
  await rm(PROFILE, { recursive: true, force: true }).catch(() => {})
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

// Port 0, read back off stderr. A FIXED debugging port is not just a collision
// risk: Chrome refuses to start a second browser on a bound one and exits
// quietly, so the poll below finds the OTHER browser's tabs and this file
// drives those — which cost `verify.mjs` two runs against a css guide page
// open in another session's Chrome.
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0',
  `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
chromePid = chrome.pid
children.push({ kill: () => { try { process.kill(-chrome.pid, 'SIGTERM') } catch {} } })

const browserWsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15_000)
  chrome.stderr.on('data', d => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
}).catch(async (e) => {
  console.error(`\n  ${e.message} — is ${CHROME} installed? Set $FJS_CHROME.\n`)
  await cleanup()
  process.exit(1)
})

const cdpPort = new URL(browserWsUrl).port
let target = null
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    target = list.find(t => t.type === 'page')
  } catch {}
  if (!target) await sleep(250)
}
if (!target) {
  console.error(`\n  No Chrome debug target on :${cdpPort}. Is ${CHROME} installed? Set $FJS_CHROME.\n`)
  await cleanup()
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))

let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
// An untimed promise on a renderer that stopped answering hangs the run with no
// output, so the wrapper is killed and its Chrome orphaned. Name it instead.
const send = (method, params = {}, ms = 30_000) => new Promise((res, rej) => {
  const n = ++msgId
  const timer = setTimeout(() => {
    pending.delete(n)
    rej(new Error(`CDP ${method} timed out after ${ms}ms — the page stopped answering`))
  }, ms)
  pending.set(n, msg => { clearTimeout(timer); res(msg) })
  ws.send(JSON.stringify({ id: n, method, params }))
})

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
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
