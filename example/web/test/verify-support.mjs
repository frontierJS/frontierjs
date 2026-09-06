/**
 * web/test/verify-support.mjs — support mode: acting as somebody else, bounded
 * and recorded.
 *
 * Started by `bun run verify:support`. It starts the API itself and stops it
 * again, and opens no browser: everything here is a boundary question, and the
 * one thing a browser would add — a banner — is a field on the session that
 * `basecamp`: `verify:screens` already renders.
 *
 * ─── What is only provable here ──────────────────────────────────────────────
 *
 *   · **The ceiling is the SUBJECT's.** An admin acting as a shopper reads what
 *     the shopper reads, and the wrong answer is a 200 with the whole roster in
 *     it rather than an error. Asked as a PAIR against the same account outside
 *     the episode, because a ceiling that refused everybody would look identical
 *     from the refused side (`FJS-351`).
 *
 *   · **The trail names the OPERATOR.** Every unit test above this can assert
 *     what junction hands litestone; only a running app can assert what actually
 *     lands in the trail, which is the file this drive reads. `actorId` is the
 *     admin, `subjectId` is the shopper, `actorType` is `support` — the
 *     inversion `FJS-142` was filed for, and the default Laravel Nova still has.
 *
 *   · **A credential path refuses from inside.** An API key minted here would
 *     authenticate as the shopper for as long as it lives, which is the episode
 *     escaped permanently — and the trail would show an ordinary key issue.
 *
 *   · **The expiry is read at RESOLUTION.** Nothing sweeps: the drive moves no
 *     clock and runs no job, and the next request after the ceiling passes is
 *     the operator's own again. A cron makes an episode end eventually; this is
 *     what makes it end.
 *
 *   · **A live socket does not outlive the episode.** A session is resolved once
 *     at upgrade and its principal is handed to every frame after that, so
 *     without an explicit close an operator who has stopped over HTTP goes on
 *     acting as the subject down a connection nobody re-asked. This is the only
 *     place in the repo where that is asserted end to end.
 *
 * ─── The trap ────────────────────────────────────────────────────────────────
 *
 * **The trail is written fire-and-forget**, so an entry is not on disk the
 * instant the request returns. Every read of it here polls to a deadline rather
 * than sleeping once — a fixed sleep is a flake that only shows up on a loaded
 * machine, which is the machine CI runs on.
 */
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const BASE = `${API}/api`
const TRAIL = join(ROOT, 'db/audit/auditLogs.jsonl')

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

