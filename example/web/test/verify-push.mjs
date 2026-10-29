/**
 * web/test/verify-push.mjs — a paid order reaches a device and its click opens it.
 *
 * Started by `bun run verify:push`, which runs it inside Xvfb. Builds the SPA
 * (the worker exists only in a build), starts the API, the push sink and a
 * preview of the build itself, on the test ports, and stops all three.
 *
 * ─── What is under test ──────────────────────────────────────────────────
 *
 * The chain `IDEAS/web-push.md` 4.2 and 4.3 name, from `pay` to the tab:
 *
 *   pay → payment-announce → OrderPaid's push formatter → webPush() → the push
 *   sink → (decrypted here) → the built sw.js → the desktop's daemon → a click
 *   → the open tab focused and navigated, or a window opened
 *
 * and a device whose push service answers 410 retired, so the next send lists
 * one fewer.
 *
 * ─── What stands in, and why each is honest ───────────────────────────────
 *
 * **The push service.** A real one accepts only a subscription its own browser
 * made, so the devices here are key pairs this drive holds, subscribed through
 * the real `push-subscriptions` service. The API runs with PUSH_SINK_URL, which
 * hands every request webPush() builds to api/src/providers/push/sink.ts. The
 * drive decrypts what arrived from the device's private key alone, so a body the
 * device could not read fails here rather than passing on a 201.
 *
 * **The browser's own decrypt.** The plaintext reaches the worker through
 * `ServiceWorker.deliverPushMessage`, the DevTools Push button. It is a trusted
 * push event, so the worker's `waitUntil` is honored, and it skips only the
 * browser's half of the decryption the step above already proved.
 *
 * **The click.** No CDP call clicks a notification, and a script-built
 * NotificationEvent is refused focus() and openWindow(). A headed Chrome on
 * Linux hands a notification to org.freedesktop.Notifications over D-Bus and
 * learns of a click from the daemon's ActionInvoked signal, so the drive runs a
 * daemon of its own (lib/notification-daemon.py) on a private bus and sends that
 * signal. Chrome cannot tell it from a person's click, and grants the worker the
 * activation focus() and openWindow() require.
 *
 * Needs xvfb-run, dbus-daemon and python3 with dbus-python and PyGObject, and a
 * VAPID pair in example/.env (`fli crypto:keygen vapid --env`). Seeds the dev
 * database, as verify:offline does.
 */

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawn, execFileSync }            from 'node:child_process'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                         from 'node:os'
import { dirname, join }                  from 'node:path'
import { createInterface }                from 'node:readline'
import { fileURLToPath }                  from 'node:url'
import { portFor }                        from '@frontierjs/cli/core/ports.js'
import { PORTS }                          from './lib/preflight.mjs'
import { results, report }                from './lib/report.mjs'
import { openChrome }                     from '../../../packages/mesa/src/drive.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API_PORT  = process.env.API_PORT ?? String(PORTS.apiTest)
const UI_PORT   = process.env.UI_PORT  ?? String(PORTS.uiTest)
const SINK_PORT = String(await portFor(import.meta.url, 'be', { env: 'test', service: 9 }))
const API  = `http://localhost:${API_PORT}`
const UI   = `http://localhost:${UI_PORT}`
const SINK = `http://localhost:${SINK_PORT}`
const RUN  = Date.now().toString(36).slice(-6).toUpperCase()

const { got, t } = results()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─── Preconditions ─────────────────────────────────────────────────────────

const missing = []
if (!process.env.DISPLAY) missing.push('a display — run it through `bun run verify:push`, which starts Xvfb')
try { execFileSync('dbus-daemon', ['--version'], { stdio: 'ignore' }) } catch { missing.push('dbus-daemon') }
try { execFileSync('python3', ['-c', 'import dbus, gi'], { stdio: 'ignore' }) } catch { missing.push('python3 with dbus-python and PyGObject (python3-dbus, python3-gi)') }
if (missing.length) {
  console.error(`verify:push needs:\n${missing.map(m => `  - ${m}`).join('\n')}`)
  process.exit(1)
}

