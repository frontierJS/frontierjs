#!/usr/bin/env node
// web/test/verify-provision.mjs — Basecamp makes a machine at a cloud.
//
//   bun web/test/verify-provision.mjs
//
// The flow the mockup promised and nothing here ran: choose an account, read
// that account's own regions and sizes, see what it will cost, and press a
// button that spends money. Then the machine boots, enrolls itself, and the
// screen follows along.
//
// Starts and stops EVERYTHING itself — a scratch database in a temp directory,
// the DigitalOcean stand-in, the API, the web server and Chrome — so it touches
// nothing local and never asks anybody to reset a dev fleet.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   A picker is offering the VENDOR's list. Every unit test here hands the
//   connector a canned answer, so *the catalog reached a <select>* is a claim
//   no test on either side can make: the service could answer correctly and the
//   screen could render a hardcoded list, and both halves would be green.
//
//   The spend guard is not in the way of the thing it protects. `sendVia`
//   refuses a POST at a non-loopback address, and a guard that also refused the
//   stand-in would look exactly like a working one to every test that only asks
//   about the refusal. This drive provisions for real, through the guard.
//
//   The machine arrives ON ITS OWN. Every other test moves the droplet by
//   calling `sinkBoot`; here the sink is a separate process with
//   `DO_SINK_BOOT_MS` set, so the row moves `provisioning → installing` because
//   a job polled a vendor and found an address — with nothing in the browser
//   asking, which is the claim the live progress strip makes.
//
//   The enrollment route is reachable. It answers 405 to a path parameter
//   spelled `:id` and every function behind it stays correct, which is how it
//   shipped unreachable; here a real curl-shaped POST goes at it.
//
// ─── Traps this file has already paid for ────────────────────────────────
//
//   Setting `.value` on an input does not notify Mesa — it listens for `input`.
//   `--headless=new` delivers almost no rendering lifecycle after load, so
//   everything is polled rather than slept on.
//   Backgrounding a server from a tool call is unreliable; this spawns, polls
//   until each answers, asserts, and kills.

import { spawn } from 'node:child_process'
import { mkdtempSync, appendFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE      = dirname(fileURLToPath(import.meta.url))
const PKG       = join(HERE, '..', '..')
const CHROME    = process.env.FJS_CHROME ?? 'google-chrome'
const API_PORT  = 8120
const WEB_PORT  = 8020
const SINK_PORT = 7122          // test tier, basecamp, the DO stand-in
const HZ_PORT   = 7124          // …and the Hetzner one, the next slot along
const BASE      = `http://localhost:${WEB_PORT}`
const API       = `http://localhost:${API_PORT}`
const SINK      = `http://localhost:${SINK_PORT}`
const HZ_SINK   = `http://localhost:${HZ_PORT}`
const EMAIL     = 'sam@example.com'
const PASSWORD  = 'hunter2hunter2'
const DO_TOKEN  = 'dop_v1_devtoken'
// 64 characters and no prefix, which is Hetzner's shape and not DigitalOcean's.
const HZ_TOKEN  = 'hz'.padEnd(64, '0')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
let passed = 0, failed = 0

function ok(label)          { passed++; console.log(`  ✓ ${label}`) }
function bad(label, detail) { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail) }

// The GROUP, not the child. `bun run web` spawns vite and `bun api/index.ts`
// spawns the app, so killing the direct child leaves the server holding its
// port — the next run then either refuses to start or, worse, is answered by
// the process that never went away. Every child here is spawned detached for
// exactly this: `-pid` is its group.
async function cleanup() {
  for (const c of children) {
    try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill?.() } catch {} }
  }
  await sleep(500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }

// ─── A database of its own ───────────────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), 'basecamp-provision-'))
const DB      = join(SCRATCH, 'basecamp.db')

console.log('\nBasecamp — provisioning a machine\n')
console.log(`  seeding ${DB}`)

const seed = spawn('bun', ['db/seed.js'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, DATABASE_URL: DB, AUDIT_PATH: join(SCRATCH, 'audit/') },
})
let seedErr = ''
seed.stderr.on('data', d => { seedErr += d })
const seedCode = await new Promise(r => seed.on('exit', r))
if (seedCode !== 0) fail(`db/seed.js exited ${seedCode}\n${seedErr}`)

// ─── No cloud account, to start with ─────────────────────────────────────
// `db/seed.js` writes provider keys of its own — a fleet with nothing in it
// teaches you nothing about the UI. They are removed here for two reasons and
// both are assertions below: the EMPTY state is the one a fresh install is in
// and is where this feature was undiscoverable, and with them gone the account
// this drive makes is the only one, so a picker offering it cannot be confused
// with a picker offering somebody else's.
{
  const { Database } = await import('bun:sqlite')
  const db = new Database(DB)
  db.run("DELETE FROM secret WHERE kind = 'provider_key'")
  db.close()
}

