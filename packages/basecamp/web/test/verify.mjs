/**
 * web/test/verify.mjs — drive Basecamp in a real browser and assert what happens.
 *
 * Starts from an EMPTY database and works the way a person does: navigate, fill,
 * click. Nothing here calls the API to make the UI look right — the few direct
 * calls that exist are seeding a precondition or checking a refusal the UI never
 * offers, and each says so.
 *
 * It covers first-run setup, login and the navigation guard; workspace
 * switching; Projects → Environments → Apps; deployments including the live
 * step timeline; the server fleet, its custom methods and the outpost heartbeat;
 * jobs and their run history; the admin zone; and an accessibility pass on
 * every screen.
 *
 * Unit tests cannot settle any of it. The failures this guards against are
 * silent ones — a navigation guard registered too late protects client-side
 * navigation while leaving a direct load of the same URL wide open, a channel
 * that delivers nothing looks identical to one with nothing to say, and a
 * method returning a partial row renders "undefined" in a heading while every
 * data assertion still passes. Only a real browser on a real URL tells you.
 *
 * Usage, from the package root:
 *
 *   bun run verify            # needs an empty database
 *   bun run verify --reset    # deletes the database first, then runs
 *
 * It starts the API and the web server itself and stops them at the end, so it
 * needs both ports free. Needs Chrome on PATH (or $FJS_CHROME), the same
 * requirement the css package's harness has.
 *
 * Exits non-zero and prints what differed if any assertion fails.
 */

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG  = join(HERE, '../..')            // packages/basecamp

const CHROME   = process.env.FJS_CHROME ?? 'google-chrome'
const API_PORT = 8120
const WEB_PORT = 8020
// The fake Basecamp outpost. `volumes.remove` refuses to forget a row until the
// machine says the disk is gone, so proving the happy path needs something
// that answers as an outpost — the same reason the channels checks send a real
// webhook at a URL that does not resolve, one step further along.
const OUTPOST_PORT = 3011
const BASE     = `http://localhost:${WEB_PORT}`
const PROFILE  = '/tmp/fjs-basecamp-verify-profile'

const ACCOUNT = {
  workspace: 'Acme',
  name:      'Sam',
  email:     'sam@example.com',
  password:  'hunter2hunter2',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []

function fail(message) {
  console.error(`\n  ${message}\n`)
  cleanup().then(() => process.exit(1))
}

async function cleanup() {
  for (const c of children) { try { c.kill() } catch {} }
  await sleep(300)
}

// ─── Ports ────────────────────────────────────────────────────────────────
// A port still held by an earlier run is the worst failure mode here: the stale
// API keeps the OLD database open — including one this script just deleted,
// since an unlinked SQLite file lives on while a handle does — so every request
// is answered from data that no longer exists on disk.
async function portFree(port) {
  const net = await import('node:net')
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '0.0.0.0')
  })
}

// Chrome's debugging port is NOT in this list — it is asked for as 0 and read
// back, which is the only thing that makes two harnesses on one machine safe.
// See the browser block below for what a fixed one cost.
for (const [port, who] of [[API_PORT, 'API'], [WEB_PORT, 'web'], [OUTPOST_PORT, 'outpost sink']]) {
  if (!(await portFree(port))) {
    console.error(`\n  Port ${port} (${who}) is in use — stop it first:\n\n    bun run stop\n`)
    process.exit(1)
  }
}

// ─── Fresh database ───────────────────────────────────────────────────────
if (process.argv.includes('--reset')) {
  for (const f of [
    'db/basecamp.db', 'db/basecamp.db-shm', 'db/basecamp.db-wal',
    'db/basecamp-jobs.db', 'db/basecamp-jobs.db-shm', 'db/basecamp-jobs.db-wal',
    'db/audit',
  ]) await rm(join(PKG, f), { recursive: true, force: true })
}

// ─── Servers ──────────────────────────────────────────────────────────────
children.push(spawn('bun', ['api/src/index.ts'], { cwd: PKG, stdio: 'ignore' }))
children.push(spawn('bun', ['run', 'web'],       { cwd: PKG, stdio: 'ignore' }))

// ─── The outpost sink ───────────────────────────────────────────────────────
// Stands in for the Basecamp outpost on gateway-01. It records what it was asked
// to do, which is the half a database check cannot see: a `remove` that deleted
// the row and never left the process looks identical from the outside, and the
// disk stays exactly as full.
//
// It is not asked to be a good outpost — no HMAC verification, no real disk. What
// it proves is that the request was MADE, and with which name.
const outpostSaw = { deleted: [], pruned: [], ran: [], swept: [] }
{
  const http  = await import('node:http')
  const outpost = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'DELETE' && req.url.startsWith('/volumes/')) {
        outpostSaw.deleted.push(decodeURIComponent(req.url.slice('/volumes/'.length)))
        return res.end(JSON.stringify({ ok: true }))
      }
      // A recipe run. The command it was handed is the half nothing else can
      // see: a run row saying `success` proves the engine wrote a row, not that
      // a machine was ever asked to do anything.
      if (req.method === 'POST' && req.url === '/exec') {
        const command = JSON.parse(body || '{}').command ?? ''
        outpostSaw.ran.push(command)
        return res.end(JSON.stringify({
          exit_code: command.includes('exit 3') ? 3 : 0,
          stdout:    'Filesystem      Size  Used Avail Use%\n/dev/vda1        79G   42G   34G  55%',
          stderr:    command.includes('exit 3') ? 'du: permission denied' : '',
        }))
      }
      // A reclaim sweep. It answers a fresh `usage` snapshot as well as what it
      // freed, because it has just run `docker system df` to work that out —
      // asking again a second later would be a second answer to one question.
      if (req.method === 'POST' && req.url === '/system/prune') {
        const sent = JSON.parse(body || '{}')
        outpostSaw.swept.push((sent.targets ?? []).join('+'))
        return res.end(JSON.stringify({
          freed_bytes: 3 * 1024 ** 3,
          removed:     { images: 22, containers: 2, build_cache_bytes: 2 * 1024 ** 3 },
          volumes:     [],
          usage: {
            images:      { total: 12, unused: 0, dangling: 0, size_bytes: 4 * 1024 ** 3, reclaimable_bytes: 0 },
            containers:  { running: 4, stopped: 0, reclaimable_bytes: 0 },
            build_cache: { size_bytes: 0, reclaimable_bytes: 0 },
          },
        }))
      }
      if (req.method === 'POST' && req.url === '/volumes/prune') {
        const names = (JSON.parse(body || '{}').names ?? [])
        outpostSaw.pruned.push(...names)
        // Answering the names back is the contract prune relies on: it forgets
        // exactly what the outpost says it removed, never what it asked for.
        return res.end(JSON.stringify({ removed: names }))
      }
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not an outpost route' }))
    })
  })
  outpost.listen(OUTPOST_PORT)
  // `children` is killed in cleanup(); a server is not a child process, so it
  // gets a kill() of its own rather than a second teardown path to forget.
  children.push({ kill: () => outpost.close() })
}

let probe = null
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${BASE}/setup/probe`, { headers: { accept: 'application/json' } })
    if (res.ok) { probe = await res.json(); break }
  } catch {}
  await sleep(500)
}
if (!probe) fail(`No answer from ${BASE}/setup/probe after 30s — did the servers start?`)

if (!probe.needs_setup) {
  fail(
    'This harness needs an EMPTY database: it asserts that the first-run wizard\n' +
    `  owns the app, and there are already ${probe.users} user(s).\n\n` +
    '    bun run verify --reset'
  )
}

// ─── Browser ──────────────────────────────────────────────────────────────
// The debugging port is asked for as 0 and read back off stderr, which is what
// `example/`'s harnesses already do. A FIXED port is not merely a collision
// risk: Chrome refuses to start a second browser on a bound one and exits
// quietly, so the `/json/list` poll below finds the OTHER browser's tabs and
// this file then drives those. It failed twice as `no field #workspace on
// /packages/css/guide/index.html` — a page from another package, in another
// session's Chrome, with every check up to that point green.
await rm(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0',
  `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
children.push(chrome)
chrome.on('error', e => fail(`Could not launch ${CHROME}: ${e.message}. Set $FJS_CHROME.`))

const browserWsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15_000)
  chrome.stderr.on('data', d => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
}).catch(e => fail(`${e.message}. Is ${CHROME} installed? Set $FJS_CHROME.`))

// The port is in the browser's own WebSocket URL, so the page list is asked of
// THIS browser rather than of whatever is listening on a number.
const cdpPort = new URL(browserWsUrl).port
let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    target = list.find(t => t.type === 'page')
    if (target) break
  } catch {}
  await sleep(250)
}
if (!target) fail(`No Chrome debug target on :${cdpPort}. Is ${CHROME} installed? Set $FJS_CHROME.`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))

let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise(res => {
  const n = ++msgId
  pending.set(n, res)
  ws.send(JSON.stringify({ id: n, method, params }))
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const ex = r.result?.exceptionDetails
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex))
  return r.result?.result?.value
}

// A navigation, then time for the guard to resolve `ready` and commit a route.
// The guard awaits a network round trip, so this is not instant.
async function goto(path) {
  await send('Page.navigate', { url: BASE + path })
  await sleep(2500)
}

// Setting .value on an input does not notify Mesa — bind:value listens for
// input events, so a value written without one submits as an empty string.
const fill = fields => evaluate(`
  (() => {
    ${Object.entries(fields).map(([id, v]) =>
      `{ const el = document.getElementById(${JSON.stringify(id)})
         if (!el) throw new Error('no field #${id} on ' + location.pathname)
         el.value = ${JSON.stringify(v)}
         el.dispatchEvent(new Event('input', { bubbles: true })) }`).join('\n    ')}
  })()
`)

const submit = () => evaluate(`document.querySelector('button[type=submit]').click()`)

/**
 * Poll until an expression settles, instead of sleeping a guessed amount.
 *
 * The checks that depend on something arriving — a channel push, a job run
 * landing on Caravan's thread — were fixed sleeps, and a fixed sleep is a bet:
 * one run of this harness reported 89/90 with no way to tell which line lost
 * the race. Polling turns "wait long enough" into "wait until true, or fail
 * with what it actually was".
 */
async function waitFor(expression, predicate, ms = 15_000) {
  let value = null
  for (let waited = 0; waited < ms; waited += 250) {
    value = await evaluate(expression)
    if (predicate(value)) return value
    await sleep(250)
  }
  return value
}

const results = []
function check(name, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want
  results.push({ name, ok, got })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `   got: ${JSON.stringify(got)}`}`)
}

const path     = () => evaluate('location.pathname')
const heading  = () => evaluate(`document.querySelector('h1')?.textContent ?? null`)
const badges   = () => evaluate(`[...document.querySelectorAll('.badge')].map(e => e.textContent.trim()).join('|')`)
const hasToken = () => evaluate(`!!localStorage.getItem('basecamp_token')`)

await send('Page.enable')
await send('Runtime.enable')
await evaluate(`window.__errs = []; addEventListener('error', e => __errs.push(String(e.message)))`)

console.log('\nBasecamp — auth flow\n')

// 1. With no account, the wizard owns the app — including on a direct load.
await goto('/')
check('empty database sends / to the wizard', await path(), '/setup/')
check('the wizard renders', await heading(), 'Set up Basecamp')
await goto('/login/')
check('and /login/ too — there is nobody to log in as', await path(), '/setup/')

// 2. First run.
await goto('/setup/')
await fill({
  workspace: ACCOUNT.workspace,
  name:      ACCOUNT.name,
  email:     ACCOUNT.email,
  password:  ACCOUNT.password,
})
await submit()

