/**
 * site/test/verify-account.mjs — the shopper's own account, on a static site.
 *
 * Started by `bun run verify:account`. Needs a built site (`bun run
 * build:site`); it starts the API and the storefront origin itself.
 *
 * ─── What this is for ─────────────────────────────────────────────────────
 *
 * Every other drive here signs in as STAFF. This one is the other audience,
 * and the two are separated by a column rather than by a level — a verified
 * shopper and a member of staff both grade USER(4), because the ladder answers
 * *what kind of caller* and *is this person one of ours* is not on that axis.
 * `User.isStaff` is the shop's own answer (`extend model User`).
 *
 * The half that cannot be seen from the SPA at all: the storefront is a
 * different ORIGIN, so the session here is not the session there. A shopper
 * signed in on :7712 is not signed in on :8010 and must not be.
 *
 * ─── The assertion that matters most ──────────────────────────────────────
 *
 * `GET /api/orders` with no filter, and the answer is one order. The screen
 * does no filtering and must not: `@@allow('read', userId == auth().id)` is
 * declared at the Data boundary, and a page that filtered as well would be a
 * second copy of the rule in the one place it cannot be enforced. So the drive
 * asks for everything, twice — as a shopper and with no session at all — and
 * grades what comes back.
 *
 * Run under BUN for the same reason `verify:site` is: it reads the app's own
 * TypeScript modules.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serveSite } from '@frontierjs/sierra/site/serve'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = join(HERE, '..')
const DIST = join(SITE, 'dist')
const ROOT = join(SITE, '..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
// test / siteServe / project 1 / service 2 — its own slot, so it collides with
// neither `verify:site` (7710) nor a dev server on 8710.
const PORT   = 7712
const DEBUG_PORT = 9225
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

const BUYER = { email: 'robin@buyer.test', password: 'correct-horse-battery' }

// ─── plumbing ─────────────────────────────────────────────────────────────

const procs = [], servers = []
function start(cmd, args, name, cwd = ROOT) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', d => { if (process.env.DEBUG) process.stdout.write(`[${name}] ${d}`) })
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p); return p
}
const stopAll = () => {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} } }
  for (const s of servers) { try { s.close() } catch {} }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

let pass = 0, fail = 0
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else    { fail++; console.log(`  ✗ ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── preflight ────────────────────────────────────────────────────────────

if (!existsSync(join(DIST, 'account', 'index.html'))) {
  console.error(`No account page at ${DIST}/account/.\nRun: bun run build:site`)
  process.exit(1)
}
for (const [port, what] of [[8110, 'the API'], [PORT, 'the storefront origin']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) { console.error(`port ${port} already answers — ${what} is up from an earlier run.`); process.exit(1) }
}

const { execFileSync } = await import('node:child_process')
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
start('bun', ['run', 'api/index.ts'], 'api')
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`${API}/api/health`)).ok) break } catch {}
  await sleep(250)
}

const site = await serveSite({ dir: DIST, port: PORT })
servers.push(site.server ?? { close() {} })
const ORIGIN = `http://localhost:${PORT}`

console.log('\n  the account — a shopper, on a static storefront\n')

// ─── the boundary, before a browser touches it ────────────────────────────
//
// Asked over HTTP first, because a screen that shows the right thing over a
// boundary that answers everything is a screen that is right by accident.

const anonOrders = await fetch(`${API}/api/orders`)
const anonLines  = await fetch(`${API}/api/order-lines`)
const anonCust   = await fetch(`${API}/api/customers`)
check('the sales ledger is not public', [anonOrders.status, anonLines.status, anonCust.status], [401, 401, 401])

// …and the catalogue still is, which is what makes the storefront possible at
// all. The two answers are the whole reason the gates were wrong: they were the
// same string.
const anonProducts = await fetch(`${API}/api/products`)
check('and the catalogue still is — the storefront reads it with no session',
      anonProducts.status, 200)

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BUYER),
})
const buyerToken = (await login.json())?.token
if (!buyerToken) { console.error('could not sign the shopper in — login limiter?'); stopAll(); process.exit(1) }

const asBuyer = p => fetch(`${API}/api${p}`, { headers: { authorization: `Bearer ${buyerToken}` } })
const mine = await (await asBuyer('/orders')).json()
check('a shopper asking for every order gets their own', 
      [mine.total, mine.data.map(o => o.reference)], [1, ['ORD-2001']])

const theirs = await (await asBuyer('/customers')).json()
check('…and for every customer, only their own record',
      theirs.data.map(c => c.email), [BUYER.email])

// A shopper is USER(4) exactly as staff is. The level does not separate them
// and was never asked to: `isStaff` does.
const staffLogin = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'sam@shop.test', password: 'correct-horse-battery' }),
})
const staffToken = (await staffLogin.json())?.token
const staffSees = await (await fetch(`${API}/api/orders`, {
  headers: { authorization: `Bearer ${staffToken}` } })).json()
check('staff at the same level sees the whole book', staffSees.total > 1, true)

// ─── the browser ──────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-account-'))
start(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profile}`, 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://localhost:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl }
  catch { await sleep(250) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let msgId = 0
const pending = new Map(), pageErrors = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    pageErrors.push(m.params.args?.map(a => a.value ?? a.description).join(' ') ?? '')
  if (m.method === 'Runtime.exceptionThrown')
    pageErrors.push(m.params.exceptionDetails?.exception?.description ?? '')
}
const send = (method, params = {}, sessionId) =>
  new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })) })

const { result: { targetId } }  = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}
async function until(fn, tries = 120) {
  for (let i = 0; i < tries; i++) {
    let v = null
    try { v = await fn() } catch {}
    if (v) return v
    await sleep(200)
  }
  return null
}
async function goto(url) {
  await send('Page.navigate', { url }, sessionId)
  await until(async () => await evaluate(`document.readyState === 'complete' || null`))
}

await goto(`${ORIGIN}/account/`)

const form = await until(async () => await evaluate(`!!document.querySelector('[data-submit]') || null`))
check('the page ships as a file and the island signs in on it', form, true)

// The heading is in the FILE — a crawler and a reader with no JavaScript get a
// page rather than an empty div.
const baked = await (await fetch(`${ORIGIN}/account/`)).text()
check('and the page around it is prerendered, not an empty mount point',
      baked.includes('Your account'), true)
check('with nothing of anybody\'s account baked into it',
      /ORD-\d|robin@buyer/.test(baked), false)

await evaluate(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel); el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set('[data-email-input]', ${JSON.stringify(BUYER.email)})
  set('[data-password]', ${JSON.stringify(BUYER.password)})
  document.querySelector('[data-submit]').click()
  return true
})()`)

const who = await until(async () => await evaluate(`document.querySelector('[data-email]')?.textContent ?? null`))
// What the SCREEN says when this fails, because the first time it did the
// answer was `Failed to fetch` and the island was rewriting it as *wrong
// password* — which is an afternoon spent on the wrong bug (`FJS-496`).
if (!who) console.log('      screen says:',
  await evaluate(`document.querySelector('[data-error]')?.textContent ?? 'nothing'`))
check('signing in on the storefront reaches the shop, cross-origin', who, BUYER.email)

const listed = await until(async () => await evaluate(
  `(() => { const els = [...document.querySelectorAll('[data-order]')]
            return els.length ? els.map(e => e.dataset.order) : null })()`))
check('and the history is their orders and only theirs', listed, ['ORD-2001'])

await evaluate(`(() => { document.querySelector('[data-open="ORD-2001"]').click(); return true })()`)
const items = await until(async () => await evaluate(
  `(() => { const rows = document.querySelectorAll('[data-lines="ORD-2001"] tbody tr td:first-child')
            const t = [...rows].map(r => r.textContent.trim()).filter(x => x && x !== 'Loading…')
            return t.length ? t : null })()`))
check('opening one shows what was in it', items?.length, 2)

// ── the origin boundary ───────────────────────────────────────────────────
//
// The token is in THIS origin's localStorage. The operations app is a different
// origin and cannot read it — which is not a nicety: it is why a shopper signing
// in here does not acquire a session in the staff console.
const stored = await evaluate(`!!localStorage.getItem('shop_account_token') || null`)
check('the session is stored on the storefront\'s own origin', stored, true)

await goto(`${ORIGIN}/catalog/`)
await goto(`${ORIGIN}/account/`)
const stillIn = await until(async () => await evaluate(`document.querySelector('[data-email]')?.textContent ?? null`))
check('and survives a page load, because a static site has no session but this', stillIn, BUYER.email)

// ── signing out, and signing up ───────────────────────────────────────────

await evaluate(`(() => { document.querySelector('[data-signout]').click(); return true })()`)
const out = await until(async () => await evaluate(`!!document.querySelector('[data-submit]') || null`))
check('signing out puts the form back', out, true)

const fresh = `shopper-${Date.now().toString(36)}@buyer.test`
await evaluate(`(() => {
  document.querySelector('[data-to-signup]').click()
  return true
})()`)
await until(async () => await evaluate(`!!document.querySelector('[data-name]') || null`))
await evaluate(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel); el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set('[data-name]', 'New Shopper')
  set('[data-email-input]', ${JSON.stringify(fresh)})
  set('[data-password]', 'correct-horse-battery')
  document.querySelector('[data-submit]').click()
  return true
})()`)

const empty = await until(async () => await evaluate(
  `document.querySelector('[data-empty]') ? 'empty' : null`))
check('a brand new account signs in and has an empty history', empty, 'empty')

// The one that says the leak is really closed: a stranger who registered ten
// seconds ago asks for every order, and gets none of the shop's.
const newToken = await evaluate(`localStorage.getItem('shop_account_token')`)
const strangerSees = await (await fetch(`${API}/api/orders`, {
  headers: { authorization: `Bearer ${newToken}` } })).json()
check('…and asking the API directly for every order answers none of them',
      [strangerSees.total, strangerSees.data.length], [0, 0])

// A shopper is not staff, and registering is not a promotion — auth defaults
// `role` to "user", which is the role Sam has, so this is the assertion that
// the shop's own column is what separates them.
const strangerCust = await (await fetch(`${API}/api/customers`, {
  headers: { authorization: `Bearer ${newToken}` } })).json()
check('nor any customer — registering is not becoming staff', strangerCust.total, 0)

const noisy = pageErrors.filter(t => t && !/favicon|ERR_FILE_NOT_FOUND/.test(t))
check('no console errors anywhere in it', noisy, [])

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail > 0 ? 1 : 0)
