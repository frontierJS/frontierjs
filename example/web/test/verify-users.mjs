/**
 * web/test/verify-users.mjs — user management: the roster, and adding somebody to it.
 *
 * Started by `bun run verify:users`. It starts BOTH servers itself and stops
 * them again, for `verify-catalog`'s reason: what it proves spans them, and a
 * drive that assumed a running pair would pass against whichever build those
 * were serving.
 *
 * ─── What is only provable here ──────────────────────────────────────────────
 *
 * Every other drive in this app is over a model `db/schema.lite` declares. This
 * one is over `@frontierjs/auth`'s `User`, which the app appends IN MEMORY
 * (api/src/core/db.ts) and extends in db/user.lite. Four things follow, and
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
 *   · **Signing in as two requests.** Once an account has a second factor, a
 *     password answers a ticket with no token, and the ticket plus a code
 *     answers the session. The package's own tests run a harness app; this is
 *     the only run through a real app's plugin, its per-shop provider proxy and
 *     a tenant database, with codes from `lib/authenticator.mjs` rather than
 *     from the server's own arithmetic.
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
import { dirname, join }       from 'node:path'
import { fileURLToPath }       from 'node:url'

import { authenticator, wrongCode, enrolledAccount } from './lib/authenticator.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'
const BASE   = `${API}/api`
const MAIL   = process.env.MAIL_SINK_URL ?? 'http://localhost:8111'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

const PASSWORD = 'correct-horse-battery'
const ADMIN = 'alex@shop.test', STAFF = 'sam@shop.test', SHOPPER = 'robin@buyer.test', OPS = 'kit@shop.test'

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
check('…with the address normalized by @lower at the boundary',
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

// And that the invitation WORKS. For as long as the two rows above were green,
// redeeming it answered 409 *this account has no password* — the reset refused
// any account without one, and a created account has no credential at all — so
// every person an admin added was locked out of an account that answered 201
// (FJS-1099). The link is read out of the mail, the way the person reads it.
const inviteToken = decodeURIComponent(JSON.stringify(invites[0] ?? {}).match(/token=([A-Za-z0-9_%\-]+)/)?.[1] ?? '')
const redeemed = await fetch(`${BASE}/auth/password-reset/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: inviteToken, password: 'Invited-Passw0rd' }),
})
check('the invitation link sets the first password', [Boolean(inviteToken), redeemed.status], [true, 200])
const firstIn = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: addr('c'), password: 'Invited-Passw0rd' }),
})
check('…and the invited person signs in with it', [firstIn.status, typeof (await firstIn.json()).token], [200, 'string'])

// ─── A second factor ───────────────────────────────────────────────────────
//
// Signing in as TWO requests. Every test of it in the package runs a harness
// app; this is the one run through a real app's plugin, its per-shop `IAuth`
// proxy (api/src/core/auth.ts routes every method it is handed, including ones
// written after it) and its tenant database.
//
// Codes come from `lib/authenticator.mjs`, a second implementation of the
// arithmetic, rather than from the server's own `totp.ts`.
//
// The account is registered per run, never a seeded one: a run that dies
// between enabling and disabling leaves the factor on, and every other drive
// signs in as the seeded people.
//
// The clock is real and the replay guard spends a step per acceptance, so the
// codes are chosen by step: confirm with the PREVIOUS step's code, sign in with
// the current one. At the shipped drift of one step both remain acceptable
// across a boundary crossed mid-run.

console.log('\n  users — a second factor')

const post = async (path, data, tok, method) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(tok    ? { authorization: `Bearer ${tok}` } : {}),
      ...(method ? { 'x-service-method': method }     : {}),
    },
    body: JSON.stringify(data),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const account  = (tok, method, data = {}) => post('/account/me', data, tok, method)
const password = (email) => post('/auth/login', { email, password: PASSWORD })
const answer   = (challenge, code) => post('/auth/login/challenge', { challenge, code })
const whoami   = async (tok) => (await fetch(`${BASE}/account/me`, { headers: { authorization: `Bearer ${tok}` } })).status

const twoStep = addr('t')
const joined  = await post('/auth/register', { email: twoStep, password: PASSWORD, name: 'Two Step' })
check('a fresh account registers with a session', [joined.status, typeof joined.body?.token], [201, 'string'])
let tok = joined.body.token

// Re-authenticating is the pair: the same call one field different. 403 and
// not 401, and the session answering afterwards is asserted beside it, because
// a 401 is what a browser client signs the person out on (FJS-1088).
check('setting up a factor with the wrong password is refused as 403',
      (await account(tok, 'setupTotp', { currentPassword: 'not-it' })).status, 403)
check('…and the session that sent it is still a session', await whoami(tok), 200)
const setup = await account(tok, 'setupTotp', { currentPassword: PASSWORD })
check('…and with the right one answers a secret and an otpauth URI',
      [setup.status, /^[A-Z2-7]{32}$/.test(setup.body?.secret ?? ''), setup.body?.qr?.startsWith('otpauth://totp/')],
      [200, true, true])
const secret = setup.body.secret

check('a pending enrollment does not change how the account signs in',
      typeof (await password(twoStep)).body?.token, 'string')

const confirmed = await account(tok, 'confirmTotp', { code: authenticator(secret, -1) })
check('confirming with a code from a SECOND implementation switches it on',
      [confirmed.status, confirmed.body?.recoveryCodes?.length], [200, 10])
const recoveryCodes = confirmed.body.recoveryCodes
check('…and the status says so', (await account(tok, 'totpStatus')).body,
      { enabled: true, recoveryCodesRemaining: 10 })

// The headline. A password alone is now worth a ticket and nothing else.
const first = await password(twoStep)
check('a password alone answers a challenge', [first.status, typeof first.body?.challenge], [200, 'string'])
check('…carrying no token and no user', ['token' in (first.body ?? {}), 'user' in (first.body ?? {})], [false, false])
check('…and the ticket is not a session', await whoami(first.body.challenge), 401)

const code = authenticator(secret)
const done = await answer(first.body.challenge, code)
check('the ticket plus a code answers a token', [done.status, typeof done.body?.token], [200, 'string'])
check('…that the account service accepts', await whoami(done.body.token), 200)

// The replay, paired with a recovery code accepted on the SAME ticket — which
// is also what shows a refused attempt leaves the ticket usable.
const second = await password(twoStep)
const replay = await answer(second.body.challenge, code)
check('the code that just signed in is refused the second time', replay.status, 401)
check('…as retryable, because the ticket survives it', replay.body?.retryable, true)
const viaRecovery = await answer(second.body.challenge, recoveryCodes[0].toLowerCase())
check('a recovery code on the same ticket answers a token, typed in lower case',
      [viaRecovery.status, await whoami(viaRecovery.body?.token)], [200, 200])
tok = viaRecovery.body.token
check('…and it is spent: nine remain', (await account(tok, 'totpStatus')).body?.recoveryCodesRemaining, 9)

// The ceiling. Five wrong codes spend the ticket, and a code that would be
// accepted is then refused on it — beside the same code accepted on a fresh one.
const wrong = wrongCode(secret)
const third = await password(twoStep)
const tries = []
for (let i = 0; i < 5; i++) tries.push((await answer(third.body.challenge, wrong)).body?.retryable)
check('five wrong codes: four say try again, the fifth says stop', tries, [true, true, true, true, false])
const good = authenticator(secret, 1)
check('…and a good code on that ticket is refused', (await answer(third.body.challenge, good)).status, 401)
const fourth = await password(twoStep)
const control = await answer(fourth.body.challenge, good)
check('…where the same code on a fresh ticket is accepted', [control.status, typeof control.body?.token], [200, 'string'])

// Switching it off. A ticket issued before does not become a way in without
// the factor it was issued for.
const stale = await password(twoStep)
check('disabling with the wrong password is refused as 403',
      (await account(tok, 'disableTotp', { currentPassword: 'not-it' })).status, 403)
check('…and with the right one succeeds',
      (await account(tok, 'disableTotp', { currentPassword: PASSWORD })).status, 200)
check('a ticket issued before the factor was removed is refused, and says stop',
      await answer(stale.body.challenge, authenticator(secret, 1)).then(r => [r.status, r.body?.retryable]), [401, false])
check('the status is back to nothing, recovery codes included', (await account(tok, 'totpStatus')).body,
      { enabled: false, recoveryCodesRemaining: 0 })
check('a password alone answers a token again', typeof (await password(twoStep)).body?.token, 'string')

// ─── Who stands at SYSADMIN ────────────────────────────────────────────────
//
// SYSADMIN(7) used to be read off `role === 'system'`, and `role` is written by
// any admin — so one PATCH from Alex took a stranger's unverified account from 1
// to 7 (FJS-1097). It is a column now that only a sysadmin writes. Asked as the
// same payload from two people one rung apart, because a column NOBODY could
// write would pass the refusal on its own.

console.log('\n  users — who stands at SYSADMIN')

const levelOf = async (tok) => (await (await fetch(`${BASE}/account/me`, { headers: { authorization: `Bearer ${tok}` } })).json())?.level
const asOps = await login(OPS)
check('the seeded operator grades SYSADMIN', await levelOf(asOps), 7)
check('…and the admin one rung below does not', await levelOf(asAdmin), 5)

const climber = await post('/auth/register', { email: addr('s'), password: PASSWORD, name: 'Climber' })
const climberId = climber.body?.user?.userId
check('an admin may still set somebody\'s role — that column is theirs to write',
      (await patch(asAdmin, climberId, { role: 'system' })).row?.role, 'system')
check('…and it no longer grades anything: the next session is not SYSADMIN',
      await levelOf((await password(addr('s'))).body?.token) !== 7, true)

check('an admin sending isSystemAdmin is answered 200 with the column unchanged',
      await patch(asAdmin, climberId, { isSystemAdmin: true }).then(r => [r.status, r.row?.isSystemAdmin]), [200, false])
check('…where the sysadmin sending the identical payload sets it',
      (await patch(asOps, climberId, { isSystemAdmin: true })).row?.isSystemAdmin, true)
check('…and takes it back', (await patch(asOps, climberId, { isSystemAdmin: false })).row?.isSystemAdmin, false)

// ─── A lost second factor, and telling the person ──────────────────────────
//
// Two things a person who did NOT make a change must be able to rely on. The
// reset is SYSADMIN's alone and the refusal one rung below is its pair; the
// notification is read out of the OUTBOX, because a callback that is never
// wired and one that mails nobody both answer 200 (`onPasswordResetRequested`
// was that for a year, one section up).

console.log('\n  users — a lost second factor, reset by an operator')

await fetch(`${MAIL}/outbox`, { method: 'DELETE' })
const lost   = await enrolledAccount(API, addr('r'), PASSWORD)
const lostId = (await (await fetch(`${BASE}/account/me`, { headers: { authorization: `Bearer ${lost.token}` } })).json())?.userId
const resetFor = (tok) => post(`/account-recovery/${encodeURIComponent(lostId)}`, {}, tok, 'resetTotp')

check('an admin (5) resetting somebody\'s factor is refused', (await resetFor(asAdmin)).status, 403)
check('…and the factor is still owed at sign-in', typeof (await password(addr('r'))).body?.challenge, 'string')

const reset = await resetFor(asOps)
check('the sysadmin resets it, ending the person\'s sessions', [reset.status, reset.body?.sessionsRevoked >= 1], [200, true])
check('…so the session on the lost phone is gone', await whoami(lost.token), 401)
check('…and the password alone signs them in to set it up again',
      typeof (await password(addr('r'))).body?.token, 'string')
check('a sysadmin resetting their own is refused — that is disableTotp, with a password',
      (await post(`/account-recovery/me`, {}, asOps, 'resetTotp')).status, 403)

await new Promise(r => setTimeout(r, 800))
const told = ((await (await fetch(`${MAIL}/outbox`)).json().catch(() => [])) ?? [])
  .filter(m => JSON.stringify(m).includes(addr('r')))
const bodies = told.map(m => JSON.stringify(m))
check('the person was told twice — when it went on, and when support took it off',
      [told.length, bodies.some(b => b.includes('turned on')), bodies.some(b => b.includes('removed by the shop'))],
      [2, true, true])
check('…and the refused reset told them nothing: the count is the two changes that happened', told.length, 2)
check('…with no secret and no recovery code in any of it',
      [lost.secret, ...lost.recoveryCodes].some(s => bodies.some(b => b.includes(s))), false)

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
//
// The roster is a WINDOW (FJS-1098). It used to render junction's default page
// of 20 and say nothing, and this drive leaves accounts behind every run, so the
// count crossed 21 and six people were silently missing. The first render is
// asked as a PAIR with the API's count — the button is there exactly when the
// API holds more than the window — so it holds on a fresh seed of four people
// and on a database this drive has run against a hundred times.
// Paged here too: this drive leaves accounts behind, so a single `$limit=100`
// read is the same cliff one number further out.
const nowRows = []
for (let offset = 0; ; offset += 100) {
  const r = await fetch(`${API}/api/users?$limit=100&$offset=${offset}&$orderBy=email`, { headers: { authorization: `Bearer ${asAdmin}` } })
  const page = (await r.json())?.data ?? []
  nowRows.push(...page)
  if (page.length < 100) break
}
await open('/users/', asAdmin, 'tr[data-user]', 2)
const shown   = () => evaluate(`document.querySelectorAll('tr[data-user]').length`)
const firstWindow = await shown()
check('the first window is one page at most', firstWindow <= 20, true)
check('…and offers more exactly when the API holds more than it shows',
      await evaluate(`!!document.querySelector('#u-more')`), nowRows.length > firstWindow)

for (let i = 0; i < 20 && await evaluate(`!!document.querySelector('#u-more')`); i++) {
  const before = await shown()
  await evaluate(`(document.querySelector('#u-more').click(), true)`)
  for (let t = 0; t < 60 && await shown() === before; t++) await new Promise(r => setTimeout(r, 150))
}
check('growing it renders every row the API answered', await shown(), nowRows.length)
check('…and the end is said rather than implied', await evaluate(`!!document.querySelector('#u-end')`), true)
check('…including the one this run made, on the screen',
      await evaluate(`document.body.textContent.includes(${JSON.stringify(addr('c'))})`), true)
check('the standing column is derived from isStaff and role, not from the level',
      await evaluate(`[...new Set([...document.querySelectorAll('[data-standing]')].map(e => e.textContent.trim()))].sort()`),
      (v) => v.includes('shopper') && (v.includes('staff') || v.includes('admin')))

// The same screen, as a shopper. It is not refused — `User` reads at 4 — it is
// a working page with one row on it, which is the failure a policy makes and a
// gate never does.
await open('/users/', asShopper, 'tr[data-user]', 1)
check('a shopper gets a working page with only themselves on it',
      await evaluate(`document.querySelectorAll('tr[data-user]').length`), 1)

// ─── A second factor, on screen ────────────────────────────────────────────
//
// The same feature as the HTTP section, asked of the screens, and three things
// only a browser can answer. That a person can ENROLL from /account/ with codes
// from a second implementation. That signing in through /sign-in/ stores NO
// token until the code box is answered. And that a wrong code keeps both the
// box and the tab's state — FJS-1088's shape: the client announced every 401
// as a dead session, and the shell signed the person out on it.
//
// A fresh account again, for the HTTP section's reason. Its token is planted to
// reach /account/; the sign-in half types, because typing is what is under test.

console.log('\n  users — a second factor, on screen')

const fill = (sel, v) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  el.value = ${JSON.stringify(v)}
  el.dispatchEvent(new Event('input',  { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
const click = (sel) => evaluate(`(document.querySelector(${JSON.stringify(sel)}).click(), true)`)
async function until(expr, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true
    await new Promise(r => setTimeout(r, 150))
  }
  return false
}
const has    = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`
const stored = () => evaluate(`localStorage.getItem('shop_token')`)
const onScreen2 = addr('u')
const screenJoin = await post('/auth/register', { email: onScreen2, password: PASSWORD, name: 'On Screen' })
await open('/account/', screenJoin.body.token, '#totp[data-totp-state="off"]')
check('/account/ says two-step sign-in is off', await evaluate(`document.querySelector('#totp').dataset.totpState`), 'off')

await fill('#totp-password', 'not-it')
await click('#totp-enable')
await until(has('#account-error'))
check('a wrong password is refused ON the screen, and no secret is shown',
      [await evaluate(has('#account-error')), await evaluate(has('[data-totp-secret]'))], [true, false])
check('…and the tab is still signed in', [await stored(), await evaluate(has('#nav-account'))],
      [screenJoin.body.token, true])

await fill('#totp-password', PASSWORD)
await click('#totp-enable')
await until(has('[data-totp-secret]'))
const shownSecret = await evaluate(`document.querySelector('[data-totp-secret]')?.dataset.totpSecret ?? null`)
check('the right password shows a secret to add to an app', /^[A-Z2-7]{32}$/.test(shownSecret ?? ''), true)
check('…which switches nothing on yet', (await account(screenJoin.body.token, 'totpStatus')).body?.enabled, false)

await fill('#totp-code', wrongCode(shownSecret))
await click('#totp-confirm')
await until(has('#account-error'))
check('a wrong code keeps the enrollment open and the tab signed in',
      [await evaluate(has('[data-totp-secret]')), await evaluate(has('[data-recovery-code]')), await stored()],
      [true, false, screenJoin.body.token])

await fill('#totp-code', authenticator(shownSecret, -1))
await click('#totp-confirm')
await until(`document.querySelectorAll('[data-recovery-code]').length === 10`)
const shownCodes = await evaluate(`[...document.querySelectorAll('[data-recovery-code]')].map(e => e.textContent.trim())`)
check('a code from this file turns it on, and ten recovery codes are shown', shownCodes.length, 10)
check('…and the server agrees', (await account(screenJoin.body.token, 'totpStatus')).body,
      { enabled: true, recoveryCodesRemaining: 10 })

// Signed out, the long way round: no token in storage and a fresh load, so the
// app boots as a stranger and nothing from the enrollment survives in memory.
await evaluate(`(localStorage.removeItem('shop_token'), true)`)
await send('Page.navigate', { url: UI + '/sign-in/' }, sessionId)
await until(has('#si-email'))
await fill('#si-email', onScreen2)
await fill('#si-password', PASSWORD)
await click('#si-submit')
await until(has('#code-box'))
check('a password alone opens the code box', await evaluate(has('#code-box')), true)
check('…and stores no token', await stored(), null)
check('…and the shell is not signed in', await evaluate(has('#nav-account')), false)

await fill('#code-input', wrongCode(shownSecret))
await click('#code-submit')
await until(has('#session-error'))
check('a wrong code is refused in words', await evaluate(`document.querySelector('#session-error')?.textContent.trim()`),
      (t) => /invalid code/i.test(t ?? ''))
check('…and the box stays open, because the ticket is still good', await evaluate(has('#code-box')), true)

await fill('#code-input', authenticator(shownSecret, 0))
await click('#code-submit')
await until(`!document.querySelector('#code-box') && !!document.querySelector('#nav-account')`)
const signedToken = await stored()
check('the right code signs in: the box closes and the shell knows who',
      [await evaluate(has('#code-box')), await evaluate(has('#nav-account'))], [false, true])
check('…and now a token is stored, which the account service accepts',
      [typeof signedToken, await whoami(signedToken)], ['string', 200])

// Left as the drive found it: nobody else ever signs in as this address, but a
// factor left on is a thing a later reader of the database has to explain.
await account(signedToken, 'disableTotp', { currentPassword: PASSWORD })

// ─── A forgotten password, on screen ───────────────────────────────────────
//
// The emailed link is followed the way a person follows it — read out of the
// mail and opened — because for its whole life it pointed at `/reset` on the
// API's port, where nothing answers, and every assertion about the reset over
// HTTP stayed green beside a link that was a 404. The link's ORIGIN is asserted
// before anything is typed into the page it opens.
//
// The request is asked as a pair: an address with an account and one without
// get the SAME sentence, since the route answers alike on purpose and a screen
// that told them apart would be the enumeration the route refuses.

console.log('\n  users — a forgotten password, on screen')

const forgetful = addr('p')
await post('/auth/register', { email: forgetful, password: PASSWORD, name: 'Forgetful' })
await fetch(`${MAIL}/outbox`, { method: 'DELETE' })

const askForLink = async (email) => {
  await evaluate(`(localStorage.removeItem('shop_token'), true)`)
  await send('Page.navigate', { url: UI + '/sign-in/' }, sessionId)
  await until(has('#si-forgot'))
  await click('#si-forgot')
  await until(has('#fp-email'))
  await fill('#fp-email', email)
  await click('#fp-submit')
  await until(has('#fp-sent'))
  return evaluate(`document.querySelector('#fp-sent')?.textContent.replace(${JSON.stringify(email)}, '<address>').trim() ?? null`)
}
const saidForAccount = await askForLink(forgetful)
const saidForNobody  = await askForLink(`nobody-${tag}@shop.test`)
check('asking for a link says one sentence', typeof saidForAccount, 'string')
check('…and the same sentence for an address with no account', saidForNobody, saidForAccount)

await new Promise(r => setTimeout(r, 800))
const resetMail = ((await (await fetch(`${MAIL}/outbox`)).json().catch(() => [])) ?? [])
  .filter(m => JSON.stringify(m).includes(forgetful) && JSON.stringify(m).includes('token='))
const link = JSON.stringify(resetMail[0] ?? {}).match(/https?:\/\/[^\s"\\]+token=[A-Za-z0-9_%\-]+/)?.[0] ?? null
check('one link reached that address, and none reached the address with no account',
      [resetMail.length, ((await (await fetch(`${MAIL}/outbox`)).json().catch(() => [])) ?? [])
        .some(m => JSON.stringify(m).includes(`nobody-${tag}`))], [1, false])
check('…and it opens THIS console\'s reset page, not a path on the API', link?.startsWith(`${UI}/reset/?token=`), true)

await send('Page.navigate', { url: link }, sessionId)
await until(has('#rp-password'))
await fill('#rp-password', 'Forgot-Passw0rd')
await fill('#rp-again', 'Forgot-Passw0rX')
await click('#rp-submit')
await until(has('#rp-error'))
check('two passwords that differ are refused on the page', await evaluate(has('#rp-done')), false)
check('…and nothing was sent: the old password still signs in', typeof (await password(forgetful)).body?.token, 'string')

await fill('#rp-again', 'Forgot-Passw0rd')
await click('#rp-submit')
await until(has('#rp-done'))
check('the matching pair sets the password', await evaluate(has('#rp-done')), true)
const newIn = await post('/auth/login', { email: forgetful, password: 'Forgot-Passw0rd' })
check('…the new one signs in and the old one does not',
      [typeof newIn.body?.token, (await password(forgetful)).status], ['string', 401])

await send('Page.navigate', { url: link }, sessionId)
await until(has('#rp-password'))
await fill('#rp-password', 'Second-Passw0rd')
await fill('#rp-again', 'Second-Passw0rd')
await click('#rp-submit')
await until(has('#rp-error'))
check('the same link a second time is refused in words, and sets nothing',
      [await evaluate(has('#rp-error')), typeof (await post('/auth/login', { email: forgetful, password: 'Forgot-Passw0rd' })).body?.token],
      [true, 'string'])

console.log('')
console.log(`  ${pass} passed, ${fail} failed`)
stopAll()
process.exit(fail ? 1 : 0)
