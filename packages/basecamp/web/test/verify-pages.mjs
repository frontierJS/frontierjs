#!/usr/bin/env node
// web/test/verify-pages.mjs — /pages/ lists, regenerates and opens what fli writes.
//
//   bun web/test/verify-pages.mjs
//   API_PORT=7120 UI_PORT=7020 bun web/test/verify-pages.mjs   # beside a dev server
//
// Starts and stops its own database, API, web server and Chrome. The pages are
// the REAL workspace's — this screen exists to describe the tree it runs in —
// so a run rewrites `repo-rings.html` and `repo-work.html` at the root, which
// are generated and gitignored.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   The list is fli's inventory and not a copy of it: a page row here is one a
//   command DECLARED, so the row the drive presses is the one `runnables()`
//   built from `ws:atlas`'s own frontmatter.
//
//   A generate is a real `fli` process the API started, and the screen follows
//   it to the end without being asked — the written time moves.
//
//   An opened page is the file, not the API's JSON: the blob the tab is pointed
//   at holds the page's own markup, and a link to another page (the rings and
//   the work map name each other) is handed back to this tab and swapped in.
//
// ─── Traps ───────────────────────────────────────────────────────────────
//
//   A window opened by the page is a second CDP target, so `window.open` is
//   replaced with a stand-in that records where the tab was sent.
//   Backgrounding a server from a tool call is unreliable; this spawns, polls
//   until each answers, asserts, and kills.

import { spawn } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'

const HERE     = dirname(fileURLToPath(import.meta.url))
const PKG      = join(HERE, '..', '..')
const ROOT     = join(PKG, '..', '..')
const API_PORT = Number(process.env.API_PORT ?? 8120)
const WEB_PORT = Number(process.env.UI_PORT ?? 8020)
const BASE     = `http://localhost:${WEB_PORT}`
const API      = `http://localhost:${API_PORT}`
const EMAIL    = 'sam@example.com'
const PASSWORD = 'hunter2hunter2'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
let passed = 0, failed = 0
let browser = null

function ok(label)          { passed++; console.log(`  ✓ ${label}`) }
function bad(label, detail) { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail) }

// The GROUP, not the child: `bun run web` spawns vite, so killing the direct
// child leaves the server holding its port.
async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill?.() } catch {} } }
  await sleep(500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  await browser?.close()
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup().then(() => process.exit(130)))

for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'basecamp-pages-'))
const DB      = join(SCRATCH, 'basecamp.db')
const dbEnv   = { DATABASE_URL: DB, AUDIT_PATH: join(SCRATCH, 'audit/') }

const seed = spawn('bun', ['db/seed.js'], { cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...dbEnv } })
let seedErr = ''
seed.stderr.on('data', d => { seedErr += d })
if (await new Promise(r => seed.on('exit', r)) !== 0) fail(`db/seed.js failed\n${seedErr}`)

children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, ...dbEnv, APP_URL: BASE, PORT: String(API_PORT), LOCAL_MACHINE: '1' },
}))
children.push(spawn('bun', ['run', 'web'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) },
}))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) { try { await fetch(url); return } catch {} await sleep(500) }
  fail(`${label} never answered ${url}`)
}
await waitFor(`${API}/health`, 'the API')
await waitFor(BASE, 'the web server')

