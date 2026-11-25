#!/usr/bin/env node
// web/test/verify-capture.mjs — /capture/ reads and writes the Capture tool's
// config.toml through the real controls.
//
//   bun web/test/verify-capture.mjs
//   API_PORT=7121 UI_PORT=7021 bun web/test/verify-capture.mjs   # pin the ports
//
// Starts and stops its own database, API, web server and Chrome. The API runs
// with XDG_CONFIG_HOME pointed at a scratch directory, so the settings file it
// reads and writes is a temp one; the real ~/.config/capture is looked at before
// and after and must not have been created or touched.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   Every control on the screen is changed the way a person changes it, then
//   the file on disk is read back: a value the screen showed but the file never
//   got, or the reverse, is the failure. The file's mode is held at 0600 because
//   it carries the share key. There is no key box: Connect opens the share app's
//   approval page (window.open is stubbed, so no browser launches), and the drive
//   plays the share app by requesting the redirect_uri itself against a stand-in
//   share server it runs. The key lands in the file and nowhere in the page; Test
//   names the failing part. An empty file name is refused on the screen and the
//   file is unchanged.
//   Reset to defaults writes nothing until it is confirmed, then puts every
//   setting back while the share address, the key and keys it does not know stay.
//
// ─── Traps ───────────────────────────────────────────────────────────────
//
//   Setting `.value` on an input does not notify Mesa — it listens for `input`.
//   A Switch is its checkbox: click it, never set `.checked`.
//   Backgrounding a server from a tool call is unreliable; this spawns, polls
//   until each answers, asserts, and kills.

// Workbench lives in the global port block, which has no slot for a drive, so
// both servers take an OS-chosen port and nothing is held.
export const holds = []

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer as httpServer } from 'node:http'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'

const HERE     = dirname(fileURLToPath(import.meta.url))
const PKG      = join(HERE, '..', '..')
const freePort = () => new Promise((done, fail) => {
  const s = createServer()
  s.on('error', fail)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)) })
})
const API_PORT = Number(process.env.API_PORT ?? await freePort())
const WEB_PORT = Number(process.env.UI_PORT ?? await freePort())
const BASE     = `http://localhost:${WEB_PORT}`
const API      = `http://localhost:${API_PORT}`
const KEY      = 'workbench-drive-key'
const SHARE    = 'sk-drive-secret-key-1234'
const CODE     = 'drive-code'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// The share app's part: a connect exchange it accepts only for the attempt the
// drive read off the screen, and a ping whose answer the drive switches.
const share = { port: await freePort(), mode: 'ok', expect: null, exchanged: 0 }
const SHARE_URL = `http://127.0.0.1:${share.port}/share/`
const standIn = httpServer((req, res) => {
  const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.url === '/share/api/connect/exchange' && req.method === 'POST') {
      const { code, verifier, redirectUri } = JSON.parse(body || '{}')
      const challenge = createHash('sha256').update(String(verifier)).digest('base64url')
      if (code !== CODE || !share.expect || challenge !== share.expect.challenge || redirectUri !== share.expect.redirectUri) return reply(400, { error: 'The drive refused this exchange' })
      share.exchanged++
      return reply(200, { key: SHARE, name: 'Ada', email: 'ada@example.com' })
    }
    if (req.url === '/share/api/ping') {
      if (share.mode === 'revoked') return reply(401, { error: 'The key is missing, wrong or revoked' })
      if (share.mode === 'html') return reply(200, '<html>not the share app</html>', 'text/html')
      return reply(200, { app: 'capture', user: { id: 'u1', email: 'ada@example.com', name: null }, credentialId: 'k1' })
    }
    reply(404, '<html>nothing here</html>', 'text/html')
  })
})
await new Promise(r => standIn.listen(share.port, '127.0.0.1', r))

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
  standIn.close()
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup().then(() => process.exit(130)))

for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'workbench-capture-'))
const XDG     = join(SCRATCH, 'xdg')
const FILE    = join(XDG, 'capture', 'config.toml')
const DB      = join(SCRATCH, 'workbench.db')
const dbEnv   = { DATABASE_URL: DB, AUDIT_PATH: join(SCRATCH, 'audit.db') }

