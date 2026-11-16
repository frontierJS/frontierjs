#!/usr/bin/env node
// web/test/verify-messages.mjs -- /messages/ reads and writes the team's
// Mattermost through Workbench (`IDEAS/workbench-messages.md` 2.1-2.3).
//
//   bun run verify:messages
//   API_PORT=7121 UI_PORT=7021 bun run verify:messages   # pin the ports
//
// Never the live server: the chat URL handed to the API is the connector's sink,
// started here, and every CHAT_* variable in the environment is dropped. The
// databases (main, chat, jobs) and the config folder are a temp directory, so
// the owner's running Workbench and its db/ files are never touched; the API and
// the web server take OS-chosen ports.
//
// What only this can ask: that the pages COMPILE (a .mesa error can be silent in
// a loader, so the proof is the page rendering with zero console errors), that a
// token pasted on /laptop/ links the member, that a post another person makes on
// the server arrives over /ws without a reload, and that a channel that is not
// open grows an unread pill the sync computed.

// The global port block has no slot for a drive, so every server takes an OS port.
export const holds = []

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'
import { startMattermostSink } from '@frontierjs/conduit-mattermost/sink'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG  = join(HERE, '..', '..')
const freePort = () => new Promise((done, fail) => {
  const s = createServer()
  s.on('error', fail)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)) })
})
const API_PORT = Number(process.env.API_PORT ?? await freePort())
const WEB_PORT = Number(process.env.UI_PORT ?? await freePort())
const BASE = `http://localhost:${WEB_PORT}`
const API  = `http://localhost:${API_PORT}`
const KEY  = 'workbench-drive-key'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
let passed = 0, failed = 0
let browser = null
let sink = null
let SCRATCH = null

const ok  = (label) => { passed++; console.log(`  ✓ ${label}`) }
const bad = (label, detail) => { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
const check = (label, cond, detail) => cond ? ok(label) : bad(label, typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400))

// The GROUP, not the child: `bun run web` spawns vite, so killing the direct child leaves the server holding its port.
async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill?.() } catch {} } }
  await sleep(500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  await browser?.close()
  sink?.stop()
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup().then(() => process.exit(130)))

for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

// Nothing here may name a real server.
const env = { ...process.env }
for (const k of Object.keys(env)) if (k.startsWith('CHAT_')) delete env[k]

SCRATCH = mkdtempSync(join(tmpdir(), 'workbench-messages-'))
sink = startMattermostSink({ port: 0 })
const { ids, tokens } = sink
const sinkCall = async (path, token, init = {}) => {
  const res = await fetch(`${sink.url}/api/v4${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const sinkPost = (token, channel_id, message) => sinkCall('/posts', token, { method: 'POST', body: { channel_id, message } })

// Posts that exist before the member links: what the backfill lands.
const earlier = `backfilled ${Date.now()}`
await sinkPost(tokens.bob, ids.open, earlier)
await sinkPost(tokens.bob, ids.open, 'a second line, with **bold** and a mention of @alice')

children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...env, DATABASE_URL: join(SCRATCH, 'workbench.db'), CHAT_DATABASE_URL: join(SCRATCH, 'chat.db'),
         JOBS_DATABASE_URL: join(SCRATCH, 'jobs.db'), AUDIT_PATH: join(SCRATCH, 'audit.db'),
         XDG_CONFIG_HOME: SCRATCH, WORKBENCH_DIR: join(SCRATCH, 'workbench'),
         CHAT_URL: sink.url, FRONTIER_APP_URL: BASE, PORT: String(API_PORT), WORKBENCH_KEY: KEY },
}))
children.push(spawn('bun', ['run', 'web'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...env, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) },
}))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) { try { await fetch(url); return } catch {} await sleep(500) }
  fail(`${label} never answered ${url}`)
}
await waitFor(`${API}/health`, 'the API')
await waitFor(BASE, 'the web server')

browser = await openChrome().catch(async (e) => { console.error(`\n✗ ${e.message}\n`); await cleanup(); process.exit(1) })
const send = browser.cmd
// A headless page has no focus, and the channel on screen is read only while the window has it.
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

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
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 300)}`)
}
const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }
// A native setter plus `input`: setting `.value` alone tells Mesa nothing.
const fillSel = (sel, v) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('nothing matches ${sel}')
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set
  set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const textOf = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`)
const clickText = (sel, text) => evaluate(`(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(text)}))
  if (!b) throw new Error('nothing under ${sel} reads ${text}')
  b.click(); return true })()`)

// Zero allowed: a console error or a failed request is a bug that rendered plausibly.
const problems = []
browser.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return
  const t = p.args.map(a => a.value ?? a.description ?? '').join(' ')
  if (!/favicon/i.test(t)) problems.push(`console: ${t.slice(0, 300)}`)
})
browser.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300)}`))
browser.on('Network.responseReceived', (p) => {
  if (p.response.status >= 400 && !/favicon/i.test(p.response.url)) problems.push(`${p.response.status} ${p.response.url}`)
})
browser.on('Network.loadingFailed', (p) => { if (!p.canceled) problems.push(`failed ${p.errorText} ${p.requestId}`) })
await send('Network.enable')