browser = await openChrome().catch(async (e) => { console.error(`\n✗ ${e.message}\n`); await cleanup(); process.exit(1) })
const send = browser.cmd

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
async function until(expression, predicate, label, ms = 20_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 200)}`)
}
const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }
const fill = fields => evaluate(`(() => { ${Object.entries(fields).map(([id, v]) =>
  `{ const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}
     el.dispatchEvent(new Event('input', { bubbles: true })) }`).join('\n')} })()`)

/** The row's text and its buttons, by the row id fli gave it. */
const rowOf = id => evaluate(`(() => {
  const li = document.querySelector('[data-id=${JSON.stringify(id)}]')
  if (!li) return null
  return { text: li.textContent.replace(/\\s+/g, ' ').trim(),
           buttons: [...li.querySelectorAll('button, a.btn, a[href]')].map(b => ({ label: b.textContent.trim(), disabled: !!b.disabled })) }
})()`)
const press = (id, label) => evaluate(`(() => {
  const b = [...document.querySelectorAll('[data-id=${JSON.stringify(id)}] button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})
  if (!b) throw new Error('no ${label} on ${id}')
  b.click(); return true
})()`)

const consoleErrors = []
browser.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return
  const t = p.args.map(a => a.value ?? a.description ?? '').join(' ')
  if (!/favicon|\[vite\]/i.test(t)) consoleErrors.push(t)
})

try {
  await goto('/login/')
  await until(`!!document.getElementById('email')`, v => v, 'the sign-in form never rendered')
  await fill({ email: EMAIL, password: PASSWORD })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/', 'sign-in never landed on the overview')
  ok('signed in as the seeded owner')

  console.log('\n  /pages/ — the list is fli\'s')
  await goto('/pages/')
  await until(`!!document.getElementById('pages-generated')`, v => v, 'the pages list never rendered')
  const ids = await evaluate(`[...document.querySelectorAll('#pages-groups [data-id]')].map(e => e.dataset.id)`)
  for (const id of ['page:repo-rings.html', 'page:repo-work.html', 'page:repo-terms.html', 'page:codegraph.html', 'page:repo-atlas.live.html'])
    check(`${id} is listed, declared by its command`, ids.includes(id), ids.join(', '))
  check('the committed atlas pages are listed apart', ids.includes('snapshot:repo-atlas.snapshot.html'), ids.join(', '))
  check('and the tools, with their state', ids.includes('tool:gui') && /down|up|unknown/.test((await rowOf('tool:gui'))?.text ?? ''))
  // `FJS_DRIVE_SHOT=<path>` saves the screen as a PNG, for a person to look at.
  if (process.env.FJS_DRIVE_SHOT) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await Bun.write(process.env.FJS_DRIVE_SHOT, Buffer.from(data, 'base64'))
  }
  const rings = await rowOf('page:repo-rings.html')
  check('a row says the command that writes it', /fli ws:atlas --as=rings/.test(rings?.text ?? ''), rings?.text)

  console.log('\n  Generate — a real fli process, followed to the end')
  const before = (() => { try { return statSync(join(ROOT, 'repo-rings.html')).mtimeMs } catch { return 0 } })()
  await press('page:repo-rings.html', (rings.buttons.find(b => /generate/i.test(b.label)) ?? {}).label ?? 'Generate')
  // Followed off the FILE: a row reading *written 30s ago* is true of the last
  // run too, so the screen alone cannot say this one finished.
  const mtimeOf = () => { try { return statSync(join(ROOT, 'repo-rings.html')).mtimeMs } catch { return 0 } }
  for (let i = 0; i < 360 && mtimeOf() <= before; i++) await sleep(250)
  const after = await until(`document.querySelector('[data-id="page:repo-rings.html"]')?.textContent.replace(/\\s+/g, ' ') ?? ''`,
    t => !/generating/i.test(t) && /linked from the rings/.test(t), 'the run never finished on screen', 30_000)
  const mtime = mtimeOf()
  check('the file on disk was rewritten', mtime > before, `${before} → ${mtime}`)
  ok('the row shows the run, and then that it ended')
  check('and the row says it was not a failure', !/failed/i.test(after), after)
  check('and shows what the run printed', /linked from the rings/.test(after), after.slice(0, 200))
  check('as text, with no terminal color codes in it', !/\x1b|\[3\dm/.test(after), after.slice(0, 200))

  console.log('\n  Open — the file, in a tab of its own')
  await evaluate(`(() => {
    window.__sent = []
    window.open = () => ({ location: { set href(u) { window.__sent.push(u) } }, close() { window.__closed = true } })
  })()`)
  await press('page:repo-rings.html', 'Open')
  const url = await until(`window.__sent[0] ?? null`, v => !!v, 'Open never pointed the tab anywhere')
  check('the tab is pointed at a blob, not at a file:// link the browser refuses', url.startsWith('blob:'), url)
  const html = await evaluate(`fetch(${JSON.stringify(url)}).then(r => r.text())`)
  check('holding the page itself', /<html|<!doctype html/i.test(html) && /ring/i.test(html), html.slice(0, 120))
  check('with the link relay appended', /fjsPage/.test(html))

  // WebKit — the desktop shell's webview, a blocked popup — answers `null`
  // from window.open, and the page has to show in Basecamp instead.
  console.log('\n  Open where no window comes back — the viewer')
  await evaluate(`window.open = () => null`)
  await press('page:repo-rings.html', 'Open')
  const ringsTitle = await until(`document.getElementById('pages-viewer')?.contentDocument?.title ?? null`,
    t => /rings/.test(t ?? ''), 'the viewer never showed the page')
  check('a null window opens the page in a viewer here, not an error', /rings/.test(ringsTitle), ringsTitle)
  check('and no error banner', !(await evaluate(`!!document.getElementById('screen-error')`)))
  // A real click inside the framed page, so the relay's parent branch runs.
  await evaluate(`(() => {
    const doc = document.getElementById('pages-viewer').contentDocument
    const a = doc.createElement('a'); a.href = 'repo-work.html'; a.textContent = 'work'
    doc.body.appendChild(a); a.click()
  })()`)
  const workInViewer = await until(`document.getElementById('pages-viewer')?.contentDocument?.title ?? null`,
    t => /how work moves/.test(t ?? ''), 'a link inside the viewer never swapped the page')
  check('a link to another page swaps the viewer to it', /how work moves/.test(workInViewer), workInViewer)
  await evaluate(`[...document.querySelectorAll('dialog button')].find(b => b.textContent.trim() === 'Close').click()`)
  await until(`!document.getElementById('pages-viewer')`, v => v, 'Close never closed the viewer')
  ok('Close closes it')

  // The work map names the rings and the rings name the work map; inside a
  // blob neither resolves, so the opened tab posts the click back and this tab
  // answers by pointing that same window at the next page.
  await evaluate(`window.postMessage({ fjsPage: 'repo-work.html' }, '*')`)
  const swapped = await until(`location.href`, h => h.startsWith('blob:'), 'a page link was never swapped in')
  const title = await until(`document.title`, t => /how work moves/.test(t), 'the work map never loaded in the swapped tab')
  check('a link to another page opens that page in the same tab', swapped.startsWith('blob:') && /how work moves/.test(title), title)

  check('no console errors on the screen', !consoleErrors.length, consoleErrors.join(' | ').slice(0, 300))
} catch (e) {
  bad('the drive stopped', e.message)
}

await cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