// ─── Refuse a port that already answers ──────────────────────────────────
for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT],
                            ['DO sink', SINK_PORT], ['Hetzner sink', HZ_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

// ─── The cloud ───────────────────────────────────────────────────────────
// A separate PROCESS, not an in-process fake. The token is really read off an
// Authorization header conduit really wrote, from a Secret that was really
// decrypted — and the created droplet really comes up a few seconds later
// rather than being moved by a function call.
const sinkProc = spawn('bun', ['api/src/providers/compute/digitalocean-sink.ts'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  env: { ...process.env, DO_SINK_PORT: String(SINK_PORT), DO_SINK_BOOT_MS: '4000' },
})
children.push(sinkProc)
// The stand-in names what it refused. A credential mistake otherwise arrives
// here as the vendor's own opaque 401 and there is nothing to look at.
const sinkRefusals = []
sinkProc.stderr.on('data', d => { const t = String(d); if (/refused/.test(t)) sinkRefusals.push(t.trim()) })

// The SECOND cloud, and a second process for the reason the first one is one:
// two vendors answered by one listener would share a router and an error shape,
// which is exactly what a second connector is here to disprove.
const hzProc = spawn('bun', ['api/src/providers/compute/hetzner-sink.ts'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  env: { ...process.env, HZ_SINK_PORT: String(HZ_PORT), HZ_SINK_BOOT_MS: '4000' },
})
children.push(hzProc)
hzProc.stderr.on('data', d => { const t = String(d); if (/refused/.test(t)) sinkRefusals.push(t.trim()) })

const api = spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: {
    ...process.env,
    DATABASE_URL: DB, APP_URL: BASE, AUDIT_PATH: join(SCRATCH, 'audit/'),
    // What points the connector at the stand-in. Loopback, so `sendVia`'s
    // spend guard allows the POST without `ALLOW_CLOUD_SPEND` — which is the
    // guard's own claim and is asserted below rather than assumed.
    DIGITALOCEAN_URL: SINK,
    HETZNER_URL:      HZ_SINK,
  },
})
children.push(api)
// A credential that resolves to nothing is answered by the vendor as an opaque
// 401. `core/credentials.ts` names which of the four ways it failed; this is
// what puts that sentence in front of whoever is reading this drive's output.
const apiWarnings = []
const apiErrors   = []
// `FJS_DRIVE_LOG=<path>` tees the app's own output somewhere readable. Not on
// by default and not needed for a pass — but when this drive fails, the API's
// own sentence about what it refused is usually the whole answer, and it is
// otherwise thrown away with the process.
api.stdout.on('data', d => {
  if (process.env.FJS_DRIVE_LOG) appendFileSync(process.env.FJS_DRIVE_LOG, String(d))
})
api.stderr.on('data', d => {
  const t = String(d)
  if (process.env.FJS_DRIVE_LOG) appendFileSync(process.env.FJS_DRIVE_LOG, t)
  if (/\[credentials\]/.test(t)) apiWarnings.push(t.trim())
  // Anything the app logged as a failure. A service that refused a call
  // answers the browser, and the browser may or may not render it — this is
  // the side that always has the sentence.
  for (const line of t.split('\n'))
    if (/"level":"(error|warn)"|failed/.test(line)) apiErrors.push(line.slice(0, 400))
})
children.push(spawn('bun', ['run', 'web'], { cwd: PKG, stdio: 'ignore', detached: true }))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) {
    try { await fetch(url); return } catch {}
    await sleep(500)
  }
  fail(`${label} never answered ${url}`)
}
await waitFor(`${SINK}/v2/account`, 'the DigitalOcean stand-in')
await waitFor(`${API}/health`, 'the API')
await waitFor(BASE, 'the web server')

// ─── Chrome ──────────────────────────────────────────────────────────────
const PROFILE = mkdtempSync(join(tmpdir(), 'basecamp-provision-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`,
  '--window-size=1280,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
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
if (!target) fail(`No Chrome debug target on :${cdpPort}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))

let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}, ms = 30_000) => new Promise((res, rej) => {
  const n = ++msgId
  const timer = setTimeout(() => {
    pending.delete(n)
    rej(new Error(`CDP ${method} timed out after ${ms}ms`))
  }, ms)
  pending.set(n, msg => { clearTimeout(timer); res(msg) })
  ws.send(JSON.stringify({ id: n, method, params }))
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const ex = r.result?.exceptionDetails
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex))
  return r.result?.result?.value
}

/** Poll until an expression settles rather than sleeping a guessed amount. */
async function until(expression, predicate, label, ms = 20_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 200)}`)
}

const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }
const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
const body = () => evaluate(`document.body.textContent`)
const click = sel => evaluate(`
  (() => { const el = document.querySelector(${JSON.stringify(sel)})
           if (!el) throw new Error('no ' + ${JSON.stringify(sel)})
           el.click(); return true })()`)
const fill = fields => evaluate(`
  (() => {
    ${Object.entries(fields).map(([id, v]) =>
      `{ const el = document.getElementById(${JSON.stringify(id)})
         if (!el) throw new Error('no field #${id} on ' + location.pathname)
         el.value = ${JSON.stringify(v)}
         el.dispatchEvent(new Event('input', { bubbles: true }))
         el.dispatchEvent(new Event('change', { bubbles: true })) }`).join('\n    ')}
  })()`)

/** The options a <select> is actually offering, by value. */
const options = id => evaluate(
  `[...document.getElementById(${JSON.stringify(id)}).options].map(o => o.value).filter(Boolean)`)

