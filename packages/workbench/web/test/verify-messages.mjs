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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'
import { startMattermostSink } from '@frontierjs/conduit-mattermost/sink'
import { startBasecampSink } from '@frontierjs/conduit-37signals/sink'

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
let todoSink = null   // Basecamp, the 37signals product, standing in for 3.basecampapi.com
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
  todoSink?.stop()
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
for (const k of Object.keys(env)) if (k.startsWith('CHAT_') || k.startsWith('BASECAMP_')) delete env[k]

SCRATCH = mkdtempSync(join(tmpdir(), 'workbench-messages-'))
sink = startMattermostSink({ port: 0 })
todoSink = startBasecampSink({ port: 0 })
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

// A recap spawns CLAUDE_BIN; this stands in for it so the real `claude` is never run, and keeps what it was handed.
const FAKE_CLAUDE = join(SCRATCH, 'fake-claude')
const FAKE_STDIN  = join(SCRATCH, 'fake-claude.stdin')
const FAKE_ARGV   = join(SCRATCH, 'fake-claude.argv')
const FAKE_CALLS  = join(SCRATCH, 'fake-claude.calls')
writeFileSync(FAKE_CLAUDE, `#!/usr/bin/env node
const fs = require('fs')
// Only a recap is recorded: the API also runs claude auth status on the same binary.
if (!process.argv.includes('--system-prompt')) process.exit(1)
fs.writeFileSync(${JSON.stringify(FAKE_STDIN)}, fs.readFileSync(0, 'utf8'))
fs.writeFileSync(${JSON.stringify(FAKE_ARGV)}, JSON.stringify(process.argv.slice(2)))
fs.appendFileSync(${JSON.stringify(FAKE_CALLS)}, 'x\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'STUB RECAP: the room agreed on nothing.' }) + '\\n')
`)
chmodSync(FAKE_CLAUDE, 0o755)
const recapCalls = () => existsSync(FAKE_CALLS) ? readFileSync(FAKE_CALLS, 'utf8').split('\n').filter(Boolean).length : 0

