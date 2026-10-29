#!/usr/bin/env node
// web/test/verify-sso.mjs — Basecamp's provider sign-in, in a browser.
//
//   bun web/test/verify-sso.mjs
//   API_PORT=7120 UI_PORT=7020 bun web/test/verify-sso.mjs   # beside a dev server
//
// Starts and stops its own database, identity provider stand-in, API, web
// server and Chrome. The provider is an OIDC one the drive serves itself, so
// nothing leaves the machine and nothing needs a real client id.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   `api/test/sso-env.test.ts` reads the environment and mounts the API; it
//   cannot say that the SAME variables, set on the web server's process,
//   reach `sierra.config.js` as `__BASECAMP_COOKIE_AUTH__`. Left false while
//   the API runs cookie sessions, a signed-in browser holds a session it
//   cannot find again: the page keeps no token and has no boot restore.
//
//   The button is asked of the API, so it appears only when the API's
//   environment names the provider; pressing it LEAVES THE PAGE, and the only
//   place to see where it went is the provider that was sent there.
//
//   A refused provider sign-in is a redirect back to /login/, so the alert is
//   the one screen that proves the code in the query reached the session.
//
// ─── Traps ───────────────────────────────────────────────────────────────
//
//   Backgrounding a server from a tool call is unreliable; this spawns, polls
//   until each answers, asserts, and kills.

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'
import { portFor } from '@frontierjs/cli/core/ports.js'

const HERE     = dirname(fileURLToPath(import.meta.url))
const PKG      = join(HERE, '..', '..')
const API_PORT = Number(process.env.API_PORT ?? await portFor(import.meta.url, 'be', { env: 'dev' }))
const WEB_PORT = Number(process.env.UI_PORT ?? await portFor(import.meta.url, 'fe', { env: 'dev' }))
const IDP_PORT = await portFor(import.meta.url, 'be', { env: 'dev', service: 2 })
const BASE     = `http://localhost:${WEB_PORT}`
const API      = `http://localhost:${API_PORT}`
const IDP      = `http://localhost:${IDP_PORT}`
const EMAIL    = 'dev@knight.works'
const PASSWORD = 'test1234'
const TOKEN_KEY = 'basecamp_token'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
let passed = 0, failed = 0
let browser = null
let idp = null

function ok(label)          { passed++; console.log(`  ✓ ${label}`) }
function bad(label, detail) { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail) }

// The GROUP, not the child: `bun run web` spawns vite, so killing the direct
// child leaves the server holding its port.
async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill?.() } catch {} } }
  await sleep(500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  idp?.stop(true)
  await browser?.close()
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup().then(() => process.exit(130)))

for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT], ['identity provider', IDP_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

// The provider: records what the browser was sent with, then answers the way a
// person refusing the consent screen would — a redirect back with the state it
// was handed and `error=access_denied`.
const authorizeRequests = []
idp = Bun.serve({
  port: IDP_PORT,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== '/authorize') return new Response('not found', { status: 404 })
    authorizeRequests.push(Object.fromEntries(url.searchParams))
    const back = new URL(url.searchParams.get('redirect_uri'))
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('state', url.searchParams.get('state') ?? '')
    return Response.redirect(back.href, 302)
  },
})

const SCRATCH = mkdtempSync(join(tmpdir(), 'basecamp-sso-'))
const DB      = join(SCRATCH, 'basecamp.db')
const dbEnv   = { DATABASE_URL: DB, AUDIT_PATH: join(SCRATCH, 'audit.db') }
// Both processes read the SAME variables: the API for the provider list and
// cookie mode, vite for the define that is cookie mode's twin in the page.
const ssoEnv  = {
  OIDC_CLIENT_ID: 'basecamp-drive', OIDC_CLIENT_SECRET: 'drive-secret',
  OIDC_AUTHORIZE_URL: `${IDP}/authorize`, OIDC_TOKEN_URL: `${IDP}/token`, OIDC_USERINFO_URL: `${IDP}/userinfo`,
}