// Polled, not slept. This was `sleep(3500)`, and a fixed sleep is a bet — the
// harness says so about its own history. The shell now loads three resources at
// mount for the notice bar, so the redirect lands later than it used to.
check('setup lands on home',
  await waitFor(`location.pathname`, p => p === '/'), '/')
check('signed in as the new user', await evaluate('document.body.textContent'), t => t.includes(ACCOUNT.email))
// The workspace tile names the workspace the page is scoped to. Empty or
// 'none' means /auth/workspace answered nothing and every scoped request from
// here would 400.
check('workspace resolved',
  await waitFor(`[...document.querySelectorAll('.badge')].map(e => e.textContent.trim()).join('|')`,
    t => t.includes('acme')),
  t => t.includes('acme'))
check('token persisted', await hasToken(), true)
// The socket opens only once a token is stored, so this is also the proof that
// storing it and handing it to the client happen together.
check('websocket live', await evaluate(`document.querySelector('.pill')?.textContent.trim()`), 'live')

// 3. Setup closes behind itself.
await goto('/setup/')
check('setup is unreachable once done', await path(), '/')

// 4. Sign out.
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Sign out')).click()`)
await sleep(2000)
check('sign out returns to /login/', await path(), '/login/')
check('token cleared', await hasToken(), false)
await goto('/')
check('signed out, / is guarded', await path(), '/login/')

// 5. A wrong password is a message, not a broken app.
await fill({ email: ACCOUNT.email, password: 'wrongwrongwrong' })
await submit()
await sleep(2000)
check('wrong password explains itself',
  await evaluate(`document.querySelector('.alert.danger')?.textContent.trim() ?? null`),
  t => typeof t === 'string' && t.includes('Wrong email or password'))
check('and stays on the form', await path(), '/login/')

// 6. The right one.
await fill({ email: ACCOUNT.email, password: ACCOUNT.password })
await submit()
await sleep(3000)
check('login lands on home',
  await waitFor(`location.pathname`, p => p === '/'), '/')
check('token stored again', await hasToken(), true)

// 7. A reload is the real test of session restore — it re-runs the guard with
//    nothing in memory, only what localStorage kept.
await goto('/')
check('reload keeps the session', await path(), '/')
check('reload keeps the user', await evaluate('document.body.textContent'), t => t.includes(ACCOUNT.email))

// ── 8. Workspace scoping ──────────────────────────────────────────────
// Seeded over HTTP rather than through the UI: creating projects is Phase 3,
// but the scoping claim can be tested now, and a claim that can be tested now
// and is not is a claim nobody is checking.
const token = await evaluate(`localStorage.getItem('basecamp_token')`)

async function apiCall(path, { method = 'GET', body, workspace, header } = {}) {
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` }
  if (body) headers['content-type'] = 'application/json'
  if (workspace) headers['x-workspace-id'] = workspace
  // Custom methods dispatch on X-Service-Method, never a sub-path.
  if (header) Object.assign(headers, header)
  const res = await fetch(`http://localhost:${API_PORT}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
  return data
}

const firstWs = (await apiCall('/workspaces')).data[0]
await apiCall('/projects', { method: 'POST', workspace: firstWs.id, body: { name: 'Website', slug: 'website' } })

const secondWs = await apiCall('/workspaces', { method: 'POST', workspace: firstWs.id, body: { name: 'Skunkworks', slug: 'skunkworks' } })
await apiCall('/projects', { method: 'POST', workspace: secondWs.id, body: { name: 'Prototype', slug: 'prototype' } })
await apiCall('/projects', { method: 'POST', workspace: secondWs.id, body: { name: 'Spike',     slug: 'spike' } })

await goto('/')
check('switcher lists both workspaces',
  await evaluate(`[...document.querySelectorAll('#workspace-switch option')].map(o => o.textContent.trim()).sort().join(',')`),
  'Acme,Skunkworks')
check('first workspace shows its one project',
  await evaluate(`document.getElementById('project-count')?.textContent.trim()`), '1 projects')
check('and only its own row',
  await evaluate(`[...document.querySelectorAll('#project-rows td')].map(t => t.textContent.trim()).join('|')`),
  t => t.includes('Website') && !t.includes('Prototype'))

// Switching is a <select> change, which is what a person does.
await evaluate(`
  (() => {
    const sel = document.getElementById('workspace-switch')
    sel.value = ${JSON.stringify(secondWs.id)}
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()
`)
await sleep(2000)

check('switching re-scopes the list without a reload',
  await evaluate(`document.getElementById('project-count')?.textContent.trim()`), '2 projects')
check('showing the other workspace rows',
  await evaluate(`[...document.querySelectorAll('#project-rows td')].map(t => t.textContent.trim()).join('|')`),
  t => t.includes('Prototype') && t.includes('Spike') && !t.includes('Website'))
check('and the heading follows',
  await evaluate(`document.querySelector('h1')?.textContent.trim()`), 'Skunkworks')

// The choice has to survive a reload, or a switch silently undoes itself.
await goto('/')
check('the chosen workspace survives a reload',
  await evaluate(`document.querySelector('h1')?.textContent.trim()`), 'Skunkworks')

// ── 9. Projects → Environments → Apps, through the UI ─────────────────
// Everything below is done the way a person does it: navigate, fill, click.
// Nothing here calls the API directly — the point is that the screens work,
// not that the service does.
const click = text => evaluate(`
  (() => {
    const el = [...document.querySelectorAll('button, a')]
      .find(e => e.textContent.trim() === ${JSON.stringify(text)})
    if (!el) throw new Error('no control labelled ' + ${JSON.stringify(text)} + ' on ' + location.pathname)
    el.click()
  })()
`)

await goto('/projects/')
check('the projects list renders', await heading(), 'Projects')

await click('New project')
await sleep(1500)
check('new project form opens', await heading(), 'New project')

await fill({ name: 'Checkout rewrite' })
// The slug derives from the name until someone edits it — nothing is typed
// into #slug here, and the form must still submit a valid one.
check('slug derives from the name', await evaluate(`document.getElementById('slug').value`), 'checkout-rewrite')
await submit()
await sleep(2500)

check('creating lands on the project', await heading(), 'Checkout rewrite')
const projectPath = await path()
check('…at its own URL', projectPath, p => /^\/projects\/[0-9a-f-]{36}\/$/.test(p))

// Rename in place.
await click('Edit')
await sleep(800)
await fill({ name: 'Checkout rewrite v2', description: 'Phase 3 verification' })
await click('Save')
await sleep(2000)
check('renaming updates the heading', await heading(), 'Checkout rewrite v2')

// Environments: the picker's options come from the schema's EnvironmentTier
// enum, not from a list written in the component.
// #tier-select, not `select` — the first <select> on the page is the workspace
// switcher in the topbar, and setting THAT to 'production' silently does
// nothing while the tier stays at its default.
check('tier options come from the schema enum',
  await evaluate(`[...document.querySelectorAll('#tier-select option')].map(o => o.value).join(',')`),
  t => t.includes('development') && t.includes('production'))

await evaluate(`
  (() => {
    const sel = document.getElementById('tier-select')
    sel.value = 'production'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()
`)
await click('Add environment')
await sleep(2500)
check('the environment is listed',
  await evaluate(`[...document.querySelectorAll('#environment-rows td')].map(t => t.textContent.trim()).join('|')`),
  t => t.includes('Production'))

// Into the environment.
// The production row's Open, not the first one on the page.
await evaluate(`
  (() => {
    const row = [...document.querySelectorAll('#environment-rows tr')]
      .find(tr => tr.textContent.includes('Production'))
    if (!row) throw new Error('no Production row')
    row.querySelector('a.btn').click()
  })()
`)
await sleep(2500)
check('the environment opens', await heading(), 'Production')
const envPath = await path()
check('protected environments say so',
  await evaluate(`document.querySelector('.alert.warning')?.textContent ?? ''`),
  t => t.includes('protected'))

// Variables ride a custom method — X-Service-Method, not a sub-path.
await fill({ 'var-key': 'DATABASE_URL', 'var-value': 'sqlite://./db/app.db' })
await click('Set variable')
await waitFor(`document.getElementById('variable-rows')?.textContent ?? ''`, t => t.includes('DATABASE_URL'))
check('the variable is saved',
  await evaluate(`[...document.querySelectorAll('#variable-rows td')].map(t => t.textContent.trim()).join('|')`),
  t => t.includes('DATABASE_URL') && t.includes('sqlite://./db/app.db'))

// The page assigns the method's result to the record it is rendering. When
// setVariable answered a partial row ({id, variables}), that assignment wiped
// name and tier and the heading rendered "undefined" — with every variable
// assertion above still passing. Checking what the screen says afterwards is
// the only thing that catches it.
check('…and the page still knows what it is showing', await heading(), 'Production')

// A masked value is hidden in the table but still present in the response —
// display, not secrecy. The check is that the mask renders.
await fill({ 'var-key': 'API_TOKEN', 'var-value': 'tok_live_123' })
await evaluate(`
  (() => {
    const box = document.querySelector('.field-check input[type=checkbox]')
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
  })()
`)
await click('Set variable')
await sleep(2000)
check('a masked variable renders masked',
  await evaluate(`[...document.querySelectorAll('#variable-rows td')].map(t => t.textContent.trim()).join('|')`),
  t => t.includes('API_TOKEN') && t.includes('••••••••') && !t.includes('tok_live_123'))

await click('Remove')
await sleep(2000)
check('removing a variable leaves the other',
  await evaluate(`[...document.querySelectorAll('#variable-rows td')].map(t => t.textContent.trim()).join('|')`),
  t => !t.includes('DATABASE_URL') && t.includes('API_TOKEN'))

// A reload proves it was persisted rather than held in the component.
await goto(envPath)
check('variables survive a reload',
  await evaluate(`[...document.querySelectorAll('#variable-rows td')].map(t => t.textContent.trim()).join('|')`),
  t => t.includes('API_TOKEN'))

// ── 10. Deployments, and the live channel ─────────────────────────────
// This is the one screen the WebSocket exists for. Everything asserted below
// happens WITHOUT a reload: the page is loaded once, a release is started, and
// the engine's pushes are what change it.
//
// The channel had never had a subscriber before this phase, and it did not
// work: the connection joined `workspace:${session.workspace_id}` (a field that
// does not exist — it is workspaceId, and auth never sets it), and the engine
// called `channel.publish()` (a manager method, not a channel one) behind a
// guard that swallowed the miss. Both are fixed; these checks are what stop
// them regressing into silence again.
await goto(envPath)

// An app first — it is what a release releases, and an App belongs to exactly
// one environment, so this is where it is created.
await fill({ 'app-name': 'web' })
await click('Add app')
await sleep(2500)
check('the app is listed',
  await evaluate(`document.getElementById('app-rows')?.textContent ?? ''`),
  t => t.includes('web') && t.includes('container'))

// ── 9b. The App's own screen ─────────────────────────────────────────
// The largest single gap in docs/SCREENS.md until 2026-08-06: an App could be
// created from an Environment and then never looked at again.
const appOwnerEnvPath = await path()
await evaluate(`document.querySelector('#app-rows a[href^="/apps/"]').click()`)
await sleep(2000)
const appDetailPath = await path()
check('an app has its own screen', await heading(), 'web')
check('…opening in one request, with placement, releases and jobs',
  await evaluate(`document.getElementById('app-overview')?.textContent ?? ''`),
  t => t.includes('Placement') && t.includes('Serving'))

// Domains & SSL — the tab the mock has and the schema could not describe until
// `Domain` replaced `App.domain`, one nullable string.
await evaluate(`[...document.querySelectorAll('#app-tabs button')].find(b => b.textContent.trim() === 'domains').click()`)
await sleep(600)
await click('Add hostname')
await sleep(800)
await fill({ hostname: 'app.acme.test' })
await submit()
check('the first hostname becomes the primary',
  await waitFor(`document.getElementById('domain-list')?.textContent ?? ''`, t => t.includes('app.acme.test')),
  t => t.includes('app.acme.test') && t.includes('primary'))