for (const [port, what] of [[API_PORT, 'the API'], [UI_PORT, 'the preview'], [SINK_PORT, 'the push sink']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first; this drive starts its own.`)
    process.exit(1)
  }
}

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
const scratch = []
function start(cmd, args, name, env, stdio = ['ignore', 'pipe', 'pipe']) {
  // Detached, so stopAll can signal the GROUP: a launcher killed alone leaves
  // the app holding the port.
  const p = spawn(cmd, args, { cwd: ROOT, stdio, detached: true, env: { ...process.env, ...env } })
  p.stdout?.on('data', () => {})
  p.stderr?.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).status < 500) return true } catch {}
    await sleep(250)
  }
  console.error(`${label} never answered on ${url}`)
  stopAll()
  process.exit(1)
}

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
execFileSync('npx', ['vite', 'build', '-c', 'web/config/vite.config.js'], { cwd: ROOT, stdio: process.env.DEBUG ? 'inherit' : 'ignore' })
if (!existsSync(join(ROOT, 'web/dist/client/sw.js'))) {
  console.error('the build wrote no sw.js — is `push: true` still in web/config/sierra.config.js?')
  process.exit(1)
}

start('bun', ['api/src/providers/push/sink.ts'], 'sink', { PUSH_SINK_PORT: SINK_PORT })
start('bun', ['run', 'api/index.ts'], 'api', { API_PORT, PUSH_SINK_URL: SINK })
start('node', ['web/test/preview.mjs'], 'preview', { PREVIEW_PORT: UI_PORT, FRONTIER_API_URL: API })
await waitFor(`${SINK}/outbox`, 'the push sink')
await waitFor(`${API}/api/products`, 'the API')
await waitFor(UI, 'the preview')

// ─── The desktop: a bus of its own, and the daemon on it ───────────────────

// A bus with no service directory, so nothing on it is auto-started: under
// dbus-run-session Chrome waits on the desktop portal and never opens its
// DevTools port.
const busDir = mkdtempSync(join(tmpdir(), 'fjs-push-bus-'))
scratch.push(busDir)
writeFileSync(join(busDir, 'bus.conf'), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${busDir}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>`)
const bus = start('dbus-daemon', ['--config-file', join(busDir, 'bus.conf'), '--nofork', '--print-address=1'], 'bus', {}, ['ignore', 'pipe', 'pipe'])
process.env.DBUS_SESSION_BUS_ADDRESS = await new Promise(r => createInterface({ input: bus.stdout }).once('line', r))

const daemon = start('python3', [join(HERE, 'lib/notification-daemon.py')], 'daemon', {}, ['pipe', 'pipe', 'pipe'])
const shown = []
const waiting = []
await new Promise((ready) => createInterface({ input: daemon.stdout }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.ready) return ready()
  shown.push(m)
  waiting.shift()?.(m)
}))
const nextNotify = () => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 10_000)
  waiting.push((m) => { clearTimeout(timer); resolve(m) })
})
const click = (id) => daemon.stdin.write(`click ${id}\n`)

// ─── Devices: key pairs this drive holds ───────────────────────────────────

function device(name) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 13 + name.length) & 0xff))
  // A public address literal: the service grades an endpoint as a URL a
  // stranger chose, and the sink, not this address, receives the push.
  const endpoint = `https://8.8.8.8/verify-push/${RUN}-${name}`
  return {
    ecdh, auth, endpoint,
    subscription: { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  }
}

/** RFC 8291 from the receiving side: the device's private key and the header, nothing else. */
function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const record = body.subarray(21 + idlen)
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
  return padded.subarray(0, padded.length - 1).toString()
}

// ─── The shop's side ───────────────────────────────────────────────────────

async function signIn(email) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery' }),
  })
  if (!res.ok) throw new Error(`sign-in failed for ${email}: HTTP ${res.status}`)
  return { authorization: `Bearer ${(await res.json()).token}`, 'content-type': 'application/json' }
}

const orders = []
async function payAnOrder(admin) {
  const created = await (await fetch(`${API}/api/orders`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ reference: `ORD-P${RUN}${orders.length}`, total: 4200, status: 'pending', customerId: 1 }),
  })).json()
  const id = created.id ?? created.data?.id
  orders.push(id)
  const paid = await fetch(`${API}/api/orders/${id}`, { method: 'POST', headers: { ...admin, 'x-service-method': 'pay' }, body: '{}' })
  if (!paid.ok) throw new Error(`pay on order ${id} answered ${paid.status}`)
  return id
}

