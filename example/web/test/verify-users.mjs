/**
 * web/test/verify-users.mjs — user management: the roster, and adding somebody to it.
 *
 * Started by `bun run verify:users`. It starts BOTH servers itself and stops
 * them again, for `verify-catalogue`'s reason: what it proves spans them, and a
 * drive that assumed a running pair would pass against whichever build those
 * were serving.
 *
 * ─── What is only provable here ──────────────────────────────────────────────
 *
 * Every other drive in this app is over a model `db/schema.lite` declares. This
 * one is over `@frontierjs/auth`'s `User`, which the app appends IN MEMORY
 * (api/src/core/db.ts) and extends in db/user.lite. Three things follow, and
 * nothing else here can ask any of them:
 *
 *   · **A row policy over a model from a package.** `User` reads at USER(4), so
 *     the gate lets a shopper in and the POLICY is the whole of what stops them
 *     reading the roster. The wrong answer is a 200 with one row — never an
 *     error — so the only way to see it is to ask as three audiences and
 *     compare. Staff see everybody, a shopper sees themselves, a stranger is
 *     refused.
 *
 *   · **A field write policy DECLINING in silence.** `isStaff` is
 *     `@allow('write', auth().isAdmin)`, which compiles to
 *     `SET col = CASE WHEN … THEN ? ELSE col END`. A non-admin sending
 *     `isStaff: true` on their own row is answered **200 with the column
 *     unchanged**: no error, no field message, nothing a form can render. It is
 *     asserted here as a PAIR — the same payload from an admin moves the
 *     column, from a shopper it does not — because a refusal that cannot be
 *     shown to come from the rule it names proves nothing (`FJS-351`).
 *
 *   · **An account being MADE, and what it is not.** A created `User` is half an
 *     account — the other half is a `Credential`, which only @frontierjs/auth
 *     writes — so the drive asserts the new address cannot sign in, and that an
 *     invitation reached the outbox. The authority is
 *     `@@allow('create', auth().isAdmin)`, and create is the one operation
 *     where a policy THROWS rather than filtering, so a shopper is refused by
 *     name where a read would have been an empty list.
 *
 * ─── The trap this file exists to stay out of ────────────────────────────────
 *
 * **This drive leaves one account behind per run, and cannot not.** The service
 * declines DELETE by design — `Credential.userId` and `Session.userId` are bare
 * String columns with no relation behind them, so removing a `User` leaves live
 * sessions authenticating against nothing — and there is no other door. So every
 * count here is a DELTA or a re-read, never an absolute, and the address is
 * minted per run because `@unique` on a model with no `@@softDelete` makes a
 * fixed fixture key pass exactly once (`FJS-530`). Removing somebody properly is
 * `FJS-629`.
 *
 * Test ORDER is load-bearing and got this wrong once already. `verifySession`
 * re-reads the user row, so promoting somebody to `role: 'admin'` and then
 * asking what they may do answers about an ADMIN — the first draft of this
 * drive proved a shopper could promote themselves and the shopper had been made
 * an admin two lines earlier. Every negative case below runs BEFORE any
 * positive one touches the same row, and the row is restored at the end.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'
const BASE   = `${API}/api`
const MAIL   = process.env.MAIL_SINK_URL ?? 'http://localhost:8111'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

const PASSWORD = 'correct-horse-battery'
const ADMIN = 'alex@shop.test', STAFF = 'sam@shop.test', SHOPPER = 'robin@buyer.test'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
if (!await waitFor(UI, 'web'))                    { stopAll(); process.exit(1) }

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

// ─── The boundary, over HTTP ───────────────────────────────────────────────
//
// Asked first and without a browser, so a failure here is the Data boundary and
// never the screen. The two are told apart the way `verify:account` tells them
// apart — the same question from both sides.

const login = async (email) => {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (r.status === 429) {
    console.error('\nSign-in was rate limited (HTTP 429). Login allows 10 per 15 minutes and this\n' +
                  'drive signs in three times. Wait, or restart the API to reset the window.')
    stopAll(); process.exit(1)
  }
  return (await r.json()).token
}

const asAdmin   = await login(ADMIN)
const asStaff   = await login(STAFF)
const asShopper = await login(SHOPPER)

const roster = async (tok) => {
  const r = await fetch(`${API}/api/users?$limit=100`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} })
  return { status: r.status, rows: (await r.json().catch(() => null))?.data ?? null }
}
const patch = async (tok, id, data) => {
  const r = await fetch(`${API}/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(data),
  })
  return { status: r.status, row: await r.json().catch(() => null) }
}

console.log('\n  users — the boundary')

const all = await roster(asAdmin)
check('admin reads the whole roster', all.rows?.length >= 3, true)

const shopperView = await roster(asShopper)
check('a shopper reads ONE row — the policy filtered, it did not refuse', shopperView.status, 200)
check('…and the row is their own', shopperView.rows?.map(u => u.email), [SHOPPER])

check('staff read the whole roster', (await roster(asStaff)).rows?.length, all.rows.length)
check('a stranger is refused by the GATE, not filtered', (await roster(null)).status, 401)

// The surface `methods:` declares. The gate would have permitted delete —
// ADMINISTRATOR(5) — so 405 is the SERVICE's answer and not the ladder's, and
// the reason is the one thing a gate cannot know: `Credential.userId` and
// `Session.userId` are bare String columns with no relation behind them, so a
// deleted row leaves live sessions authenticating against nothing.
const removed = await fetch(`${API}/api/users/${all.rows[0].id}`, {
  method: 'DELETE', headers: { authorization: `Bearer ${asAdmin}` },
})
check('DELETE /users is 405 — a live session would outlive the row', removed.status, 405)

// ─── The field policy, as a pair ───────────────────────────────────────────
//
// NEGATIVE FIRST, and on an untouched row. Promoting the shopper before asking
// what a shopper may do is what made the first version of this file report the
// opposite of the truth.

const robin = all.rows.find(u => u.email === SHOPPER)
check('the shopper starts as neither staff nor admin', [robin.isStaff, robin.role], [false, 'user'])

const selfPromote = await patch(asShopper, robin.id, { isStaff: true })
check('a shopper promoting themselves is answered 200', selfPromote.status, 200)
check('…and isStaff did not move — the write policy declined in silence',
      selfPromote.row?.isStaff, false)

const selfRole = await patch(asShopper, robin.id, { role: 'admin' })
check('…nor did role', selfRole.row?.role, 'user')

// The control: the same shape of write, from the same person, on a column with
// no field policy on it. Without this the two above prove only that PATCH does
// nothing.
const rename = await patch(asShopper, robin.id, { name: 'Robin V' })
check('…while a column with no field policy DOES move', rename.row?.name, 'Robin V')

// A member of staff who is not an admin, on somebody else's row: 404 rather
// than 403, because a refusal must never confirm a row exists.
const byStaff = await patch(asStaff, robin.id, { name: 'Nope' })
check('staff editing another person is 404, not 403', byStaff.status, 404)

// POSITIVE, last. Everything above has already been asked.
const promoted = await patch(asAdmin, robin.id, { isStaff: true })
check('an admin promoting the same person on the same column DOES move it',
      promoted.row?.isStaff, true)

// Put the row back, so a second run starts where the first did.
await patch(asAdmin, robin.id, { isStaff: false, role: 'user', name: 'Robin Vale' })
const restored = (await roster(asAdmin)).rows.find(u => u.email === SHOPPER)
check('the row is restored, so this drive is repeatable',
      [restored.isStaff, restored.role, restored.name], [false, 'user', 'Robin Vale'])

// ─── Making an account ─────────────────────────────────────────────────────
//
// Every assertion here is a pair or a control. The negative cases run against a
// fresh address each time — `@unique` on a soft-delete-free model means a fixed
// fixture key passes exactly once (`FJS-530`), and this service declines DELETE,
// so a run cannot tidy up after itself and must not need to.

console.log('\n  users — adding somebody')

const tag = Math.random().toString(36).slice(2, 8)
const addr = (p) => `${p}-${tag}@shop.test`

const create = async (tok, data) => {
  const r = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(data),
  })
  return { status: r.status, row: await r.json().catch(() => null) }
}

// The policy REFUSES rather than filters. A read by the same caller is a 200
// with one row; a create is a 403 naming the model, because the payload IS the
// row and there is nothing to hide.
const byShopper = await create(asShopper, { email: addr('a'), name: 'Nope' })
check('a shopper creating an account is refused, not filtered', byShopper.status, 403)
check('…and the refusal names the model', /User/.test(byShopper.row?.message ?? ''), true)

// Staff, not admin — the control that separates *signed in* from *isAdmin*.
check('a member of staff who is not an admin is refused too',
      (await create(asStaff, { email: addr('b'), name: 'Nope' })).status, 403)

await fetch(`${MAIL}/outbox`, { method: 'DELETE' })

// Sent in MIXED case to prove @lower ran at the boundary rather than in a form.
const made = await create(asAdmin, {
  email: addr('C').toUpperCase(), name: 'New Person', isStaff: true, emailVerified: true,
})
check('an admin creates one', made.status, 201)
check('…with the address normalised by @lower at the boundary',
      made.row?.email, addr('c'))
check('…and the three admin-only columns set, because an admin set them',
      [made.row?.isStaff, made.row?.emailVerified], [true, true])

// The same address again. `@unique` answers a 409 whose payload is a list of
// { path, message } — one of the three shapes toFieldErrors reads — so <Form>
// marks the box. Asserted as the SHAPE, not just the status: a 409 carrying a
// bare sentence renders as a banner and looks like a server fault.
const dup = await create(asAdmin, { email: addr('c'), name: 'Clash' })
check('a duplicate address is a 409', dup.status, 409)
check('…carrying a per-field error, so a form can mark the box',
      Array.isArray(dup.row?.data) && dup.row.data[0]?.path?.[0] === 'email', true)

// The half that makes this an invitation rather than a row. A `User` with no
// `Credential` cannot sign in, and only @frontierjs/auth writes credentials.
const tryIn = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: addr('c'), password: 'anything-at-all' }),
})
check('the new account cannot sign in — it is half an account', tryIn.status, 401)

// …so an invitation has to have gone out. This is the assertion that would have
// caught the two defects this section was written around: `onPasswordResetRequested`
// was never wired, so the route answered 200 and mailed nobody; and the after
// hook read `ctx.result` where the envelope lives, so `email` was undefined and
// the invitation silently never fired.
await new Promise(r => setTimeout(r, 800))
const outbox = await (await fetch(`${MAIL}/outbox`)).json().catch(() => [])
const invites = (Array.isArray(outbox) ? outbox : []).filter(m => JSON.stringify(m).includes(addr('c')))
check('an invitation reached the outbox', invites.length, 1)
check('…and it is the set-a-password one', invites[0]?.subject, 'Set your password')

// ─── Chrome over CDP ───────────────────────────────────────────────────────

const chrome = start(CHROME, [
  '--headless=new', '--remote-debugging-port=9223', '--disable-gpu',
  '--no-sandbox', '--window-size=1400,1000', 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const v = await (await fetch('http://localhost:9223/json/version')).json()
    wsUrl = v.webSocketDebuggerUrl
  } catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pendingMsg = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pendingMsg.has(m.id)) { pendingMsg.get(m.id)(m); pendingMsg.delete(m.id) }
}
function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise(res => { pendingMsg.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })) })
}

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}

// The token is planted rather than typed, so the browser half costs no further
// sign-ins against the 10-per-15-minutes limiter — the three above are the
// whole budget.
async function open(path, token, waitSel, atLeast = 1) {
  await send('Page.navigate', { url: UI + '/' }, sessionId)
  await evaluate(`(async () => { if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r, { once: true })); return true })()`)
  await evaluate(`(localStorage.setItem('shop_token', ${JSON.stringify(token)}), true)`)
  await send('Page.navigate', { url: UI + path }, sessionId)
  for (let i = 0; i < 120; i++) {
    const n = await evaluate(`document.querySelectorAll('${waitSel}').length`)
    if (n >= atLeast) return
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`${path}: never rendered ${atLeast}× \`${waitSel}\``)
}

console.log('\n  users — the screen')

// Re-read rather than comparing against `all`, which was taken before this
// drive created an account — a stale count here fails on the drive's own work
// and reads as a screen that lost a row.
const nowRows = (await roster(asAdmin)).rows
await open('/users/', asAdmin, 'tr[data-user]', 2)
const onScreen = await evaluate(`document.querySelectorAll('tr[data-user]').length`)
check('the roster renders every row the API answered', onScreen, nowRows.length)
check('…including the one this run made', nowRows.some(u => u.email === addr('c')), true)
check('the standing column is derived from isStaff and role, not from the level',
      await evaluate(`[...new Set([...document.querySelectorAll('[data-standing]')].map(e => e.textContent.trim()))].sort()`),
      (v) => v.includes('shopper') && (v.includes('staff') || v.includes('admin')))

// The same screen, as a shopper. It is not refused — `User` reads at 4 — it is
// a working page with one row on it, which is the failure a policy makes and a
// gate never does.
await open('/users/', asShopper, 'tr[data-user]', 1)
check('a shopper gets a working page with only themselves on it',
      await evaluate(`document.querySelectorAll('tr[data-user]').length`), 1)

console.log('')
console.log(`  ${pass} passed, ${fail} failed`)
stopAll()
process.exit(fail ? 1 : 0)
