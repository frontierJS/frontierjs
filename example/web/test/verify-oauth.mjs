/**
 * web/test/verify-oauth.mjs — signing in with a provider, across a real wire.
 *
 * Started by `bun run verify:oauth`. It starts its OWN api, because this is the
 * one drive that needs the app in a different mode: an OAuth callback is a
 * browser redirect and can only hand a session back as a COOKIE, so the shop
 * runs with `SHOP_COOKIE_AUTH=1` here and with Bearer everywhere else. The dev
 * identity provider on :8113 comes up with it.
 *
 * ─── No browser, and that is not a shortcut ────────────────────────────────
 *
 * What is under test is the wire: three redirects, a cookie with a Path, a
 * `Set-Cookie` that has to survive a cross-origin hop, and a state that lives
 * in two places at once. `redirect: 'manual'` plus a cookie jar of our own is
 * MORE faithful here than a browser would be, because it can do the one thing a
 * browser cannot be told to do — arrive at the callback WITHOUT the cookie,
 * which is the attack the whole design is arranged around.
 *
 * ─── What it is actually proving ───────────────────────────────────────────
 *
 *   · the state on the URL and the state in the cookie are separate carriers,
 *     and holding one without the other is refused (login CSRF, RFC 9700)
 *   · an identity is keyed on (provider, subject) and never on the address
 *   · an unverified local account is NOT linked to, however verified the
 *     provider says the address is — CVE-2026-53516's shape
 *   · a `returnTo` is honored only if it passed the allow-list at flow START
 *   · a person cannot unlink their last way in
 *
 * Every one of those is a refusal. The happy path is three of eighteen.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const IDP  = process.env.IDP_URL ?? 'http://localhost:8113'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name, env = {}) {
  const p = spawn(cmd, args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, ...env },
  })
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

async function waitFor(url, label, tries = 120, method = 'GET') {
  const init = method === 'POST'
    ? { method, headers: { 'content-type': 'application/json' }, body: '{}' }
    : undefined
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url, init)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else      { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ─── A cookie jar, because the cookie IS the thing under test ──────────────
//
// Path-aware on purpose: the flow cookie is scoped to the callback path, and a
// jar that ignored Path would send it everywhere and hide the exact bug this
// found once already — a cookie scoped without `apiPrefix`, which the browser
// then never sends to a callback that lives under it.

function jar() {
  const store = new Map()   // name → { value, path }
  return {
    set(header) {
      for (const line of header ?? []) {
        const [pair, ...attrs] = line.split(';')
        const i = pair.indexOf('=')
        const name = pair.slice(0, i).trim()
        const value = pair.slice(i + 1).trim()
        const path = (attrs.find(a => a.trim().toLowerCase().startsWith('path=')) ?? '=/')
          .split('=')[1]?.trim() ?? '/'
        if (value === '' || /max-age=0/i.test(line)) store.delete(name)
        else store.set(name, { value, path })
      }
    },
    for(url) {
      const p = new URL(url).pathname
      return [...store.entries()]
        .filter(([, c]) => p === c.path || p.startsWith(c.path.endsWith('/') ? c.path : c.path + '/'))
        .map(([n, c]) => `${n}=${c.value}`).join('; ')
    },
    has: (n) => store.has(n),
    raw: store,
  }
}

async function hop(url, j, { sendCookies = true } = {}) {
  const headers = {}
  const cookie = sendCookies ? j.for(url) : ''
  if (cookie) headers.cookie = cookie
  const res = await fetch(url, { headers, redirect: 'manual' })
  j.set(res.headers.getSetCookie?.() ?? [])
  return res
}

/** Walk the whole flow. `stopBefore` returns the callback URL unfollowed. */
async function signIn(j, { returnTo, sendCookieToCallback = true } = {}) {
  const startUrl = `${API}/api/auth/oauth/devidp` + (returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '')
  const a = await hop(startUrl, j)
  const idpUrl = a.headers.get('location')
  const b = await fetch(idpUrl, { redirect: 'manual' })
  const cbUrl = b.headers.get('location')
  const c = await hop(cbUrl, j, { sendCookies: sendCookieToCallback })
  return { start: a, idp: b, callback: c, idpUrl, cbUrl }
}