// The real file, fingerprinted before anything starts and compared at the end.
const REAL_DIR  = join(homedir(), '.config', 'capture')
const REAL_FILE = join(REAL_DIR, 'config.toml')
const fingerprint = () => ({
  dir:  existsSync(REAL_DIR),
  file: existsSync(REAL_FILE) ? createHash('sha1').update(readFileSync(REAL_FILE)).digest('hex') + statSync(REAL_FILE).mtimeMs : null,
})
const realBefore = fingerprint()

children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, ...dbEnv, FRONTIER_APP_URL: BASE, PORT: String(API_PORT), WORKBENCH_KEY: KEY,
         WORKBENCH_DIR: join(SCRATCH, 'workbench'), XDG_CONFIG_HOME: XDG },
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

// A kit control puts its id on the wrapper or the native element; either way the
// native input, select or checkbox is what a person touches.
const NATIVE = id => `(() => { const e = document.getElementById(${JSON.stringify(id)}); return e && (e.matches('input,select,textarea') ? e : e.querySelector('input,select,textarea')) })()`
const type = (id, v) => evaluate(`(() => {
  const el = ${NATIVE(id)}
  if (!el) throw new Error('no control ${id}')
  el.focus(); el.value = ${JSON.stringify(String(v))}
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
const choose = type
const read    = id => evaluate(`${NATIVE(id)}?.value ?? null`)
const checked = id => evaluate(`${NATIVE(id)}?.checked ?? null`)
const flip    = id => evaluate(`(() => { const el = ${NATIVE(id)}; if (!el) throw new Error('no control ${id}'); el.click() })()`)
const press   = id => evaluate(`(() => { const b = document.getElementById(${JSON.stringify(id)}); if (!b) throw new Error('no button ${id}'); (b.matches('button') ? b : b.querySelector('button')).click() })()`)
const textOf  = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`)

const toml = () => { try { return Bun.TOML.parse(readFileSync(FILE, 'utf8')) } catch { return null } }
const raw  = () => { try { return readFileSync(FILE, 'utf8') } catch { return null } }
const mode = () => { try { return statSync(FILE).mode & 0o777 } catch { return null } }
const saved = async (predicate, label) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { const t = toml(); if (t && predicate(t)) return t; await sleep(200) }
  throw new Error(`${label} — file reads ${JSON.stringify(toml())?.slice(0, 300)}`)
}
const openScreen = async () => {
  await goto('/capture/')
  await until(`!!document.getElementById('capture-form')`, v => v, 'the settings form never rendered', 30_000)
}

const testPart = async () => {
  await press('capture-test')
  return until(`document.getElementById('capture-test-result')?.dataset.part ?? null`, v => v, 'Test never answered', 15_000)
}
// Press Connect and read what the screen opened, then play the share app: the
// browser's return is a plain request to the redirect_uri with the state it sent.
const connectKey = async ({ code = CODE, approve = true } = {}) => {
  await evaluate(`window.__opened = []; window.open = u => { window.__opened.push(String(u)); return null }`)
  await press('capture-connect')
  await until(`document.getElementById('capture-waiting')?.textContent ?? ''`, t => t.includes('Waiting for approval in your browser'), 'Connect never showed the waiting state')
  const link   = await evaluate(`document.getElementById('capture-connect-link')?.href ?? null`)
  const opened = await evaluate(`window.__opened`)
  const q = new URL(link).searchParams
  share.expect = { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') }
  if (approve) {
    const res = await fetch(`${q.get('redirect_uri')}?${code ? `code=${code}&` : 'error=access_denied&'}state=${encodeURIComponent(q.get('state'))}`)
    return { link, opened, q, page: await res.text(), status: res.status }
  }
  return { link, opened, q }
}

const consoleErrors = []
browser.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return
  const t = p.args.map(a => a.value ?? a.description ?? '').join(' ')
  if (!/favicon|\[vite\]/i.test(t)) consoleErrors.push(t)
})

const FOLDER = join(SCRATCH, 'shots')
const TEMPLATE = 'Shot-%Y%m%d-%n'