{
  let busy = false
  try { await fetch(`${BASE}/products`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port 8110 already answers — the API is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
start('bun', ['run', 'api/index.ts'], 'api')
if (!await waitFor(`${BASE}/products`, 'api')) { stopAll(); process.exit(1) }

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

const login = async (email) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const body = await res.json()
  return body.token
}
const as = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
const me = async (token) => (await fetch(`${BASE}/account/me`, { headers: as(token) })).json()

const startEpisode = (token, subjectId, reason, ttl) => fetch(`${BASE}/auth/support/start`, {
  method: 'POST', headers: as(token),
  body: JSON.stringify({ subjectId, reason, ...(ttl ? { ttl } : {}) }),
})
const endEpisode = (token) => fetch(`${BASE}/auth/support/end`, { method: 'POST', headers: as(token) })

/** Poll the trail to a deadline — it is written fire-and-forget. */
async function trailUntil(predicate, ms = 4000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const rows = readFileSync(TRAIL, 'utf8').trim().split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const hit = rows.filter(predicate)
    if (hit.length) return hit
    await new Promise(r => setTimeout(r, 100))
  }
  return []
}

const adminToken   = await login(ADMIN)
const shopperToken = await login(SHOPPER)
const staffToken   = await login(STAFF)

const admin   = await me(adminToken)
const shopper = await me(shopperToken)

console.log('\nsupport mode\n')

// ─── Who may start one ─────────────────────────────────────────────────────
//
// The app's answer and not the framework's: `canStartSupport` in
// api/src/app.ts. Absent, both of these would be 403 and the pair would prove
// nothing — which is why the acceptance is asserted first.

{
  const refusedByStaff = await startEpisode(staffToken, shopper.userId, 'ticket-1')
  check('a member of staff may not start one', refusedByStaff.status, 403)

  const refusedAdminSubject = await startEpisode(adminToken, admin.userId, 'ticket-1')
  check('nobody may act as an administrator — the ceiling would BE admin',
        refusedAdminSubject.status, s => s === 403 || s === 400)

  const noReason = await startEpisode(adminToken, shopper.userId, '')
  check('a reason is required', noReason.status, 400)
}

// ─── The ceiling ───────────────────────────────────────────────────────────
//
// `User` reads at USER(4) and its row policy is *your own row, or staff*. So an
// admin sees the roster and a shopper sees one row, and the WRONG answer here is
// a 200 with everybody in it rather than an error.

const roster = async (token) => {
  const res = await fetch(`${BASE}/users`, { headers: as(token) })
  const body = await res.json()
  return (body.data ?? body ?? []).length
}

const asAdmin = await roster(adminToken)
check('an admin reads the whole roster', asAdmin, n => n > 1)

{
  const started = await startEpisode(adminToken, shopper.userId, 'cannot reproduce the basket bug')
  check('the episode starts', started.status, 200)

  const now = await me(adminToken)
  check('the same token answers as the SUBJECT', now.email, SHOPPER)
  check('and the operator is still on the principal', now.support?.operatorId, admin.userId)
  check('with the reason it was started for', now.support?.reason, 'cannot reproduce the basket bug')

  // The pair: the same account, the same token, one column apart.
  check('acting as a shopper, the operator reads ONE row where they read many',
        await roster(adminToken), 1)
}

// ─── The trail ─────────────────────────────────────────────────────────────
//
// A write the SUBJECT is entitled to make, from inside the episode. `User`
// carries `@@log(audit)` and `@@allow('update', id == auth().id || …)`, so this
// is the shopper editing their own row — and every part of the entry that
// matters is about who really did it.

{
  const RUN = Date.now().toString(36)
  const res = await fetch(`${BASE}/users/${shopper.userId}`, {
    method: 'PATCH', headers: as(adminToken), body: JSON.stringify({ name: `Robin ${RUN}` }),
  })
  check('the operator may make the write the subject may make', res.status, 200)

  const rows = await trailUntil(r => r.model === 'user' && r.actorType === 'support')
  const entry = rows[rows.length - 1]

  check('the entry names the OPERATOR as the actor', entry?.actorId, admin.userId)
  check('and the SUBJECT beside them, rather than instead of them', entry?.subjectId, shopper.userId)
  check('and says which episode it belongs to', entry?.episodeId, e => typeof e === 'string' && e.length > 0)

  // The pair, and the whole complaint in `FJS-142`: nothing about this write is
  // filed under the person it was done to.
  const underSubject = readFileSync(TRAIL, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    .filter(r => r.actorId === shopper.userId && r.actorType === 'support')
  check('and nothing is filed under the subject', underSubject.length, 0)
}

// ─── The refusals ──────────────────────────────────────────────────────────

{
  const inside = await fetch(`${BASE}/api-keys`, {
    method: 'POST', headers: as(adminToken), body: JSON.stringify({ name: 'stolen' }),
  })
  check('minting an API key from inside an episode is refused', inside.status, 403)

  const pw = await fetch(`${BASE}/account/me`, {
    method: 'POST', headers: { ...as(adminToken), 'x-service-method': 'changePassword' },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'something-else-1' }),
  })
  check('so is changing the password', pw.status, 403)

  // PAIRED — the subject, as themselves, may mint one. Without this the two
  // rows above are satisfied by a service that refuses everybody.
  const outside = await fetch(`${BASE}/api-keys`, {
    method: 'POST', headers: as(shopperToken), body: JSON.stringify({ name: 'theirs' }),
  })
  check('while the subject, as themselves, may mint one', outside.status, s => s === 200 || s === 201)
}

// ─── The way back ──────────────────────────────────────────────────────────

{
  const ended = await endEpisode(adminToken)
  check('ending it answers ended', (await ended.json()).ended, true)
  check('and the token is the operator’s own again', (await me(adminToken)).email, ADMIN)
  check('with the roster back', await roster(adminToken), n => n > 1)
}

// ─── The expiry, read at resolution ────────────────────────────────────────
//
// Nothing sweeps here. No job runs, no clock is moved, and the drive does not
// call end — the next resolution is simply the operator's own.

{
  await startEpisode(adminToken, shopper.userId, 'ticket-expiry', '1 second')
  check('the short episode applies', (await me(adminToken)).email, SHOPPER)

  await new Promise(r => setTimeout(r, 1400))
  check('and stops applying with nothing having swept it', (await me(adminToken)).email, ADMIN)
}

// ─── The socket ────────────────────────────────────────────────────────────
//
// A session is resolved once, at upgrade. Without an explicit close an operator
// who has stopped over HTTP keeps acting as the subject down this connection.

{
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?token=${adminToken}`)
  let closed = null
  await new Promise((res, rej) => {
    ws.onmessage = e => { const f = JSON.parse(e.data); if (f.type === 'connection' || f.type === 'connected') res() }
    ws.onerror = rej
    setTimeout(() => rej(new Error('socket never connected')), 5000)
  })
  ws.onclose = e => { closed = e.code }

  check('a socket is open before the episode', ws.readyState, 1)

  await startEpisode(adminToken, shopper.userId, 'ticket-socket')
  await new Promise(r => setTimeout(r, 500))

  check('and the server closed it, rather than leaving it resolved as it was',
        closed, c => c != null)

  await endEpisode(adminToken)
  try { ws.close() } catch {}
}

// ─── Result ────────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass}/${pass + fail} checks passed\n`)
stopAll()
process.exit(fail === 0 ? 0 : 1)