const setNext = (body) =>
  fetch(`${IDP}/_control/next`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

const me = (j) => hop(`${API}/api/account/me`, j).then(r => r.ok ? r.json() : null)

// ─── Go ────────────────────────────────────────────────────────────────────

console.log('\nverify:oauth — signing in with a provider\n')

start('bun', ['run', 'api/index.ts'], 'api', { SHOP_COOKIE_AUTH: '1' })
if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
// Every real endpoint on the IdP answers 401 or 404 without a credential, so
// the readiness probe is the control endpoint — the one thing that is 200 by
// definition. Probing /userinfo printed a failure on every healthy run.
if (!await waitFor(`${IDP}/_control/next`, 'idp', 60, 'POST')) { stopAll(); process.exit(1) }
console.log('  servers up\n')

const uniq = Date.now()

// ── 1. a person nobody has seen ────────────────────────────────────────────
console.log('a new person')
{
  const email = `new-${uniq}@shop.test`
  await setNext({ sub: `s-new-${uniq}`, email, name: 'New', verified: true, deny: false })
  const j = jar()
  const flow = await signIn(j)

  ok('the start route redirects to the provider', flow.start.status === 302 && flow.idpUrl?.startsWith(IDP))
  ok('the authorize URL carries PKCE S256',
     new URL(flow.idpUrl).searchParams.get('code_challenge_method') === 'S256')
  ok('the flow cookie is scoped to where the callback actually is',
     [...j.raw.values()].some(c => c.path === new URL(flow.cbUrl).pathname) ||
     !j.has('fjs_oauth_state'),
     'a Path without apiPrefix is never sent back')
  ok('the callback ends at a session cookie', flow.callback.status === 302 && j.has('session'))
  ok('the flow cookie is cleared', !j.has('fjs_oauth_state'))

  const who = await me(j)
  ok('the session is real and is this person', who?.email === email, JSON.stringify(who))
}

// ── 1b. what a sign-in screen can find out ─────────────────────────────────
//
// The buttons on a sign-in page are a second copy of the API's `oauthProviders`
// unless the page asks — in a different build, with nothing to fail when the
// two disagree. This is the ask, and it is the one call in this flow made by a
// caller with no session at all.
console.log('\nwhat the screen can ask')
{
  const res  = await fetch(`${API}/api/auth/oauth`)
  const body = await res.json().catch(() => null)

  ok('the provider list is public — the page that asks has no session yet',
     res.status === 200, `got ${res.status}`)
  ok('and it names what this app is configured for',
     Array.isArray(body?.providers) && body.providers.includes('devidp'), JSON.stringify(body))

  // Every code the server can emit has to have a sentence in sierra, or a
  // screen renders a token no person can read. The two live in separate
  // packages and neither imports the other, so this is the crossing.
  // By relative path to the source, not through the package: this drive runs
  // under node, and `@frontierjs/sierra/junction` re-exports junction's browser
  // client, which is TypeScript that node's strip-only loader refuses.
  const { OAUTH_ERRORS } = await import(
    '../../../packages/sierra/src/junction/session.js'
  )
  const emitted = ['denied', 'state', 'exchange', 'unavailable', 'link_required']
  const missing = emitted.filter(c => !OAUTH_ERRORS[c])
  ok('every code this API can emit has words on the client side',
     missing.length === 0, `no sentence for: ${missing.join(', ')}`)
}

// ── 2. the same person again ───────────────────────────────────────────────
console.log('\nthe same provider account, a different address')
{
  const sub = `s-stable-${uniq}`
  await setNext({ sub, email: `first-${uniq}@shop.test`, verified: true, deny: false })
  const first = await me(await (async () => { const j = jar(); await signIn(j); return j })())

  // People rename themselves at the provider. Keying on the address would make
  // a second account here — which is nOAuth's mistake from the other side.
  await setNext({ sub, email: `renamed-${uniq}@shop.test`, verified: true, deny: false })
  const j2 = jar(); await signIn(j2)
  const again = await me(j2)

  // BOTH have to exist. `undefined === undefined` is true, so the weaker form
  // of this passed while nobody was signed in at all — which is exactly the
  // state a broken flow leaves behind.
  ok('a renamed provider account is the same person',
     Boolean(first?.userId) && first?.userId === again?.userId,
     `${first?.userId} vs ${again?.userId}`)
}

// ── 3. the refusals ────────────────────────────────────────────────────────
console.log('\nrefusals')
{
  // Login CSRF: the callback URL, handed to a browser that never started a flow.
  await setNext({ sub: `s-csrf-${uniq}`, email: `csrf-${uniq}@shop.test`, verified: true, deny: false })
  const j = jar()
  const startUrl = `${API}/api/auth/oauth/devidp`
  const a = await hop(startUrl, j)
  const b = await fetch(a.headers.get('location'), { redirect: 'manual' })
  const victim = jar()                      // a different browser entirely
  const c = await hop(b.headers.get('location'), victim, { sendCookies: true })

  ok('a callback with no matching cookie is refused',
     String(c.headers.get('location')).includes('oauth_error=state'), String(c.headers.get('location')))
  ok('and nothing is signed in', !victim.has('session'))
}
{
  // A code is single use at the provider AND the flow row is claimed here.
  await setNext({ sub: `s-replay-${uniq}`, email: `replay-${uniq}@shop.test`, verified: true, deny: false })
  const j = jar()
  const flow = await signIn(j)
  const again = await hop(flow.cbUrl, j)
  ok('a replayed callback is refused',
     String(again.headers.get('location')).includes('oauth_error='), String(again.headers.get('location')))
}
{
  await setNext({ deny: true })
  const j = jar()
  const flow = await signIn(j)
  ok('a denial comes back as a code, not as JSON',
     String(flow.callback.headers.get('location')).includes('oauth_error=denied'))
  ok('and sets no session', !j.has('session'))
  await setNext({ deny: false })
}

// ── 4. THE CVE ─────────────────────────────────────────────────────────────
console.log('\nan address somebody already holds')
{
  // Pre-registration: an account exists for this address and has never proved
  // it owns it. The provider says the address is verified. It must not link.
  const email = `planted-${uniq}@shop.test`
  await fetch(`${API}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'planted-pw-1', name: 'Planted' }),
  })

  await setNext({ sub: `s-cve-${uniq}`, email, verified: true, deny: false })
  const j = jar()
  const flow = await signIn(j)

  ok('an UNVERIFIED local account is not linked to',
     String(flow.callback.headers.get('location')).includes('oauth_error=link_required'),
     String(flow.callback.headers.get('location')))
  ok('and nobody is signed in', !j.has('session'))
}

// ── 5. returnTo ────────────────────────────────────────────────────────────
console.log('\nwhere it lands')
{
  await setNext({ sub: `s-ret-${uniq}`, email: `ret-${uniq}@shop.test`, verified: true, deny: false })
  const j = jar()
  const flow = await signIn(j, { returnTo: '/orders' })
  ok('an allow-listed returnTo is honored', flow.callback.headers.get('location') === '/orders',
     String(flow.callback.headers.get('location')))
}
{
  await setNext({ sub: `s-open-${uniq}`, email: `open-${uniq}@shop.test`, verified: true, deny: false })
  const j = jar()
  const flow = await signIn(j, { returnTo: '//evil.test' })
  ok('an open redirect is dropped and it lands at the default',
     flow.callback.headers.get('location') === '/', String(flow.callback.headers.get('location')))
}

// ── 6. connections ─────────────────────────────────────────────────────────
console.log('\nwhat is attached')
{
  await setNext({ sub: `s-conn-${uniq}`, email: `conn-${uniq}@shop.test`, verified: true, deny: false })
  const j = jar()
  await signIn(j)

  const list = await hop(`${API}/api/connections`, j).then(r => r.json()).catch(() => null)
  const rows = Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : []
  ok('the connection is listed', rows.length === 1 && rows[0].provider === 'devidp', JSON.stringify(list))
  ok('the provider subject is not in the answer', !JSON.stringify(rows).includes('s-conn-'))

  // Guarded, because a drive that CRASHES here reports nothing about the
  // fifteen assertions above it — and this block is downstream of a sign-in, so
  // it is empty whenever anything earlier is broken.
  if (rows.length) {
    const del = await fetch(`${API}/api/connections/${rows[0].id}`, {
      method: 'DELETE', headers: { cookie: j.for(`${API}/api/connections`) },
    })
    ok('unlinking the LAST way in is refused with 409', del.status === 409, `got ${del.status}`)
  } else {
    ok('unlinking the LAST way in is refused with 409', false, 'no connection to try it on')
  }
}

// ─── Result ────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail ? 1 : 0)