try {
  await goto('/login/')
  await until(`!!document.getElementById('key')`, v => v, 'the sign-in form never rendered')
  await evaluate(`(() => { const el = document.getElementById('key'); el.value = ${JSON.stringify(KEY)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/home/', 'sign-in never landed on home')
  ok('signed in with the pass-phrase')

  console.log('\n  /capture/ — Rust\'s defaults, from a file that does not exist')
  await openScreen()
  check('the file is the scratch one, not the real one', (await textOf('header code'))?.includes(FILE), await textOf('header code'))
  check('no file has been written by looking', !existsSync(FILE))
  const defaults = {
    'capture-save-to-file': true, 'capture-save-dir': join(homedir(), 'Pictures', 'Screenshots'),
    'capture-template': 'Screenshot_%Y-%m-%d_%H-%M-%S', 'capture-format': 'webp', 'capture-delay': '5',
    'capture-start-tool': 'select', 'capture-border-width': '0', 'capture-scale': 'auto', 'capture-fps': '30', 'capture-cursor': true, 'capture-ink': '3',
    'capture-ink-never': false, 'capture-web-url': '',
  }
  for (const [id, want] of Object.entries(defaults)) {
    const got = typeof want === 'boolean' ? await checked(id) : await read(id)
    check(`${id} reads ${JSON.stringify(want)}`, got === want, JSON.stringify(got))
  }
  const swatch = hex => `document.querySelector('#capture-border input[type=radio][value="${hex}"]')`
  check('no border: the color is off and black is picked', await evaluate(`${swatch('#000000')}.disabled && ${swatch('#000000')}.checked`) === true)
  check('the key line says none is set', (await textOf('[data-key-state]'))?.startsWith('No key is set.'), await textOf('[data-key-state]'))
  check('Remove key is not offered with no key', !(await evaluate(`!!document.getElementById('capture-remove-key')`)))
  check('there is no key box to paste into', await evaluate(`!document.getElementById('capture-web-key') && !document.querySelector('input[type=password]')`))
  check('Connect is disabled with no address saved', await evaluate(`(() => { const e = document.getElementById('capture-connect'); return (e.matches('button') ? e : e.querySelector('button')).disabled })()`) === true)
  check('the hint asks for the address first', (await textOf('#capture-connect-hint'))?.includes('Save the address'), await textOf('#capture-connect-hint'))
  check('Test with no address names the address', await testPart() === 'url', await textOf('#capture-test-result'))

  console.log('\n  Every setting, changed through its control, saved, read from disk')
  await flip('capture-save-to-file')
  await type('capture-save-dir', FOLDER)
  await evaluate(`document.querySelector('[data-preset="%Y%m%d-%H%M%S"]').click()`)
  check('a preset fills the file name', await read('capture-template') === '%Y%m%d-%H%M%S', await read('capture-template'))
  await type('capture-template', TEMPLATE)
  await choose('capture-format', 'png')
  await choose('capture-start-tool', 'arrow')
  await type('capture-border-width', '6')
  check('a border width turns the color on', await evaluate(`${swatch('#3b82f6')}.disabled`) === false)
  await evaluate(`${swatch('#3b82f6')}.click()`)
  await type('capture-delay', '12')
  await choose('capture-scale', '1.5')
  await choose('capture-fps', '60')
  await flip('capture-cursor')
  await type('capture-ink', '7.5')
  await type('capture-web-url', SHARE_URL)
  await press('capture-save')
  const t1 = await saved(t => t.name_template === TEMPLATE, 'the save never reached the file')
  check('save_to_file is off', t1.save_to_file === false, JSON.stringify(t1.save_to_file))
  check('save_dir is the typed folder', t1.save_dir === FOLDER, t1.save_dir)
  check('name_template is the typed one', t1.name_template === TEMPLATE)
  check('file_format is png', t1.file_format === 'png', t1.file_format)
  check('delay_secs is 12', t1.delay_secs === 12, String(t1.delay_secs))
  check('start_tool is arrow', t1.start_tool === 'arrow', t1.start_tool)
  check('border_width is 6', t1.border_width === 6, String(t1.border_width))
  check('border_color is the picked swatch', t1.border_color === '#3b82f6', t1.border_color)
  check('ui_scale is 1.5', t1.ui_scale === 1.5, String(t1.ui_scale))
  check('video_fps is 60', t1.video_fps === 60, String(t1.video_fps))
  check('video_cursor_highlight is off', t1.video_cursor_highlight === false, String(t1.video_cursor_highlight))
  check('video_ink_secs is 7.5', t1.video_ink_secs === 7.5, String(t1.video_ink_secs))
  check('web_url is the typed address', t1.web_url === SHARE_URL, t1.web_url)
  check('the file is mode 0600', mode() === 0o600, mode()?.toString(8))
  check('no key was asked for, so none is in the file', !t1.web_key)

  await flip('capture-ink-never')
  check('Never fade disables the seconds box', await evaluate(`${NATIVE('capture-ink')}.disabled`) === true)
  await choose('capture-scale', 'auto')
  await press('capture-save')
  const t2 = await saved(t => t.video_ink_secs === 0 && !('ui_scale' in t), 'Never fade and Auto never reached the file')
  check('Never fade writes video_ink_secs 0', t2.video_ink_secs === 0)
  check('Auto removes ui_scale from the file', !('ui_scale' in t2))
  check('the other settings stayed', t2.file_format === 'png' && t2.delay_secs === 12 && t2.video_fps === 60 && t2.save_to_file === false)

  console.log('\n  Reload — the saved values come back')
  await openScreen()
  const back = {
    'capture-save-to-file': false, 'capture-save-dir': FOLDER, 'capture-template': TEMPLATE, 'capture-format': 'png', 'capture-start-tool': 'arrow',
    'capture-border-width': '6', 'capture-delay': '12', 'capture-scale': 'auto', 'capture-fps': '60', 'capture-cursor': false,
    'capture-ink-never': true, 'capture-web-url': SHARE_URL,
  }
  for (const [id, want] of Object.entries(back)) {
    const got = typeof want === 'boolean' ? await checked(id) : await read(id)
    check(`${id} reads ${JSON.stringify(want)} after a reload`, got === want, JSON.stringify(got))
  }
  await flip('capture-ink-never')
  check('un-ticking Never brings the seconds back to the default', await read('capture-ink') === '3', await read('capture-ink'))

  console.log('\n  Connect — the key comes back through the API, never through the page')
  await openScreen()
  check('Test with an address and no key names the key', await testPart() === 'key', await textOf('#capture-test-result'))
  const c1 = await connectKey()
  check('Connect opened one window, the same URL as the link', c1.opened.length === 1 && c1.opened[0] === c1.link, JSON.stringify(c1.opened))
  check('the link goes to the share app\'s connect page', c1.link.startsWith(`${SHARE_URL}connect/?`), c1.link)
  check('and carries device, redirect_uri, state and code_challenge', ['device', 'redirect_uri', 'state', 'code_challenge'].every(k => c1.q.get(k)) && /^[A-Za-z0-9_-]{43}$/.test(c1.q.get('code_challenge')), c1.link)
  check('the redirect_uri is this API, on the port it listens on', c1.q.get('redirect_uri') === `${API}/capture-connected`, c1.q.get('redirect_uri'))
  check('the landing page says who it connected', c1.status === 200 && c1.page.includes('Connected as ada@example.com. You can close this tab'), c1.page.slice(0, 200))
  check('the landing page does not hold the key', !c1.page.includes(SHARE))
  check('the share server saw one good exchange', share.exchanged === 1, String(share.exchanged))
  const t3 = await saved(t => t.web_key === SHARE, 'the key never reached the file')
  check('the key is in the file', t3.web_key === SHARE)
  check('and the file is still 0600', mode() === 0o600, mode()?.toString(8))
  await until(`document.querySelector('[data-key-state]')?.textContent ?? ''`, t => t.includes('A key is set'), 'the screen never learned the key arrived')
  check('the waiting state is gone', await evaluate(`!document.getElementById('capture-waiting')`))
  const exposed = await evaluate(`(() => {
    const values = [...document.querySelectorAll('input,textarea')].map(e => e.value).join('|')
    return document.documentElement.outerHTML.includes(${JSON.stringify(SHARE)}) || document.body.innerText.includes(${JSON.stringify(SHARE)}) || values.includes(${JSON.stringify(SHARE)})
  })()`)
  check('the key is nowhere in the page', exposed === false)
  check('the page shows only a masked tail', /A key is set \(••••34\)/.test((await textOf('[data-key-state]')) ?? ''), await textOf('[data-key-state]'))
  check('and says sharing is on', (await textOf('[data-key-state]'))?.includes('Sharing is on'), await textOf('[data-key-state]'))
  check('Remove key is offered', await evaluate(`!!document.getElementById('capture-remove-key')`))
  await openScreen()
  check('a reload does not bring the key back either', await evaluate(`!document.documentElement.outerHTML.includes(${JSON.stringify(SHARE)}) && [...document.querySelectorAll('input')].every(e => !e.value.includes(${JSON.stringify(SHARE)}))`))

  console.log('\n  Connect, refused: a cancelled approval and a stale landing write nothing')
  await press('capture-remove-key')
  await saved(t => !t.web_key, 'Remove key never cleared the file')
  await until(`document.querySelector('[data-key-state]')?.textContent ?? ''`, t => t.includes('No key is set'), 'the page never learned the key is gone')
  const c2 = await connectKey({ code: null })
  check('access_denied shows a cancelled page', c2.page.includes('cancelled'), c2.page.slice(0, 200))
  check('and no key was written', !toml()?.web_key)
  await until(`document.getElementById('capture-waiting') === null ? 'gone' : ''`, v => v === 'gone', 'the screen kept waiting after a cancel', 15_000)
  const stale = await fetch(`${API}/capture-connected?code=${CODE}&state=${encodeURIComponent(c2.q.get('state'))}`)
  check('a landing with a spent state is refused and writes nothing', stale.status === 400 && !toml()?.web_key, String(stale.status))
  const wrong = await fetch(`${API}/capture-connected?code=${CODE}&state=nope`)
  check('a landing with the wrong state is refused', wrong.status === 400)

  console.log('\n  Test — each failing part, then success')
  await connectKey()
  await until(`document.querySelector('[data-key-state]')?.textContent ?? ''`, t => t.includes('A key is set'), 'the key never arrived the second time')
  check('Test with a good key succeeds and names whose it is', await testPart() === 'ok' && (await textOf('#capture-test-result'))?.includes('ada@example.com'), await textOf('#capture-test-result'))
  share.mode = 'revoked'
  check('a revoked key names the key', await testPart() === 'key', await textOf('#capture-test-result'))
  share.mode = 'html'
  check('something that is not the share app names the address', await testPart() === 'url', await textOf('#capture-test-result'))
  share.mode = 'ok'
  const dead = await freePort()
  await type('capture-web-url', `http://127.0.0.1:${dead}/share/`)
  await press('capture-save')
  await saved(t => t.web_url.includes(String(dead)), 'the unreachable address never reached the file')
  check('an unreachable server names the network', await testPart() === 'network', await textOf('#capture-test-result'))
  await type('capture-web-url', SHARE_URL)
  await press('capture-save')
  await saved(t => t.web_url === SHARE_URL, 'the address never came back')

  await press('capture-remove-key')
  const t4 = await saved(t => !t.web_key, 'Remove key never cleared the file')
  check('Remove key clears web_key in the file', !t4.web_key, JSON.stringify(t4.web_key))
  check('and leaves the address alone', t4.web_url === SHARE_URL)
  await until(`document.querySelector('[data-key-state]')?.textContent ?? ''`, t => t.includes('No key is set'), 'the page never learned the key is gone')
  check('the page says no key, sharing off', /No key is set\. Sharing is off\./.test((await textOf('[data-key-state]')) ?? ''), await textOf('[data-key-state]'))

  console.log('\n  Refusals — said on the screen, the file unchanged')
  const before = raw()
  await type('capture-template', '')
  await press('capture-save')
  const said = await until(`document.body.innerText`, t => /must not be empty/.test(t), 'an empty file name was never refused on the screen', 8000)
  check('an empty file name is refused by name', /file name template must not be empty/.test(said))
  check('and the file is byte for byte as it was', raw() === before)
  check('and the form still holds what was typed', await read('capture-template') === '')

  console.log('\n  Reset to defaults — asks first, keeps the address, the key and what it does not know')
  await openScreen()
  await type('capture-delay', '20')
  await choose('capture-format', 'png256')
  await choose('capture-fps', '60')
  await choose('capture-scale', '2')
  await type('capture-web-url', SHARE_URL)
  await press('capture-save')
  await saved(t => t.delay_secs === 20 && t.web_url === SHARE_URL, 'the settings before the reset never reached the file')
  await connectKey()
  await saved(t => t.web_key === SHARE, 'the key never reached the file before the reset')
  appendFileSync(FILE, '\nfuture_flag = true\n\n[mine]\nname = "kept"\n')
  const changed = raw()
  await press('capture-reset')
  await until(`!!document.getElementById('capture-reset-confirm')`, v => v, 'Reset never asked to confirm', 5000)
  check('Reset asks on the page before it writes', raw() === changed)
  await press('capture-reset-no')
  await until(`!document.getElementById('capture-reset-confirm')`, v => v, 'Cancel never closed the question', 5000)
  check('Cancel writes nothing', raw() === changed)
  await press('capture-reset')
  await until(`!!document.getElementById('capture-reset-yes')`, v => v, 'Reset never asked again', 5000)
  await press('capture-reset-yes')
  const t5 = await saved(t => t.delay_secs === 5, 'the reset never reached the file')
  const want = {
    save_to_file: true, save_dir: join(homedir(), 'Pictures', 'Screenshots'), name_template: 'Screenshot_%Y-%m-%d_%H-%M-%S',
    delay_secs: 5, file_format: 'webp', capture_mode: 'screenshot', video_fps: 30, video_ink_secs: 3,
    video_name_template: 'Recording_%Y-%m-%d_%H-%M-%S', video_cursor_highlight: true, record_audio: false,
    record_system_audio: false, webcam: false, webcam_size: 'medium',
  }
  for (const [k, v] of Object.entries(want)) check(`reset writes ${k} = ${JSON.stringify(v)}`, t5[k] === v, JSON.stringify(t5[k]))
  check('reset removes ui_scale, which is Auto', !('ui_scale' in t5))
  check('reset puts the tool styles back', t5.tool_styles?.highlighter?.color === '#ffc107' && t5.tool_styles?.text?.size === 22, JSON.stringify(t5.tool_styles?.text))
  check('the share address is kept', t5.web_url === SHARE_URL, t5.web_url)
  check('the key is kept', t5.web_key === SHARE)
  check('the file is still 0600', mode() === 0o600, mode()?.toString(8))
  check('an unknown key survived', t5.future_flag === true)
  check('an unknown section survived', t5.mine?.name === 'kept', JSON.stringify(t5.mine))
  await until(`!document.getElementById('capture-reset-confirm')`, v => v, 'the question stayed open after the reset', 5000)
  check('the screen shows the defaults', await read('capture-delay') === '5' && await read('capture-format') === 'webp' && await read('capture-scale') === 'auto' && await read('capture-fps') === '30',
    JSON.stringify([await read('capture-delay'), await read('capture-format'), await read('capture-scale'), await read('capture-fps')]))
  check('and still says a key is set', (await textOf('[data-key-state]'))?.includes('A key is set'), await textOf('[data-key-state]'))
  check('and the key is still nowhere in the page', !(await evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(SHARE)})`)))

  const real = fingerprint()
  check('~/.config/capture was not created', real.dir === realBefore.dir, JSON.stringify([realBefore.dir, real.dir]))
  check('and the real config.toml was not touched', real.file === realBefore.file)
  check('no console errors on the screen', !consoleErrors.length, consoleErrors.join(' | ').slice(0, 300))
} catch (e) {
  bad('the drive stopped', e.message + (consoleErrors.length ? ` | console: ${consoleErrors.join(' | ').slice(0, 400)}` : ''))
}

await cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