/**
 * Watch what the page SENDS, not what its DOM shows. For a textarea the value
 * property and the child text diverge the moment either is written, so reading
 * a box back says nothing about the record a form will submit — which is the
 * difference between the token being on screen and it being in the payload.
 *
 * The SOCKET is hooked as well as fetch, and that is the half that matters:
 * Junction sends over a WebSocket whenever one is connected and falls back to
 * HTTP, so an instrument watching fetch alone would report that this app sends
 * nothing at all.
 *
 * Re-installed after every full page load, because Page.navigate throws the
 * window away and a hook installed once quietly stops recording.
 */
async function instrument() {
  await evaluate(`
    (() => {
      if (window.__sent) return
      window.__sent = []
      const orig = window.fetch
      window.fetch = async (input, init) => {
        try {
          const url  = typeof input === 'string' ? input : input?.url
          const body = init?.body
          if (typeof body === 'string') window.__sent.push({ via: 'http', url, body })
        } catch {}
        return orig(input, init)
      }
      window.__recv = []
      // A rejected promise nobody awaited. goto is async and callers do not
      // await it, so a navigation that fails is silent in the console AND
      // invisible to a check that only asks where the page ended up.
      window.__unhandled = []
      addEventListener('unhandledrejection', e => {
        try { window.__unhandled.push(String(e.reason?.stack ?? e.reason)) } catch {}
      })
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === 'string') window.__sent.push({ via: 'ws', body: data })
          // The ANSWER, once per socket. A call that was sent and never landed
          // is either still pending or was answered with something the page did
          // not act on, and only the reply tells the two apart.
          if (!this.__watched) {
            this.__watched = true
            window.__sockets = (window.__sockets ?? 0) + 1
            this.addEventListener('message', e => {
              try { if (typeof e.data === 'string') window.__recv.push(e.data) } catch {}
            })
            // A socket that CLOSES mid-call answers nothing and looks exactly
            // like a server that never replied.
            this.addEventListener('close', e => {
              try { window.__recv.push('[close] code=' + e.code + ' reason=' + e.reason) } catch {}
            })
            this.addEventListener('error', () => {
              try { window.__recv.push('[error]') } catch {}
            })
          }
        } catch {}
        return send.call(this, data)
      }
    })()`)
}

/**
 * What the page the redirect was aiming at actually says, loaded directly.
 *
 * The created row's id comes off the socket reply rather than the URL, because
 * the URL is exactly what did not change. A route module that fails to compile
 * renders Sierra's own error overlay here and nothing anywhere else.
 */
async function destinationSays() {
  const id = await evaluate(`(() => {
    const hit = (window.__recv ?? []).find(r => /service_result/.test(r) && /"status"/.test(r))
    if (!hit) return ''
    try { return JSON.parse(hit).result?.id ?? '' } catch { return '' }
  })()`)
  if (!id) return '(no created row on the socket to aim at)'
  await send('Page.navigate', { url: `${BASE}/servers/${id}/` })
  await sleep(2500)
  return String(await body()).replace(/\s+/g, ' ').slice(0, 220)
}

const consoleErrors = []
await send('Runtime.enable')
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    const t = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
    if (/favicon|\[vite\]|Download the .* DevTools/i.test(t)) return
    consoleErrors.push(t)
  }
})

