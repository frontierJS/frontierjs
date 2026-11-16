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
let rootId = null   // the thread the drive is on, so a miss can be told from the API's side

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


const sel = (v) => JSON.stringify(v)
const click = (s) => evaluate(`(() => { const el = document.querySelector(${sel(s)}); if (!el) throw new Error('nothing matches ' + ${sel(s)}); el.click(); return true })()`)
const exists = (s) => evaluate(`!!document.querySelector(${sel(s)})`)
const typeAndEnter = async (s, v) => {
  await fillSel(s, v)
  await evaluate(`document.querySelector(${sel(s)}).focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}
// A hover-bar menu is portaled out of the post, so a row is found by its words.
const menuItems = () => evaluate(`[...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent.replace(/\\s+/g, ' ').trim())`)
async function openMenu(scope, trigger) {
  await until(`!!document.querySelector(${sel(`${scope} ${trigger}`)})`, v => v, `${scope} ${trigger} never drew`)
  await click(`${scope} ${trigger}`)
  await until(`document.querySelectorAll('[role=menuitem]').length`, n => n > 0, 'the menu never opened')
}
async function menuPick(scope, trigger, text) {
  await openMenu(scope, trigger)
  await until(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${sel(text)}))`, v => v, `the menu never offered ${text}`)
  await clickText('[role=menuitem]', text)
}
const channelPosts = async () => Object.values((await sinkCall(`/channels/${ids.open}/posts`, tokens.alice)).json?.posts ?? {})
const sinkPostBy = async (message) => (await channelPosts()).find(p => p.message === message)
const textsIn = (area) => evaluate(`[...document.querySelectorAll(${sel(area + ' [data-post-text]')})].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`)
const threadOf = async (root) => (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/threads/${root}`, tokens.alice)).json
const markUnreadOf = async () => (await sinkCall(`/channels/${ids.open}/members`, tokens.alice)).json?.find(m => m.user_id === ids.alice)?.notify_props?.mark_unread
const reactionsOn = async (post) => ((await sinkCall(`/channels/${ids.open}/posts`, tokens.alice)).json?.posts?.[post]?.metadata?.reactions ?? []).map(r => `${r.user_id === ids.bob ? 'bob' : 'alice'}:${r.emoji_name}`).sort()

const poll = async (fn, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250) } return null }
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
  await fillSel('[data-composer="post"] textarea', mine)
  await evaluate(`document.querySelector('[data-composer="post"] textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`document.querySelector('[data-composer="post"] textarea').value`, v => v === '', 'Enter never sent and cleared the box')
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

  // ── 2.4 The thread pane ──
  console.log('\n  Threads: a pane beside the channel, replies, a reply arriving, read, follow')
  const rootText = `thread root ${Date.now()}`
  const root = (await sinkPost(tokens.bob, ids.open, rootText)).json
  const R = root.id
  rootId = R
  await until(`!!document.querySelector('[data-post="${R}"]')`, v => v, 'the new root never drew', 15_000)
  check('a post with no replies has no reply link', !(await exists(`[data-post="${R}"] [data-post-replies]`)))
  await click(`[data-post="${R}"] [data-post-reply]`)
  await until(`location.search`, q => q === `?thread=${R}`, 'Reply in thread never put ?thread= in the URL')
  await until(`!!document.querySelector('[data-thread-pane="${R}"] [data-post="${R}"]')`, v => v, 'the pane never drew the root')
  ok('Reply in thread opens the pane on ?thread=<root> with the root in it')
  const mineReply = `my reply ${Date.now()}`
  await typeAndEnter('[data-composer="reply"] textarea', mineReply)
  await until(`document.querySelector('[data-composer="reply"] textarea').value`, v => v === '', 'the reply box never cleared')
  await until(`document.querySelector('[data-thread-posts]').textContent`, t => t.includes(mineReply), 'the reply never drew in the pane')
  const replySink = (await channelPosts()).find(p => p.message === mineReply)
  check('the sink holds the reply with root_id and alice as author', replySink?.root_id === R && replySink?.user_id === ids.alice, replySink)
  const theirReply = `bob answers ${Date.now()}`
  await sinkCall('/posts', tokens.bob, { method: 'POST', body: { channel_id: ids.open, message: theirReply, root_id: R } })
  await until(`document.querySelector('[data-thread-posts]').textContent`, t => t.includes(theirReply), 'a second person\'s reply never arrived in the pane', 15_000)
  ok('a reply from another person arrives in the pane without a reload')
  let th
  for (let i = 0; i < 40; i++) { th = await threadOf(R); if (th?.unread_replies === 0) break; await sleep(250) }
  check('the thread reads as read on the server (opening it called readThread)', th?.unread_replies === 0, th)
  const listNow = await textsIn('[data-post-list]')
  check('the replies are not drawn as root posts in the channel', !listNow.some(t => t.includes(mineReply) || t.includes(theirReply)), listNow)
  const link = await until(`document.querySelector('[data-post="${R}"] [data-post-replies]')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`, t => t.includes('2 replies'), 'the root never showed 2 replies', 15_000)
  ok('the root carries "2 replies" as the link that opens the thread')

  // Following: replying follows; the pane's button turns it off and on.
  await until(`!!document.querySelector('[data-thread-following]')`, v => v, 'the pane never said Following after a reply')
  await click('[data-thread-follow]')
  await until(`document.querySelector('[data-thread-follow]').textContent.trim()`, t => t === 'Follow', 'Unfollow never turned the button to Follow')
  check('unfollow reaches the server', (await threadOf(R))?.is_following === false, await threadOf(R))
  await click('[data-thread-follow]')
  await until(`document.querySelector('[data-thread-follow]').textContent.trim()`, t => t === 'Unfollow', 'Follow never turned the button to Unfollow')
  check('follow reaches the server', (await threadOf(R))?.is_following === true, await threadOf(R))

  // The Threads route.
  await click('[data-threads-link]')
  await until(`location.pathname`, p => p === '/messages/threads/', 'the Threads link never opened the route')
  await until(`!!document.querySelector('[data-thread-row="${R}"]')`, v => v, 'the followed thread is not listed', 15_000)
  ok('/messages/threads/ lists the followed thread')
  check('and it is not marked new once read', !(await exists(`[data-thread-row="${R}"] [data-thread-new]`)))
  // The sink tells a thread's author, replier and the people named; naming alice is what reaches her.
  await sinkCall('/posts', tokens.bob, { method: 'POST', body: { channel_id: ids.open, message: `another reply for @alice ${Date.now()}`, root_id: R } })
  await until(`!!document.querySelector('[data-thread-row="${R}"] [data-thread-new]')`, v => v, 'a new reply never marked the row New', 15_000)
  ok('a reply landing while the list is open marks the row New')
  await click(`[data-thread-row="${R}"] [data-thread-unfollow]`)
  await until(`!document.querySelector('[data-thread-row="${R}"]')`, v => v, 'Unfollow never took the row off the list')
  check('Unfollow leaves the list and reaches the server', (await threadOf(R))?.is_following === false, await threadOf(R))
  await click(`[data-chat-sidebar] [data-channel="${ids.open}"]`)
  await until(`location.pathname`, p => p === `/messages/${ids.open}/`, 'the sidebar never went back to general')
  await until(`!!document.querySelector('[data-post="${R}"]')`, v => v, 'general never redrew its posts', 15_000)

  // ── Edit, delete, and what the menu offers another person's post ──
  console.log('\n  Posts: edit, delete')
  await openMenu(`[data-post="${R}"]`, '[data-post-more]')
  const theirs2 = await menuItems()
  check('another person\'s post offers no Edit and no Delete', !theirs2.some(t => /^(Edit|Delete)/.test(t)), theirs2)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`document.querySelectorAll('[role=menuitem]').length`, n => n === 0, 'Esc never closed the menu')
  const mineSink = await sinkPostBy(mine)
  await menuPick(`[data-post="${mineSink.id}"]`, '[data-post-more]', 'Edit')
  await until(`!!document.querySelector('[data-post-editor] textarea')`, v => v, 'Edit never opened the editor')
  const edited = `${mine} (edited)`
  await typeAndEnter('[data-post-editor] textarea', edited)
  await until(`!document.querySelector('[data-post-editor]')`, v => v, 'Enter never saved and closed the editor')
  await until(`document.querySelector('[data-post="${mineSink.id}"] [data-post-text]')?.textContent ?? ''`, t => t.includes('(edited)'), 'the edited text never drew', 15_000)
  await until(`!!document.querySelector('[data-post="${mineSink.id}"] [data-post-edited]')`, v => v, 'the post never said edited')
  check('the sink holds the edited message', (await sinkPostBy(edited))?.id === mineSink.id, await sinkPostBy(edited))
  const doomed = `to delete ${Date.now()}`
  await typeAndEnter('[data-composer="post"] textarea', doomed)
  await until(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].some(e => e.textContent.includes(${sel(doomed)}))`, v => v, 'the post to delete never drew')
  const doomedSink = await sinkPostBy(doomed)
  await menuPick(`[data-post="${doomedSink.id}"]`, '[data-post-more]', 'Delete')
  await until(`!!document.querySelector('[data-confirm-panel]')`, v => v, 'Delete never asked to confirm')
  check('the post is still there while the confirm is open', await exists(`[data-post="${doomedSink.id}"]`))
  await evaluate(`document.querySelector('[data-confirm-panel] .btn.danger').click()`)
  await until(`!document.querySelector('[data-post="${doomedSink.id}"]')`, v => v, 'the confirmed delete never took the post off the screen', 15_000)
  check('the sink no longer lists it', !(await sinkPostBy(doomed)))

  // ── Pins ──
  console.log('\n  Pins')
  const P = (await sinkPostBy(theirs)).id
  await menuPick(`[data-post="${P}"]`, '[data-post-more]', 'Pin')
  await until(`!!document.querySelector('[data-post="${P}"] [data-post-pinned]')`, v => v, 'the pinned post never wore its flag', 15_000)
  check('the sink lists it as pinned', !!(await sinkCall(`/channels/${ids.open}/pinned`, tokens.alice)).json?.posts?.[P])
  await click('[data-room-pins]')
  await until(`!!document.querySelector('[data-pin-item="${P}"]')`, v => v, 'the pins menu never listed the post')
  check('the pins menu counts it', (await textOf('[data-room-pin-count]')) === '1', await textOf('[data-room-pin-count]'))
  await evaluate(`document.querySelector('[data-pin-item="${P}"]').click()`)
  await until(`document.querySelector('[data-post="${P}"]')?.classList.contains('marked')`, v => v === true, 'clicking a pin never marked the post')
  ok('clicking a pin jumps to the post and marks it')
  await menuPick(`[data-post="${P}"]`, '[data-post-more]', 'Unpin')
  await until(`!document.querySelector('[data-post="${P}"] [data-post-pinned]')`, v => v, 'Unpin never took the flag off', 15_000)
  await until(`document.querySelector('[data-room-pin-count]')?.textContent.trim()`, t => t === '0', 'the pin count never went to 0', 15_000)
  check('the sink no longer lists it as pinned', !(await sinkCall(`/channels/${ids.open}/pinned`, tokens.alice)).json?.posts?.[P])

  // ── Reactions ──
  console.log('\n  Reactions')
  await click(`[data-post="${P}"] [data-post-react]`)
  await until(`!!document.querySelector('[data-reaction-quick] [data-emoji="+1"]')`, v => v, 'the picker never offered +1')
  const grid = await evaluate(`document.querySelectorAll('[data-reaction-all] [data-emoji]').length`)
  check('the picker carries the whole map as a grid', grid >= 60, grid)
  check('and no free-form entry', !(await exists('[data-reaction-quick] input, [data-reaction-all] input')))
  await click('[data-reaction-quick] [data-emoji="+1"]')
  await until(`document.querySelector('[data-post="${P}"] [data-reaction="+1"]')?.getAttribute('aria-pressed')`, v => v === 'true', 'my +1 chip never drew as mine', 15_000)
  check('the chip shows the glyph and a count of 1', /👍\s*1/.test(await textOf(`[data-post="${P}"] [data-reaction="+1"]`) ?? ''), await textOf(`[data-post="${P}"] [data-reaction="+1"]`))
  check('the sink holds alice\'s +1', (await reactionsOn(P)).join() === 'alice:+1', await reactionsOn(P))
  await sinkCall('/reactions', tokens.bob, { method: 'POST', body: { user_id: ids.bob, post_id: P, emoji_name: '+1' } })
  await until(`document.querySelector('[data-post="${P}"] [data-reaction="+1"] [data-reaction-count]')?.textContent.trim()`, v => v === '2', 'bob\'s +1 never raised the count', 15_000)
  ok('another person\'s reaction arrives and raises the count')
  await sinkCall('/reactions', tokens.bob, { method: 'POST', body: { user_id: ids.bob, post_id: P, emoji_name: 'zz_not_in_the_map' } })
  await until(`!!document.querySelector('[data-post="${P}"] [data-reaction="zz_not_in_the_map"]')`, v => v, 'an unmapped name never drew', 15_000)
  check('a name outside the map draws as :name: text', /:zz_not_in_the_map:/.test(await textOf(`[data-post="${P}"] [data-reaction="zz_not_in_the_map"]`) ?? ''))
  await click(`[data-post="${P}"] [data-reaction="+1"]`)
  await until(`document.querySelector('[data-post="${P}"] [data-reaction="+1"]')?.getAttribute('aria-pressed')`, v => v === 'false', 'clicking my chip never took my reaction back', 15_000)
  check('un-reacting leaves bob\'s and the sink agrees', (await reactionsOn(P)).join() === 'bob:+1,bob:zz_not_in_the_map', await reactionsOn(P))

  // ── 2.6 Mute, and mark unread ──
  console.log('\n  Mute and mark unread')
  await click('[data-room-mute]')
  await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"]')?.classList.contains('muted-room')`, v => v === true, 'Mute never dimmed the channel', 15_000)
  check('the sink holds the mute (mark_unread: mention)', (await markUnreadOf()) === 'mention', await markUnreadOf())
  await until(`document.querySelector('[data-room-mute]').textContent.trim()`, t => t === 'Unmute', 'the header never offered Unmute')
  await click(`[data-chat-sidebar] [data-channel="${ids.secret}"]`)
  await until(`document.querySelector('[data-room-title]')?.textContent.trim()`, t => t === 'Ops', 'never moved to ops')
  await sinkPost(tokens.bob, ids.open, `quiet ${Date.now()}`)
  await sleep(2000)
  check('a muted channel shows no unread pill for a plain post', (await pillOf(ids.open)) === null, await pillOf(ids.open))
  await sinkPost(tokens.bob, ids.open, `loud @alice ${Date.now()}`)
  await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]')?.dataset.pill`, t => t === 'mention', 'a mention never pilled a muted channel', 15_000)
  ok('but keeps its mention pill')
  await click(`[data-chat-sidebar] [data-channel="${ids.open}"]`)
  await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]') === null`, v => v === true, 'opening never cleared the mention', 15_000)
  await click('[data-room-mute]')
  await until(`!document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"]').classList.contains('muted-room')`, v => v, 'Unmute never restored the channel', 15_000)
  check('the sink holds the unmute (mark_unread: all)', (await markUnreadOf()) === 'all', await markUnreadOf())
  ok('Unmute restores the channel')

  const M = (await sinkPostBy(theirs)).id
  await menuPick(`[data-post="${M}"]`, '[data-post-more]', 'Mark unread')
  await until(`!!document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]')`, v => v, 'Mark unread never moved the pill back', 15_000)
  await sleep(1500)
  check('and the open channel does not read itself straight back', !!(await pillOf(ids.open)), await pillOf(ids.open))
  await typeAndEnter('[data-composer="post"] textarea', `back to it ${Date.now()}`)
  await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]') === null`, v => v === true, 'sending never read the channel again', 15_000)
  ok('sending ends the hold: the pill clears')
  await evaluate(`document.querySelector('[data-post="${M}"] .post-text, [data-post="${M}"] [data-post-text]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }))`)
  await until(`!!document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]')`, v => v, 'Alt-click never marked the post unread', 15_000)
  ok('Alt-click marks unread too')

  console.log('\n  Files: paste an image, attach a text file')
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-composer="post"] textarea')`, v => v, 'the channel never drew its composer')
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await evaluate(`(() => {
    const ta = document.querySelector('[data-composer="post"] textarea')
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(${sel(PNG)}), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) })()`)
  await until(`document.querySelector('[data-composer="post"] [data-composer-file]')?.textContent ?? ''`, t => /Image Pasted at/.test(t) && !/uploading/.test(t), 'a pasted image never finished uploading', 15_000)
  ok('a pasted image is named for when it was pasted and uploads as it is attached')
  await evaluate(`(() => {
    const input = document.querySelector('[data-composer="post"] [data-composer-input]')
    const dt = new DataTransfer(); dt.items.add(new File(['the plain notes'], 'notes.txt', { type: 'text/plain' }))
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await until(`document.querySelector('[data-composer="post"] [data-composer-file="notes.txt"]')?.textContent ?? ''`, t => t.includes('notes.txt') && !/uploading/.test(t), 'the attached text file never finished uploading', 15_000)
  ok('a file chosen with the button uploads too')
  const withFiles = `with files ${Date.now()}`
  await typeAndEnter('[data-composer="post"] textarea', withFiles)
  await until(`document.querySelector('[data-composer="post"] textarea').value === '' && !document.querySelector('[data-composer="post"] [data-composer-file]')`, v => v, 'sending never cleared the box and its files')
  const filed = await poll(() => sinkPostBy(withFiles))
  check('the sink holds the post with both files claimed', filed?.file_ids?.length === 2, filed)
  const fileBytes = async (id) => { const r = await fetch(`${sink.url}/api/v4/files/${id}`, { headers: { authorization: `Bearer ${tokens.alice}` } }); return { type: r.headers.get('content-type'), bytes: new Uint8Array(await r.arrayBuffer()) } }
  const heldFiles = await Promise.all((filed?.file_ids ?? []).map(fileBytes))
  check('and the sink has the bytes: a PNG and the text', heldFiles.some(f => f.type === 'image/png' && f.bytes.length > 20) && heldFiles.some(f => new TextDecoder().decode(f.bytes) === 'the plain notes'), heldFiles.map(f => [f.type, f.bytes.length]))
  const mineEl = `[data-post="${filed?.id}"]`
  await until(`document.querySelector(${sel(mineEl + ' [data-file-card="image"] img')})?.naturalWidth ?? 0`, n => n > 0, 'the image never drew inline', 20_000)
  ok('the image draws inline from the preview route')
  const card = await until(`document.querySelector(${sel(mineEl + ' [data-file-card="file"]')})?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`, t => t.includes('notes.txt'), 'the text file never drew as a card', 20_000)
  check('the text file is a card with its name, size and a download', /notes\.txt/.test(card) && /15 B/.test(card) && /Download/.test(card) && await exists(`${mineEl} [data-file-download]`), card)

  console.log('\n  @-mentions: the picker, the highlight')
  const typeInto = async (s, v) => { await fillSel(s, v); await evaluate(`document.querySelector(${sel(s)}).focus()`) }
  const press = async (key, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk })
  }
  const mentionItems = () => evaluate(`[...document.querySelectorAll('[data-mention-list] [data-mention]')].map(b => b.dataset.mention)`)
  await typeInto('[data-composer="post"] textarea', '@al')
  const offered = await until(`[...document.querySelectorAll('[data-mention-list] [data-mention]')].map(b => b.dataset.mention)`, l => l.length > 0, '@al never opened the picker')
  check('@al offers alice', offered[0] === 'alice', offered)
  await press('Tab', 9)
  await until(`document.querySelector('[data-composer="post"] textarea').value`, v => v === '@alice ', 'Tab never inserted the pick')
  check('the picker closes once it has picked', (await mentionItems()).length === 0, await mentionItems())
  await typeInto('[data-composer="post"] textarea', '@')
  const calls = await until(`[...document.querySelectorAll('[data-mention-list] [data-mention]')].map(b => b.dataset.mention)`, l => l.length > 0, 'a bare @ never opened the picker')
  check('a bare @ offers the people, then @channel, @here and @all', ['channel', 'here', 'all'].every(c => calls.includes(c)) && calls.includes('bob') && calls.indexOf('bob') < calls.indexOf('channel'), calls)
  await press('ArrowDown', 40)
  const selectedAfter = await evaluate(`[...document.querySelectorAll('[data-mention-list] [role=option]')].findIndex(b => b.getAttribute('aria-selected') === 'true')`)
  check('the arrow keys move through the list', selectedAfter === 1, selectedAfter)
  await press('Escape', 27)
  await until(`!document.querySelector('[data-mention-list]')`, v => v, 'Esc never closed the picker')
  ok('Esc closes the picker')
  const aboutMe = `@alice that is you ${Date.now()}`
  await typeAndEnter('[data-composer="post"] textarea', aboutMe)
  const sentNamed = await poll(() => sinkPostBy(aboutMe))
  check('the sent text holds @alice', !!sentNamed && sentNamed.message.includes('@alice'), sentNamed)
  const hey = `hey @alice are you there ${Date.now()}`
  const heyPost = (await sinkPost(tokens.bob, ids.open, hey)).json
  await until(`!!document.querySelector('[data-post="${heyPost.id}"][data-post-named]')`, v => v, 'a post that names the reader was never marked', 15_000)
  ok('a post that mentions the reader is marked')
  check('and one the reader wrote naming themselves is not', !(await exists(`[data-post="${sentNamed?.id}"][data-post-named]`)))
  const ownText = await evaluate(`document.querySelector('[data-post="${heyPost.id}"] [data-post-text] strong')?.textContent ?? ''`)
  check('the mention is drawn bold', ownText === '@alice', ownText)
  await menuPick(`[data-post="${sentNamed?.id}"]`, '[data-post-more]', 'Edit')
  await until(`!!document.querySelector('[data-post-editor] textarea')`, v => v, 'Edit never opened the editor')
  await typeInto('[data-post-editor] textarea', `${aboutMe} and @bo`)
  await until(`[...document.querySelectorAll('[data-post-editor] ~ [data-mention-list] [data-mention], [data-mention-list] [data-mention]')].some(b => b.dataset.mention === 'bob')`, v => v, 'the editor never offered bob')
  ok('the post editor opens the same picker')
  await press('Tab', 9)
  await until(`document.querySelector('[data-post-editor] textarea').value`, v => v.endsWith('@bob '), 'Tab in the editor never inserted bob')
  await press('Escape', 27)
  await press('Escape', 27)
  await until(`!document.querySelector('[data-post-editor]')`, v => v, 'Esc twice never closed the editor')
  ok('Esc closes the picker first and the editor second')

  console.log('\n  New message: a direct channel, then a group')
  const roomIds = async (type) => ((await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels`, tokens.alice)).json ?? []).filter(c => c.type === type)
  const pickPerson = async (name) => {
    await evaluate(`document.querySelector('[data-new-dm] [role=combobox]').focus()`)
    await click('[data-new-dm] [role=combobox]')
    await until(`[...document.querySelectorAll('[role=option]')].some(o => o.textContent.replace(/\\s+/g, ' ').trim().startsWith(${sel(name)}))`, v => v, `the picker never offered ${name}`)
    await clickText('[role=option]', name)
    await until(`[...document.querySelectorAll('[data-new-dm] .pill')].some(e => e.textContent.trim().startsWith(${sel(name)}))`, v => v, `${name} never showed as picked`)
    await sleep(300)
  }
  await click('[data-add="dms"]')
  await until(`!!document.querySelector('[data-new-dm]')`, v => v, 'the + beside Direct messages never opened the dialog')
  await pickPerson('bob')
  await evaluate(`document.querySelector('[data-new-dm] button[type=submit]').click()`)
  await until(`location.pathname`, p => /^\/messages\/[a-z0-9]{26}\/$/.test(p) && p !== `/messages/${ids.open}/`, 'Open never navigated to the direct channel', 20_000)
  const dmId = await evaluate(`location.pathname.split('/')[2]`)
  const dms = await roomIds('D')
  check('a direct channel with bob exists on the sink', dms.some(c => c.id === dmId && c.name.includes(ids.bob)), dms.map(c => [c.id, c.name]))
  await until(`document.querySelector('[data-room-title]')?.textContent.trim() ?? ''`, t => t === 'bob', 'the DM header never named bob', 15_000)
  ok('the header names the other person')
  const dmText = `just us ${Date.now()}`
  await typeAndEnter('[data-composer="post"] textarea', dmText)
  const dmPosted = await poll(async () => Object.values((await sinkCall(`/channels/${dmId}/posts`, tokens.alice)).json?.posts ?? {}).find(p => p.message === dmText))
  check('a post in it lands on the sink in the direct channel', dmPosted?.channel_id === dmId, dmPosted)
  check('and the sidebar lists it under Direct messages', await exists(`[data-section="dms"] [data-channel="${dmId}"]`))
  await click('[data-add="dms"]')
  await until(`!!document.querySelector('[data-new-dm]')`, v => v, 'the dialog never opened a second time')
  await pickPerson('bob')
  await pickPerson('bot')
  await evaluate(`document.querySelector('[data-new-dm] button[type=submit]').click()`)
  await until(`location.pathname`, p => /^\/messages\/[a-z0-9]{26}\/$/.test(p) && p !== `/messages/${dmId}/`, 'Open never navigated to the group', 20_000)
  const groupId = await evaluate(`location.pathname.split('/')[2]`)
  const groups = await roomIds('G')
  check('a group of three exists on the sink', groups.some(c => c.id === groupId), groups.map(c => c.id))
  const groupMembers = ((await sinkCall(`/channels/${groupId}/members`, tokens.alice)).json ?? []).map(m => m.user_id).sort()
  check('with alice, bob and the bot', groupMembers.join() === [ids.alice, ids.bob, ids.bot].sort().join(), groupMembers)

  console.log('\n  New channel: private')
  const roomName = `design-${String(Date.now()).slice(-6)}`
  await click('[data-add="channels"]')
  await until(`!!document.querySelector('[data-new-room] input[name=name]')`, v => v, 'the + beside Channels never opened the dialog')
  await fillSel('[data-new-room] input[name=name]', roomName)
  await fillSel('[data-new-room] input[name=purpose]', 'where design happens')
  await click('[data-new-room] input[name=private]')
  await evaluate(`document.querySelector('[data-new-room] button[type=submit]').click()`)
  await until(`location.pathname`, p => /^\/messages\/[a-z0-9]{26}\/$/.test(p) && p !== `/messages/${groupId}/`, 'Create never navigated to the new channel', 20_000)
  const roomId = await evaluate(`location.pathname.split('/')[2]`)
  const madeRoom = ((await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels`, tokens.alice)).json ?? []).find(c => c.id === roomId)
  check('the channel exists on the sink: private, named, with its purpose', madeRoom?.type === 'P' && madeRoom.name === roomName && madeRoom.purpose === 'where design happens' && madeRoom.creator_id === ids.alice, madeRoom)
  await until(`document.querySelector('[data-room-title]')?.textContent.trim() ?? ''`, t => t === roomName, 'the header never named the new channel', 15_000)
  check('it is in the sidebar under Channels', await exists(`[data-section="channels"] [data-channel="${roomId}"]`))

  console.log('\n  Browse, join and leave')
  const open2 = (await sinkCall('/channels', tokens.bob, { method: 'POST', body: { team_id: ids.team, name: `lounge-${String(Date.now()).slice(-6)}`, display_name: 'Lounge', type: 'O', purpose: 'for chatting' } })).json
  const aliceIn = async (ch) => ((await sinkCall(`/channels/${ch}/members`, tokens.alice)).json ?? []).some(m => m.user_id === ids.alice)
  check('seed: alice is not in the open channel bob made', open2?.id && !(await aliceIn(open2.id)), open2)
  await click('[data-browse-link]')
  await until(`location.pathname`, p => p === '/messages/browse/', 'Browse never navigated')
  await until(`!!document.querySelector('[data-browse-channel="${open2.id}"]')`, v => v, 'Browse never listed the open channel', 20_000)
  check('Browse lists it with its purpose, and not a channel alice is in', /for chatting/.test(await textOf(`[data-browse-channel="${open2.id}"]`) ?? '') && !(await exists(`[data-browse-channel="${ids.open}"]`)), await evaluate(`[...document.querySelectorAll('[data-browse-channel]')].map(e => e.dataset.browseChannel)`))
  check('and it is not in the sidebar yet', !(await exists(`[data-chat-sidebar] [data-channel="${open2.id}"]`)))
  await click(`[data-browse-channel="${open2.id}"] [data-browse-join]`)
  await until(`location.pathname`, p => p === `/messages/${open2.id}/`, 'Join never opened the channel', 20_000)
  check('Join makes alice a member on the sink', await aliceIn(open2.id))
  await until(`!!document.querySelector('[data-chat-sidebar] [data-channel="${open2.id}"]:not(.not-joined)')`, v => v, 'the joined channel never took its place in the sidebar', 15_000)
  ok('and the channel moves to the sidebar')
  await menuPick('[data-room-header]', '[data-room-menu]', 'Leave channel')
  await until(`!!document.querySelector('[data-confirm-panel]')`, v => v, 'Leave never asked to confirm')
  await evaluate(`document.querySelector('[data-confirm-panel] .btn.danger').click()`)
  await until(`location.pathname`, p => /^\/messages\/[a-z0-9]{26}\/$/.test(p) && p !== `/messages/${open2.id}/`, 'Leave never went to another channel', 20_000)
  check('Leave removes alice on the sink', !(await aliceIn(open2.id)))
  await until(`!document.querySelector('[data-chat-sidebar] [data-channel="${open2.id}"]')`, v => v, 'the left channel stayed in the sidebar', 15_000)
  ok('and the sidebar drops it, the screen going to a channel she is still in')
  await goto('/messages/browse/')
  await until(`!!document.querySelector('[data-browse-channel="${open2.id}"]')`, v => v, 'Browse never listed the channel again after she left', 20_000)
  ok('Browse lists it again')

  console.log('\n  Chrome')
  check('the nav carries Messages', await evaluate(`[...document.querySelectorAll('a[href="/messages/"]')].some(a => /Messages/.test(a.textContent))`))
  if (process.env.FRONTIER_DRIVE_SHOT) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(process.env.FRONTIER_DRIVE_SHOT, Buffer.from(data, 'base64'))
  }
} catch (err) {
  bad('the drive threw', err.message)
  // What the page itself holds, so a miss is told from a missing element.
  try { console.log('    page:', await evaluate(`location.pathname + location.search + ' | pane: ' + (document.querySelector('[data-thread-pane]')?.innerText.replace(/\\s+/g, ' ').slice(0, 400) ?? 'none') + ' | room: ' + (document.querySelector('[data-channel-page]')?.className ?? 'none') + ' | editor: ' + (document.querySelector('[data-post-editor]')?.innerText.replace(/\\s+/g, ' ') ?? 'none') + ' | post errors: ' + [...document.querySelectorAll('[data-post-error]')].map(e => e.textContent.trim()).join(';') + ' | menu: ' + [...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim()).join(',')`)) } catch {}
  // What the API itself holds for the member, so a miss on screen is told from a miss in the sync.
  try {
    const login = await (await fetch(`${API}/door/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ key: KEY }) })).json()
    const get = async (path) => (await (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${login.token}`, accept: 'application/json' } })).json())
    const cs = await get('/channels'), ms = await get('/channelMembers')
    if (rootId) { const r = await get(`/posts?externalId=${rootId}`); const d = (r.data ?? r)[0] ?? {}; console.log("    API root:", JSON.stringify({ replyCount: d.replyCount, lastReplyAt: d.lastReplyAt })) }
    console.log('    API channels:', JSON.stringify((cs.data ?? cs).map?.(c => [c.name, c.type])), 'members:', JSON.stringify((ms.data ?? ms).map?.(m => [m.channelExternalId?.slice(0, 8), m.profileExternalId?.slice(0, 8)])))
  } catch (e) { console.log('    (could not read the API:', e.message, ')') }
}

check('no console error, exception or failed request', problems.length === 0, problems)
console.log(`\n${failed ? `${failed} failed` : 'all green'} (${passed} passed)`)
await cleanup()
process.exit(failed ? 1 : 0)