/** The sink's requests for these devices, once `count` of them have arrived. */
async function pushesTo(devices, count, ms = 20_000) {
  const endpoints = new Set(devices.map(d => d.endpoint))
  const t0 = Date.now()
  for (;;) {
    const box = (await (await fetch(`${SINK}/outbox`)).json()).filter(r => endpoints.has(r.url))
    if (box.length >= count || Date.now() - t0 > ms) return box
    await sleep(150)
  }
}

let stoppedEarly = null
let browser = null
try {
  const admin = await signIn('alex@shop.test')
  const key = await fetch(`${API}/api/push-subscriptions/key`, { headers: admin })
  if (key.status === 404) throw new Error('the API has no VAPID pair — run `fli crypto:keygen vapid --env --subject mailto:shop@example.test` in example/')

  const phone = device('phone'), laptop = device('laptop')
  for (const d of [phone, laptop]) {
    const res = await fetch(`${API}/api/push-subscriptions`, { method: 'POST', headers: admin, body: JSON.stringify(d.subscription) })
    if (!res.ok) throw new Error(`subscribing ${d.endpoint} answered ${res.status}: ${await res.text()}`)
  }

  // ── the browser, on the build, with its worker ───────────────────────────
  browser = await openChrome({ headed: true })
  const { cmd, send } = browser
  const value = (r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const page = (expression) => cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(value)

  // Without the grant showNotification rejects inside the worker, and the
  // browser swallows the rejection: every case reads as nothing shown.
  await send('Browser.grantPermissions', { origin: UI, permissions: ['notifications'] })
  const registrations = []
  browser.on('ServiceWorker.workerRegistrationUpdated', (p) => registrations.push(...p.registrations))
  await cmd('ServiceWorker.enable')
  // A window openWindow() makes is created blank and given its url after, so
  // `opened` follows every page's url and `created` counts the windows.
  const opened = [], created = []
  browser.on('Target.targetCreated', (p) => { if (p.targetInfo.type === 'page') { created.push(p.targetInfo.targetId); opened.push(p.targetInfo.url) } })
  browser.on('Target.targetInfoChanged', (p) => {
    if (p.targetInfo.type === 'page' && p.targetInfo.url.startsWith(UI)) opened.push(p.targetInfo.url)
  })
  await send('Target.setDiscoverTargets', { discover: true })

  const loaded = new Promise((done) => { const off = browser.on('Page.loadEventFired', () => { off(); done() }) })
  await cmd('Page.navigate', { url: `${UI}/` })
  await loaded
  // The build's own registration, not one this drive makes: index.html carries
  // it only when the build wrote a worker.
  await page(`navigator.serviceWorker.ready.then(() => true)`)
  const registration = registrations.find(r => !r.isDeleted && r.scopeURL === `${UI}/`)
  t('worker.registeredByTheBuild', { registered: !!registration })

  // ── 4.2: pay, and the push reaches both devices, readable ───────────────
  await fetch(`${SINK}/outbox`, { method: 'DELETE' })
  const first = await payAnOrder(admin)
  const arrived = await pushesTo([phone, laptop], 2)
  const forPhone = arrived.find(r => r.url === phone.endpoint)
  const payload = forPhone ? JSON.parse(decrypt(Buffer.from(forPhone.body, 'base64'), phone)) : null
  t('push.reachedEachDevice', {
    devices: arrived.length,
    topic:   forPhone?.headers.Topic ?? forPhone?.headers.topic ?? null,
    vapid:   /^vapid t=.+, k=.+/.test(forPhone?.headers.Authorization ?? forPhone?.headers.authorization ?? ''),
  })
  t('push.decryptsToTheFormatter', payload && { title: payload.title, url: payload.url })

  // ── the worker shows it, and a click lands on the open tab ───────────────
  const deliver = () => cmd('ServiceWorker.deliverPushMessage', { origin: UI, registrationId: registration.registrationId, data: JSON.stringify(payload) })
  let notice = nextNotify()
  await deliver()
  const onScreen = await notice
  t('worker.showed', onScreen && { title: onScreen.summary, hasBody: onScreen.body.includes(payload.body), clickable: onScreen.actions.includes('default') })

  opened.length = 0; created.length = 0
  click(onScreen.id)
  const want = `${UI}/orders/${first}/`
  let landed = null
  for (let i = 0; i < 40 && landed !== want; i++) { await sleep(150); landed = await page('location.href') }
  t('click.focusesTheOpenTab', {
    navigated:  landed === want,
    focused:    await page('document.hasFocus()'),
    newWindows: created.length,
  })

  // ── with no tab of the app open, the click opens one ─────────────────────
  const away = new Promise((done) => { const off = browser.on('Page.loadEventFired', () => { off(); done() }) })
  await cmd('Page.navigate', { url: 'about:blank' })
  await away.catch(() => {})
  await sleep(300)
  opened.length = 0; created.length = 0
  notice = nextNotify()
  await deliver()
  const second = await notice
  click(second.id)
  for (let i = 0; i < 40 && !opened.includes(want); i++) await sleep(150)
  t('click.opensAWindowWhenNoneIsOpen', { opened: opened.includes(want), windows: created.length, thisTabStayed: await page('location.href') === 'about:blank' })

  // ── 4.3: a device whose service answers 410 is retired ───────────────────
  await fetch(`${SINK}/outbox`, { method: 'DELETE' })
  await fetch(`${SINK}/answer`, { method: 'POST', body: JSON.stringify({ endpoint: laptop.endpoint, status: 410 }) })
  await payAnOrder(admin)
  const refused = await pushesTo([phone, laptop], 2)
  const listed = async () => {
    const mine = await (await fetch(`${API}/api/push-subscriptions`, { headers: admin })).json()
    return (mine.data ?? mine).map(r => r.endpoint).filter(e => e === phone.endpoint || e === laptop.endpoint)
  }
  let left = await listed()
  for (let i = 0; i < 40 && left.length > 1; i++) { await sleep(150); left = await listed() }
  t('gone.retiresThatDevice', { answered: refused.map(r => r.status).sort(), listed: left })

  await fetch(`${SINK}/outbox`, { method: 'DELETE' })
  await payAnOrder(admin)
  await sleep(1500)
  t('gone.nextSendListsOneFewer', (await pushesTo([phone, laptop], 2, 3_000)).map(r => r.url === phone.endpoint ? 'phone' : 'laptop'))

  // Leave no device behind: a later run's staff fan-out would push to it.
  const mine = await (await fetch(`${API}/api/push-subscriptions`, { headers: admin })).json()
  for (const row of (mine.data ?? mine).filter(r => r.endpoint.includes(`/verify-push/${RUN}-`)))
    await fetch(`${API}/api/push-subscriptions/${row.id}`, { method: 'DELETE', headers: admin })
  for (const id of orders) await fetch(`${API}/api/orders/${id}`, { method: 'DELETE', headers: admin })
} catch (err) {
  stoppedEarly = err
  console.error(err)
} finally {
  await browser?.close?.()
  daemon.stdin.end()
}

const expected = {
  'worker.registeredByTheBuild':      { registered: true },
  'push.reachedEachDevice':           (v) => v.devices === 2 && /^order-\d+$/.test(v.topic ?? '') && v.vapid === true,
  'push.decryptsToTheFormatter':      (v) => v?.title === 'Order paid' && /^\/orders\/\d+\/$/.test(v.url),
  'worker.showed':                    { title: 'Order paid', hasBody: true, clickable: true },
  'click.focusesTheOpenTab':          { navigated: true, focused: true, newWindows: 0 },
  'click.opensAWindowWhenNoneIsOpen': { opened: true, windows: 1, thisTabStayed: true },
  'gone.retiresThatDevice':           (v) => JSON.stringify(v.answered) === '[201,410]' && v.listed.length === 1,
  'gone.nextSendListsOneFewer':       ['phone'],
}
process.exit(report(got, expected, { stoppedEarly }))