try {
  // ─── Sign in ───────────────────────────────────────────────────────────
  await goto('/login/')
  await until(`!!document.getElementById('email')`, v => v, 'the sign-in form never rendered')
  await fill({ email: EMAIL, password: PASSWORD })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/', 'sign-in never landed on the overview')
  ok('signed in as the seeded owner')

  // ─── Getting there at all ──────────────────────────────────────────────
  // The half that was broken and had nothing to do with the code: a person
  // could not find this feature. One button said "Add server" and whether it
  // provisioned was decided by a dropdown four fields down.
  console.log('\n  /servers/ — two acts, two buttons')
  await goto('/servers/')
  const buttons = await evaluate(
    `[...document.querySelectorAll('.section-header a, .section-header button')].map(e => e.textContent.trim())`)
  check('the list offers provisioning by name', buttons.some(b => /provision a machine/i.test(b)), buttons.join(' | '))
  check('and importing as a separate act', buttons.some(b => /import existing/i.test(b)), buttons.join(' | '))

  // ─── The empty state, which is what a fresh install shows ──────────────
  await goto('/servers/provision/')
  await until(`!!document.getElementById('no-accounts') || !!document.getElementById('account')`, v => v,
    'the provision screen never settled')
  check('with no cloud account it says so, rather than showing a dead picker',
    await evaluate(`!!document.getElementById('no-accounts')`))
  const empty = await text('#no-accounts')
  check('…and points at the Secret that fixes it', /provider key/i.test(empty ?? ''), empty?.replace(/\s+/g, ' ').slice(0, 140))
  check('…and at importing, for somebody who has a machine already',
    await evaluate(`!!document.querySelector('#no-accounts a[href="/servers/import/"]')`))

  // ─── The account ───────────────────────────────────────────────────────
  // An account is a `Secret` of kind `provider_key` that NAMES a cloud. Made
  // through the screen rather than written into the database, because the
  // schema's `@@check` refuses one that names no cloud and the field that
  // satisfies it has to exist on the form — a check with no way to answer it is
  // a kind somebody can choose and never save.
  console.log('\n  /secrets/ — an account at a cloud')
  await goto('/secrets/')
  await click('#new-secret')
  await until(`!!document.getElementById('kind')`, v => v, 'the secret form never opened')

  // What the page SENDS, not what its DOM shows. For a `<textarea>` the value
  // property and the child text diverge the moment either is written, so
  // reading the box back says nothing about the record the form will submit —
  // which is the difference between *the token is on screen* and *the token is
  // in the payload*.
  //
  // The SOCKET is hooked as well as fetch, and that is the half that matters:
  // Junction sends over a WebSocket whenever one is connected and falls back to
  // HTTP, so an instrument that watched `fetch` alone would report that this
  // app sends nothing at all.
  await instrument()


  await fill({ name: 'do-main', kind: 'provider_key' })
  await until(`!!document.getElementById('providerKind')`, v => v,
    'choosing provider_key never revealed the cloud field')
  ok('choosing "provider key" asks which cloud — the column the @@check requires')

  const clouds = await options('providerKind')
  // Read off the schema's own enum, and `custom` is filtered: a provider key at
  // no provider is exactly what the check refuses.
  check('the clouds offered come from the schema, without the one that means none',
    clouds.includes('digitalocean') && !clouds.includes('custom'), clouds.join(', '))

  // The refusal FIRST, and it is a pair with the save below: a form that
  // refused everything would satisfy any assertion about the refusal alone.
  await fill({ data: JSON.stringify({ token: DO_TOKEN }) })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`!!document.getElementById('screen-error')`, v => v,
    'a provider key naming no cloud was accepted')
  const refusal = await text('#screen-error')
  check('a provider key naming no cloud is refused, and the message names the field',
    /providerKind|which cloud/i.test(refusal ?? ''), refusal)

  // A value typed into a write-only field must survive a refusal. It cannot be
  // read back from the API by design, so losing it on a rejected submit means
  // retyping a credential with nothing on screen saying it is gone — and the
  // second attempt then stores an EMPTY token, which fails later at the vendor
  // as an authentication error nobody can trace back to this form.
  const kept = await evaluate(`document.getElementById('data')?.value ?? ''`)
  check('the token typed survives the refusal — it cannot be read back to check',
    kept.includes('dop_v1_'), kept ? `held ${kept.length} chars` : '(empty)')

  await fill({ providerKind: 'digitalocean' })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`document.body.textContent.includes('do-main')`, v => v,
    'the secret never appeared in the list')
  ok('and with the cloud named it is stored')

  // ─── The wizard reads the VENDOR ───────────────────────────────────────
  console.log('\n  /servers/provision/ — the catalog is the account\'s')
  await goto('/servers/provision/')
  await until(`!!document.getElementById('account')`, v => v, 'the create form never rendered')
  await instrument()

  const accounts = await evaluate(
    `[...document.getElementById('account').options].map(o => o.textContent.trim())`)
  check('the account appears, named with its cloud',
    accounts.some(a => a.includes('do-main') && a.includes('digitalocean')), accounts.join(' | '))

  // One account is not a choice, so the screen makes it. Asserted rather than
  // assumed: without it a person adds their only cloud account and lands on a
  // picker asking them to pick it.
  const preselected = await evaluate(`document.getElementById('account').value`)
  check('a workspace with ONE account has it chosen already', !!preselected, `value=${preselected}`)

  // BY NAME, never by position. A seeded workspace can already hold a provider
  // key, and taking the first option would silently drive the whole rest of
  // this file against somebody else's account.
  const accountId = await evaluate(
    `[...document.getElementById('account').options].find(o => o.textContent.includes('do-main'))?.value ?? ''`)
  check('and it is the account this drive made that gets chosen', !!accountId)
  await fill({ account: accountId })

  // The failure here is almost always the CATALOG READ rather than the picker,
  // so the wait reports what the screen said instead of `false`.
  await until(`(() => {
      const err = document.getElementById('catalog-error')
      if (err) return 'catalog-error: ' + err.textContent.trim()
      const r = document.getElementById('region')
      if (!r) return 'no #region'
      return r.options.length > 1 ? true : 'region has ' + r.options.length + ' options'
    })()`, v => v === true,
    'the catalog never reached the region picker'
      + (apiWarnings.length ? ` | ${apiWarnings[0]}` : '')
      + (sinkRefusals.length ? ` | ${sinkRefusals[0]}` : ''), 25_000)
  ok('choosing an account reads that cloud, and the regions arrive')

  const regions = await options('region')
  // The vendor's own list, and the whole claim: a hardcoded picker passes every
  // unit test on either side of this.
  check('the regions offered are the ones the vendor answered',
    regions.includes('nyc3') && regions.includes('fra1'), regions.join(', '))
  // `ams2` is in the stand-in's list and is `available: false`. A picker
  // offering it is a create that fails at the vendor with a message nobody here
  // wrote — this is the pair that separates *rendered the list* from *rendered
  // the right list*.
  check('and a region the vendor marks unavailable is NOT offered',
    !regions.includes('ams2'), regions.join(', '))

  // ─── A size belongs to a region ────────────────────────────────────────
  await fill({ region: 'nyc3' })
  await until(`document.getElementById('size').options.length > 1`, v => v,
    'sizes never arrived for nyc3')
  const nyc = await options('size')
  check('nyc3 offers the CPU-optimized size', nyc.includes('c-4'), nyc.join(', '))

  await fill({ region: 'fra1' })
  await until(`[...document.getElementById('size').options].map(o => o.value).join(',')`,
    v => !v.includes('c-4'), 'fra1 went on offering a size it does not have')
  const fra = await options('size')
  check('fra1 does not — the picker narrows by region, both ways',
    !fra.includes('c-4') && fra.includes('s-2vcpu-4gb'), fra.join(', '))

  // ─── What it costs, before it is spent ─────────────────────────────────
  // One field at a time, waiting for each to take. Choosing a region CLEARS the
  // size and re-renders its options, so setting both in one pass writes a value
  // the select does not yet offer — which a <select> answers by staying empty,
  // silently, and the submit below is then disabled for a reason nothing says.
  await fill({ region: 'nyc3' })
  await until(`[...document.getElementById('size').options].map(o => o.value).includes('s-2vcpu-4gb')`,
    v => v, 'nyc3 never offered the size again')

  // The button is DISABLED until a provision has everything it costs money to
  // get wrong. Asserted here, one field short, because a submit that fell back
  // to `create` on a missing field would record a machine nobody made.
  // The name is filled FIRST so the halfway assertion is about the size and the
  // image. With it blank the button is disabled for a reason this row does not
  // mean, and the check would pass against a screen that never arms at all.
  await fill({ name: 'drive-web-01' })
  const halfway = await evaluate(`document.querySelector('form button[type=submit]').disabled`)
  check('the submit is refused while the machine is only half chosen', halfway === true, `disabled=${halfway}`)

  await fill({ size: 's-2vcpu-4gb' })
  await fill({ image: 'ubuntu-24-04-x64' })
  await until(`!!document.getElementById('provision-cost')`, v => v,
    'the cost line never appeared')
  const cost = await text('#provision-cost')
  // $24.00/month is the stand-in's `price_monthly: 24`, crossed as minor units
  // and formatted by the currency's own divisor. A number typed into this
  // screen would read the same and mean nothing.
  check('the cost line quotes the vendor\'s own price', /24\.00/.test(cost ?? ''), cost?.trim())
  check('and says plainly that this creates a machine and starts billing',
    /creates a machine/i.test(cost ?? '') && /billing/i.test(cost ?? ''))

  const label = await evaluate(`document.querySelector('form button[type=submit]').textContent.trim()`)
  // One act per screen now, so the button states it flatly instead of inferring
  // it from a dropdown four fields up.
  check('the button names the act, and it is the only one this screen does',
    label === 'Provision machine', label)

  // ─── Provision ─────────────────────────────────────────────────────────
  // Through the spend guard, for real. `sendVia` refuses a POST at anything
  // that is not loopback and the stand-in is on localhost, so this is the only
  // assertion that the guard is not also in the way of the thing it protects.
  console.log('\n  provisioning')
  const armed = await evaluate(`!document.querySelector('form button[type=submit]').disabled`)
  check('and offered once every one of them is answered', armed === true)
  await evaluate(`document.querySelector('form button[type=submit]').click()`)

  // A rejected promise nobody holds. Measured against the real fault this file
  // paid for and it does NOT catch that one — sierra absorbs the rejection
  // somewhere between `goto` and here — so it is a general guard and not a
  // tripwire for `FJS-1026`. Kept, and its limit stated, because an assertion
  // believed to cover something it does not is worse than no assertion.
  await sleep(2500)
  const unhandled = await evaluate(`JSON.stringify(window.__unhandled ?? [])`)
  check('nothing rejected with nobody holding it',
    unhandled === '[]', String(unhandled).slice(0, 300))

  // The refusal, if there is one, is on the page — reported instead of a bare
  // the provision path, which says only that nothing happened.
  await until(`(() => {
      const p = location.pathname
      if (/^\\/servers\\/[0-9a-f-]{36}\\/$/.test(p)) return true
      // The form's own id, never the alert-danger class: the shell's
      // fleet-notice bar wears the same classes, and the seed leaves an
      // unreachable machine sitting in it. (No backticks in here -- this is
      // inside a template literal and one would close it.)
      const err = document.querySelector('#form-error .alert-content')
      return err ? 'refused: ' + err.textContent.trim() : p
    })()`, v => v === true,
    'provisioning never landed on the machine'
      + ` | sent: ${String(await evaluate('JSON.stringify((window.__sent ?? []).map(s => s.body).filter(b => /provision/.test(b)))')).slice(0, 400)}`
      + ` | recv=${(await evaluate('(window.__recv ?? []).length')) ?? '?'}`
      + ` | sent ${await evaluate('(window.__sent ?? []).length')}, received ${await evaluate('(window.__recv ?? []).length')}`
      + (consoleErrors.length ? ` | console: ${consoleErrors.slice(-1)[0].slice(0, 200)}` : '')
      + (apiErrors.length ? ` | api: ${apiErrors.slice(-1)[0].slice(0, 200)}` : '')
      // The DESTINATION, loaded directly. `goto` awaits the route module's
      // dynamic import and its callers do not await `goto`, so a route whose
      // module throws reads here as *nothing happened* with no error anywhere.
      // Loading it as a full page is the only thing that says which — and it is
      // what diagnosed `FJS-1025` after an hour of looking at the wrong half.
      + ` | destination: ${await destinationSays()}`, 30_000)
  const serverPath = await evaluate(`location.pathname`)
  const serverId   = serverPath.split('/')[2]
  ok('it lands on the machine it just asked for')

  const status0 = await until(`document.getElementById('server-status')?.textContent?.trim()`,
    v => !!v, 'the status pill never rendered')
  check('which exists at `provisioning` before any cloud has answered',
    status0 === 'provisioning', status0)

  const flight = await text('#server-inflight')
  check('and says what it is waiting for, in words a person would use',
    /asking the provider/i.test(flight ?? ''), flight?.trim()?.slice(0, 120))

  // ─── The machine arrives, and the screen follows ───────────────────────
  // Nothing here refreshes. The row is WATCHED, so this moves because a job in
  // another process polled a vendor, found an address and transitioned the row
  // — which is the whole claim of the progress strip above it.
  const status1 = await until(`document.getElementById('server-status')?.textContent?.trim()`,
    v => v === 'installing', 'the row never reached installing', 60_000)
  check('the row reaches `installing` with nothing in the browser asking', status1 === 'installing')

  const addr = await until(`document.body.textContent`, t => /203\.0\.113\./.test(t),
    'the address the vendor gave never reached the screen', 20_000)
  check('carrying the address the vendor gave it', /203\.0\.113\./.test(addr))

  const trail = await text('#server-events')
  check('and the trail says what was asked for',
    /s-2vcpu-4gb/.test(trail ?? '') && /nyc3/.test(trail ?? ''), trail?.replace(/\s+/g, ' ').slice(0, 160))

  // ─── The machine comes online, and the open page follows ───────────────
  //
  // This drive stands in for the machine. Every step below is one cloud-init
  // takes: read the token the vendor's metadata service handed it, exchange it
  // once for a credential of its own, then sign with THAT.
  //
  // The token is the REAL one — read out of the dispatched job's payload, which
  // is where `servers.provision` put it and the only place it exists outside
  // the machine. Minting a second token here would prove the enrollment route
  // works and say nothing about whether the token cloud-init actually carries
  // does.
  console.log('\n  the machine enrolls and comes online')
  const enrollToken = await (async () => {
    const { Database } = await import('bun:sqlite')
    const jobs = new Database(DB.replace('.db', '-jobs.db'), { readonly: true })
    const row = jobs.query(
      "SELECT data FROM jobs WHERE name = 'server:provision' ORDER BY created_at DESC LIMIT 1").get()
    jobs.close()
    try { return JSON.parse(row?.data ?? '{}').enrollToken ?? '' } catch { return '' }
  })()
  check('the token cloud-init carries is the one the app dispatched',
    /^bcen_[0-9a-f]{64}$/.test(enrollToken), enrollToken ? 'shaped wrong' : '(none found)')

  const enrolled = await fetch(`${API}/servers/${serverId}/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: enrollToken }),
  })
  const credential = (await enrolled.json()).secret
  check('the exchange hands back a credential of its own', enrolled.status === 200 && !!credential)

  /** A heartbeat, signed the way the outpost on that machine signs one. */
  async function heartbeat(secret) {
    const { signRequest } = await import('@frontierjs/toolbelt/signature')
    const body = JSON.stringify({ outpost_version: '0.4.1', health: { cpu: 4, memory: 12 } })
    const path = `/servers/${serverId}`
    const headers = await signRequest({
      secret, method: 'POST', path, query: '', body,
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
    return fetch(API + path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-service-method': 'heartbeat' },
      body,
    })
  }

  // The FLEET key first, and it must be refused. That is the property the whole
  // per-machine credential exists for: one string every machine holds must not
  // open this machine's door. Asserted BEFORE the acceptance, so a run that
  // stopped here could not be read as a pass.
  const fleet = await heartbeat('outpost-dev-secret')
  check('the fleet-wide key is REFUSED for a machine that has its own',
    fleet.status === 401, `${fleet.status}`)

  const own = await heartbeat(credential)
  check('and its own credential is accepted', own.status === 200, `${own.status}`)

  // The half only a browser can ask. The page has been open since before the
  // machine existed; nothing here reloads it.
  const online = await until(`document.getElementById('server-status')?.textContent?.trim()`,
    v => v === 'online', 'the open page never saw the machine come online', 20_000)
  check('the page that has been open all along says `online`', online === 'online')
  check('and the progress strip is gone, because nothing is in flight now',
    await evaluate(`!document.getElementById('server-inflight')`))

  // ─── The machine enrolls itself ────────────────────────────────────────
  // Over real HTTP at the real route, with no session, no signature and no
  // principal — which is what cloud-init has. This route answered 405 to
  // everything for its whole life because the path parameter was spelled `:id`,
  // and every function behind it was correct.
  console.log('\n  enrollment')
  const wrong = await fetch(`${API}/servers/${serverId}/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'bcen_not_the_one' }),
  })
  check('a wrong token is refused by the route — which is REACHED, not 405',
    wrong.status === 401, `${wrong.status}`)

  // ─── A second cloud, on the same screen ────────────────────────────────
  //
  // Everything above is one vendor, and a wizard driven by one vendor cannot
  // say whether it reads a catalog or knows DigitalOcean. This is the same
  // screen against Hetzner, and nothing in it was changed to make that work.
  //
  // Two things live only here. A price is per LOCATION at Hetzner, so the SAME
  // size in two regions is two figures — which no assertion at DigitalOcean can
  // make, because its price does not move. And it is the first non-dollar
  // currency this app has ever rendered, so the divisor being the currency's
  // stops being a comment and becomes a number on a screen.
  console.log('\n  a second cloud — the same wizard, a different vendor')

  await goto('/secrets/')
  await until(`!!document.getElementById('new-secret')`, v => v, 'the secrets screen never rendered')
  await click('#new-secret')
  await until(`!!document.getElementById('name')`, v => v, 'the secret form never opened')
  await fill({ name: 'hz-main', kind: 'provider_key' })
  await until(`!!document.getElementById('providerKind')`, v => v, 'the cloud field never appeared')

  const clouds2 = await options('providerKind')
  check('the second cloud is offered too, off the schema rather than a list here',
    clouds2.includes('hetzner') && clouds2.includes('digitalocean'), clouds2.join(', '))

  await fill({ providerKind: 'hetzner', data: JSON.stringify({ token: HZ_TOKEN }) })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`document.body.textContent.includes('hz-main')`, v => v,
    'the Hetzner key never appeared in the list')
  ok('a Hetzner key is stored the same way')

  await goto('/servers/provision/')
  await until(`!!document.getElementById('account')`, v => v, 'the provision form never rendered')

  // Two accounts now, so the picker is a real choice and the one chosen decides
  // which vendor is read. Chosen by NAME: taking the first would drive the rest
  // of this section against DigitalOcean and every assertion below would be
  // about the wrong cloud.
  const hzOption = await evaluate(
    `[...document.getElementById('account').options].find(o => o.textContent.includes('hz-main'))?.value ?? ''`)
  check('both accounts are offered, and they name their clouds', !!hzOption, hzOption)
  await fill({ account: hzOption })

  await until(`(() => {
      const r = document.getElementById('region')
      if (!r) return 'no #region'
      return [...r.options].some(o => o.value === 'nbg1') ? true : 'regions: '
        + [...r.options].map(o => o.value).join(',')
    })()`, v => v === true, "the Hetzner catalog never reached the region picker", 20_000)

  const hzRegions = await options('region')
  check('the regions are HETZNER\'s, and DigitalOcean\'s are gone',
    hzRegions.includes('nbg1') && hzRegions.includes('fsn1') && hzRegions.includes('hel1')
      && !hzRegions.includes('nyc3'), hzRegions.join(', '))

  await fill({ region: 'nbg1' })
  const nbg = await until(`[...document.getElementById('size').options].map(o => o.value).filter(Boolean)`,
    v => v.length, 'sizes never arrived for nbg1')
  check('nbg1 offers cpx11 and NOT the Arm size, which is sold in one location',
    nbg.includes('cpx11') && !nbg.includes('cax11'), nbg.join(', '))

  await fill({ region: 'fsn1' })
  const fsn = await until(`[...document.getElementById('size').options].map(o => o.value).filter(Boolean)`,
    v => v.includes('cax11') ? v : false, 'fsn1 never offered the Arm size')
  check('and fsn1 does — the picker narrows by region at the second vendor too',
    fsn.includes('cax11'))

  // ── the same size, two regions, two prices ──
  await fill({ region: 'nbg1' })
  await until(`[...document.getElementById('size').options].some(o => o.value === 'cpx11')`, v => v,
    'nbg1 never offered cpx11 again')
  await fill({ size: 'cpx11' })
  await fill({ image: 'ubuntu-24.04' })
  const costNbg = await until(`document.getElementById('provision-cost')?.textContent ?? ''`,
    t => /€/.test(t) ? t : false, 'the Hetzner cost line never appeared')
  check('the cost is in EUR, formatted by the currency and not by a hundred',
    /€5\.18/.test(costNbg), costNbg.replace(/\s+/g, ' ').trim().slice(0, 120))

  await fill({ region: 'hel1' })
  await until(`[...document.getElementById('size').options].some(o => o.value === 'cpx11')`, v => v,
    'hel1 never offered cpx11')
  await fill({ size: 'cpx11' })
  const costHel = await until(`document.getElementById('provision-cost')?.textContent ?? ''`,
    t => /€/.test(t) && !/€5\.18/.test(t) ? t : false,
    'the price never moved with the region', 10_000)
  check('and the SAME size in another region is another price — the map, on a screen',
    /€5\.77/.test(costHel), costHel.replace(/\s+/g, ' ').trim().slice(0, 120))

  // ── and it really provisions, at the other vendor ──
  await fill({ region: 'nbg1' })
  await until(`[...document.getElementById('size').options].some(o => o.value === 'cpx11')`, v => v,
    'nbg1 never offered cpx11 for the provision')
  await fill({ name: 'drive-hz-01', size: 'cpx11', image: 'ubuntu-24.04' })
  await until(`!document.querySelector('form button[type=submit]').disabled`, v => v,
    'the Hetzner provision was never armed')
  await evaluate(`document.querySelector('form button[type=submit]').click()`)

  await until(`(() => {
      const p = location.pathname
      if (/^\\/servers\\/[0-9a-f-]{36}\\/$/.test(p)) return true
      const err = document.querySelector('#form-error .alert-content')
      return err ? 'refused: ' + err.textContent.trim() : p
    })()`, v => v === true,
    'provisioning at the second vendor never landed on the machine', 30_000)
  ok('provisioning at the second cloud lands on the machine, through the same guard')

  const hzTrail = await until(`document.getElementById('server-events')?.textContent ?? ''`,
    t => /cpx11/.test(t) ? t : false, 'the trail never named what was asked for', 20_000)
  check('and the trail names the vendor\'s own words, not DigitalOcean\'s',
    /cpx11/.test(hzTrail) && /nbg1/.test(hzTrail), hzTrail.replace(/\s+/g, ' ').slice(0, 140))

  // ─── Cloud spend ───────────────────────────────────────────────────────
  // The price the vendor quoted, copied onto the row at purchase, summed. Not a
  // bill: the screen says so, and that sentence is asserted because a number
  // presented as a bill is worse than no number.
  console.log('\n  /cloud-spend/ — what was committed')
  await goto('/cloud-spend/')
  await until(`!!document.getElementById('spend-committed')`, v => v,
    'the committed tile never rendered')
  const committed = await text('#spend-committed')
  check('the committed figure is the vendor\'s price, from the row',
    /24\.00/.test(committed ?? ''), committed?.replace(/\s+/g, ' ').trim())
  check('and it says how many machines it covers, since an imported one is in none of it',
    /of \d+ machines/.test(committed ?? ''), committed?.replace(/\s+/g, ' ').trim())
  // The grouping, which had nothing to group until there were two clouds: two
  // currencies cannot be added, so they are listed. A tile that summed them
  // would print one plausible number that is nobody's bill.
  check('and the two currencies are listed rather than added together',
    /24\.00/.test(committed ?? '') && /€/.test(committed ?? ''),
    committed?.replace(/\s+/g, ' ').trim())
  check('the screen still refuses to call it a bill',
    /not what the vendor will bill/i.test(await body()))

  // ─── The other act ─────────────────────────────────────────────────────
  // The screen this one was split from. Asserted because the split is only a
  // gain if BOTH halves still work: a rename that left importing broken would
  // pass every row above.
  console.log('\n  /servers/import/ — the act that costs nothing')
  await goto('/servers/import/')
  await until(`!!document.getElementById('ipAddress')`, v => v, 'the import form never rendered')
  check('it says plainly that nothing is billed and nothing is contacted',
    /nothing is billed/i.test(await body()))
  check('and offers no account, region catalog or price',
    await evaluate(`!document.getElementById('account') && !document.getElementById('size')`))

  await fill({ name: 'under-the-desk', ipAddress: '10.0.1.9', region: 'dc1' })
  await evaluate(`document.querySelector('form button[type=submit]').click()`)
  await until(`location.pathname`, p => /^\/servers\/[0-9a-f-]{36}\/$/.test(p),
    'importing never landed on the machine', 20_000)
  const imported = await text('#server-status')
  // `pending`, not `provisioning`: nothing was bought, so no job is working on
  // it and no cloud will ever answer about it.
  check('an imported machine lands at `pending`, with no job working on it',
    imported === 'pending', imported)
  // The PAIR, and it is the whole point of the row. `pending` alone cannot say
  // whether anything is working on this machine: a provisioned one is queued,
  // an imported one is parked. The provisioned machine above showed the strip
  // at `provisioning`; this one must not show it at `pending`, or the screen is
  // telling an operator their own box is queued for a job that will never run.
  check('and NO progress strip — nothing is queued for a machine nobody bought',
    await evaluate(`!document.getElementById('server-inflight')`))

  // ─── …and it is told how to get a credential ───────────────────────────
  // An imported machine holds nothing. There is no fleet-wide key any more, so
  // until it enrolls its check-ins are refused — which is a machine somebody
  // has not finished installing rather than one that is broken, and the screen
  // has to say which.
  check('the screen says it has no credential of its own',
    await evaluate(`!!document.getElementById('needs-enrollment')`))

  await click('#needs-enrollment button')
  await until(`!!document.getElementById('enroll-command')`, v => v,
    'the install command never appeared')
  const command = await text('#enroll-command')
  check('and hands over one command to run on it',
    /curl -fsSL .*\/install\.sh \| sudo env /.test(command ?? ''), command?.trim()?.slice(0, 120))
  // The token is an env var, never in the URL: a URL puts it in an access log,
  // a proxy's, and the shell history of whoever pasted it.
  check('…carrying the token as an environment variable, not in the URL',
    /ENROLL_TOKEN=bcen_[0-9a-f]{64}/.test(command ?? '')
    && !/install\.sh\?/.test(command ?? ''), command?.trim()?.slice(0, 160))

  // The script the command fetches is public and carries nothing. Asserted from
  // the browser because that is the origin a person's machine would fetch it
  // from, and a route that only answered in a unit test would pass there.
  const script = await fetch(`${API}/install.sh`)
  const text0  = await script.text()
  check('the script it fetches is served, and holds no credential',
    script.status === 200 && !text0.includes('bcen_'), `${script.status}`)

  // ─── The console ───────────────────────────────────────────────────────
  console.log('\n  the console')
  check('no console errors or warnings across the flow',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

} catch (e) {
  bad('the run stopped', e.message)
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`)
await cleanup()
await rm(SCRATCH, { recursive: true, force: true })
await rm(PROFILE, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