check('…and reports having no certificate, rather than looking fine',
  await evaluate(`document.getElementById('domain-list')?.textContent ?? ''`),
  t => t.includes('none'))

// A certificate goes in once. What comes back is metadata; the key is a Secret.
await click('Upload certificate')
await sleep(600)
const CERT_CANARY = 'KEYCANARYzzz'
await fill({
  certPem:   '-----BEGIN CERTIFICATE-----CERTCANARYzzz',
  keyPem:    `-----BEGIN PRIVATE KEY-----${CERT_CANARY}`,
  expiresAt: new Date(Date.now() + 10 * 86400000).toISOString(),
})
await click('Store certificate')
check('a stored certificate reports its condition, derived from the expiry',
  await waitFor(`
    (document.getElementById('screen-error')?.textContent ?? '')
    + (document.getElementById('domain-list')?.textContent ?? '')`,
    t => t.includes('expiring_soon')),
  t => t.includes('expiring_soon'))
check('the private key is not on the page',
  await evaluate(`document.body.textContent.includes(${JSON.stringify(CERT_CANARY)})`), false)
check('…nor in what the API answers for the domain',
  await evaluate(`
    fetch('/domains', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': ${JSON.stringify(secondWs.id)},
    }}).then(r => r.text()).then(t => t.includes(${JSON.stringify(CERT_CANARY)}))`),
  false)

// The primary cannot be deleted while it is the only route to the app.
await click('Delete')
await sleep(1200)
check('deleting the only primary hostname is allowed — it is the last one',
  await evaluate(`document.getElementById('domain-list')?.textContent ?? ''`),
  t => !t.includes('app.acme.test'))

await goto(appOwnerEnvPath)

// Record every push the browser receives, through the app's OWN module — the
// same resource instance the screens use, so this observes the real socket
// rather than a second connection made for the test.
//
// Asserting "the status is still 'pending' three seconds in" would be racy:
// the engine's work is simulated and a release can finish before the page
// settles. What is not racy is whether pushes arrived at all — which is the
// actual claim, and the thing that was broken.
await evaluate(`
  (async () => {
    const m = await import('/src/resources/Deployment.mesa')
    window.__pushes = []
    m.deployments.service.on('patched', r => window.__pushes.push(r.status))
  })()
`)

await evaluate(`
  (() => {
    const btn = [...document.querySelectorAll('#app-rows button')].find(b => b.textContent.trim() === 'Deploy')
    if (!btn) throw new Error('no Deploy button — is there an app in this environment?')
    btn.click()
  })()
`)
await sleep(3000)

check('deploying opens the release', await path(), p => /^\/deployments\/[0-9a-f-]{36}\/$/.test(p))
const deployPath = await path()
check('the step list is written up front',
  await evaluate(`document.querySelectorAll('#deploy-steps li').length`), n => n >= 3)

// Now wait — without touching the page. If nothing arrives on the socket this
// sits on 'pending' until it times out, which is exactly the failure the old
// code had.
const live = await waitFor(
  `document.getElementById('deploy-status')?.textContent.trim()`,
  v => ['success', 'failed', 'rolled_back', 'cancelled'].includes(v),
  40_000)
check('the release finishes on screen with no reload', live, 'success')
// The engine pushes on every step transition, so a six-step release produces
// several. Zero means the socket delivered nothing and the screen only looked
// right because it was re-fetched.
check('…because the engine pushed over the socket',
  await evaluate(`(window.__pushes ?? []).length`), n => n > 0)
check('…including the terminal state',
  await evaluate(`JSON.stringify(window.__pushes ?? [])`), t => t.includes('success'))
check('…and every step reports complete',
  await evaluate(`document.getElementById('step-progress')?.textContent.trim()`),
  t => /^(\d+) \/ \1 complete$/.test(t))

// The list carries the same state, and gets there the same way.
await goto('/deployments/')
check('the deployments list shows the release',
  await evaluate(`document.getElementById('deployment-rows')?.textContent ?? ''`),
  t => t.includes('success'))

// Cancel is a state change, not a delete — history is the point of the record.
await goto(deployPath)
check('a finished release offers no cancel',
  await evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Cancel')`),
  false)

// ── 11. Servers ───────────────────────────────────────────────────────
// The richest service: custom methods that transition status, Json columns,
// an event trail, and a heartbeat that arrives from a machine rather than a
// person.
await goto('/servers/')
check('the servers list renders', await heading(), 'Servers')
check('status filter is built from the schema enum',
  await evaluate(`[...document.querySelectorAll('#filter-status option')].map(o => o.value).join(',')`),
  t => t.includes('online') && t.includes('draining') && t.includes('unreachable'))

await click('Add server')
await sleep(1500)
// camelCase, because the wire contract is the schema's field names. `ip_address`
// would not error — autoValidate strips it and the column comes back null.
await fill({ name: 'gateway-01', ipAddress: '10.0.9.10', region: 'nbg1' })
await submit()
await sleep(2500)

check('creating opens the server', await heading(), 'gateway-01')
const serverPath = await path()
check('a new server starts pending',
  await evaluate(`document.getElementById('server-status')?.textContent.trim()`), 'pending')
check('ipAddress persisted',
  await evaluate(`document.body.textContent`), t => t.includes('10.0.9.10'))

// A pending server cannot be drained, and the page does not offer it.
check('pending offers no drain',
  await evaluate(`document.getElementById('server-actions')?.textContent ?? ''`),
  t => !t.includes('Drain'))

// The outpost's own endpoint — no session, authenticated at the transport, and
// the only path in the app a machine uses. Bringing the server online this way
// is also what makes the drain path reachable.
const serverId = serverPath.split('/').filter(Boolean)[1]
// The heartbeat payload is the OUTPOST's contract and it is snake_case
// (`outpost_version`), unlike every other call in this file — the schema's
// camelCase applies to model fields, and these are not model fields. Sending
// `outpostVersion` is not an error: it is ignored, and the page reports the
// outpost as 'not installed' while everything else looks fine.
await apiCall(`/servers/${serverId}`, {
  method: 'POST', workspace: firstWs.id,
  body: { outpost_version: '0.4.1', health: { cpu: 12, memory: 41 } },
  header: { 'x-service-method': 'heartbeat' },
})
// No reload: the heartbeat published to the workspace channel and the open page
// picked it up.
check('a heartbeat brings the server online with no reload',
  await waitFor(`document.getElementById('server-status')?.textContent.trim()`, v => v === 'online'),
  'online')
check('…and its health arrives with it',
  await evaluate(`document.body.textContent`), t => t.includes('cpu') && t.includes('12'))
check('…and the outpost version it reported',
  await evaluate(`document.body.textContent`), t => t.includes('0.4.1'))

// Now the transitions, through the buttons.
await click('Drain')
check('draining transitions the status',
  await waitFor(`document.getElementById('server-status')?.textContent.trim()`, v => v === 'draining'),
  'draining')
check('and the trail records it',
  await evaluate(`document.getElementById('server-events')?.textContent ?? ''`),
  t => t.includes('drain'))

// The Toaster is mounted once in the shell; anything can call toasts.success().
// Asserted here rather than in a chrome section of its own because a toast is
// transient — the only honest place to look for one is straight after the act.
check('the transition is confirmed in a toast',
  await waitFor(`document.querySelector('.toast-stack')?.textContent ?? ''`, t => t.includes('draining')),
  t => t.includes('draining'))

check('a draining server offers cancel, not drain',
  await evaluate(`document.getElementById('server-actions')?.textContent ?? ''`),
  t => t.includes('Cancel drain') && !t.includes('>Drain'))

await click('Cancel drain')
check('cancelling returns it to online',
  await waitFor(`document.getElementById('server-status')?.textContent.trim()`, v => v === 'online'),
  'online')

// The service refuses to remove an online server. The button is NOT disabled —
// the refusal is the server's to make, and showing it is more honest than
// guessing at it.
await click('Remove')
await sleep(2000)
check('removing an online server is refused, in words',
  await evaluate(`document.querySelector('.alert.danger')?.textContent.trim() ?? ''`),
  t => t.includes('drain it first'))
check('…and it is still here', await path(), serverPath)

// ── 11b. Shell chrome — the attention system and ⌘K ───────────────────
// The mock's NoticeBar / ActionQueue / CommandPalette, over real rows. The
// notice engine is src/notices.js, a leaf module both the shell and the home
// screen call, so "needs attention" has one definition.

// Pressure reported by the outpost. Nothing here reloads: the heartbeat
// publishes to the workspace channel, the shell's servers store takes the
// push, and the notice is DERIVED from the store — so this asserts the whole
// chain, not a re-fetch.
await apiCall(`/servers/${serverId}`, {
  method: 'POST', workspace: firstWs.id,
  body: { outpost_version: '0.4.1', health: { cpu: 95, memory: 41 } },
  header: { 'x-service-method': 'heartbeat' },
})
check('a notice appears with no reload, off the same push the page reads',
  await waitFor(`document.body.textContent`, t => t.includes('CPU at 95%')),
  t => t.includes('CPU at 95%'))