const pillOf = id => textOf(`[data-chat-sidebar] [data-channel="${id}"] .chat-pill`)
const postTexts = () => evaluate(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`)

try {
  console.log('\n  Sign in, and link a member on /laptop/')
  await goto('/login/')
  await until(`!!document.getElementById('key')`, v => v, 'the sign-in form never rendered')
  await fillSel('#key', KEY)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/home/', 'sign-in never landed on home')
  ok('signed in with the pass-phrase')

  await goto('/messages/')
  await until(`!!document.querySelector('[data-messages-unlinked]')`, v => v, 'an unlinked member never saw the prompt')
  const prompt = await textOf('[data-messages-unlinked]')
  check('an unlinked member sees a prompt that points to Laptop', /Laptop/.test(prompt ?? ''), prompt)

  await goto('/laptop/')
  await until(`!!document.querySelector('[role=tab]')`, v => v, 'the Laptop tabs never rendered')
  await clickText('[role=tab]', 'Services')
  await until(`!!document.querySelector('[data-link]')`, v => v, 'the Messages card never rendered')
  await until(`!!document.querySelector('input[aria-label="Team chat personal access token"]')`, v => v, 'the card never offered the token box', 15_000)
  ok('the Messages card starts unlinked, with a token box')
  await fillSel('input[aria-label="Team chat personal access token"]', 'not-a-token')
  await clickText('[data-link] button', 'Connect')
  await until(`document.querySelector('[data-link] .alert')?.textContent ?? ''`, t => t.length > 0, 'a refused token showed no error')
  ok('a token the server refuses is shown as an error')
  await fillSel('input[aria-label="Team chat personal access token"]', tokens.alice)
  await clickText('[data-link] button', 'Connect')
  await until(`document.querySelector('[data-link]').dataset.link`, v => v === 'linked', 'Connect never linked the member')
  const linkedText = await textOf('[data-link]')
  check('the card says who the member is linked as', /@alice/.test(linkedText ?? ''), linkedText)

  console.log('\n  /messages/ — the channels, a channel, its backfilled posts')
  await goto('/messages/')
  await until(`location.pathname`, p => /^\/messages\/[a-z0-9]{26}\/$/.test(p), '/messages/ never redirected to a channel', 30_000)
  const first = await evaluate(`location.pathname.split('/')[2]`)
  check('/messages/ redirects to the first channel, by its externalId', first === ids.open, first)
  const listed = await until(`[...document.querySelectorAll('[data-chat-sidebar] [data-channel]')].map(a => a.dataset.channel).sort()`, l => l.length >= 2, 'the sidebar never listed both channels', 30_000)
  check('the sidebar lists the open channel and the private one', listed.includes(ids.open) && listed.includes(ids.secret), listed)
  await until(`document.querySelector('[data-room-title]')?.textContent ?? ''`, t => t.trim() === 'General', 'the header never named the channel')
  ok('the header names the channel')
  const texts = await until(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`, l => l.length >= 2, 'the backfilled posts never drew', 30_000)
  check('the backfilled posts are drawn, oldest first', texts[0]?.includes(earlier) && texts[1]?.includes('a second line'), texts)
  const authors = await evaluate(`[...document.querySelectorAll('[data-post-author]')].map(e => e.textContent.trim())`)
  check('a post is signed with its author\'s name', authors.includes('bob'), authors)
  const mention = await evaluate(`document.querySelectorAll('[data-post-list] [data-post-text] strong').length`)
  check('markdown and a known @mention are drawn (bold and bold)', mention >= 2, mention)

  console.log('\n  Posting, and a post arriving')
  const mine = `from the screen ${Date.now()}`
  await fillSel('[data-composer] textarea', mine)
  await evaluate(`document.querySelector('[data-composer] textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`document.querySelector('[data-composer] textarea').value`, v => v === '', 'Enter never sent and cleared the box')
  ok('Enter sends and clears the box')
  await until(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].map(e => e.textContent).join('|')`, t => t.includes(mine), 'the sent post never drew')
  ok('the sent post draws from the push')
  const there = await sinkCall(`/channels/${ids.open}/posts`, tokens.alice)
  const held = Object.values(there.json?.posts ?? {}).find(p => p.message === mine)
  check('the sink holds it, authored by alice', held?.user_id === ids.alice, held)

  const theirs = `bob says ${Date.now()}`
  await sinkPost(tokens.bob, ids.open, theirs)
  await until(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].map(e => e.textContent).join('|')`, t => t.includes(theirs), 'another person\'s post never arrived over /ws', 15_000)
  ok('a second user\'s post arrives without a reload')
  await sleep(1500)
  check('the channel on screen shows no pill for it', (await pillOf(ids.open)) === null, await pillOf(ids.open))

  console.log('\n  Unread: a channel that is not open')
  await evaluate(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.secret}"]').click()`)
  await until(`location.pathname`, p => p === `/messages/${ids.secret}/`, 'the sidebar link never opened ops')
  await until(`document.querySelector('[data-room-title]')?.textContent.trim()`, t => t === 'Ops', 'the header never moved to ops')
  ok('opening a channel from the sidebar moves the header')
  const away = `while you were in ops ${Date.now()}`
  await sinkPost(tokens.bob, ids.open, away)
  const pill = await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]')?.textContent.trim() ?? ''`, t => t === '1', 'no unread pill of 1 on general', 15_000)
  check('a post in a channel that is not open raises its unread pill', pill === '1', pill)
  const named = `hey @alice ${Date.now()}`
  await sinkPost(tokens.bob, ids.open, named)
  await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]')?.dataset.pill`, t => t === 'mention', 'the mention never turned the pill', 15_000)
  ok('a post naming the reader makes it a mention pill')
  await evaluate(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"]').click()`)
  await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]') === null`, v => v === true, 'opening general never cleared its pill', 15_000)
  ok('opening the channel (chat.view) clears the pill')
  const seen = await until(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].map(e => e.textContent).join('|')`, t => t.includes(away) && t.includes(named), 'the unread posts never drew')
  ok('and its posts are there')

  console.log('\n  Chrome')
  check('the nav carries Messages', await evaluate(`[...document.querySelectorAll('a[href="/messages/"]')].some(a => /Messages/.test(a.textContent))`))
  if (process.env.FRONTIER_DRIVE_SHOT) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(process.env.FRONTIER_DRIVE_SHOT, Buffer.from(data, 'base64'))
  }
} catch (err) {
  bad('the drive threw', err.message)
  // What the API itself holds for the member, so a miss on screen is told from a miss in the sync.
  try {
    const login = await (await fetch(`${API}/door/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ key: KEY }) })).json()
    const get = async (path) => (await (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${login.token}`, accept: 'application/json' } })).json())
    const cs = await get('/channels'), ms = await get('/channelMembers')
    console.log('    API channels:', JSON.stringify((cs.data ?? cs).map?.(c => [c.name, c.type])), 'members:', JSON.stringify((ms.data ?? ms).map?.(m => [m.channelExternalId?.slice(0, 8), m.profileExternalId?.slice(0, 8)])))
  } catch (e) { console.log('    (could not read the API:', e.message, ')') }
}

check('no console error, exception or failed request', problems.length === 0, problems)
console.log(`\n${failed ? `${failed} failed` : 'all green'} (${passed} passed)`)
await cleanup()
process.exit(failed ? 1 : 0)
