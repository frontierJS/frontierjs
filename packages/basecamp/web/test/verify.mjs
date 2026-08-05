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
 * step timeline; the server fleet, its custom methods and the agent heartbeat;
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
const API_PORT = 3001
const WEB_PORT = 5274
const CDP_PORT = 9333
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

for (const [port, who] of [[API_PORT, 'API'], [WEB_PORT, 'web']]) {
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
await rm(PROFILE, { recursive: true, force: true })
children.push(spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800',
  'about:blank',
], { stdio: 'ignore' }))

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    target = list.find(t => t.type === 'page')
    if (target) break
  } catch {}
  await sleep(250)
}
if (!target) fail(`No Chrome debug target on :${CDP_PORT}. Is ${CHROME} installed? Set $FJS_CHROME.`)

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
await sleep(3500)

check('setup lands on home', await path(), '/')
check('signed in as the new user', await evaluate('document.body.textContent'), t => t.includes(ACCOUNT.email))
// The workspace tile names the workspace the page is scoped to. Empty or
// 'none' means /auth/workspace answered nothing and every scoped request from
// here would 400.
check('workspace resolved', await badges(), t => t.includes('acme'))
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
check('login lands on home', await path(), '/')
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
    const m = await import('/src/resources/deployments.mesa')
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

// The agent's own endpoint — no session, authenticated at the transport, and
// the only path in the app a machine uses. Bringing the server online this way
// is also what makes the drain path reachable.
const serverId = serverPath.split('/').filter(Boolean)[1]
// The heartbeat payload is the AGENT's contract and it is snake_case
// (`agent_version`), unlike every other call in this file — the schema's
// camelCase applies to model fields, and these are not model fields. Sending
// `agentVersion` is not an error: it is ignored, and the page reports the
// agent as 'not installed' while everything else looks fine.
await apiCall(`/servers/${serverId}`, {
  method: 'POST', workspace: firstWs.id,
  body: { agent_version: '0.4.1', health: { cpu: 12, memory: 41 } },
  header: { 'x-service-method': 'heartbeat' },
})
// No reload: the heartbeat published to the workspace channel and the open page
// picked it up.
check('a heartbeat brings the server online with no reload',
  await waitFor(`document.getElementById('server-status')?.textContent.trim()`, v => v === 'online'),
  'online')
check('…and its health arrives with it',
  await evaluate(`document.body.textContent`), t => t.includes('cpu') && t.includes('12'))
check('…and the agent version it reported',
  await evaluate(`document.body.textContent`), t => t.includes('0.4.1'))

// Now the transitions, through the buttons.
await click('Drain')
check('draining transitions the status',
  await waitFor(`document.getElementById('server-status')?.textContent.trim()`, v => v === 'draining'),
  'draining')
check('and the trail records it',
  await evaluate(`document.getElementById('server-events')?.textContent ?? ''`),
  t => t.includes('drain'))

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

// Delete the project, which cascades in the schema.
await goto(projectPath)
await click('Delete')
await sleep(2500)
check('deleting returns to the list', await path(), '/projects/')
check('and the project is gone',
  await evaluate(`document.getElementById('project-rows')?.textContent ?? ''`),
  t => !t.includes('Checkout rewrite'))

// ── 14. Accessibility, on every screen ────────────────────────────────
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

for (const route of ['/', '/projects/', '/projects/create/', '/servers/', '/servers/create/',
                     '/deployments/', '/jobs/', '/admin/', '/admin/audit/', '/admin/adapters/']) {
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