// ⌘K. The listener is on `mesa:window`, so the event goes to the window.
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`)
await sleep(500)
check('⌘K opens the palette',
  await evaluate(`!!document.querySelector('.cp-panel')`), true)
check('…and the fleet is in it, not just the nav',
  await evaluate(`document.querySelector('.cp-panel')?.textContent ?? ''`),
  t => t.includes('Provision server') && t.includes('gateway-01'))
await evaluate(`document.querySelector('.cp-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(400)
check('…and Escape closes it', await evaluate(`!!document.querySelector('.cp-panel')`), false)

// The queue is the same notices, unfolded, on the home screen.
await goto('/')
check('the home screen opens on what needs attention',
  await waitFor(`document.getElementById('notice-rows')?.textContent ?? ''`, t => t.includes('CPU at 95%')),
  t => t.includes('CPU at 95%'))
check('…counted by priority',
  await evaluate(`document.getElementById('notice-warning')?.textContent ?? ''`),
  t => t.includes('warning'))

// Targeted, not click('✕'): the shell's NoticeBar carries a dismiss with the
// same glyph and sits ABOVE the queue, so the loose match would have dismissed
// the wrong one and the check would have failed for the wrong reason.
await evaluate(`document.querySelector('#notice-rows button[aria-label^="Dismiss"]').click()`)
await sleep(400)
check('a notice can be dismissed',
  await evaluate(`document.getElementById('notice-rows')?.textContent ?? ''`),
  t => !t.includes('CPU at 95%'))

// ── 12. Jobs ──────────────────────────────────────────────────────────
// Seeded fleets have jobs; a fresh database does not, so one is created over
// HTTP. Running it is the part that matters here — the run happens on
// Caravan's thread, not in the request.
// secondWs, not firstWs: the browser switched to Skunkworks back in the
// workspace-switcher checks and that choice persists across reloads, so a job
// created in Acme is correctly invisible here — `Job '...' not found`, which is
// the tenancy boundary working rather than a bug.
const job = await apiCall('/jobs', {
  method: 'POST', workspace: secondWs.id,
  body: { name: 'Nightly backup', kind: 'one_shot', command: '/usr/local/bin/backup.sh' },
})

await goto('/jobs/')
check('the jobs list renders', await heading(), 'Jobs')
check('and shows the job',
  await evaluate(`document.getElementById('job-rows')?.textContent ?? ''`),
  t => t.includes('Nightly backup'))

await goto(`/jobs/${job.id}/`)
check('the job opens', await heading(), 'Nightly backup')
check('the job shows what it will run',
  await evaluate(`document.body.textContent`), t => t.includes('/usr/local/bin/backup.sh'))

// A one_shot job is dispatched ON CREATION — the engine picks up anything
// pending — so it has already run by the time this page loads. The run fails
// with 'No server assigned and no local target registered', which is correct
// for a fleet with nothing attached, and is exactly the kind of history this
// screen exists to show.
const runsBefore = await evaluate(`document.querySelectorAll('#job-runs li').length`)
check('its run history is already there', runsBefore, n => n >= 1)

await click('Run now')
check('running it again adds to the history',
  await waitFor(`document.querySelectorAll('#job-runs li').length`, n => n > runsBefore),
  n => n > runsBefore)

// ── 13. The sysadmin zone ─────────────────────────────────────────────
await goto('/admin/')
check('admin opens on members', await heading(), 'Administration')
check('the owner is listed',
  await evaluate(`document.getElementById('member-rows')?.textContent ?? ''`),
  t => t.includes(ACCOUNT.email))
check('and is not offered a way to remove themselves',
  await evaluate(`document.getElementById('member-rows')?.textContent ?? ''`),
  t => t.includes('you'))

// The trail. Everything done above should be in it.
await goto('/admin/audit/')
check('the audit trail lists what happened',
  await evaluate(`document.getElementById('audit-rows')?.textContent ?? ''`),
  t => t.includes('projects.create') || t.includes('servers.create'))

// Append-only, and that is enforced by the service rather than by the UI
// hiding a button. Verified at the API, because the UI never offers it.
let forged = null
try {
  await apiCall('/audit', {
    method: 'POST', workspace: firstWs.id,
    body: { action: 'forged.event', subjectType: 'projects', subjectId: 'x' },
  })
  forged = 'accepted'
} catch (e) {
  forged = String(e.message)
}
check('the trail refuses to be written to', forged, t => t.includes('405'))

await goto('/admin/adapters/')
check('the adapters are listed',
  await evaluate(`document.getElementById('adapter-tiles')?.textContent ?? ''`),
  t => t.includes('Infisical') && t.includes('Forgejo'))
check('…and unconfigured ones say so, rather than reading as broken',
  await evaluate(`document.getElementById('adapter-tiles')?.textContent ?? ''`),
  t => t.includes('unconfigured'))

// ── 13b. Portal — the same appliances, measured rather than declared ──
// /admin/adapters/ asks whether an adapter is WIRED and pings nothing; this
// screen asks whether it answers RIGHT NOW. The service splits the same way:
// find() is the declaration, get(id) is the ping.
await goto('/portal/')
check('the portal lists the appliances', await heading(), 'Portal')
check('…with their URLs, not just their names',
  await evaluate(`document.getElementById('portal-tiles')?.textContent ?? ''`),
  t => t.includes('Typesense') && t.includes('Zot'))

await evaluate(`document.getElementById('portal-check-all').click()`)
check('checking pings every adapter for real',
  await waitFor(`document.getElementById('portal-tiles')?.textContent ?? ''`,
    t => !t.includes('not checked')),
  t => !t.includes('not checked'))

// An appliance opens at its own URL, and opening it IS the health check.
await evaluate(`document.querySelector('#portal-tiles a[href^="/portal/"]').click()`)
await sleep(1800)
check('an appliance has its own screen',
  await evaluate(`document.getElementById('appliance-facts')?.textContent ?? ''`),
  t => t.includes('Adapter'))
check('…and says whether it is real or a stub',
  await evaluate(`document.getElementById('appliance-status')?.textContent.trim() ?? ''`),
  t => t.length > 0)

// ── 13c. Networking, Alerts, Secrets ─────────────────────────────────
// Three sets of models sat in db/schema.lite with NO API surface at all until
// 2026-08-06 — `Network`+`ServerNetwork`+`AppNetwork`, `AlertRule`+`AlertEvent`
// and `Secret`. These checks are the proof they are reachable.

await goto('/networks/')
check('networking renders', await heading(), 'Networking')
await click('New network')
await sleep(800)
await fill({ name: 'Mesh prod', cidr: '10.10.0.0/16' })
await submit()
check('a network is created',
  await waitFor(`document.getElementById('network-list')?.textContent ?? ''`, t => t.includes('Mesh prod')),
  t => t.includes('Mesh prod') && t.includes('10.10.0.0/16'))

// The join table is the point of the service — a network nothing is on tells
// an operator nothing.
await click('Attach a server')
await sleep(600)
await evaluate(`
  (() => {
    const sel = document.querySelector('#network-list select')
    sel.value = [...sel.options].find(o => o.value)?.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
// The Attach button follows the picker. It is a kit <Button> immediately
// followed by another one, and until `FJS-110` two components separated only by
// whitespace shared a compiled anchor: the second registration replaced the
// first in the component registry, so Attach never received another prop push
// and stayed disabled forever — while a plain <button> carrying the identical
// expression followed the pick. Nothing about the DOM looked wrong, which is
// exactly why it needs an assertion rather than a glance.
check('the Attach button follows the picker',
  await waitFor(`(() => {
    const b = [...document.querySelectorAll('#network-list button')]
      .find(x => x.textContent.trim() === 'Attach')
    return b ? String(b.disabled) : 'no Attach button'
  })()`, v => v === 'false'), 'false')

await click('Attach')
// Poll on the MEMBER COUNT, not on the server's name: the name is also the text
// of the <option> in the picker, so a predicate looking for it passes before
// anything has been attached and the poll exits on its own setup. Nor on
// `.alert.danger` — the shell's notice bar is one, permanently.
check('a server joins the network',
  await waitFor(`document.getElementById('network-list')?.textContent ?? ''`, t => t.includes('1 attached')),
  t => t.includes('1 attached'))

// Deleting is refused while anything is on it — the service's judgement, shown
// rather than pre-empted by a disabled button.
await click('Delete')
await sleep(1200)
check('a populated network refuses to be deleted, in words',
  await waitFor(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.includes('detach')),
  t => t.includes('detach'))

await goto('/alerts/')
check('alerts renders', await heading(), 'Alerts')
check('…and says plainly that nothing evaluates the rules yet',
  await evaluate(`document.body.textContent`), t => t.includes('not yet evaluated'))
await click('New rule')
await sleep(800)
await fill({ name: 'DB memory high', metricName: 'memory', threshold: '85' })
// severity is left untouched on purpose: it must arrive from the schema's own
// `@default(warning)`. Until 2026-08-06 the schema defaulted to "medium" and
// the service refused that value — a vocabulary owned in two places.
await submit()
check('an alert rule is created',
  await waitFor(`
    (document.getElementById('alert-list')?.textContent ?? '')
    + (document.getElementById('screen-error')?.textContent ?? '')
    + [...document.querySelectorAll('.field-error, .field-group')].map(e => e.textContent).join(' ')`,
    t => t.includes('DB memory high')),
  t => t.includes('DB memory high'))
await click('History')
check('a rule that never fired says so, rather than showing an empty box',
  await waitFor(`document.getElementById('alert-list')?.textContent ?? ''`, t => t.includes('never fired')),
  t => t.includes('never fired'))

// ── 13c-ii. Channels — where an alert actually goes ──────────────────
// `AlertRule.channels` was `Json @default("[]")`, an array of ids pointing at
// rows no model declared. These checks are that the pointer now lands
// somewhere: a channel exists, a rule reaches it, and the credential it holds
// is nowhere a browser can see.
await goto('/channels/')
check('channels renders', await heading(), 'Notification channels')
check('…and an alert rule with nowhere to go is visible as such',
  await evaluate(`document.body.textContent`), t => t.includes('where alerts get delivered'))

await click('New channel')
await sleep(800)
// The kind picker decides which fields the form asks for, so it is set before
// the rest is filled: `url` does not exist as a control until kind is webhook.
await evaluate(`
  (() => {
    const sel = document.getElementById('kind')
    sel.value = 'webhook'
    sel.dispatchEvent(new Event('input',  { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
await sleep(500)
await fill({ name: 'Ops webhook', configValue: 'https://hooks.invalid.test/basecamp', secret: 'WEBHOOKTOKENCANARY' })
await submit()
check('a channel is created',
  await waitFor(`document.getElementById('channel-rows')?.textContent ?? ''`, t => t.includes('Ops webhook')),
  t => t.includes('Ops webhook') && t.includes('active'))

// The credential went into a Secret (@encrypted). Not masked — absent.
check('the token it was given is nowhere on the page',
  await evaluate(`document.body.textContent.includes('WEBHOOKTOKENCANARY')`), false)
check('…nor in what the channels API answers',
  await evaluate(`
    fetch('/channels', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': ${JSON.stringify(secondWs.id)},
    }}).then(r => r.text()).then(t => t.includes('WEBHOOKTOKENCANARY'))`),
  false)

// A test really sends. Nothing answers on .invalid.test, so it must FAIL —
// and say so. A test that reported success here would be the exact failure
// this screen exists to rule out.
await click('Send test')
check('a test that could not be delivered says so',
  await waitFor(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.includes('Delivery failed')),
  t => t.includes('Delivery failed'))
check('…and does not mark the channel as tested',
  await evaluate(`document.getElementById('channel-rows')?.textContent ?? ''`),
  t => t.includes('never'))

// Attach it to the rule created above, from the alerts screen.
await goto('/alerts/')
check('a rule with no channel reports that it reaches nobody',
  await waitFor(`document.body.textContent`, t => t.includes('Delivers to')),
  t => t.includes('nobody'))

await evaluate(`
  (() => {
    const sel = [...document.querySelectorAll('select')].find(s => s.id.startsWith('attach-'))
    sel.value = [...sel.options].find(o => o.value)?.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
await sleep(400)
await click('Attach')
check('attaching a channel is reflected on the rule',
  await waitFor(`document.getElementById('alert-list')?.textContent ?? ''`, t => t.includes('Ops webhook')),
  t => t.includes('Ops webhook'))

// The refusal is the server's: a channel with a rule attached cannot be
// deleted. The mock made that call in the browser over an array it happened
// to have loaded.
await goto('/channels/')
check('…and the channel now counts the rule',
  await waitFor(`document.getElementById('channel-rows')?.textContent ?? ''`, t => t.includes('Ops webhook')),
  t => t.includes('Ops webhook'))
await click('Delete')
check('a channel a rule delivers through refuses to be deleted, in words',
  await waitFor(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.includes('detach')),
  t => t.includes('detach'))

// ── 13c-iii. Flags — a default, and a real environment overriding it ──
// The mock kept per-environment state in a map keyed by TIER NAME. That
// vocabulary already exists as `model Environment`, one row per environment
// per project, so the string would have meant every project sharing one
// "production" belonging to none of them. These checks are that an override
// points at the real row — and that the resolution rule lives in the service.
await goto('/flags/')
check('flags renders', await heading(), 'Feature flags')

await click('New flag')
await sleep(800)
await fill({ key: 'new-checkout-flow', description: 'One-page summary' })
await submit()
check('a flag is created',
  await waitFor(`
    (document.getElementById('flag-list')?.textContent ?? '')
    + (document.getElementById('screen-error')?.textContent ?? '')`,
    t => t.includes('new-checkout-flow')),
  t => t.includes('new-checkout-flow'))
// `type` and `isEnabled` were left untouched: both must arrive from the
// schema's own defaults. A String[] with `@default("[]")` used to reach the
// browser as `"default": "[]"` — a JSON Schema whose own default failed its
// own type check — so every create that omitted `tags` 400'd naming a field
// nobody sent.
check('…defaulting to off, and to boolean, from the schema',
  await evaluate(`document.getElementById('flag-list')?.textContent ?? ''`),
  t => t.includes('off by default') && t.includes('boolean'))

await click('Environments')
check('with no override, every environment follows the default',
  await waitFor(`document.getElementById('flag-list')?.textContent ?? ''`, t => t.includes('follows the default')),
  t => t.includes('follows the default'))

await evaluate(`
  (() => {
    const sel = [...document.querySelectorAll('select')].find(s => s.id.startsWith('env-'))
    sel.value = [...sel.options].find(o => o.value)?.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
// Assert the button followed the picker BEFORE clicking it. A disabled button
// swallows `.click()` silently, so without this a failure downstream cannot be
// told apart from a request that was made and refused — which is exactly the
// ambiguity `FJS-110` hid behind for a day.
check('the override button follows the picker',
  await waitFor(`(() => {
    const b = [...document.querySelectorAll('#flag-list button')]
      .find(x => x.textContent.trim() === 'Turn on here')
    return b ? String(b.disabled) : 'no button'
  })()`, v => v === 'false'), 'false')

await click('Turn on here')
check('an override names a real environment, not a tier',
  await waitFor(`
    (document.getElementById('flag-list')?.textContent ?? '')
    + (document.getElementById('screen-error')?.textContent ?? '')`,
    t => t.includes('override(s)')),
  t => t.includes('override(s)') && t.includes('Production'))

await click('Clear')
check('clearing it returns that environment to the default',
  await waitFor(`document.getElementById('flag-list')?.textContent ?? ''`, t => t.includes('follows the default')),
  t => t.includes('follows the default'))

await goto('/secrets/')
check('secrets renders', await heading(), 'Secrets')
await click('Add a secret')
await sleep(800)
await fill({ name: 'deploy-key', data: 'ssh-ed25519 AAAAC3NzaC1PLAINTEXTCANARY' })
await submit()
check('a secret is stored',
  await waitFor(`document.getElementById('secret-rows')?.textContent ?? ''`, t => t.includes('deploy-key')),
  t => t.includes('deploy-key') && t.includes('unverified'))

// The one that matters. Not "is it masked" — the key is ABSENT from the
// response, because @encrypted is enforced at the Data boundary.
check('the plaintext is nowhere on the page',
  await evaluate(`document.body.textContent.includes('PLAINTEXTCANARY')`), false)
check('…nor in what the API answers',
  await evaluate(`
    fetch('/secrets', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': ${JSON.stringify(secondWs.id)},
    }}).then(r => r.text()).then(t => t.includes('PLAINTEXTCANARY'))`),
  false)

// ── 13c-bis. API keys — the token this app ISSUES ─────────────────────
// Two halves, and the second is the one worth having. The screen is easy to
// check; what matters is that the token it hands you AUTHENTICATES A REQUEST
// and is refused everywhere it was not scoped for. Until 2026-08-09 it could
// not: @frontierjs/auth's verifySession never fell through to verifyApiKey, so
// createApiKey() succeeded and the key it returned was anonymous on every
// call. A screen that mints unusable tokens looks identical to one that works.
await goto('/api-keys/')
check('api keys render', await heading(), 'API keys')
check('the scope list comes from the server, not a copy in the page',
  await waitFor(`document.getElementById('new-key') ? '1' : ''`, t => t === '1'), '1')

await click('New key')
await sleep(800)
await fill({ name: 'ci-bot production' })
// Scope ids are the checkbox ids with the colon swapped — see the screen.
await evaluate(`
  (() => {
    for (const id of ['scope-servers-read', 'scope-projects-read']) {
      const el = document.getElementById(id)
      if (!el) throw new Error('no scope checkbox #' + id)
      el.click()
    }
  })()
`)
await submit()

const minted = await waitFor(
  `document.getElementById('minted-token')?.textContent?.trim() ?? ''`,
  t => t.startsWith('fjs_'))
check('the token is shown once, in full', minted, t => t.startsWith('fjs_') && t.length > 20)
check('…with a warning that it will not be shown again',
  await evaluate(`document.getElementById('minted-key')?.textContent ?? ''`),
  t => t.includes('shown once'))

// The list stores a hint, never the token. Asserted against the API as well as
// the page: a screen can mask what a response leaked.
check('the list shows a hint, not the key',
  await waitFor(`document.getElementById('key-rows')?.textContent ?? ''`, t => t.includes('ci-bot')),
  t => t.includes('ci-bot') && t.includes('…') && !t.includes(minted))
check('…and the API never answers the token again',
  await evaluate(`
    fetch('/api-keys', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': ${JSON.stringify(secondWs.id)},
    }}).then(r => r.text()).then(t => t.includes(${JSON.stringify(minted)}))`),
  false)

// ── the half that is not a screen ────────────────────────────────────
// Called with fetch rather than through apiCall(), because apiCall carries the
// SESSION token and the whole question here is what the KEY can do. Relative
// URLs, through vite's proxy — the page's own origin is :8020, so an absolute
// http://localhost:8120 is cross-origin and dies as `TypeError: Failed to
// fetch` with no status to assert on.
const asKey = (path, method = 'GET') => evaluate(`
  fetch(${JSON.stringify(path)}, {
    method: ${JSON.stringify(method)},
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer ' + ${JSON.stringify(minted)},
      'x-workspace-id': ${JSON.stringify(secondWs.id)},
    },
    ${method === 'GET' ? '' : 'body: JSON.stringify({ name: "from-a-key" }),'}
  }).then(r => r.status)
`)

check('the key authenticates a real request', await asKey('/servers'), 200)
check('a scope it does not hold is refused by name',
  await evaluate(`
    fetch('/secrets', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + ${JSON.stringify(minted)},
      'x-workspace-id': ${JSON.stringify(secondWs.id)},
    }}).then(r => r.json()).then(j => j.message)`),
  t => typeof t === 'string' && t.includes("'secrets:read' scope"))
check('read does not imply write', await asKey('/servers', 'POST'), 403)
check('a key cannot manage keys', await asKey('/api-keys'), 403)
check('a key cannot be pointed at another workspace',
  await evaluate(`
    fetch('/servers', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + ${JSON.stringify(minted)},
      'x-workspace-id': ${JSON.stringify(firstWs.id)},
    }}).then(r => r.status)`),
  403)

// Usage is attributed to the key, and only for what it was allowed to do —
// one allowed call above, four refusals.
check('usage is counted against the key that made the call',
  await waitFor(`
    fetch('/api-keys', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': ${JSON.stringify(secondWs.id)},
    }}).then(r => r.json()).then(j => String(j.data[0].totalUses))`,
    t => Number(t) >= 1),
  t => Number(t) === 1)

await goto('/api-keys/')
await click('Revoke')
check('revoking says so on the row',
  await waitFor(`document.getElementById('key-rows')?.textContent ?? ''`, t => t.includes('revoked')),
  t => t.includes('revoked'))
check('…and the token stops working immediately', await asKey('/servers'), 401)
check('a revoked key is still listed — revocation is a state, not a deletion',
  await evaluate(`document.getElementById('key-rows')?.textContent ?? ''`),
  t => t.includes('ci-bot'))

// ── 13c-ter. Volumes — the first thing here that is OBSERVED ─────────
// Every other model in this app is something a person created and Basecamp then
// acted on. A volume is the other direction, and that changes what is worth
// checking: not "can I make one" but "does the picture match the machine, and
// does deleting the record delete the disk".
//
// The server is gateway-01 in Skunkworks — the browser switched workspaces back
// in the switcher checks and that choice persists, so this is the workspace the
// screen is showing.
const REPORT = (volumes) => fetch(`http://localhost:${API_PORT}/volumes`, {
  method:  'POST',
  // No authorization header, deliberately. An outpost holds no session; if
  // `report` were not exempted from sessionScope this 401s, which is exactly
  // how every server check-in failed once.
  headers: { 'content-type': 'application/json', accept: 'application/json',
             'x-service-method': 'report' },
  body:    JSON.stringify({ server_id: serverId, volumes }),
}).then(r => r.json())

const created = await fetch(`http://localhost:${API_PORT}/volumes`, {
  method:  'POST',
  headers: { accept: 'application/json', authorization: `Bearer ${token}`,
             'content-type': 'application/json', 'x-workspace-id': secondWs.id },
  body:    JSON.stringify({ name: 'invented', serverId }),
})
check('a volume cannot be created — there is no disk to correspond to it', created.status, 405)

const report = await REPORT([
  { name: 'pg-data',     mountpoint: '/var/lib/docker/volumes/pg-data/_data',
    size_bytes: 5 * 1024 ** 3, in_use: true, containers: ['pg-data-svc'] },
  { name: 'build-cache', mountpoint: '/var/lib/docker/volumes/build-cache/_data',
    size_bytes: 2 * 1024 ** 3, in_use: false, containers: [] },
  { name: 'orphan-tmp',  mountpoint: '/var/lib/docker/volumes/orphan-tmp/_data',
    size_bytes: 100 * 1024 ** 2, in_use: false, containers: [] },
])
check('an outpost with no session can report what it found', report.added, 3)

await goto('/volumes/')
check('volumes render', await heading(), 'Volumes')
// Read the page, not the badge strip: when the strip is missing the failure
// message is the empty string, and the reason it is missing — a refusal in
// `#screen-error` — is the only thing worth printing.
check('the totals are the fleet\'s, not the page\'s',
  await waitFor(`document.body.textContent`, t => t.includes('3 volumes')),
  t => t.includes('3 volumes') && t.includes('1 in use') && t.includes('2 unused'))
// Bytes in the column, a sentence on the screen. 100 MB stored as 0.1 GB is a
// number nothing can un-round.
check('…and a size reads in the unit that suits it, from bytes',
  await evaluate(`document.getElementById('volume-list')?.textContent ?? ''`),
  t => t.includes('5.0 GB') && t.includes('100 MB'))

// The refusal that stops somebody deleting a database. Named containers, not a
// count — "stop the container first" is only actionable if it says which.
await evaluate(`[...document.querySelectorAll('#volume-list button')]
  .find(b => b.getAttribute('aria-label') === 'Delete pg-data').click()`)
check('a mounted volume refuses to be deleted, naming what holds it',
  await waitFor(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.includes('mounted by')),
  t => t.includes('pg-data-svc') && t.includes('stop the container first'))

// No outpost has registered yet: gateway-01's heartbeats have carried no URL. The
// row must SURVIVE, because forgetting it would leave the disk full and the
// fleet's picture wrong in the one direction nothing can detect.
await evaluate(`[...document.querySelectorAll('#volume-list button')]
  .find(b => b.getAttribute('aria-label') === 'Delete build-cache').click()`)
check('with no outpost to ask, the record is left alone and it says so',
  await waitFor(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.includes('outpost')),
  t => t.includes('No outpost is registered'))
check('…and the volume is still listed',
  await evaluate(`document.getElementById('volume-list')?.textContent ?? ''`),
  t => t.includes('build-cache'))

// Register the outpost, the only way one ever is: a heartbeat carrying a URL.
// gateway-01 is already online, so this exercises the half that used to sit
// inside the status transition and therefore never ran for a live machine.
await apiCall(`/servers/${serverId}`, {
  method: 'POST', workspace: secondWs.id,
  body: { outpost_version: '0.4.1', health: { cpu: 12, memory: 41 },
          outpost_url: `http://localhost:${OUTPOST_PORT}` },
  header: { 'x-service-method': 'heartbeat' },
})

await goto('/volumes/')
await evaluate(`[...document.querySelectorAll('#volume-list button')]
  .find(b => b.getAttribute('aria-label') === 'Delete build-cache').click()`)
check('with an outpost, the row goes',
  await waitFor(`document.getElementById('volume-list')?.textContent ?? ''`, t => !t.includes('build-cache')),
  t => !t.includes('build-cache'))
// The check that makes the one above mean anything. A remove that deleted the
// row without leaving the process looks identical from the browser.
check('…because the disk was deleted on the machine first',
  outpostSaw.deleted.join(','), 'build-cache')
check('…and the reclaimable total went down with it',
  await evaluate(`document.getElementById('volume-usage')?.textContent ?? ''`),
  t => t.includes('2 volumes') && t.includes('1 unused'))

await click('Prune unused')
check('prune says how many it took',
  await waitFor(`document.querySelector('.toast-stack')?.textContent ?? ''`, t => t.includes('Pruned')),
  t => t.includes('Pruned 1 volume(s)'))
check('…having asked the outpost, and forgotten only what it confirmed',
  outpostSaw.pruned.join(','), 'orphan-tmp')
check('…leaving nothing reclaimable',
  await waitFor(`document.getElementById('volume-usage')?.textContent ?? ''`, t => t.includes('0 unused')),
  t => t.includes('1 volumes') && t.includes('0 unused'))

// A report is the whole truth about one machine at one moment, so a volume
// missing from it is a volume that no longer exists. Nothing here reloads: the
// report published to the workspace channel and the open page took the push,
// which is the whole reason an outpost endpoint announces at all.
const second = await REPORT([
  { name: 'pg-data', size_bytes: 6 * 1024 ** 3, in_use: true, containers: ['pg-data-svc'] },
  { name: 'metrics', size_bytes: 512 * 1024 ** 2, in_use: false, containers: [] },
])
check('a report adds what is new', second.added, 1)
check('a new disk appears with no reload',
  await waitFor(`document.getElementById('volume-list')?.textContent ?? ''`, t => t.includes('metrics')),
  t => t.includes('metrics'))

await REPORT([{ name: 'pg-data', size_bytes: 6 * 1024 ** 3, in_use: true, containers: ['pg-data-svc'] }])
// Reloaded, not watched. The push arrives and the screen starts its reload, and
// that reload does not settle. There is deliberately no `goto` here: this reads
// whatever the PUSH-DRIVEN reload produced, so the live path is asserted rather
// than stepped around. It used to navigate first, which made the check pass
// whether or not the reload ever settled — and that is what let `FJS-139` sit
// open with the only reproduction of it masked by the test that found it.
// Read the whole page, not `#volume-list`: an empty list renders an EmptyState
// and no list at all, so scoping the read to the list cannot tell "the row went"
// from "everything went".
check('…and one the machine no longer has is forgotten',
  await waitFor(`document.body.textContent`, t => t.includes('pg-data')),
  t => !t.includes('metrics') && t.includes('pg-data'))

// Only pg-data is left and it is mounted, so filtering to unused must empty the
// screen. Asserted on the EMPTY STATE rather than on the absence of a name: a
// screen still saying "Loading…" also lacks the name, and would pass a check
// written the other way round while proving nothing.
await evaluate(`[...document.querySelectorAll('#volume-filters button')]
  .find(b => b.textContent.trim() === 'Unused').click()`)
check('the unused filter is the service\'s answer, not the browser\'s',
  await waitFor(`document.body.textContent`, t => t.includes('No volumes')),
  t => t.includes('No volumes') && !t.includes('/var/lib/docker/volumes/pg-data'))

// ── 13c-quater. Dashboards — a vocabulary, not a stored query ────────
// The phase's whole question was whether a widget's data source is declared or
// free-form. It is declared, so what is worth checking is the two halves of
// that: the picker cannot offer a kind the service would refuse, and a widget
// cannot be made to carry a query even by a caller that does not use the UI.
//
// The browser is in Skunkworks here — the workspace the volumes checks left it
// in — which is the one with `gateway-01` in it, so the subject checks below
// have a real server to point at.

await goto('/dashboards/')
check('dashboards render', await heading(), 'Dashboards')

await click('New dashboard')
await sleep(800)
await fill({ name: 'Ops overview', description: 'morning check' })
await submit()
check('creating a board opens it',
  await waitFor(`location.pathname`, p => p.startsWith('/dashboards/') && p !== '/dashboards/'),
  p => /^\/dashboards\/[0-9a-f-]+\/$/.test(p))
const boardPath = await path()
check('and the board is named on its own screen', await heading(), t => t.includes('Ops overview'))

await click('Add widget')
await sleep(800)
// Nine, and from the SERVICE: the picker is built from the `kinds` action, so a
// kind that exists in the schema and not in the service — or the other way
// round — cannot be offered. A hardcoded list in the bundle would pass this
// check while being exactly the drift it is here to catch.
check('the picker is the service\'s own vocabulary',
  await evaluate(`document.querySelectorAll('#widget-kinds button').length`), 9)

const pick = label => evaluate(`
  [...document.querySelectorAll('#widget-kinds button')]
    .find(b => b.textContent.includes(${JSON.stringify(label)})).click()`)

await pick('Server fleet')
await sleep(500)
await click('Add to dashboard')
check('a widget is added and renders its own data',
  await waitFor(`document.getElementById('widget-grid')?.textContent ?? ''`, t => t.includes('Server fleet')),
  t => t.includes('Server fleet') && t.includes('gateway-01'))

// A kind with a required subject, added with none. The refusal is the
// service's, in words — the screen does not pre-empt it, because which kinds
// need a subject is not a fact the browser owns.
await click('Add widget')
await sleep(600)
await pick('Server health')
await sleep(500)
await click('Add to dashboard')
check('a widget that needs a subject says so rather than being placed',
  await waitFor(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.includes('needs a server')),
  t => t.includes('needs a server'))

await evaluate(`
  (() => {
    const sel = document.getElementById('widget-subject')
    sel.value = [...sel.options].find(o => o.value)?.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
await sleep(400)
await click('Add to dashboard')
check('…and placed once it has one, with the subject named on the card',
  await waitFor(`document.getElementById('widget-grid')?.textContent ?? ''`, t => t.includes('Server health')),
  t => t.includes('Server health') && t.includes('gateway-01'))
// The card says what it cannot show. `Server.health` is the last heartbeat, not
// a series, and the sentence comes from the service's vocabulary rather than
// from the component — so it changes when the gap closes, in one place.
check('a thin card states what is missing instead of drawing it',
  await evaluate(`document.getElementById('widget-grid')?.textContent ?? ''`),
  t => t.includes('metric store'))

// A counter counts. The mock's version is a number typed in when the widget is
// added, which is a dashboard displaying whatever it was told.
await click('Add widget')
await sleep(600)
await pick('Counter')
await sleep(500)
await click('Add to dashboard')
const fleetSize = (await apiCall('/servers', { workspace: secondWs.id })).total
check('a counter reads a real total, not a value typed into the widget',
  await waitFor(`document.getElementById('widget-grid')?.textContent ?? ''`, t => t.includes('Servers')),
  t => t.includes(String(fleetSize)))

// The picker cannot express a query — so this is asked of the API directly,
// the way a caller who skipped the UI would. Both halves matter: an unknown
// kind, and a config key nothing reads. A widget accepting either is a stored
// read that no policy graded.
const boardId = boardPath.split('/').filter(Boolean)[1]
const refuse = (body) => fetch(`http://localhost:${API_PORT}/dashboards/${boardId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json',
             authorization: `Bearer ${token}`, 'x-workspace-id': secondWs.id,
             'x-service-method': 'addWidget' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.text() }))

const badKind = await refuse({ kind: 'sql_query' })
check('a kind outside the vocabulary is refused, and named', badKind.status, 400)
check('…with the vocabulary in the message', badKind.body, t => t.includes('server_fleet'))

const badConfig = await refuse({ kind: 'stat_counter', config: { source: 'servers', where: '1=1' } })
check('a widget cannot be given a query to run', badConfig.status, 400)
check('…and the key it refused is named', badConfig.body, t => t.includes('where'))

// Layout is the board's, and reordering rewrites every position rather than
// swapping two — so the check is that the first card CHANGED, which a partial
// write would leave alone.
await goto(boardPath)
await click('Edit layout')
await sleep(500)
const firstBefore = await evaluate(`document.querySelector('#widget-grid h2')?.textContent.trim() ?? ''`)
await evaluate(`[...document.querySelectorAll('#widget-grid button')]
  .find(b => (b.getAttribute('aria-label') ?? '').startsWith('Move') && b.textContent.trim() === '→').click()`)
check('reordering moves the card',
  await waitFor(`document.querySelector('#widget-grid h2')?.textContent.trim() ?? ''`, t => t && t !== firstBefore),
  t => t !== firstBefore)

// ── 13d. Activity — the trail as a narrative ─────────────────────────
// The point of this check is not the table. It is that the trail now records
// ACTIONS: before 2026-08-06 the audit hook ran on create/patch/remove only,
// so draining a server — the operator verb — was recorded nowhere.
await goto('/activity/')
check('the activity feed renders', await heading(), 'Activity')
check('the trail records custom actions, not only CRUD',
  await waitFor(`document.getElementById('activity-rows')?.textContent ?? ''`, t => t.includes('drain')),
  t => t.includes('drain'))
check('…and an actor id is resolved to a person',
  await evaluate(`document.getElementById('activity-rows')?.textContent ?? ''`),
  t => t.includes('sam@example.com') || t.includes('Sam'))

// Two sources, one feed. `AuditEvent` is what people did; `ServerEvent` is what
// the machines did — and until `servers.feed` landed the second was readable
// per-server only, so a fleet view meant one request per server merged in the
// browser (`FJS-104`). The drain above wrote both: an audit row for the person
// and a server event for the transition.
check('the fleet\'s own events are in the feed, not only the human trail',
  await waitFor(`document.getElementById('activity-rows')?.textContent ?? ''`, t => t.includes('outpost')),
  t => t.includes('outpost'))

const kindCount = await evaluate(`document.querySelectorAll('#activity-kinds button').length`)
check('the kind filter is built from what happened, not declared', kindCount, n => n > 1)
await evaluate(`[...document.querySelectorAll('#activity-kinds button')].find(b => b.textContent.trim() === 'servers').click()`)
await sleep(600)
check('filtering to one kind drops the others',
  await evaluate(`document.getElementById('activity-rows')?.textContent ?? ''`),
  t => t.includes('servers') && !t.includes('projects'))

// Delete the project, which cascades in the schema.
await goto(projectPath)
await click('Delete')
await sleep(2500)
check('deleting returns to the list', await path(), '/projects/')
check('and the project is gone',
  await evaluate(`document.getElementById('project-rows')?.textContent ?? ''`),
  t => !t.includes('Checkout rewrite'))

// ── 13e. Recipes and reclaim — the two ways to act on a machine ──────
// One screen runs arbitrary code and one names declared targets, and the pair
// is the phase. What is worth checking is therefore not "does a row appear" but
// the two things a database read cannot see: that a MACHINE was actually asked,
// and with what.
//
// The browser is in Skunkworks — the workspace the volumes checks left it in —
// where `gateway-01` has a registered outpost and the sink above is answering as
// it. That is what makes both screens reachable without inventing a second one.

await goto('/recipes/')
check('recipes render', await heading(), 'Recipes')

// The refusal comes from the SCHEMA, in the browser, before a request is made:
// `script` is required on Recipe, and createResource validates by default.
await click('New recipe')
await sleep(600)
await fill({ name: 'Nameless', description: 'no script at all' })
await submit()
await sleep(800)
// Refused by the SCHEMA, in the browser, before a request is made. The message
// is the length rule rather than "required" because `make()` seeds every field
// — an empty string is present, so `script @length(1, 20000)` is what catches
// it, and that is the sentence a person sees.
// The kit renders a field's message as `.field-hint.danger` with role=alert —
// there is no `.field-error` class, which is worth knowing before writing a
// selector against a form anywhere in this app.
check('a recipe with no script is refused before the request is made',
  await evaluate(`[...document.querySelectorAll('[role=alert]')].map(e => e.textContent.trim()).join(' | ')`),
  t => t.includes('script'))

await fill({ script: '#!/bin/bash\ndf -h /\n' })
await submit()
check('a recipe is saved and listed',
  await waitFor(`document.getElementById('recipe-list')?.textContent ?? ''`, t => t.includes('Nameless')),
  t => t.includes('Nameless'))

// A machine with no outpost is refused AT THE CLICK, naming the machine — not
// queued and failed a minute later where nobody is looking.
const outpostless = await apiCall('/servers', {
  method: 'POST', workspace: secondWs.id, body: { name: 'no-outpost-01' },
})
await goto('/recipes/')
await evaluate(`(() => {
  const sel = document.getElementById('run-target')
  sel.value = ${JSON.stringify(outpostless.id)}
  sel.dispatchEvent(new Event('input',  { bubbles: true }))
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
await evaluate(`[...document.querySelectorAll('#recipe-list button')]
  .find(b => b.getAttribute('aria-label') === 'Run Nameless').click()`)
check('running on a machine with no outpost is refused, naming it',
  await waitFor(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.includes('outpost')),
  t => t.includes('no-outpost-01') && t.includes('No outpost is registered'))

// Now the machine that has one. The queue carries it, the engine sends it, and
// the run row fills in from a channel push with nothing polling.
await goto('/recipes/')
await evaluate(`(() => {
  const sel = document.getElementById('run-target')
  sel.value = ${JSON.stringify(serverId)}
  sel.dispatchEvent(new Event('input',  { bubbles: true }))
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
await evaluate(`[...document.querySelectorAll('#recipe-list button')]
  .find(b => b.getAttribute('aria-label') === 'Run Nameless').click()`)
check('a run finishes and the exit code is on screen',
  await waitFor(`document.getElementById('recipe-runs')?.textContent ?? ''`, t => t.includes('success')),
  t => t.includes('success') && t.includes('gateway-01'))
// The check that makes the one above mean anything: a run row saying success
// proves the engine wrote a row, not that any machine was asked.
check('…because the script really reached the outpost',
  outpostSaw.ran.join('|'), t => t.includes('df -h /'))
check('…and its output is the machine\'s, not the recipe\'s text',
  await evaluate(`document.getElementById('recipe-detail')?.textContent ?? ''`),
  t => t.includes('/dev/vda1'))

// The one property that survives editing: a run keeps the script it ran, so
// output and script cannot silently stop matching. Asked of the API because the
// screen shows the recipe's current text — which is the point.
const recipeId = await evaluate(`(async () => {
  const res = await fetch('/recipes', { headers: {
    accept: 'application/json',
    authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
    'x-workspace-id': ${JSON.stringify(secondWs.id)},
  }})
  const j = await res.json()
  return j.data.find(r => r.name === 'Nameless').id
})()`)
await apiCall(`/recipes/${recipeId}`, {
  method: 'PATCH', workspace: secondWs.id, body: { script: '#!/bin/bash\nrm -rf /tmp/nothing\n' },
})
// A single read unwraps its envelope and a list keeps one, so this is the row
// itself — `.data` here is the LIST shape and would be undefined.
const kept = await apiCall(`/recipes/${recipeId}`, { workspace: secondWs.id })
check('editing a recipe does not rewrite what already ran',
  kept.runs[0].script, t => t.includes('df -h /'))

// ── The declared half ────────────────────────────────────────────────
await goto('/cleanup/')
check('disk cleanup renders', await heading(), 'Disk cleanup')
// From the service, not the bundle: the checkboxes are the `targets` action's
// answer, so this screen cannot offer something the API would refuse.
check('the targets are the service\'s own vocabulary',
  await evaluate(`document.querySelectorAll('#cleanup-targets input[type=checkbox]').length`), 5)
check('…and the one that destroys data is off by default',
  await evaluate(`[...document.querySelectorAll('#cleanup-targets label')]
    .find(l => l.textContent.includes('Unused volumes'))?.querySelector('input').checked`), false)
check('a machine that has never reported says so, rather than showing zeroes',
  await evaluate(`document.getElementById('cleanup-list')?.textContent ?? ''`),
  t => t.includes('never reported'))

// The outpost's endpoint — no session, like the volume report and the heartbeat.
const disk = await fetch(`http://localhost:${API_PORT}/cleanup`, {
  method:  'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json',
             'x-service-method': 'report' },
  body: JSON.stringify({
    server_id: serverId,
    images:      { total: 58, unused: 9, dangling: 22, size_bytes: 18 * 1024 ** 3, reclaimable_bytes: 9 * 1024 ** 3 },
    containers:  { running: 1, stopped: 2, reclaimable_bytes: 40 * 1024 ** 2 },
    build_cache: { size_bytes: 8 * 1024 ** 3, reclaimable_bytes: 8 * 1024 ** 3 },
  }),
})
check('an outpost with no session can report a disk', disk.status, 200)

await goto('/cleanup/')
check('the figures on screen are the ones Docker measured',
  await waitFor(`document.getElementById('cleanup-list')?.textContent ?? ''`, t => t.includes('58 images')),
  t => t.includes('22 dangling') && t.includes('2 stopped'))

// Both image targets draw on ONE reclaimable figure, and Docker reports no
// split. Ticking the second must not double the estimate — the mock added
// invented per-category numbers and would have promised twice what a sweep
// could deliver.
const estimateBefore = await evaluate(`document.getElementById('cleanup-list')?.textContent ?? ''`)
await evaluate(`[...document.querySelectorAll('#cleanup-targets input[type=checkbox]')][0].click()`)
await sleep(400)
check('two image targets do not add up to twice the images',
  await evaluate(`document.getElementById('cleanup-list')?.textContent ?? ''`),
  t => t.match(/(\d+\.\d) GB by these targets/)?.[1] === estimateBefore.match(/(\d+\.\d) GB by these targets/)?.[1])

await evaluate(`[...document.querySelectorAll('#cleanup-list button')]
  .find(b => b.getAttribute('aria-label') === 'Clean gateway-01').click()`)
check('a sweep records what the machine says it freed',
  await waitFor(`document.getElementById('cleanup-history')?.textContent ?? ''`, t => t.includes('3.0 GB')),
  t => t.includes('3.0 GB') && t.includes('success'))
check('…having asked the outpost for exactly the targets that were ticked',
  outpostSaw.swept.join('|'), t => t.includes('unused_images') && !t.includes('unused_volumes'))
// The outpost answers a fresh picture with what it freed, written through the
// same path the report endpoint uses — so the screen is not left showing what
// was there before the sweep.
check('…and the picture is the one the outpost left behind',
  await waitFor(`document.getElementById('cleanup-summary')?.textContent ?? ''`, t => t.includes('0 B')),
  t => t.includes('0 B reclaimable'))

// Two refusals the UI never offers, asked of the API directly.
const unknownTarget = await fetch(`http://localhost:${API_PORT}/cleanup`, {
  method: 'POST',
  headers: { accept: 'application/json', authorization: `Bearer ${token}`,
             'content-type': 'application/json', 'x-workspace-id': secondWs.id,
             'x-service-method': 'run' },
  body: JSON.stringify({ serverId, targets: ['everything'] }),
})
check('a target outside the vocabulary is refused by name', unknownTarget.status, 400)
check('…and the refusal says what it does know',
  await unknownTarget.text(), t => t.includes('everything') && t.includes('dangling_images'))

const inventedRun = await fetch(`http://localhost:${API_PORT}/cleanup`, {
  method: 'POST',
  headers: { accept: 'application/json', authorization: `Bearer ${token}`,
             'content-type': 'application/json', 'x-workspace-id': secondWs.id },
  body: JSON.stringify({ serverId, status: 'success', freedBytes: 999 }),
})
check('a sweep that never happened cannot be recorded from the wire', inventedRun.status, 405)

// ── 13f. The platform hub — the one tier that is not a workspace ──────
//
// Everything else in this file is scoped to a workspace by a header. These
// four screens are not: they read across every tenant behind `isSystemAdmin`,
// a column on User, and the whole point of the section is that the flag is
// enforced on the SERVER — the topbar link and the router redirect are
// affordances that could both be deleted without changing who can read what.
//
// The section leaves the world as it found it: both suspensions are undone
// before the a11y pass, which drives every screen as this same user.

await goto('/hub/')
check('the hub opens', await heading(), 'Platform hub')
check('the shell offers it to a system administrator',
  await evaluate(`[...document.querySelectorAll('.topbar .navlink')].map(a => a.textContent.trim()).join('|')`),
  t => t.includes('Hub'))

// Read at request time from the things that own them — SQLite for its own
// version, Caravan for the queues. Nothing here is stored, so there is nothing
// that can be stale.
check('the runtime is measured, not declared',
  await evaluate(`document.getElementById('hub-runtime')?.textContent ?? ''`),
  t => /\d+\.\d+/.test(t) && t.includes('basecamp.db'))
check('every configured queue is listed, including the one added last',
  await evaluate(`document.getElementById('hub-queues')?.textContent ?? ''`),
  t => t.includes('fleet') && t.includes('deployments'))
// The subscriber count is real now — IEventBus.stats() (FJS-143). It was the
// second thing this card could not measure; CPU is the one that remains, and
// the screen still says so rather than printing a plausible number.
check('the event-bus subscriber count is measured',
  await evaluate(`document.getElementById('hub-stats')?.textContent ?? ''`),
  t => /\d+ event subscribers/.test(t))
check('…and the figure that cannot be measured still says so',
  await evaluate(`document.body.textContent`),
  t => t.includes('CPU') && t.includes('not measured'))

// ── Workspaces: a cross-tenant read the workspaces service refuses to do ──
await goto('/hub/workspaces/')
check('every tenant is listed, not the caller\'s memberships',
  await evaluate(`document.getElementById('hub-workspace-rows')?.textContent ?? ''`),
  t => t.includes('Acme') && t.includes('Skunkworks'))
check('…with the counts nothing else joins up',
  await evaluate(`document.getElementById('hub-ws-stats')?.textContent ?? ''`),
  t => t.includes('2 workspaces') && t.includes('2 active'))

// Suspension is the action worth proving, and proving it means proving it bites
// somewhere else: a status column nothing reads is a button that reports
// success and revokes nothing.
await evaluate(`[...document.querySelectorAll('#hub-workspace-rows button')]
  .find(b => b.getAttribute('aria-label') === 'Suspend Skunkworks').click()`)
check('suspending a workspace is visible where it was done',
  await waitFor(`document.getElementById('hub-ws-stats')?.textContent ?? ''`, t => t.includes('1 suspended')),
  t => t.includes('1 suspended'))

let suspendedRead = null
try {
  await apiCall('/projects', { workspace: secondWs.id })
  suspendedRead = 'answered'
} catch (e) { suspendedRead = String(e.message) }
check('…and a suspended workspace is refused by every scoped service',
  suspendedRead, t => t.includes('403') && t.includes('suspended'))
check('…while the hub itself stays reachable',
  (await apiCall('/hub', { method: 'POST', header: { 'x-service-method': 'overview' } })).runtime.pid,
  n => Number.isInteger(n))

await evaluate(`[...document.querySelectorAll('#hub-workspace-rows button')]
  .find(b => b.getAttribute('aria-label') === 'Reinstate Skunkworks').click()`)
check('reinstating gives it back',
  await waitFor(`(async () => {
    const r = await fetch('/projects', { headers: { accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': ${JSON.stringify(secondWs.id)} } })
    return r.status
  })()`, s => s === 200), 200)

// ── Users and bots ───────────────────────────────────────────────────
await goto('/hub/users/')
check('the actor list is there',
  await evaluate(`document.getElementById('hub-user-rows')?.textContent ?? ''`),
  t => t.includes(ACCOUNT.email))
// /setup is the only place a system administrator is CREATED rather than
// granted — without it the tier would exist and nobody could ever reach it.
check('the bootstrap user is the first system administrator',
  await evaluate(`document.getElementById('hub-user-rows')?.textContent ?? ''`),
  t => t.includes('sysadmin'))
check('…and is not offered a way to lock themselves out',
  await evaluate(`document.getElementById('hub-user-rows')?.textContent ?? ''`),
  t => t.includes('you'))

await evaluate(`document.getElementById('new-bot').click()`)
await sleep(400)
await fill({ 'bot-name': 'CI deploy' })
// The workspace is CHOSEN, not left at the form's default — the picker is
// ordered newest-first, so the default is Skunkworks, and a bot in the wrong
// tenant fails later as "not a member of this workspace" rather than here.
await evaluate(`(() => {
  const sel = document.getElementById('bot-ws')
  const opt = [...sel.options].find(o => o.textContent.trim() === 'Acme')
  if (!opt) throw new Error('no Acme in the bot workspace picker')
  sel.value = opt.value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
await evaluate(`document.getElementById('create-bot').click()`)
check('a bot account can be created',
  await waitFor(`document.getElementById('hub-user-rows')?.textContent ?? ''`, t => t.includes('CI deploy')),
  t => t.includes('CI deploy'))
// RFC 2606 reserves .invalid, so the address resolves nowhere — `User.email`
// is required and unique, and a plausible one would eventually be mailed.
check('…at an address that can never receive mail',
  await evaluate(`document.getElementById('hub-user-rows')?.textContent ?? ''`),
  t => t.includes('ci-deploy@bots.invalid'))

// The gap this closes, recorded in api-keys.service.ts since Phase 6: a key
// belonged to whoever pressed the button, so CI's key was a person's key.
const botId = (await apiCall('/hub', { method: 'POST', header: { 'x-service-method': 'users' } }))
  .data.find(u => u.kind === 'bot').id
const botKey = await apiCall('/api-keys', {
  method: 'POST', workspace: firstWs.id,
  body: { name: 'ci-pipeline', userId: botId, scopes: ['servers:read'] },
})
check('a key can now belong to a bot rather than to a person', botKey.userId, botId)

let humanKey = null
try {
  await apiCall('/api-keys', {
    method: 'POST', workspace: firstWs.id,
    body: { name: 'not-mine', userId: firstWs.ownerId + 'x', scopes: ['servers:read'] },
  })
  humanKey = 'accepted'
} catch (e) { humanKey = String(e.message) }
check('…and only to a bot — naming anyone else is refused',
  humanKey, t => t.includes('400') && t.includes('bot account'))

// A bot with the run of every tenant is a credential, not a revocable human.
let botAdmin = null
try {
  await apiCall('/hub', {
    method: 'POST', header: { 'x-service-method': 'setSystemAdmin' },
    body: { userId: botId, isSystemAdmin: true },
  })
  botAdmin = 'accepted'
} catch (e) { botAdmin = String(e.message) }
check('a bot cannot be made a system administrator', botAdmin, t => t.includes('403'))

// ── Suspension of a person, at the door they come in through ─────────
// Done at the API rather than through the screen because it needs a SECOND
// human, and the browser is signed in as the first — swapping sessions costs
// two logins against auth's 10-per-15-minutes limit, which every later check
// then pays for.
const pat = await fetch(`http://localhost:${API_PORT}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ email: 'pat@example.com', name: 'Pat', password: 'hunter2hunter2' }),
}).then(r => r.json())

const patLogin = () => fetch(`http://localhost:${API_PORT}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ email: 'pat@example.com', password: 'hunter2hunter2' }),
})
check('a second human can sign in', (await patLogin()).status, 200)

// `User.status` was a free String nothing read until this phase — @frontierjs/auth
// never looks at it, so "suspended" was a word with no enforcement anywhere.
await apiCall('/hub', {
  method: 'POST', header: { 'x-service-method': 'setUserStatus' },
  body: { userId: pat.user.userId, status: 'suspended' },
})
const refused = await patLogin()
check('a suspended account cannot sign in', refused.status, 403)
check('…and is told why, rather than reading as a wrong password',
  await refused.text(), t => t.includes('suspended'))

// The token issued BEFORE the suspension is the other half: deleting the
// Session rows does not cover an API key, which is a Credential.
const stale = await fetch(`http://localhost:${API_PORT}/workspaces`, {
  headers: { accept: 'application/json', authorization: `Bearer ${pat.token}` },
})
check('…and a token issued before it stops working too', stale.status, s => s === 401 || s === 403)

await apiCall('/hub', {
  method: 'POST', header: { 'x-service-method': 'setUserStatus' },
  body: { userId: pat.user.userId, status: 'active' },
})
check('restoring lets them back in', (await patLogin()).status, 200)

// The tier is enforced on the server. Everything above ran as a sysadmin; this
// is the same API asked by somebody who is not one.
const patToken = await patLogin().then(r => r.json()).then(r => r.token)
const patHub = await fetch(`http://localhost:${API_PORT}/hub`, {
  method:  'POST',
  headers: { accept: 'application/json', authorization: `Bearer ${patToken}`,
             'x-service-method': 'overview' },
})
// 404, not 403: the hub is not a screen somebody is being refused, it is a
// surface they have no business knowing exists.
check('the hub is invisible to a non-administrator', patHub.status, 404)

// ── The gate ladder, asked of somebody who is not a sysadmin ──────────
//
// Everything above ran as the setup user, who is `isSystemAdmin` and therefore
// SYSADMIN(7) — a level that clears every gate in the schema. So none of it
// proves a gate; it proves the app still works with gates on. This section is
// the other half, and it is the only place the ladder is exercised at all.
//
// Pat is a real second human with no standing anywhere. What each refusal
// below is coming FROM matters:
//
//   POST /servers   the role hook AND @@gate("2.4.4.5") both refuse a viewer
//   GET  /secrets   ONLY @@gate("5") refuses — the secrets service has no role
//                   hook on find, so before this landed a viewer could list
//                   every secret in the workspace
//
// The second is why this is worth the requests: it fails if `memberRole` never
// reaches the principal, which is the one thing no unit test can see.

const asPat = (path, opts = {}) => fetch(`http://localhost:${API_PORT}${path}`, {
  method:  opts.method ?? 'GET',
  headers: {
    accept: 'application/json', authorization: `Bearer ${patToken}`,
    'x-workspace-id': opts.workspace ?? firstWs.id,
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
  },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
})

check('a non-member is refused the workspace outright', (await asPat('/servers')).status, 403)

await apiCall(`/workspaces/${firstWs.id}`, {
  method: 'POST', header: { 'x-service-method': 'addMember' },
  body:   { userId: pat.user.userId, role: 'viewer' },
})

check('a viewer reads the fleet',          (await asPat('/servers')).status, 200)
check('…and creates nothing',              (await asPat('/servers', { method: 'POST', body: { name: 'nope', hostname: 'nope.example' } })).status, 403)

const viewerSecrets = await asPat('/secrets')
check('…and cannot list secrets', viewerSecrets.status, 403)
// Naming the level is what makes this check about the GATE. A 403 alone would
// also be what a role hook answers, and the point of this one is that there is
// no role hook on secrets.find — the schema is the only thing refusing.
check('…refused by a level, which is the schema talking',
  await viewerSecrets.text(), t => t.includes('requires level 5'))

await apiCall(`/workspaces/${firstWs.id}`, {
  method: 'POST', header: { 'x-service-method': 'setMemberRole' },
  body:   { userId: pat.user.userId, role: 'developer' },
})

check('promoting to developer opens the write',
  (await asPat('/projects', { method: 'POST', body: { name: 'Pat project', slug: 'pat-project' } })).status, 201)
check('…and secrets stay shut at the Data boundary', (await asPat('/secrets')).status, 403)

// The standing is per workspace, not per person: the same token, one header
// apart. Without applyStanding re-resolving, a developer here would be a
// developer everywhere they can name.
check('standing does not travel to another workspace',
  (await asPat('/servers', { workspace: secondWs.id })).status, 403)

// ── Flags at hub scope ───────────────────────────────────────────────
await goto('/hub/flags/')
// The flag was authored above while the switcher was on Skunkworks, and the
// workspace it belongs to is named on the row — which is the whole reason this
// screen exists. Reading it across tenants is useless if you cannot tell whose
// killswitch you are about to flip.
check('a workspace-scoped model, read across every tenant',
  await evaluate(`document.getElementById('hub-flag-groups')?.textContent ?? ''`),
  t => t.includes('new-checkout-flow') && t.includes('Skunkworks'))
// Grouped by the prefix convention in the key. A flag that follows none is in
// `ungrouped` rather than dropped — the convention is a grouping, not a filter.
check('…grouped by the convention in the key, with a home for keys that follow none',
  await evaluate(`document.getElementById('hub-flag-groups')?.textContent ?? ''`),
  t => t.includes('ungrouped'))

const flagBefore = await evaluate(`document.getElementById('hub-flag-groups')?.textContent ?? ''`)
await evaluate(`[...document.querySelectorAll('#hub-flag-groups button')][0].click()`)
check('toggling one from the hub changes the flag\'s own default',
  await waitFor(`document.getElementById('hub-flag-groups')?.textContent ?? ''`, t => t !== flagBefore),
  t => t !== flagBefore)

// ── 14. Accessibility, on every screen ────────────────────────────────
// The app detail screen is a dynamic route, so it is audited by its captured
// path after the static loop rather than being left out of the pass.
// Not a substitute for using the thing with a keyboard and a screen reader —
// it is the subset a machine can settle, run everywhere so a new screen cannot
// quietly drop a label or a table header.
//
// The skip link is here because it was missing from every page: without it a
// keyboard user tabs through the nav, the workspace switcher and sign-out on
// EVERY navigation before reaching the content.
const AUDIT = `(() => {
  const out = []
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const labelled = (el.id && document.querySelector('label[for="' + el.id + '"]'))
      || el.closest('label') || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
    if (!labelled) out.push('control without a name: ' + (el.id || el.className))
  }
  for (const th of document.querySelectorAll('th'))
    if (!th.getAttribute('scope')) out.push('th without scope: ' + th.textContent.trim().slice(0, 20))
  const hs = [...document.querySelectorAll('h1,h2,h3,h4')].map(h => +h.tagName[1])
  if (hs.filter(n => n === 1).length !== 1) out.push('h1 count = ' + hs.filter(n => n === 1).length)
  for (let i = 1; i < hs.length; i++)
    if (hs[i] - hs[i - 1] > 1) out.push('heading jumps h' + hs[i - 1] + ' to h' + hs[i])
  for (const el of document.querySelectorAll('button, a'))
    if (!el.textContent.trim() && !el.getAttribute('aria-label'))
      out.push('control with no text: ' + el.outerHTML.slice(0, 40))
  if (!document.querySelector('.skip-link')) out.push('no skip link')
  if (!document.querySelector('main'))       out.push('no <main> landmark')
  return out
})()`

for (const route of [appDetailPath, boardPath, '/', '/dashboards/', '/projects/', '/projects/create/', '/servers/', '/servers/create/',
                     '/deployments/', '/jobs/', '/networks/', '/volumes/', '/cleanup/', '/recipes/',
                     '/alerts/', '/channels/', '/flags/', '/secrets/',
                     '/api-keys/', '/activity/', '/portal/',
                     '/admin/', '/admin/audit/', '/admin/adapters/',
                     '/hub/', '/hub/workspaces/', '/hub/users/', '/hub/flags/']) {
  await goto(route)
  const issues = await evaluate(AUDIT)
  check(`a11y: ${route}`, Array.isArray(issues) ? issues.join(' | ') : String(issues), '')
}

check('no uncaught page errors', await evaluate('JSON.stringify(window.__errs ?? [])'), '[]')

if (process.env.FJS_SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(process.env.FJS_SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log(`\n  screenshot → ${process.env.FJS_SHOT}`)
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`)
await cleanup()
process.exit(failed.length ? 1 : 0)