const seed = spawn('bun', ['db/seed.js'], { cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...dbEnv } })
let seedErr = ''
seed.stderr.on('data', d => { seedErr += d })
if (await new Promise(r => seed.on('exit', r)) !== 0) fail(`db/seed.js failed\n${seedErr}`)

children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, ...dbEnv, ...ssoEnv, FRONTIER_APP_URL: BASE, FRONTIER_PORT_BE: String(API_PORT), LOCAL_MACHINE: '1' },
}))
children.push(spawn('bun', ['run', 'web'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, ...ssoEnv, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) },
}))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) { try { await fetch(url); return } catch {} await sleep(500) }
  fail(`${label} never answered ${url}`)
}
await waitFor(`${API}/health`, 'the API')
await waitFor(BASE, 'the web server')

browser = await openChrome().catch(async (e) => { console.error(`\n✗ ${e.message}\n`); await cleanup(); process.exit(1) })
const send = browser.cmd

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
async function until(expression, predicate, label, ms = 20_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression).catch(() => undefined)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 200)}`)
}
const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }
const fill = fields => evaluate(`(() => { ${Object.entries(fields).map(([id, v]) =>
  `{ const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}
     el.dispatchEvent(new Event('input', { bubbles: true })) }`).join('\n')} })()`)

try {
  console.log('\n  The API names its providers')
  const listed = await fetch(`${API}/auth/oauth`).then(r => r.json())
  check('GET /auth/oauth lists the one the environment configured', JSON.stringify(listed.providers) === '["oidc"]', JSON.stringify(listed))

  console.log('\n  The login screen draws a button per provider')
  await goto('/login/')
  await until(`!!document.getElementById('email')`, v => v, 'the sign-in form never rendered')
  const buttons = await until(`[...document.querySelectorAll('[data-oauth]')].map(b => b.dataset.oauth)`,
    v => v?.length > 0, 'no provider button was drawn')
  check('one button, for the provider the API listed', JSON.stringify(buttons) === '["oidc"]', JSON.stringify(buttons))
  check('the password form is still there beside it', await evaluate(`!!document.getElementById('password')`))

  console.log('\n  The page runs cookie sessions, the twin of the API')
  await fill({ email: EMAIL, password: PASSWORD })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/', 'password sign-in never landed on the overview')
  ok('a password still signs in with a provider configured')
  check('and the page holds no bearer token', (await evaluate(`localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`)) === null,
    'cookieAuth never reached sierra.config.js, so the client stored a token the API never sent')
  await goto('/')
  await sleep(800)
  check('a reload is still signed in, restored from the cookie', await evaluate(`location.pathname`) === '/',
    await evaluate(`location.pathname`))
  await evaluate(`fetch('/auth/logout', { method: 'POST' }).then(() => true)`)

  console.log('\n  The button leaves the page for the provider')
  await goto('/login/')
  await until(`!!document.querySelector('[data-oauth=oidc]')`, v => v, 'the provider button never rendered')
  await evaluate(`document.querySelector('[data-oauth=oidc]').click()`)
  await until(`location.pathname`, p => p === '/login/', 'the provider refusal never came back to the login screen', 30_000)
  const asked = authorizeRequests[0]
  check('the provider was sent here', !!asked, 'the provider was never asked')
  check('as the client the environment named', asked?.client_id === 'basecamp-drive', JSON.stringify(asked))
  check('with a state to check on the way back', (asked?.state ?? '').length >= 16, JSON.stringify(asked))
  check('and a callback on the origin the browser sees', asked?.redirect_uri?.startsWith(`${BASE}/auth/`), asked?.redirect_uri)

  console.log('\n  A refused sign-in is said on the login screen')
  await until(`!!document.getElementById('oauth-alert')`, v => v, 'the refusal never drew its alert')
  const alert = await evaluate(`document.getElementById('oauth-alert').textContent.replace(/\\s+/g, ' ').trim()`)
  check('the alert carries the reason, not an empty box', alert.length > 0, alert)
  check('the password form is back to try again', await evaluate(`!!document.getElementById('password')`))
} catch (e) {
  bad('the drive stopped', e.message)
}

await cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