children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...env, DATABASE_URL: join(SCRATCH, 'workbench.db'), CHAT_DATABASE_URL: join(SCRATCH, 'chat.db'),
         JOBS_DATABASE_URL: join(SCRATCH, 'jobs.db'), AUDIT_PATH: join(SCRATCH, 'audit.db'),
         XDG_CONFIG_HOME: SCRATCH, WORKBENCH_DIR: join(SCRATCH, 'workbench'), CLAUDE_BIN: FAKE_CLAUDE,
         BC3_ACCOUNT_ID: String(todoSink.account), BC3_TOKEN: todoSink.token, BC3_API_ORIGIN: todoSink.url,
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
  await until(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].map(e => e.textContent).join('|')`, t => t.includes(away) && t.includes(named), 'the unread posts never drew')
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
  await until(`document.querySelector('[data-post="${R}"] [data-post-replies]')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`, t => t.includes('2 replies'), 'the root never showed 2 replies', 15_000)
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
  // A post's files, reactions and images grow it after its row lands; a tall block stands in for one.
  const gap = `(() => { const l = document.querySelector('[data-post-list]'); return l.scrollHeight - l.scrollTop - l.clientHeight })()`
  await until(gap, v => v < 2, 'switching back to general never landed at the newest post')
  await evaluate(`document.querySelector('[data-post-list] .posts-body').insertAdjacentHTML('beforeend', '<div data-late style="block-size: 600px"></div>')`)
  await until(gap, v => v < 2, 'content that grew after the list drew left the view short of the newest post')
  await evaluate(`document.querySelector('[data-late]').remove()`)
  ok('a room opens at its newest post and stays there while its posts grow')

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
  // Up in an empty composer edits the reader's newest post, and Esc hands the focus back.
  await evaluate(`document.querySelector('[data-composer="post"] textarea').focus()`)
  await until(`document.querySelector('[data-composer="post"] textarea').value`, v => v === '', 'the composer is not empty for Up')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 })
  await until(`(() => { const own = document.querySelectorAll('[data-post-list] [data-post-mine]'); return !!own[own.length - 1]?.querySelector('[data-post-editor] textarea') && document.activeElement === own[own.length - 1].querySelector('[data-post-editor] textarea') })()`, v => v, 'Up in an empty composer never opened the newest own post\'s editor')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`!document.querySelector('[data-post-editor]') && document.activeElement === document.querySelector('[data-composer="post"] textarea')`, v => v, 'Esc never closed the editor and refocused the composer')
  ok('Up in an empty composer edits the newest own post, and Esc returns to the composer')
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
  // The form stays mounted inside a closed <dialog>, so finding it says nothing about the dialog being open.
  const dmShown = `!!document.querySelector('[data-new-dm]')?.closest('dialog')?.open`
  const pickPerson = async (name) => {
    await evaluate(`document.querySelector('[data-new-dm] [role=combobox]').focus()`)
    await click('[data-new-dm] [role=combobox]')
    await until(`[...document.querySelectorAll('[role=option]')].some(o => o.textContent.replace(/\\s+/g, ' ').trim().startsWith(${sel(name)}))`, v => v, `the picker never offered ${name}`)
    await clickText('[role=option]', name)
    await until(`[...document.querySelectorAll('[data-new-dm] .pill')].some(e => e.textContent.trim().startsWith(${sel(name)}))`, v => v, `${name} never showed as picked`)
    await sleep(300)
  }
  await click('[data-add="dms"]')
  await until(dmShown, v => v, 'the + beside Direct messages never opened the dialog')
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
  await until(dmShown, v => v, 'the dialog never opened a second time')
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

  console.log('\n  Drafts: kept while typing, restored, shared, and deleted')
  const draftsOnSink = async () => ((await sinkCall(`/users/${ids.alice}/teams/${ids.team}/drafts`, tokens.alice)).json ?? []).filter(d => !d.delete_at)
  const draftIn = async (root = '') => (await draftsOnSink()).find(d => d.channel_id === ids.open && d.root_id === root)
  const roomBox = '[data-composer="post"] textarea'
  const boxValue = (s) => evaluate(`document.querySelector(${sel(s)})?.value ?? null`)
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector(${sel(roomBox)})`, v => v, 'the room box never drew')
  const draftText = `half a thought ${Date.now()}`
  await fillSel(roomBox, draftText)
  const held1 = await poll(async () => (await draftIn())?.message === draftText ? await draftIn() : null)
  check('typing in the room box saves a draft on the server, with no send', !!held1 && !(await sinkPostBy(draftText)), held1)
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector(${sel(roomBox)})`, v => v, 'the room box never drew after a reload')
  await until(`document.querySelector(${sel(roomBox)}).value`, v => v === draftText, 'the draft was never restored into the box', 15_000)
  ok('and a reload restores it into the box')
  check('the sidebar counts it under Drafts', (await textOf('[data-drafts-count]')) === '1', await textOf('[data-drafts-count]'))
  check('and marks its room with a pencil', await exists(`[data-channel="${ids.open}"] [data-room-draft]`))
  await goto('/messages/drafts/')
  await until(`!!document.querySelector('[data-draft-row]')`, v => v, 'the Drafts page never listed the draft', 15_000)
  const draftRow = await textOf('[data-draft-row]')
  check('/messages/drafts/ lists it with its room and its words', /General/.test(draftRow ?? '') && (draftRow ?? '').includes(draftText), draftRow)
  await click('[data-draft-open]')
  await until(`location.pathname`, p => p === `/messages/${ids.open}/`, 'Open never went to the room')
  ok('Open goes to the room it came from')
  await goto('/messages/drafts/')
  await until(`!!document.querySelector('[data-draft-delete]')`, v => v, 'the draft row never drew again')
  await click('[data-draft-delete]')
  await until(`!document.querySelector('[data-draft-row]')`, v => v, 'Delete never took the row away', 15_000)
  check('Delete removes it on the server and from the sidebar', !(await draftIn()) && !(await exists('[data-drafts-count]')) && !(await exists(`[data-channel="${ids.open}"] [data-room-draft]`)), await draftsOnSink())

  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector(${sel(roomBox)})`, v => v, 'the room box never drew')
  check('with no draft the box opens empty', (await boxValue(roomBox)) === '', await boxValue(roomBox))
  const phoneText = `typed on a phone ${Date.now()}`
  await sinkCall('/drafts', tokens.alice, { method: 'POST', body: { user_id: ids.alice, channel_id: ids.open, root_id: '', message: phoneText } })
  await until(`document.querySelector(${sel(roomBox)}).value`, v => v === phoneText, 'a draft from another client never reached the untouched box', 15_000)
  ok('a draft edited on another client updates an untouched box')
  await fillSel(roomBox, 'mine, not saved yet')
  await sinkCall('/drafts', tokens.alice, { method: 'POST', body: { user_id: ids.alice, channel_id: ids.open, root_id: '', message: 'later from the phone' } })
  await sleep(1500)
  check('and a box being typed in is never overwritten', (await boxValue(roomBox)) !== 'later from the phone', await boxValue(roomBox))
  await fillSel(roomBox, '')
  const gone = await poll(async () => !(await draftIn()) ? true : null)
  check('emptying the box deletes the draft', !!gone, await draftsOnSink())
  const sentDraft = `typed then sent ${Date.now()}`
  await fillSel(roomBox, sentDraft)
  await poll(async () => (await draftIn())?.message === sentDraft ? true : null)
  await typeAndEnter(roomBox, sentDraft)
  await until(`document.querySelector(${sel(roomBox)}).value === ''`, v => v, 'Enter never sent the draft text')
  const sentGone = await poll(async () => !(await draftIn()) ? true : null)
  check('sending deletes the draft, and the post is on the sink', !!sentGone && !!(await poll(() => sinkPostBy(sentDraft))), await draftsOnSink())

  const replyBox = '[data-composer="reply"] textarea'
  await goto(`/messages/${ids.open}/?thread=${heyPost.id}`)
  await until(`!!document.querySelector(${sel(replyBox)})`, v => v, 'the thread box never drew', 20_000)
  const replyDraft = `a reply in progress ${Date.now()}`
  await fillSel(replyBox, replyDraft)
  const replyHeld = await poll(async () => (await draftIn(heyPost.id))?.message === replyDraft ? true : null)
  check('the thread box saves its own draft, keyed by the thread', !!replyHeld && !(await draftIn())?.message, await draftsOnSink())
  await goto(`/messages/${ids.open}/?thread=${heyPost.id}`)
  await until(`document.querySelector(${sel(replyBox)})?.value`, v => v === replyDraft, 'the thread draft was never restored', 20_000)
  ok('and restores it on reopen')
  await goto('/messages/drafts/')
  await until(`!!document.querySelector('[data-draft-row]')`, v => v, 'the thread draft never listed')
  check('Drafts marks it as a thread\'s', /in a thread/.test(await textOf('[data-draft-row]') ?? ''), await textOf('[data-draft-row]'))
  await click('[data-draft-delete]')
  await poll(async () => !(await draftIn(heyPost.id)) ? true : null)

  console.log('\n  Saved posts')
  const flagged = async () => ((await sinkCall(`/users/${ids.alice}/preferences/flagged_post`, tokens.alice)).json ?? []).filter(q => q.value === 'true').map(q => q.name)
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-post="${heyPost.id}"]')`, v => v, 'the post never drew', 20_000)
  await menuPick(`[data-post="${heyPost.id}"]`, '[data-post-more]', 'Save')
  await until(`!!document.querySelector('[data-post="${heyPost.id}"] [data-post-saved]')`, v => v, 'Save never marked the post', 15_000)
  check('Save marks the post and keeps it on the server', (await flagged()).includes(heyPost.id), await flagged())
  await sleep(1100)
  await menuPick(`[data-post="${sentNamed?.id}"]`, '[data-post-more]', 'Save')
  await until(`document.querySelector('[data-saved-count]')?.textContent.trim() ?? ''`, t => t === '2', 'the sidebar never counted two saved', 15_000)
  ok('the sidebar counts what is saved')
  await goto('/messages/saved/')
  const savedOrder = await until(`[...document.querySelectorAll('[data-saved-row]')].map(e => e.dataset.savedRow)`, l => l.length === 2, '/messages/saved/ never listed both', 20_000)
  // The server answers saved posts newest POST first (the post's age, not the save's), and the page keeps that order.
  check('/messages/saved/ lists them newest post first', savedOrder[0] === heyPost.id && savedOrder[1] === sentNamed?.id, savedOrder)
  check('each draws as a post with a link to its room', await evaluate(`[...document.querySelectorAll('[data-saved-row]')].every(r => r.querySelector('[data-post-text]') && r.querySelector('[data-saved-jump]')?.getAttribute('href') === '/messages/${ids.open}/')`))
  await menuPick(`[data-saved-row="${heyPost.id}"]`, '[data-post-more]', 'Unsave')
  await until(`!document.querySelector('[data-saved-row="${heyPost.id}"]')`, v => v, 'Unsave never took the post off the list', 15_000)
  check('Unsave leaves the list and the server', !(await flagged()).includes(heyPost.id), await flagged())
  await sinkCall(`/users/${ids.alice}/preferences`, tokens.alice, { method: 'PUT', body: [{ user_id: ids.alice, category: 'flagged_post', name: heyPost.id, value: 'true' }] })
  await until(`!!document.querySelector('[data-saved-row="${heyPost.id}"]')`, v => v, 'a save on another client never reached the list', 20_000)
  ok('a save from another client reaches the open list')
  await menuPick(`[data-saved-row="${heyPost.id}"]`, '[data-post-more]', 'Unsave')
  await menuPick(`[data-saved-row="${sentNamed?.id}"]`, '[data-post-more]', 'Unsave')
  await until(`!document.querySelector('[data-saved-row]')`, v => v, 'the list never emptied', 15_000)

  console.log('\n  Favorites and sections')
  const categories = async () => (await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels/categories`, tokens.alice)).json?.categories ?? []
  const inSection = (key, id) => exists(`[data-section="${key}"] [data-channel="${id}"]`)
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-room-star]')`, v => v, 'the star never drew', 20_000)
  check('before a favorite, the room sits under Channels', await inSection('channels', ids.open))
  await click('[data-room-star]')
  await until(`document.querySelector('[data-room-star]').getAttribute('aria-pressed')`, v => v === 'true', 'the star never lit', 15_000)
  await until(`!!document.querySelector('[data-section="favorites"] [data-channel="${ids.open}"]')`, v => v, 'the room never moved under Favorites', 15_000)
  check('the star favorites it on the server and moves it under Favorites, off Channels', (await categories()).some(c => c.type === 'favorites' && c.channel_ids.includes(ids.open)) && !(await inSection('channels', ids.open)), (await categories()).map(c => [c.type, c.channel_ids.length]))
  check('Favorites sits above Activity in the sidebar', await evaluate(`!!(document.querySelector('[data-section="favorites"]').compareDocumentPosition(document.querySelector('[data-activity-link]')) & Node.DOCUMENT_POSITION_FOLLOWING)`))
  await click('[data-room-star]')
  await until(`!!document.querySelector('[data-section="channels"] [data-channel="${ids.open}"]')`, v => v, 'unfavoriting never put the room back', 15_000)
  ok('and the star again puts it back under Channels')

  const fillSection = async (name) => {
    await until(`!!document.querySelector('[data-section-dialog] input[name=section]')`, v => v, 'the section dialog never opened')
    await fillSel('[data-section-dialog] input[name=section]', name)
    await evaluate(`document.querySelector('[data-section-dialog] button[type=submit]').click()`)
  }
  await openMenu('[data-chat-sidebar]', `[data-room-actions="${ids.open}"]`)
  await clickText('[role=menuitem]', 'Move to')
  await until(`!!document.querySelector('[data-move-new]')`, v => v, 'Move to never offered New section')
  await click('[data-move-new]')
  await fillSection('Design')
  const designKey = await until(`[...document.querySelectorAll('[data-section^="custom-"]')].find(e => e.querySelector('[data-fold]')?.textContent.trim() === 'Design')?.dataset.section ?? null`, v => v, 'the new section never drew', 20_000)
  await until(`!!document.querySelector('[data-section="${designKey}"] [data-channel="${ids.open}"]')`, v => v, 'the room never moved into the new section', 15_000)
  const design = (await categories()).find(c => c.display_name === 'Design')
  check('New section makes it on the server with the room in it, and the sidebar shows it there', design?.type === 'custom' && design.channel_ids.includes(ids.open) && !(await inSection('channels', ids.open)), design)
  await openMenu('[data-chat-sidebar]', `[data-section-menu="${designKey.replace('custom-', '')}"]`)
  await clickText('[role=menuitem]', 'Rename')
  await fillSection('Design work')
  await until(`document.querySelector('[data-section="${designKey}"] [data-fold]')?.textContent.trim() ?? ''`, t => t === 'Design work', 'Rename never changed the header', 15_000)
  check('Rename changes it on the server', (await categories()).some(c => c.display_name === 'Design work'), (await categories()).map(c => c.display_name))
  await click(`[data-fold="${designKey}"]`)
  await until(`!document.querySelector('[data-section="${designKey}"] [data-channel]')`, v => v, 'folding never hid the rooms')
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-fold="${designKey}"]')`, v => v, 'the section never drew after a reload', 20_000)
  check('a folded section stays folded after a reload (this browser\'s localStorage)', !(await exists(`[data-section="${designKey}"] [data-channel]`)) && (await evaluate(`localStorage.getItem('workbench_messages_folded')`))?.includes(designKey))
  await click(`[data-fold="${designKey}"]`)
  await until(`!!document.querySelector('[data-section="${designKey}"] [data-channel="${ids.open}"]')`, v => v, 'unfolding never showed the room')

  // The text size scales every rung on the screen, both columns, and is kept per browser.
  const sizeOf = (sel) => evaluate(`parseFloat(getComputedStyle(document.querySelector('${sel}')).fontSize)`)
  const roomText = `[data-chat-sidebar] [data-channel="${ids.open}"]`
  const before = { room: await sizeOf(roomText), body: await sizeOf('.chat-main') }
  await click('[data-text-larger]')
  await click('[data-text-larger]')
  const grown = await until(`parseFloat(getComputedStyle(document.querySelector('${roomText}')).fontSize)`, v => v > before.room, 'A+ never grew the sidebar text')
  check('A+ grows the text in the sidebar and in the room column by the same factor', Math.abs(grown / before.room - 1.25) < 0.01 && Math.abs((await sizeOf('.chat-main')) / before.body - 1.25) < 0.01, { before, grown, body: await sizeOf('.chat-main') })
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('${roomText}')`, v => v, 'the sidebar never drew after a reload', 20_000)
  check('the text size stays after a reload (this browser\'s localStorage)', Math.abs((await sizeOf(roomText)) / before.room - 1.25) < 0.01)
  await click('[data-text-smaller]')
  await click('[data-text-smaller]')
  await until(`parseFloat(getComputedStyle(document.querySelector('${roomText}')).fontSize)`, v => Math.abs(v - before.room) < 0.01, 'A− never put the text back')
  check('A− steps it back down to where it started', true)
  await openMenu('[data-chat-sidebar]', `[data-room-actions="${ids.open}"]`)
  await clickText('[role=menuitem]', 'Move to')
  await until(`!!document.querySelector('[data-move-new]')`, v => v, 'Move to never offered New section the second time')
  await click('[data-move-new]')
  await fillSection('Second')
  const secondKey = await until(`[...document.querySelectorAll('[data-section^="custom-"]')].find(e => e.querySelector('[data-fold]')?.textContent.trim() === 'Second')?.dataset.section ?? null`, v => v, 'the second section never drew', 20_000)
  await until(`!!document.querySelector('[data-section="${secondKey}"] [data-channel="${ids.open}"]') && !document.querySelector('[data-section="${designKey}"] [data-channel]')`, v => v, 'New section did not take the room out of the first', 15_000)
  ok('a room is under one heading: New section moves it out of the section it was in')
  await openMenu('[data-chat-sidebar]', `[data-room-actions="${ids.open}"]`)
  await clickText('[role=menuitem]', 'Move to')
  await until(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.trim() === 'Design work')`, v => v, 'Move to never listed the other section')
  await clickText('[role=menuitem]', 'Design work')
  await until(`!!document.querySelector('[data-section="${designKey}"] [data-channel="${ids.open}"]') && !document.querySelector('[data-section="${secondKey}"] [data-channel]')`, v => v, 'Move to never moved the room into the other section', 15_000)
  check('Move to puts the room in the section picked, on the server too', (await categories()).find(c => c.display_name === 'Design work')?.channel_ids.includes(ids.open), (await categories()).map(c => [c.display_name, c.channel_ids.length]))
  await openMenu('[data-chat-sidebar]', `[data-section-menu="${secondKey.replace('custom-', '')}"]`)
  await clickText('[role=menuitem]', 'Delete')
  await until(`!!document.querySelector('[data-confirm-panel]')`, v => v, 'Delete never asked to confirm for the empty section')
  await evaluate(`document.querySelector('[data-confirm-panel] .btn.danger').click()`)
  await until(`!document.querySelector('[data-section="${secondKey}"]')`, v => v, 'Delete never took the empty section away', 15_000)
  await openMenu('[data-chat-sidebar]', `[data-section-menu="${designKey.replace('custom-', '')}"]`)
  await clickText('[role=menuitem]', 'Delete')
  await until(`!!document.querySelector('[data-confirm-panel]')`, v => v, 'Delete never asked to confirm')
  await evaluate(`document.querySelector('[data-confirm-panel] .btn.danger').click()`)
  await until(`!document.querySelector('[data-section="${designKey}"]')`, v => v, 'Delete never took the section away', 15_000)
  check('Delete removes the section on the server', !(await categories()).some(c => c.display_name === 'Design work'), (await categories()).map(c => c.display_name))
  await until(`!!document.querySelector('[data-section="channels"] [data-channel="${ids.open}"]')`, v => v, 'the deleted section\'s room never fell back to Channels', 15_000)
  ok('and its room falls back to Channels')

  console.log('\n  Status')
  const bobsDm = dmId
  await sinkCall(`/users/${ids.bob}/status`, tokens.bob, { method: 'PUT', body: { user_id: ids.bob, status: 'dnd' } })
  await goto(`/messages/${ids.open}/`)
  await until(`document.querySelector('[data-channel="${bobsDm}"] [data-presence]')?.dataset.presence ?? ''`, v => v === 'dnd', 'the DM row never drew bob\'s presence', 20_000)
  ok('a DM row carries the other person\'s presence dot (do not disturb)')
  await sinkCall(`/users/${ids.bob}/status/custom`, tokens.bob, { method: 'PUT', body: { emoji: 'coffee', text: 'back soon' } })
  await until(`document.querySelector('[data-channel="${bobsDm}"] [data-dm-mood]')?.textContent ?? ''`, t => t.includes('back soon'), 'bob\'s custom status never reached the DM row', 20_000)
  check('and his custom status beside his name, emoji and words', /☕ back soon/.test(await textOf(`[data-channel="${bobsDm}"] [data-dm-mood]`) ?? ''), await textOf(`[data-channel="${bobsDm}"] [data-dm-mood]`))
  await goto(`/messages/${bobsDm}/`)
  await until(`document.querySelector('[data-room-header] [data-room-mood]')?.textContent ?? ''`, t => t.includes('back soon'), 'the DM header never showed the status', 20_000)
  check('the DM header shows the dot and the status too', await exists('[data-room-header] [data-presence="dnd"]'))
  const presenceOf = (s) => evaluate(`document.querySelector('[data-me] [data-presence]')?.dataset.presence ?? ''`)
  await menuPick('[data-chat-sidebar]', '[data-me]', 'Away')
  const mineAway = await poll(async () => (await sinkCall(`/users/${ids.alice}/status`, tokens.alice)).json?.status === 'away' ? true : null)
  await until(`document.querySelector('[data-me] [data-presence]')?.dataset.presence ?? ''`, v => v === 'away', 'the reader\'s own dot never went away', 15_000)
  check('the control sets the reader\'s presence on the server and draws it', !!mineAway && (await presenceOf()) === 'away')
  await menuPick('[data-chat-sidebar]', '[data-me]', 'Online')
  await until(`document.querySelector('[data-me] [data-presence]')?.dataset.presence ?? ''`, v => v === 'online', 'back online never drew', 15_000)
  await menuPick('[data-chat-sidebar]', '[data-me]', 'Set a custom status')
  await until(`!!document.querySelector('[data-status-dialog]')`, v => v, 'the status dialog never opened')
  await fillSel('[data-status-text]', 'in a meeting')
  await click('[data-status-pick="coffee"]')
  await evaluate(`(() => { const s = document.querySelector('[data-status-clear]'); s.value = '1h'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await evaluate(`document.querySelector('[data-status-dialog] button[type=submit]').click()`)
  await until(`document.querySelector('[data-me-line]')?.textContent ?? ''`, t => t.includes('in a meeting'), 'the custom status never showed on the reader\'s row', 20_000)
  const custom = JSON.parse((await sinkCall('/users/me', tokens.alice)).json?.props?.customStatus ?? 'null')
  check('the custom status is on the server with its words, its emoji and an expiry', custom?.text === 'in a meeting' && custom.emoji === 'coffee' && !!custom.expires_at, custom)
  await menuPick('[data-chat-sidebar]', '[data-me]', 'Set a custom status')
  await until(`document.querySelector('[data-status-text]')?.value === 'in a meeting'`, v => v, 'the dialog never opened with what is set')
  await fillSel('[data-status-text]', '')
  await click('[data-status-pick="coffee"]')
  await evaluate(`document.querySelector('[data-status-dialog] button[type=submit]').click()`)
  await until(`!document.querySelector('[data-me-line]')`, v => v, 'clearing never took the status off the row', 20_000)
  check('saving it empty clears the custom status', !(await sinkCall('/users/me', tokens.alice)).json?.props?.customStatus, (await sinkCall('/users/me', tokens.alice)).json?.props)

  console.log('\n  Typing')
  const bobWs = new WebSocket(`${sink.url.replace(/^http/, 'ws')}/api/v4/websocket`, { headers: { authorization: `Bearer ${tokens.bob}` } })
  await new Promise(r => { bobWs.onopen = r; setTimeout(r, 3000) })
  const typingIn = (channel, parent = '') => bobWs.send(JSON.stringify({ action: 'user_typing', seq: Date.now(), data: { channel_id: channel, parent_id: parent } }))
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-typing="post"]')`, v => v, 'the typing line never drew', 20_000)
  check('no one typing, no line', (await textOf('[data-typing="post"]')) === '', await textOf('[data-typing="post"]'))
  typingIn(ids.open)
  await until(`document.querySelector('[data-typing="post"]')?.textContent.trim() ?? ''`, t => t === 'bob is typing…', 'bob typing never showed under the posts', 15_000)
  ok('another person typing in the room shows "bob is typing…" under the posts')
  await until(`document.querySelector('[data-typing="post"]')?.textContent.trim() ?? ''`, t => t === '', 'the line never went after the typing stopped', 12_000)
  ok('and it goes about five seconds after the last frame')
  await goto(`/messages/${ids.open}/?thread=${heyPost.id}`)
  await until(`!!document.querySelector('[data-typing="reply"]')`, v => v, 'the thread typing line never drew', 20_000)
  typingIn(ids.open, heyPost.id)
  await until(`document.querySelector('[data-typing="reply"]')?.textContent.trim() ?? ''`, t => t === 'bob is typing…', 'bob typing in the thread never showed', 15_000)
  check('typing in a thread shows under the thread, not under the room', (await textOf('[data-typing="post"]')) === '', await textOf('[data-typing="post"]'))
  bobWs.close()

  // ── Phase 3, slice E: the extras ──
  {
  console.log('\n  Search')
  const needle = `quokka${Date.now()}`
  const needleOne = (await sinkPost(tokens.bob, ids.open, `first ${needle} sighting`)).json
  await sleep(1100)
  const needleTwo = (await sinkPost(tokens.alice, ids.secret, `second ${needle} sighting`)).json
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-chat-search-box]')`, v => v, 'the sidebar never drew its search box', 20_000)
  await typeAndEnter('[data-chat-search-box]', needle)
  await until(`location.pathname + location.search`, p => p === `/messages/search/?q=${needle}`, 'Enter in the sidebar box never opened the search route')
  const found = await until(`[...document.querySelectorAll('[data-search-row]')].map(e => e.dataset.searchRow)`, l => l.length === 2, 'the search never listed both posts', 25_000)
  check('Enter in the sidebar box lists the matching posts newest first', found[0] === needleTwo.id && found[1] === needleOne.id, found)
  check('each hit is drawn as a post, with its room label and a jump link to the room', await evaluate(`[...document.querySelectorAll('[data-search-row]')].every(r => r.querySelector('[data-post-text]') && /^[#@]/.test(r.querySelector('[data-search-jump]').textContent.trim()))`)
    && (await evaluate(`document.querySelector('[data-search-row="${needleOne.id}"] [data-search-jump]').getAttribute('href')`)) === `/messages/${ids.open}/`)
  check('the page says how many matched', /2 matches/.test(await textOf('[data-search-count]') ?? ''), await textOf('[data-search-count]'))
  check('the refine box holds the query', (await evaluate(`document.querySelector('[data-search-box]').value`)) === needle)
  await typeAndEnter('[data-search-box]', `${needle} second`)
  await until(`document.querySelectorAll('[data-search-row]').length`, n => n === 1, 'refining by Enter on the page never narrowed the hits (a query-only move)', 20_000)
  check('refining on the page narrows the hits without a reload', (await evaluate(`document.querySelector('[data-search-row]').dataset.searchRow`)) === needleTwo.id)
  await typeAndEnter('[data-search-box]', `nothing matches this ${Date.now()}`)
  await until(`document.querySelectorAll('[data-search-row]').length === 0 && /No matches/.test(document.querySelector('[data-search]').textContent)`, v => v, 'an empty search never said so', 20_000)
  ok('a query with no hits shows the empty state')

  console.log('\n  Link previews')
  // Every https request the page makes is caught and answered here, so one to the
  // unfurled host is counted rather than leaving the machine.
  const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const thirdParty = []
  browser.on('Fetch.requestPaused', (p) => { thirdParty.push(p.request.url); send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: DOT }).catch(() => {}) })
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] })
  const tag = Date.now()
  const linked = (await sinkPost(tokens.bob, ids.open, `look at https://example.com/launch-${tag} today`)).json
  const pictured = (await sinkPost(tokens.bob, ids.open, `a picture https://example.com/shot-${tag}.png`)).json
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-post="${linked.id}"] [data-embed="opengraph"]')`, v => v, 'the link post never drew its preview card', 30_000)
  const card = await evaluate(`(() => { const c = document.querySelector('[data-post="${linked.id}"] [data-embed="opengraph"]'); const a = c.querySelector('[data-embed-title]'); return { site: c.querySelector('[data-embed-site]')?.textContent.trim(), title: a.textContent.trim(), href: a.getAttribute('href'), target: a.target, rel: a.rel, desc: c.querySelector('[data-embed-desc]')?.textContent.trim(), imgs: c.querySelectorAll('img').length } })()`)
  check('an opengraph embed is a card: site, title as the link, description, and no thumbnail', card.site === 'example.com' && card.title === 'example.com page' && card.desc === 'What example.com says about itself' && card.imgs === 0, card)
  check('its link opens in a new tab with noopener noreferrer', card.href === `https://example.com/launch-${tag}` && card.target === '_blank' && /noopener/.test(card.rel) && /noreferrer/.test(card.rel), card)
  await until(`!!document.querySelector('[data-post="${pictured.id}"] [data-embed="image"]')`, v => v, 'the .png post never drew its image link', 30_000)
  const shot = await evaluate(`(() => { const a = document.querySelector('[data-post="${pictured.id}"] [data-embed="image"]'); return { href: a.getAttribute('href'), text: a.textContent.trim(), imgs: a.querySelectorAll('img').length, rel: a.rel, target: a.target } })()`)
  check('an image embed is a link to the image, not the image, opening in a new tab', shot.href === `https://example.com/shot-${tag}.png` && shot.text === shot.href && shot.imgs === 0 && shot.target === '_blank' && /noopener/.test(shot.rel), shot)
  await sleep(1_000)
  check('no preview asked the linked host for anything', !thirdParty.some(u => new URL(u).hostname === 'example.com'), thirdParty)
  check('a post with no link has no preview', !(await exists(`[data-post="${needleOne.id}"] [data-post-embeds]`)) && !(await exists(`[data-post="${heyPost.id}"] [data-post-embeds]`)))

  console.log('\n  Edit history')
  const hist = (await sinkPost(tokens.alice, ids.open, 'history one')).json
  await sinkCall(`/posts/${hist.id}/patch`, tokens.alice, { method: 'PUT', body: { message: 'history two' } })
  await sinkCall(`/posts/${hist.id}/patch`, tokens.alice, { method: 'PUT', body: { message: 'history three' } })
  const hers = (await sinkPost(tokens.bob, ids.open, 'bob first')).json
  await sinkCall(`/posts/${hers.id}/patch`, tokens.bob, { method: 'PUT', body: { message: 'bob second' } })
  await until(`document.querySelector('[data-post="${hist.id}"] [data-post-edited]')?.tagName ?? ''`, t => t === 'BUTTON', 'the reader\'s edited post never drew an (edited) button', 20_000)
  ok('the (edited) mark on the reader\'s own post is a button')
  await until(`!!document.querySelector('[data-post="${hers.id}"] [data-post-edited]')`, v => v, 'bob\'s edited post never drew (edited)', 20_000)
  check('and on another person\'s post it is plain text (the history is the author\'s)', (await evaluate(`document.querySelector('[data-post="${hers.id}"] [data-post-edited]').tagName`)) === 'SPAN')
  await click(`[data-post="${hist.id}"] [data-edit-history-open]`)
  const versions = await until(`[...document.querySelectorAll('[data-edit-version]')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`, l => l.length === 2, 'the dialog never listed two earlier versions', 20_000)
  check('the dialog lists the earlier versions newest first, each with a time', /history two$/.test(versions[0]) && /history one$/.test(versions[1]) && versions.every(v => /\d/.test(v.replace(/history (one|two)$/, ''))), versions)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  console.log('\n  Reminders')
  const remindFor = async () => ((await (await fetch(`${sink.url}/_sink/seen`)).json()).reminders ?? []).filter(r => r.post_id === hers.id)
  await goto(`/messages/${ids.open}/`)
  await until(`!!document.querySelector('[data-post="${hers.id}"]')`, v => v, 'the post never drew', 20_000)
  await menuPick(`[data-post="${hers.id}"]`, '[data-post-more]', 'Remind me')
  await until(`!!document.querySelector('[data-remind="3h"]')`, v => v, 'Remind me never offered its times')
  const offered = await evaluate(`[...document.querySelectorAll('[data-remind]')].map(e => e.textContent.trim())`)
  check('Remind me offers 30 minutes, 1 hour, 3 hours and tomorrow 9:00', ['In 30 minutes', 'In 1 hour', 'In 3 hours', 'Tomorrow, 9:00'].every(t => offered.includes(t)), offered)
  const before = Date.now()
  await click('[data-remind="3h"]')
  await until(`document.querySelector('[data-post="${hers.id}"] [data-post-reminded]')?.textContent ?? ''`, t => /Reminder set/.test(t), 'taking a reminder never confirmed', 15_000)
  ok('a confirmation line says the reminder was taken')
  const rung = (await poll(async () => (await remindFor()).at(-1) ?? null))
  check('the reminder is set on the server for alice, three hours out, in whole seconds', rung?.user_id === ids.alice && Math.abs(rung.target_time - (before + 3 * 3_600_000) / 1000) < 120 && Number.isInteger(rung.target_time), rung)

  console.log('\n  Activity')
  const actRoot = (await sinkPost(tokens.bob, ids.open, `activity root ${Date.now()}`)).json
  await sinkCall('/posts', tokens.alice, { method: 'POST', body: { channel_id: ids.open, message: 'alice joins', root_id: actRoot.id } })
  await sinkCall('/posts', tokens.bob, { method: 'POST', body: { channel_id: ids.open, message: `bob answers @alice ${Date.now()}`, root_id: actRoot.id } })
  await click('[data-activity-link]')
  await until(`location.pathname`, p => p === '/messages/activity/', 'the sidebar entry never opened Activity')
  await until(`!!document.querySelector('[data-mention-row="${heyPost.id}"]')`, v => v, 'a post naming the reader never listed under Mentions', 25_000)
  ok('Mentions lists a post that names the reader, drawn as a post with its room')
  check('and a post that does not name them is not there', !(await exists(`[data-mention-row="${needleOne.id}"]`)))
  await until(`!!document.querySelector('[data-thread-activity="${actRoot.id}"]')`, v => v, 'a followed thread with unread replies never listed', 25_000)
  check('Threads with new replies lists the root, linking to open its thread', (await evaluate(`document.querySelector('[data-thread-activity="${actRoot.id}"]').getAttribute('href')`)) === `/messages/${ids.open}/?thread=${actRoot.id}`)
  const pushed = `ping @alice while open ${Date.now()}`
  const pushedPost = (await sinkPost(tokens.bob, ids.open, pushed)).json
  await until(`!!document.querySelector('[data-mention-row="${pushedPost.id}"]')`, v => v, 'a mention arriving while Activity is open never joined the list', 25_000)
  ok('a mention arriving while the page is open joins Mentions without a reload')
  await click(`[data-thread-activity="${actRoot.id}"]`)
  await until(`location.search`, q => q === `?thread=${actRoot.id}`, 'the thread row never opened its thread')
  await until(`!!document.querySelector('[data-thread-pane="${actRoot.id}"]')`, v => v, 'the pane never opened from Activity', 20_000)
  ok('a thread row opens its thread beside the room')
  }

  // ── Phase 3, slice F: the extras that live only in Workbench ──
  // Scheduled posts, groups and quiet hours are rows on this laptop. "The scheduled post is
  // sent" is asserted on the row and the page, not by waiting for the API's minute job:
  // api/test/verify-chat.ts runs `sendDue` itself, and here a row is moved to sent or failed
  // in the scratch chat.db to see how the page draws each.
  {
  const box = '[data-composer="post"] textarea'
  const login = await (await fetch(`${API}/door/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ key: KEY }) })).json()
  const apiRows = async (path) => { const r = await (await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${login.token}`, accept: 'application/json' } })).json(); return r.data ?? r }
  const typeKeys = async (s, v) => { await fillSel(s, v); await evaluate(`document.querySelector(${sel(s)}).focus()`) }
  const keyPress = async (key, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk })
  }
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  const { Database } = await import('bun:sqlite')
  const chatDb = () => { const db = new Database(join(SCRATCH, 'chat.db')); db.exec('pragma busy_timeout = 5000'); return db }
  const tableLike = (db, word) => db.query(`select name from sqlite_master where type = 'table' and lower(name) like ?`).all(`%${word}%`)[0]?.name
  const roomReady = async (id) => { await goto(`/messages/${id}/`); await until(`!!document.querySelector(${sel(box)})`, v => v, 'the room box never drew', 20_000) }
  const tag = Date.now()

  console.log('\n  Groups')
  await goto('/messages/groups/')
  await until(`!!document.querySelector('[data-groups]')`, v => v, 'the Groups page never drew', 20_000)
  check('the sidebar has a Groups entry, and the page says groups exist only in Workbench', await exists('[data-groups-link]') && /only in Workbench/.test(await textOf('[data-groups-note]') ?? ''))
  await click('[data-group-new]')
  await until(`!!document.querySelector('[data-group-dialog]')?.closest('dialog')?.open`, v => v, 'New group never opened its dialog')
  await fillSel('[data-group-name]', 'Ops crew')
  check('a name typed first suggests the handle', (await evaluate(`document.querySelector('[data-group-handle]').value`)) === 'ops-crew')
  await fillSel('[data-group-handle]', 'ops')
  await click('[data-group-person="alice"]')
  await click('[data-group-person="bob"]')
  await click('[data-group-save]')
  await until(`!!document.querySelector('[data-group-row="ops"]')`, v => v, 'the new group never listed', 20_000)
  const opsRow = await textOf('[data-group-row="ops"]')
  check('a group is made with its handle, name and members, and lists them by name', /@ops/.test(opsRow) && /Ops crew/.test(opsRow) && /Ada/.test(opsRow) && /bob/i.test(opsRow), opsRow)
  const opsApi = (await apiRows('/chatGroups')).find(g => g.handle === 'ops')
  check('the API holds it, made by the reader', !!opsApi && opsApi.name === 'Ops crew' && (opsApi.profileExternalIds ?? []).length === 2 && !!opsApi.createdByProfileExternalId, opsApi)
  await click('[data-group-new]')
  await until(`!!document.querySelector('[data-group-dialog]')?.closest('dialog')?.open`, v => v, 'the second dialog never opened')
  await fillSel('[data-group-name]', 'Again')
  await fillSel('[data-group-handle]', 'ops')
  await click('[data-group-save]')
  await until(`document.querySelector('[data-group-error]')?.textContent ?? ''`, t => t.length > 0, 'a taken handle never said so', 15_000)
  ok('a handle that is taken is refused, in the dialog')
  await fillSel('[data-group-handle]', 'Not Valid!')
  await click('[data-group-save]')
  await until(`document.querySelector('[data-group-error]')?.textContent ?? ''`, t => t.length > 0 && !/taken|unique/i.test(t) || /letters|handle|regex|invalid/i.test(t), 'a malformed handle never said so', 15_000)
  ok('a malformed handle is refused, in the dialog')
  await clickText('[data-group-dialog] button', 'Cancel')
  await until(`!document.querySelector('[data-group-dialog]')?.closest('dialog')?.open`, v => v, 'Cancel never closed the dialog')
  await click('[data-group-row="ops"] [data-group-edit]')
  await until(`document.querySelector('[data-group-name]')?.value === 'Ops crew'`, v => v, 'Edit never filled the dialog')
  await fillSel('[data-group-name]', 'Operations')
  await click('[data-group-person="bob"]')
  await click('[data-group-save]')
  await until(`document.querySelector('[data-group-row="ops"] [data-group-title]')?.textContent`, t => t === 'Operations', 'the edit never reached the row', 20_000)
  check('an edit changes the name and the members', !/bob/i.test(await textOf('[data-group-row="ops"] [data-group-members]')), await textOf('[data-group-row="ops"] [data-group-members]'))
  await click('[data-group-row="ops"] [data-group-edit]')
  await until(`document.querySelector('[data-group-name]')?.value === 'Operations'`, v => v, 'Edit never filled the dialog')
  await click('[data-group-person="bob"]')
  await click('[data-group-save]')
  await until(`/bob/i.test(document.querySelector('[data-group-row="ops"] [data-group-members]')?.textContent ?? '')`, v => v, 'bob never went back in', 20_000)
  {
    const db = chatDb()
    const table = tableLike(db, 'chatgroup') ?? tableLike(db, 'chat_group')
    check('the scratch chat.db has the group table', !!table, table)
    db.query(`insert into "${table}" (handle, name, profileExternalIds, createdByProfileExternalId, createdAt) values ('elsewhere', 'Made by someone else', '[]', 'not-the-reader', ?)`).run(new Date().toISOString())
    db.close()
  }
  await goto('/messages/groups/')
  await until(`!!document.querySelector('[data-group-row="elsewhere"]')`, v => v, 'the other person\'s group never listed', 20_000)
  check('another person\'s group is read-only: no Edit, no Delete', await exists('[data-group-row="elsewhere"] [data-group-readonly]') && !(await exists('[data-group-row="elsewhere"] [data-group-edit]')) && !(await exists('[data-group-row="elsewhere"] [data-group-delete]')) && await exists('[data-group-row="ops"] [data-group-delete]'))

  console.log('\n  Groups in the Composer')
  await roomReady(ids.open)
  await typeKeys(box, '@op')
  const groupItems = await until(`[...document.querySelectorAll('[data-mention-list] [data-mention-group]')].map(b => b.dataset.mention)`, l => l.length > 0, '@op never offered the group', 15_000)
  check('@op offers the group, drawn as a group with its size', groupItems[0] === 'ops' && /group, 2 people/.test(await textOf('[data-mention-list] [data-mention="ops"]') ?? ''), await textOf('[data-mention-list] [data-mention="ops"]'))
  await keyPress('Tab', 9)
  await until(`document.querySelector(${sel(box)}).value`, v => v === '@ops ', 'Tab never inserted the group')
  const called = `@ops please look at this ${tag}`
  await typeAndEnter(box, called)
  const expanded = await poll(async () => (await channelPosts()).find(p => p.message.includes(`please look at this ${tag}`)))
  check('a sent @handle that names a group is written out as its people\'s usernames', expanded?.message === `@ops (@alice @bob) please look at this ${tag}`, expanded?.message)
  await until(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].some(e => e.textContent.includes('(@alice @bob)'))`, v => v, 'the expanded post never drew', 20_000)
  check('and the post draws, its known usernames marked', await evaluate(`[...document.querySelectorAll('[data-post-list] [data-post-text]')].find(e => e.textContent.includes('(@alice @bob)')).querySelectorAll('strong').length`) >= 2)

  console.log('\n  Scheduled posts')
  const later = `scheduled once ${tag}`
  await typeKeys(box, later)
  await until(`!document.querySelector('[data-later]').disabled`, v => v, 'Send later stayed disabled with text in the box')
  const t0 = Date.now()
  await menuPick('[data-composer="post"]', '[data-later]', 'In 1 hour')
  await until(`document.querySelector(${sel(box)}).value`, v => v === '', 'Send later never cleared the box', 15_000)
  const first = await poll(async () => (await apiRows('/scheduledPosts')).find(r => r.message === later))
  check('Send later writes a scheduled row an hour out, with the box\'s text, and posts nothing', !!first && first.status === 'scheduled' && first.channelExternalId === ids.open && Math.abs(Date.parse(first.sendAt) - (t0 + 3_600_000)) < 120_000 && !(await sinkPostBy(later)), first)
  check('the box says where it went', /Scheduled for/.test(await textOf('[data-composer-answer]') ?? ''), await textOf('[data-composer-answer]'))
  check('and its draft is dropped with the text', !(await exists('[data-room-draft]')))
  await until(`document.querySelector('[data-scheduled-count]')?.textContent.trim() ?? ''`, t => t === '1', 'the sidebar never counted the scheduled post', 15_000)
  ok('the sidebar Scheduled entry counts the waiting rows')
  const custom = new Date(Date.now() + 2 * 86_400_000); custom.setHours(10, 30, 0, 0)
  const later2 = `scheduled custom ${tag}`
  await typeKeys(box, later2)
  await until(`!document.querySelector('[data-later]').disabled`, v => v, 'Send later stayed disabled')
  await menuPick('[data-composer="post"]', '[data-later]', 'Pick a time')
  await until(`!!document.querySelector('[data-when-input]')?.closest('dialog')?.open`, v => v, 'Pick a time never opened its dialog')
  await fillSel('[data-when-input]', stamp(custom))
  await click('[data-when-save]')
  const second = await poll(async () => (await apiRows('/scheduledPosts')).find(r => r.message === later2))
  check('Pick a time schedules at the datetime typed', !!second && Date.parse(second.sendAt) === custom.getTime(), second)
  await click('[data-scheduled-link]')
  await until(`location.pathname`, p => p === '/messages/scheduled/', 'the sidebar entry never opened Scheduled')
  await until(`document.querySelectorAll('[data-scheduled-row]').length`, n => n >= 2, 'the page never listed both rows', 20_000)
  check('Scheduled lists the rows under a Scheduled heading, soonest first, each with its room, time and text', await evaluate(`(() => { const rows = [...document.querySelectorAll('[data-scheduled-group="scheduled"] [data-scheduled-row]')]; return rows.length === 2 && rows[0].dataset.scheduledRow === '${first?.id}' && rows.every(r => /^#/.test(r.querySelector('[data-scheduled-where]').textContent.trim()) && r.querySelector('[data-scheduled-when]').textContent.trim().length > 4) && /${later}/.test(rows[0].querySelector('[data-scheduled-body]').textContent) })()`))
  check('the page says scheduled posts live on this laptop and send only while Workbench runs', /on this laptop and send only while Workbench is running/.test(await textOf('[data-scheduled-note]') ?? ''), await textOf('[data-scheduled-note]'))
  check('there is no Send now (the API refuses a past time)', !(await exists('[data-scheduled-row] [data-send-now]')) && !/Send now/.test(await textOf('[data-scheduled]')))
  const rowOf = (id) => `[data-scheduled-row="${id}"]`
  await click(`${rowOf(first.id)} [data-scheduled-edit-open]`)
  await until(`!!document.querySelector('[data-scheduled-edit]')`, v => v, 'Edit text never opened the editor')
  await fillSel('[data-scheduled-edit]', `${later} edited`)
  await click('[data-scheduled-save]')
  await until(`document.querySelector(${sel(rowOf(first.id) + ' [data-scheduled-body]')})?.textContent ?? ''`, t => t.endsWith('edited'), 'the edit never reached the row', 15_000)
  check('Edit text changes the words and leaves the time', (await apiRows('/scheduledPosts')).find(r => r.id === first.id)?.message === `${later} edited` && (await apiRows('/scheduledPosts')).find(r => r.id === first.id)?.sendAt === first.sendAt)
  await menuPick(rowOf(first.id), '[data-scheduled-reschedule]', 'Tomorrow')
  const moved = await poll(async () => { const r = (await apiRows('/scheduledPosts')).find(r => r.id === first.id); return r && r.sendAt !== first.sendAt ? r : null })
  check('Reschedule moves it to tomorrow 9:00', !!moved && new Date(moved.sendAt).getHours() === 9 && Date.parse(moved.sendAt) > Date.now() + 3_600_000, moved)
  await menuPick(rowOf(second.id), '[data-scheduled-reschedule]', 'Pick a time')
  await until(`!!document.querySelector('[data-when-input]')?.closest('dialog')?.open`, v => v, 'the custom time dialog never opened')
  const custom2 = new Date(Date.now() + 3 * 86_400_000); custom2.setHours(15, 45, 0, 0)
  await fillSel('[data-when-input]', stamp(custom2))
  await click('[data-when-save]')
  const moved2 = await poll(async () => { const r = (await apiRows('/scheduledPosts')).find(r => r.id === second.id); return r && Date.parse(r.sendAt) === custom2.getTime() ? r : null })
  check('Reschedule with Pick a time writes the typed time', !!moved2, moved2)
  await click(`${rowOf(second.id)} [data-scheduled-cancel]`)
  await until(`!!document.querySelector('[data-scheduled-group="cancelled"] ${rowOf(second.id)}')`, v => v, 'Cancel never moved the row to Cancelled', 15_000)
  check('Cancel keeps the row, as cancelled, and out of the count', (await apiRows('/scheduledPosts')).find(r => r.id === second.id)?.status === 'cancelled' && (await textOf('[data-scheduled-count]')) === '1', await textOf('[data-scheduled-count]'))
  check('a cancelled row has no Edit text', !(await exists(`${rowOf(second.id)} [data-scheduled-edit-open]`)))
  {
    // Sent and failed are the job's: the scratch rows are moved by hand, the page is what is asked.
    const db = chatDb()
    const table = tableLike(db, 'scheduledpost') ?? tableLike(db, 'scheduled_post')
    check('the scratch chat.db has the scheduled table', !!table, table)
    db.query(`update "${table}" set status = 'failed', error = 'chat server answered 502' where id = ?`).run(second.id)
    db.close()
  }
  await goto('/messages/scheduled/')
  await until(`!!document.querySelector('[data-scheduled-group="failed"] [data-scheduled-row]')`, v => v, 'a failed row never drew under Failed', 20_000)
  check('a failed row shows its error', /502/.test(await textOf(`${rowOf(second.id)} [data-scheduled-error]`) ?? ''), await textOf(`${rowOf(second.id)} [data-scheduled-error]`))
  check('and can only be scheduled again or deleted', await exists(`${rowOf(second.id)} [data-scheduled-reschedule]`) && !(await exists(`${rowOf(second.id)} [data-scheduled-edit-open]`)))
  await menuPick(rowOf(second.id), '[data-scheduled-reschedule]', 'In 1 hour')
  const again = await poll(async () => { const rows = await apiRows('/scheduledPosts'); return rows.find(r => r.message === later2 && r.status === 'scheduled' && r.id !== second.id) && !rows.some(r => r.id === second.id) ? rows.find(r => r.message === later2) : null })
  check('Schedule again writes the text as a new waiting row and removes the failed one', !!again, again)
  {
    const db = chatDb()
    const table = tableLike(db, 'scheduledpost') ?? tableLike(db, 'scheduled_post')
    db.query(`update "${table}" set status = 'sent', sentAt = ? where id = ?`).run(new Date().toISOString(), first.id)
    db.close()
  }
  await goto('/messages/scheduled/')
  await until(`!!document.querySelector('[data-scheduled-group="sent"] ${rowOf(first.id)}')`, v => v, 'a sent row never drew under Sent', 20_000)
  check('a sent row draws under Sent with no way to change it', !(await exists(`${rowOf(first.id)} [data-scheduled-reschedule]`)) && !(await exists(`${rowOf(first.id)} [data-scheduled-cancel]`)) && await exists(`${rowOf(first.id)} [data-scheduled-delete]`))
  await click(`${rowOf(first.id)} [data-scheduled-delete]`)
  await until(`!document.querySelector(${sel(rowOf(first.id))})`, v => v, 'Delete never removed the row', 15_000)
  check('Delete removes the row', !(await apiRows('/scheduledPosts')).some(r => r.id === first.id))

  console.log('\n  Quiet hours')
  await roomReady(ids.open)
  await menuPick('[data-chat-sidebar]', '[data-me]', 'Quiet hours')
  await until(`!!document.querySelector('[data-quiet-dialog]')?.closest('dialog')?.open`, v => v, 'Quiet hours… never opened its dialog')
  const browserZone = await evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`)
  check('the dialog starts on every day, the browser\'s zone, and says it will hold chat notifications', await evaluate(`[...document.querySelectorAll('[data-quiet-day]')].every(b => b.getAttribute('aria-pressed') === 'true')`) && (await evaluate(`document.querySelector('[data-quiet-zone]').value`)) === browserZone && /hold Workbench's chat notifications/.test(await textOf('[data-quiet-dialog]') ?? ''), await textOf('[data-quiet-dialog]'))
  await until(`document.querySelector('[data-quiet-save]').disabled === false`, v => v, 'the dialog never finished loading its row', 15_000)
  await fillSel('[data-quiet-zone]', 'Nowhere/Land')
  await click('[data-quiet-save]')
  await until(`(document.querySelector('[data-quiet-error]')?.textContent ?? '') + '|' + document.querySelector('[data-quiet-zone]').value + '|' + (document.querySelector('[data-quiet-dialog]')?.closest('dialog')?.open)`, t => /zone/i.test(t.split('|')[0]), 'a bad zone never said so', 15_000)
  ok('a zone that is not IANA is refused, in the dialog')
  await click('[data-quiet-day="0"]')
  await fillSel('[data-quiet-zone]', 'America/Chicago')
  await fillSel('[data-quiet-from]', '21:00')
  await fillSel('[data-quiet-to]', '06:30')
  await click('[data-quiet-save]')
  await until(`!document.querySelector('[data-quiet-dialog]')?.closest('dialog')?.open`, v => v, 'Save never closed the dialog', 15_000)
  const quiet = (await apiRows('/quietSchedules'))[0]
  check('Save creates the one row: the window in minutes, the zone, the days', quiet?.fromMinute === 1260 && quiet?.toMinute === 390 && quiet?.timezone === 'America/Chicago' && JSON.stringify(quiet?.days) === '[1,2,3,4,5,6]' && quiet?.isEnabled === true, quiet)
  await menuPick('[data-chat-sidebar]', '[data-me]', 'Quiet hours')
  await until(`document.querySelector('[data-quiet-from]')?.value === '21:00'`, v => v, 'the dialog never showed the saved window', 15_000)
  await until(`document.querySelector('[data-quiet-save]').disabled === false`, v => v, 'the reopened dialog never finished loading', 15_000)
  await click('[data-quiet-enabled]')
  await click('[data-quiet-save]')
  await until(`!document.querySelector('[data-quiet-dialog]')?.closest('dialog')?.open`, v => v, 'the second Save never closed the dialog', 15_000)
  const quiet2 = await poll(async () => { const rows = await apiRows('/quietSchedules'); return rows[0]?.isEnabled === false ? rows : null })
  check('a second Save patches the same row (off, the window kept)', quiet2?.length === 1 && quiet2[0].id === quiet.id && quiet2[0].fromMinute === 1260, quiet2)

  console.log('\n  Waiting on me, waiting on others, and the nudge')
  // The query and the job are graded in api/test/verify-chat.ts; here, that the screen draws them,
  // follows the mirror live, and that the post menu and the row's Cancel reach the follow-up rows.
  const waitTag = Date.now()
  const askedOf = (await sinkPost(tokens.bob, ids.open, `waiting ask @alice ${waitTag}`)).json
  await sleep(1100)
  const waitRootPost = (await sinkPost(tokens.bob, ids.open, `waiting thread root ${waitTag}`)).json
  await sleep(1100)
  await goto('/messages/')
  await until(`!!document.querySelector('[data-waiting-link]')`, v => v, 'the sidebar never offered Waiting', 20_000)
  await click('[data-waiting-link]')
  await until(`location.pathname`, p => p === '/messages/waiting/', 'the sidebar entry never opened Waiting')
  await until(`!!document.querySelector('[data-waiting-group="me"] [data-waiting-row="${askedOf.id}"]')`, v => v, 'a mention nobody answered never listed under Waiting on you', 25_000)
  ok('Waiting on you lists a mention the reader has not answered, drawn as a post with its room')
  check('its jump link opens the room', (await evaluate(`document.querySelector('[data-waiting-row="${askedOf.id}"] [data-waiting-jump]').getAttribute('href')`)) === `/messages/${ids.open}/`)
  const askedAgain = (await sinkPost(tokens.bob, ids.open, `waiting second @alice ${waitTag}`)).json
  await until(`!!document.querySelector('[data-waiting-row="${askedAgain.id}"]')`, v => v, 'a mention arriving while Waiting is open never joined the list', 25_000)
  const order = await evaluate(`[...document.querySelectorAll('[data-waiting-group="me"] [data-waiting-row]')].map(e => e.dataset.waitingRow)`)
  check('it joins without a reload, after the older one (oldest first)', order.indexOf(askedOf.id) >= 0 && order.indexOf(askedOf.id) < order.indexOf(askedAgain.id), order)
  await sleep(1100)
  await sinkPost(tokens.alice, ids.open, `waiting answered ${waitTag}`)
  await until(`!document.querySelector('[data-waiting-group="me"] [data-waiting-row="${askedOf.id}"]') && !document.querySelector('[data-waiting-row="${askedAgain.id}"]')`, v => v, 'the reader\'s own post never cleared Waiting on you', 25_000)
  ok('a post of the reader\'s in the room clears both, live')

  const mineInThread = (await sinkCall('/posts', tokens.alice, { method: 'POST', body: { channel_id: ids.open, message: `waiting my reply ${waitTag}`, root_id: waitRootPost.id } })).json
  await until(`!!document.querySelector('[data-waiting-group="others"] [data-waiting-row="${mineInThread.id}"]')`, v => v, 'the reader\'s unanswered reply never listed under Waiting on others', 25_000)
  ok('Waiting on others lists the reader\'s last reply in a thread nobody has answered')
  check('and shows no reminder on it yet', !(await exists(`[data-waiting-row="${mineInThread.id}"] [data-waiting-reminder]`)))
  const nudgeRows = async () => (await apiRows('/followUps')).filter(r => r.postExternalId === mineInThread.id)
  await menuPick(`[data-post="${mineInThread.id}"]`, '[data-post-more]', 'Remind me if nobody replies')
  await until(`!!document.querySelector('[data-when-input]')?.closest('dialog')?.open`, v => v, 'Remind me if nobody replies never opened its time dialog')
  await fillSel('[data-when-input]', stamp(new Date(Date.now() + 2 * 3_600_000)))
  await click('[data-when-save]')
  const nudged = await poll(async () => { const r = await nudgeRows(); return r.length ? r : null })
  check('the post menu stores a pending FollowUp for alice, two hours out', nudged?.length === 1 && nudged[0].status === 'pending' && nudged[0].profileExternalId === ids.alice && Math.abs(Date.parse(nudged[0].remindAt) - (Date.now() + 2 * 3_600_000)) < 300_000, nudged)
  await until(`!!document.querySelector('[data-waiting-row="${mineInThread.id}"] [data-waiting-reminder]')`, v => v, 'the row never showed its pending reminder', 25_000)
  ok('the waiting row shows the pending reminder')
  await click(`[data-waiting-row="${mineInThread.id}"] [data-waiting-cancel]`)
  await until(`!document.querySelector('[data-waiting-row="${mineInThread.id}"] [data-waiting-reminder]')`, v => v, 'Cancel never took the reminder off the row', 25_000)
  check('Cancel clears it from the row and cancels the FollowUp, which stays', (await nudgeRows()).length === 1 && (await nudgeRows())[0].status === 'cancelled', await nudgeRows())
  const apiSend = (path, method, body) => fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${login.token}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
  const elsewhere = await apiSend('/followUps', 'POST', { postExternalId: mineInThread.id, remindAt: new Date(Date.now() + 3_600_000).toISOString() })
  const elsewhereId = elsewhere?.data?.id ?? elsewhere?.id
  check('another window can set a reminder on the same post', !!elsewhereId, elsewhere)
  await until(`!!document.querySelector('[data-waiting-row="${mineInThread.id}"] [data-waiting-reminder]')`, v => v, 'a reminder set in another window never reached the open Waiting screen', 25_000)
  ok('a reminder set in another window reaches the open Waiting screen, live')
  await apiSend(`/followUps/${elsewhereId}`, 'PATCH', { status: 'cancelled' })
  await until(`!document.querySelector('[data-waiting-row="${mineInThread.id}"] [data-waiting-reminder]')`, v => v, 'a reminder cancelled in another window stayed on the open Waiting screen', 25_000)
  ok('and one cancelled there leaves it, live')
  await sleep(1100)
  await sinkCall('/posts', tokens.bob, { method: 'POST', body: { channel_id: ids.open, message: `waiting bob replies ${waitTag}`, root_id: waitRootPost.id } })
  await until(`!document.querySelector('[data-waiting-group="others"] [data-waiting-row="${mineInThread.id}"]')`, v => v, 'an answer never took the row off Waiting on others', 25_000)
  ok('someone else\'s reply takes it off Waiting on others, live')

  console.log('\n  Catch-up and the recap')
  // The query is graded in api/test/verify-chat.ts; here, that the screen groups, that passing a group's end
  // reads it through the room's own door, and that a recap is asked by a press and shown, never kept.
  const catchTag = Date.now()
  await goto('/messages/waiting/')
  await until(`!!document.querySelector('[data-catchup-link]')`, v => v, 'the sidebar never offered Catch-up', 20_000)
  const catchPosts = []
  for (let i = 1; i <= 24; i++) catchPosts.push((await sinkPost(tokens.bob, ids.open, `catch-up post ${i} ${catchTag} ${'and more words '.repeat(14)}`)).json)
  await sleep(1500)
  await click('[data-catchup-link]')
  await until(`location.pathname`, p => p === '/messages/catch-up/', 'the sidebar entry never opened Catch-up')
  const groupSel = `[data-catchup-group="c:${ids.open}"]`
  await until(`document.querySelectorAll('${groupSel} [data-post]').length`, n => n >= 24, 'the room\'s unread posts never filled its Catch-up group', 25_000)
  const catchOrder = await evaluate(`[...document.querySelectorAll('${groupSel} [data-post]')].map(e => e.textContent.match(/catch-up post (\\d+)/)?.[1]).filter(Boolean).map(Number)`)
  check('Catch-up lists the room\'s unread posts as one group, oldest first', catchOrder.length >= 24 && catchOrder.every((n, i) => i === 0 || n > catchOrder[i - 1]), catchOrder)
  check('nothing has gone to Claude for the screen opening', recapCalls() === 0 && !existsSync(FAKE_STDIN))
  const unreadPill = `document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"] [data-pill]')`
  check('a group whose end is below the fold is not read yet: the room still shows its pill', !(await exists(`${groupSel}[data-passed]`)) && (await evaluate(`!!${unreadPill}`)), await evaluate(`${unreadPill}?.textContent ?? null`))
  // The page is what scrolls, and headless Chrome paints no frames, so the scroll event a real scroll queues is sent by hand.
  await evaluate(`(() => { const s = document.scrollingElement; s.scrollTop = s.scrollHeight; document.dispatchEvent(new Event('scroll')) })()`)
  await until(`!!document.querySelector('${groupSel}[data-passed]')`, v => v, 'scrolling past the group never passed it', 20_000)
  await until(`${unreadPill} === null`, v => v === true, 'passing the group never read the room (its pill stayed)', 25_000)
  ok('scrolling past a group marks its room read through chat.view: the pill clears, and the group stays on screen marked Read')
  check('the Read mark is drawn', await exists(`${groupSel} [data-catchup-read]`))

  await click(`${groupSel} [data-catchup-summarize]`)
  const recapText = await until(`document.querySelector('${groupSel} [data-catchup-summary-text]')?.textContent ?? ''`, t => t.length > 0, 'Summarize never showed a summary', 30_000)
  check('Summarize shows the stub\'s text under the group', recapText === 'STUB RECAP: the room agreed on nothing.', recapText)
  const sentStdin = existsSync(FAKE_STDIN) ? readFileSync(FAKE_STDIN, 'utf8') : ''
  const sentArgv = existsSync(FAKE_ARGV) ? JSON.parse(readFileSync(FAKE_ARGV, 'utf8')) : []
  check('one press ran one Claude, handed the group\'s posts as author: text lines on stdin, though the room was read first', recapCalls() === 1 && sentStdin.includes(`catch-up post 1 ${catchTag}`) && sentStdin.includes(`catch-up post 24 ${catchTag}`) && /\] [^:\n]+: catch-up post 1 /.test(sentStdin), sentStdin.slice(0, 300))
  check('the run was offered no tool and the posts were not in argv', sentArgv[sentArgv.indexOf('--tools') + 1] === '' && !sentArgv.some(a => a.includes(`${catchTag}`)), sentArgv)
  check('the summary says it is not saved', /Not saved/.test(await evaluate(`document.querySelector('${groupSel} [data-catchup-summary]').textContent`)))

  await sinkPost(tokens.bob, ids.open, `catch-up arrives later ${catchTag}`)
  await until(`!!document.querySelector('[data-catchup-fresh]')`, v => v, 'a post arriving never offered a refresh', 20_000)
  ok('a post arriving while Catch-up is open offers a refresh and does not move the page')
  await click('[data-catchup-refresh]')
  await until(`document.querySelectorAll('${groupSel} [data-post]').length`, n => n === 1, 'Refresh never narrowed the group to the new post', 25_000)
  check('Refresh asks again: the read posts are gone and only the new one is left, unsummarized', !(await exists(`${groupSel} [data-catchup-summary]`)) && recapCalls() === 1, recapCalls())
  await until(`!!document.querySelector('${groupSel}[data-passed]')`, v => v, 'the refreshed group, short enough to be seen whole, was never passed', 20_000)
  await goto('/messages/catch-up/')
  await sleep(3000)
  check('a reload lists nothing for the room, the one new post having been read where it stood, and sends nothing to Claude', !(await exists(groupSel)) && recapCalls() === 1, recapCalls())

  console.log('\n  Slash commands')
  await roomReady(ids.open)
  await typeKeys(box, '/')
  const cmds = await until(`[...document.querySelectorAll('[data-command-list] [data-command]')].map(b => b.dataset.command)`, l => l.length > 0, 'a / never opened the command list', 15_000)
  check('a / at the start offers the commands', ['away', 'online', 'dnd', 'offline', 'status', 'mute', 'leave', 'search'].every(c => cmds.includes(c)), cmds)
  await typeKeys(box, '/mu')
  await until(`[...document.querySelectorAll('[data-command-list] [data-command]')].map(b => b.dataset.command).join()`, l => l === 'mute', 'the list never narrowed to /mu', 10_000)
  ok('typing narrows the list')
  await typeAndEnter(box, '/away')
  await until(`document.querySelector('[data-me]').title`, t => /^Away/.test(t), '/away never set the reader away', 20_000)
  check('/away sets the status, posts nothing and clears the box', (await evaluate(`document.querySelector(${sel(box)}).value`)) === '' && !(await sinkPostBy('/away')), await evaluate(`document.querySelector(${sel(box)}).value`))
  await typeAndEnter(box, '/dnd 2h')
  await until(`document.querySelector('[data-me]').title`, t => /^Do not disturb/.test(t), '/dnd never took', 20_000)
  ok('/dnd 2h sets do not disturb')
  await typeAndEnter(box, '/online')
  await until(`document.querySelector('[data-me]').title`, t => /^Online/.test(t), '/online never set the reader online', 20_000)
  ok('/online and /offline map to the status too')
  await typeAndEnter(box, `/status in a meeting ${tag}`)
  await until(`document.querySelector('[data-me-line]')?.textContent ?? ''`, t => t.includes(`in a meeting ${tag}`), '/status never set the line', 20_000)
  ok('/status <text> sets the custom status')
  await typeAndEnter(box, '/status')
  await until(`!document.querySelector('[data-me-line]')`, v => v, '/status alone never cleared it', 20_000)
  ok('/status alone clears it')
  await typeAndEnter(box, '/mute')
  await until(`document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"]')?.classList.contains('muted-room')`, v => v, '/mute never muted the room', 20_000)
  ok('/mute mutes this room')
  await typeAndEnter(box, '/unmute')
  await until(`!document.querySelector('[data-chat-sidebar] [data-channel="${ids.open}"]')?.classList.contains('muted-room')`, v => v, '/unmute never unmuted the room', 20_000)
  ok('/unmute puts it back')
  const word = `/nosuchword stays text ${tag}`
  await typeAndEnter(box, word)
  check('a /word that names no command is posted as text', !!(await poll(() => sinkPostBy(word))))
  await until(`document.querySelector(${sel(box)}).value`, v => v === '', 'the box never cleared after the /word post', 15_000)
  const literal = `//away is a message ${tag}`
  await typeAndEnter(box, literal)
  check('// sends a message that begins with /', !!(await poll(() => sinkPostBy(literal.slice(1)))), { box: await evaluate(`document.querySelector(${sel(box)}).value`), answer: await textOf('[data-composer-answer]'), error: await textOf('[data-composer-error]'), posts: (await channelPosts()).slice(-3).map(p => p.message) })
  await until(`document.querySelector(${sel(box)}).value`, v => v === '', 'the box never cleared after the // post', 15_000)
  await typeAndEnter(box, `/search quokka ${tag}`)
  await until(`location.pathname + location.search`, p => p === `/messages/search/?q=quokka%20${tag}`, '/search never opened the search route', 15_000)
  ok('/search <terms> opens the search route')
  await roomReady(ids.secret)
  await typeAndEnter(box, '/leave')
  await until(`!document.querySelector('[data-chat-sidebar] [data-channel="${ids.secret}"]')`, v => v, '/leave never left the channel', 20_000)
  check('/leave leaves the channel and posts nothing', (await sinkCall(`/channels/${ids.secret}/members`, tokens.alice)).json?.every(m => m.user_id !== ids.alice) !== false, 'alice is still a member')

  console.log('\n  Nav unread badge')
  const navBadge = (scope = '.topbar-nav') => evaluate(`(() => { const e = document.querySelector('${scope} [data-nav-badge]'); return e ? { kind: e.dataset.navBadge, text: e.textContent.replace(/\\s+/g, ' ').trim() } : null })()`)
  // Start from a reader with nothing unread: every room alice is still in is opened once.
  const aliceRooms = (await apiRows('/channelMembers')).filter(m => m.profileExternalId === ids.alice).map(m => m.channelExternalId)
  for (const id of aliceRooms) { await roomReady(id); await sleep(400) }
  await goto('/home/')
  await until(`!!document.querySelector('.topbar-nav a[href="/messages/"]')`, v => v, 'the nav never drew Messages', 20_000)
  await until(`!document.querySelector('.topbar-nav [data-nav-badge]')`, v => v, 'a read reader still shows a badge', 20_000)
  check('on another screen the Messages entry shows no badge for a reader with nothing unread', (await navBadge()) === null && (await navBadge('.navlist')) === null, await navBadge())
  await sinkPost(tokens.bob, ids.open, `badge @alice ${tag}`)
  const counted = await until(`(() => { const e = document.querySelector('.topbar-nav [data-nav-badge]'); return e ? e.dataset.navBadge + ':' + e.textContent.trim() : null })()`, v => v === 'count:1', 'a post naming the reader never showed 1 on the nav, which was not reloaded', 20_000)
  check('a sink post naming the reader shows 1 on the Messages entry without a reload', counted === 'count:1', counted)
  check('and the drawer\'s copy of the entry shows it too', (await navBadge('.navlist'))?.text === '1', await navBadge('.navlist'))
  await roomReady(ids.open)
  await until(`!document.querySelector('.topbar-nav [data-nav-badge]')`, v => v, 'opening the room never cleared the mention badge', 20_000)
  ok('opening the room clears the count, in the nav on the Messages screen')
  await goto('/home/')
  await sinkPost(tokens.bob, ids.open, `badge plain ${tag}`)
  const dotted = await until(`document.querySelector('.topbar-nav [data-nav-badge]')?.dataset.navBadge ?? null`, v => v === 'dot', 'an unread plain post never showed the dot', 20_000)
  check('an unread post with no mention in an unmuted open room shows the dot, not a count', dotted === 'dot' && !/\d/.test((await navBadge())?.text ?? ''), await navBadge())
  await roomReady(ids.open)
  await until(`!document.querySelector('.topbar-nav [data-nav-badge]')`, v => v, 'opening the room never cleared the dot', 20_000)
  ok('opening the room clears the dot')
  }

  console.log('\n  A post as a Basecamp to-do')
  {
  // The sink is the connector's, never 3.basecampapi.com. A direct message is the post that must not leak.
  const todoCall = (path, init = {}) => fetch(`${todoSink.url}${path}`, init).then(r => r.json())
  const todoSeen = async () => (await todoCall('/_sink/seen')).requests
  const dmRoom = ((await sinkCall(`/users/${ids.alice}/teams/${ids.team}/channels`, tokens.alice)).json ?? []).find(c => c.type === 'D')
  const secret = `private to the two of us, never in Basecamp ${Date.now()}`
  const dmPost = (await sinkPost(tokens.bob, dmRoom.id, secret)).json
  await goto(`/messages/${dmRoom.id}/`)
  await until(`!!document.querySelector('[data-post="${dmPost.id}"]')`, v => v, 'the direct message never drew', 25_000)
  await menuPick(`[data-post="${dmPost.id}"]`, '[data-post-more]', 'Make a Basecamp to-do')
  await until(`!!document.querySelector('[data-todo-dialog]') && document.querySelectorAll('[data-todo-list] option').length > 0`, v => v, 'the dialog never loaded a project and a list', 25_000)
  const permalink = `${sink.url}/town/pl/${dmPost.id}`
  check('the notes show the permalink and nothing else', await evaluate(`document.querySelector('[data-todo-notes]').value`) === permalink)
  check('and they cannot be edited', await evaluate(`document.querySelector('[data-todo-notes]').readOnly`))
  check('the title starts as the post\'s first line', await evaluate(`document.querySelector('[data-todo-title]').value`) === secret)
  check('the project picker lists what the connector walked', await evaluate(`document.querySelectorAll('[data-todo-project] option').length`) > 1)
  const edited = `Call the client back ${Date.now()}`
  await fillSel('[data-todo-title]', edited)
  const before = (await todoSeen()).filter(r => r.method === 'POST').length
  await click('[data-todo-save]')
  await until(`document.querySelector('[data-todo-link]')?.getAttribute('href') ?? null`, h => !!h, 'the dialog never showed the to-do\'s link', 25_000)
  const sent = (await todoSeen()).filter(r => r.method === 'POST')
  check('one create reached the sink', sent.length === before + 1, sent.length - before)
  const made = sent[sent.length - 1]
  check('it is a to-do on the list picked', /\/todolists\/\d+\/todos\.json$/.test(made?.path ?? ''), made?.path)
  check('the title sent is the edited one', made?.body?.content === edited, made?.body)
  check('the notes hold the permalink alone', (made?.body?.description ?? '').replace(/<[^>]+>/g, '') === permalink, made?.body)
  check('the direct message\'s text appears nowhere in the request', !JSON.stringify(made).includes(secret) && !JSON.stringify(made).includes('private to the two'), made)
  check('the author and the channel are not in it either', !JSON.stringify(made?.body).includes(ids.bob) && !JSON.stringify(made?.body).includes(dmRoom.id), made?.body)
  check('the dialog links the to-do Basecamp made', /^https?:\/\/[^ ]+$/.test(await evaluate(`document.querySelector('[data-todo-link]').getAttribute('href')`)))
  await click('[data-todo-done] button')
  }

  console.log('\n  Sidebar width')
  {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await evaluate(`localStorage.removeItem('workbench.messages.sidebarWidth')`)
  await goto('/messages/')
  await until(`!!document.querySelector('[data-chat-resize]')`, v => v, 'the sidebar never showed its resize handle')
  const sideWidth = () => evaluate(`Math.round(document.querySelector('.chat-sidebar').getBoundingClientRect().width)`)
  check('the sidebar opens at 260px', await sideWidth() === 260, await sideWidth())
  const at = await evaluate(`(() => { const r = document.querySelector('[data-chat-resize]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2 } })()`)
  const mouse = (type, x) => send('Input.dispatchMouseEvent', { type, x, y: at.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  await mouse('mousePressed', at.x)
  await mouse('mouseMoved', at.x + 60)
  await mouse('mouseMoved', at.x + 100)
  await mouse('mouseReleased', at.x + 100)
  check('dragging the edge 100px right widens it to 360px', await sideWidth() === 360, await sideWidth())
  await mouse('mousePressed', at.x + 100)
  await mouse('mouseMoved', at.x - 400)
  await mouse('mouseReleased', at.x - 400)
  check('dragging far left stops at the 180px floor', await sideWidth() === 180, await sideWidth())
  await evaluate(`document.querySelector('[data-chat-resize]').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  check('ArrowRight on the focused handle widens it 10px', await sideWidth() === 190, await sideWidth())
  await goto('/messages/')
  await until(`!!document.querySelector('.chat-sidebar')`, v => v, 'the sidebar never came back after a reload')
  check('the width survives a reload', await sideWidth() === 190, await sideWidth())
  await evaluate(`document.querySelector('[data-chat-resize]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  check('a double-click puts it back to 260px', await sideWidth() === 260, await sideWidth())
  await send('Emulation.clearDeviceMetricsOverride')
  }

  console.log('\n  Chrome')
  check('the nav carries Messages', await evaluate(`[...document.querySelectorAll('a[href="/messages/"]')].some(a => /Messages/.test(a.textContent))`))
  if (process.env.FRONTIER_DRIVE_SHOT) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(process.env.FRONTIER_DRIVE_SHOT, Buffer.from(data, 'base64'))
  }
} catch (err) {
  bad('the drive threw', err.message)
  // What the page itself holds, so a miss is told from a missing element.
  try { console.log('    page:', await evaluate(`location.pathname + location.search + ' | pane: ' + (document.querySelector('[data-thread-pane]')?.innerText.replace(/\\s+/g, ' ').slice(0, 400) ?? 'none') + ' | room: ' + (document.querySelector('[data-channel-page]')?.className ?? 'none') + ' | editor: ' + (document.querySelector('[data-post-editor]')?.innerText.replace(/\\s+/g, ' ') ?? 'none') + ' | post errors: ' + [...document.querySelectorAll('[data-post-error]')].map(e => e.textContent.trim()).join(';') + ' | search: ' + (document.querySelector('[data-search]')?.innerText.replace(/\\s+/g, ' ').slice(0, 300) ?? 'none') + ' | menu: ' + [...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim()).join(',')`)) } catch {}
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
