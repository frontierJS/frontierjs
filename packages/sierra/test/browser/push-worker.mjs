/**
 * push-worker.mjs — the emitted push handlers, run in Chrome's own worker.
 *
 * `test/offline-shell.test.js` runs the same source against stand-ins for
 * `showNotification` and `clients`; a stand-in agrees with whatever the handler
 * passes it. This registers the push-only `sw.js` a build writes and asks the
 * browser what it put on screen.
 *
 * The push is a TRUSTED one: `ServiceWorker.deliverPushMessage` is the DevTools
 * "Push" button, so it needs no subscription and no push service, and the
 * handler's `waitUntil` is honored. What it carries is the notifications
 * driver's decrypted `payload` from `notifications/test/fixtures/push-message.json`,
 * and what `getNotifications()` reads back must be that fixture's `shown`.
 *
 * The click cannot be trusted here. CDP has no way to click a notification, and
 * a script-built `NotificationEvent` refuses `waitUntil` outright, so the click
 * runs with `waitUntil` shimmed — and the browser then refuses `focus()` and
 * `openWindow()`, which it allows only inside a real click. The refusal names
 * which branch the handler took, so that is what is asserted; the focus and the
 * navigation themselves are the headed drive's (`IDEAS/web-push.md` 4.2).
 *
 * Usage, from the sierra package root: `bun run test:push-worker`.
 * Needs Chrome on PATH (or $FJS_CHROME).
 */

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, inspect } from 'node:util'

import { writeOfflineShell } from '../../src/postbuild/offline-shell.js'
import { openChrome } from '../../../mesa/src/drive.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const wire = JSON.parse(readFileSync(join(HERE, '../../../notifications/test/fixtures/push-message.json'), 'utf8'))

const SCRATCH = mkdtempSync(join(tmpdir(), 'fjs-push-worker-'))
writeFileSync(join(SCRATCH, 'index.html'), '<!doctype html><title>t</title><body>app</body>')
await writeOfflineShell(undefined, SCRATCH, SCRATCH, true)

// ─── Chrome ───────────────────────────────────────────────────────────────────

// http://localhost is a secure context, which a service worker requires.
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const file = join(SCRATCH, path === '/' ? 'index.html' : path)
  if (!existsSync(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' })
  res.end(readFileSync(file))
})
await new Promise(r => server.listen(0, 'localhost', r))
const origin = `http://localhost:${server.address().port}`

const browser = await openChrome().catch((e) => { console.error(e.message); process.exit(1) })
const { cmd, send } = browser

const value = (r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const page = (expression) => cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(value)

// Without the grant `showNotification` rejects, and the push handler's
// rejection is swallowed by the browser — every case would read as nothing shown.
await send('Browser.grantPermissions', { origin, permissions: ['notifications'] })

// A headless profile carries component extensions with workers of their own,
// so the registration is picked by scope rather than taken first.
const registrations = []
browser.on('ServiceWorker.workerRegistrationUpdated', (p) => registrations.push(...p.registrations))
await cmd('ServiceWorker.enable')

const loaded = new Promise((done) => { const off = browser.on('Page.loadEventFired', () => { off(); done() }) })
await cmd('Page.navigate', { url: `${origin}/` })
await loaded
await page(`navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)`)
const { registrationId } = registrations.find(r => !r.isDeleted && r.scopeURL === `${origin}/`)

const { targetInfos } = await send('Target.getTargets')
const target = targetInfos.find(t => t.type === 'service_worker' && t.url === `${origin}/sw.js`)
const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const worker = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId).then(value)

// `ready` answers while the worker may still be activating; the cases are
// about a worker that is running.
async function until(expression, what) {
  for (let i = 0; i < 50; i++) {
    if (await worker(expression)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`the worker never reported ${what}`)
}
await until(`self.registration.active?.state === 'activated'`, 'activated')

// A getNotifications() that overlaps a showNotification() still being stored
// can lose that notification for good — it resolves, and is never listed. So
// the store is never polled: showNotification passes through a recorder, and
// the store is read once the call the handler made has settled.
await worker(`{
  const show = self.registration.showNotification.bind(self.registration)
  self.shows = []
  self.registration.showNotification = (...args) => { const p = show(...args); self.shows.push(p); return p }
}`)

const tabs = () => worker(`self.clients.matchAll({ type: 'window' }).then(cs => cs.map(c => c.url))`)

const onScreen = () => worker(`self.registration.getNotifications()
  .then(ns => ns.map(n => ({ title: n.title, body: n.body, data: n.data, tag: n.tag })))`)
const clear = () => worker(`self.registration.getNotifications().then(ns => ns.forEach(n => n.close()))`)

// The push event's waitUntil outlives deliverPushMessage's answer.
async function push(data) {
  const before = await worker('self.shows.length')
  await cmd('ServiceWorker.deliverPushMessage', { origin, registrationId, data })
  await until(`self.shows.length > ${before}`, 'a showNotification call')
  await worker(`self.shows[${before}]`)
  return onScreen()
}

// A real notification, clicked by script with waitUntil shimmed. Answers what
// was still on screen and how the handler's promise settled.
const click = (url) => worker(`(async () => {
  await self.registration.showNotification('click me', { data: { url: ${JSON.stringify(url)} } })
  const [notification] = await self.registration.getNotifications()
  const e = new NotificationEvent('notificationclick', { notification })
  let done
  Object.defineProperty(e, 'waitUntil', { value: (p) => { done = p } })
  self.dispatchEvent(e)
  const settled = await done.then(() => 'resolved', (x) => x.name + ': ' + x.message)
  return { left: (await self.registration.getNotifications()).length, settled }
})()`)

// ─── run ──────────────────────────────────────────────────────────────────────

let failed = 0
const check = (name, ok, got) => {
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got ${inspect(got, { depth: 5 })}`}`)
}

{
  const shown = await push(JSON.stringify(wire.payload))
  check('a push shows the fixture\'s payload as the fixture says', isDeepStrictEqual(shown, [wire.shown]), shown)
}

{
  const later = { ...wire.payload, body: 'Order 7, refunded' }
  const shown = await push(JSON.stringify(later))
  check('a second push on the same topic replaces the first on screen',
    shown.length === 1 && shown[0].body === later.body, shown)
}

{
  await clear()
  const [shown] = await push('hello')
  check('a push that is not JSON is shown as text', shown?.title === '' && shown.body === 'hello' && shown.tag === '', shown)
}

{
  await clear()
  const open = await tabs()
  check('the push-only worker controls the open tab', isDeepStrictEqual(open, [`${origin}/`]), open)

  const got = await click('/orders/7')
  check('a click closes the notification and reaches for the open tab',
    got.left === 0 && /^InvalidAccessError: .*focus/.test(got.settled), got)
}

{
  await clear()
  await cmd('Page.navigate', { url: 'about:blank' })
  await until(`self.clients.matchAll({ type: 'window' }).then(cs => cs.length === 0)`, 'the tab gone')
  const got = await click(null)
  check('a click with no tab open reaches for a new window',
    got.left === 0 && /^InvalidAccessError: .*open a window/.test(got.settled), got)
}

await browser.close()
server.close()
rmSync(SCRATCH, { recursive: true, force: true })

console.log(failed ? `\n  ${failed} case(s) failed\n` : '\n  every case agrees with the browser\n')
process.exit(failed ? 1 : 0)
