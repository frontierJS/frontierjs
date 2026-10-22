/**
 * connect-app.mjs — `connectApp()` in a browser, over a forward that carries
 * HTTP and the socket.
 *
 * `test/connect-app.test.js` proves the handle's calls against a real hosted
 * Junction app, with a socket that never opens. What it cannot reach is a built
 * page: a table, a form and a live list over the hosted app, and the WebSocket
 * a browser opens at the handle's `url` + `/ws`, which only a forward that
 * upgrades it can answer. A forward that serves the calls and drops the
 * upgrade leaves the page working and its list stale, with nothing thrown.
 *
 * `test/fixtures/connect-app-server.ts` is the pair of servers: a hosted app,
 * and the page's own API forwarding `/hosted/h1/*` to it with the owner's
 * credential in place of the page's, on HTTP and on the upgrade alike. The page
 * (`fixtures/connect-app-page/`) is bundled by Bun and served by a third
 * listener on the SAME origin as the forward, because `connectApp()` refuses any
 * other.
 *
 * Usage, from the sierra package root: `bun run test:connect-app`.
 * Needs Chrome on PATH (or $FJS_CHROME).
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'

const PKG  = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGE = resolve(PKG, 'test/fixtures/connect-app-page')

const freePort = () => new Promise((ok, no) => {
  const s = createServer()
  s.once('error', no)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) })
})

const hostedPort = await freePort()
const pagePort   = await freePort()
const ORIGIN     = `http://127.0.0.1:${pagePort}`

// ─── the page bundle ─────────────────────────────────────────────────────────

const built = await Bun.build({ entrypoints: [resolve(PAGE, 'page.js')], target: 'browser', format: 'esm' })
if (!built.success) { console.error(built.logs.join('\n')); process.exit(1) }
const SITE = mkdtempSync(join(tmpdir(), 'fjs-connect-app-'))
writeFileSync(join(SITE, 'page.js'), await built.outputs[0].text())
copyFileSync(resolve(PAGE, 'index.html'), join(SITE, 'index.html'))

// ─── the servers ─────────────────────────────────────────────────────────────

const server = spawn('bun', [
  'test/fixtures/connect-app-server.ts', String(hostedPort), String(pagePort), SITE,
], { cwd: PKG, stdio: ['ignore', 'ignore', 'inherit'] })

const stop = () => { try { server.kill() } catch {} ; rmSync(SITE, { recursive: true, force: true }) }
process.on('exit', stop)

const until = Date.now() + 20000
for (;;) {
  try { if ((await fetch(`${ORIGIN}/ping`)).ok) break } catch {}
  if (Date.now() > until) { console.error('the fixture servers did not answer'); stop(); process.exit(1) }
  await new Promise(r => setTimeout(r, 100))
}

const seen = () => fetch(`${ORIGIN}/__seen`).then(r => r.json())

// ─── drive ───────────────────────────────────────────────────────────────────

const browser = await openChrome().catch((e) => { console.error(e.message); stop(); process.exit(1) })
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         ${detail}`}`)
}
const rows = () => browser.evaluate(`return [...document.querySelectorAll('#rows tr')].map(tr => tr.textContent)`)

try {
  await browser.navigate(`${ORIGIN}/`, `globalThis.__page`)

  await browser.waitFor(`document.querySelectorAll('#rows tr').length === 1`, { label: 'the hosted row in the table' })
  check('the table lists the hosted app\'s row', (await rows()).join() === 'ada@hosted.test', JSON.stringify(await rows()))

  const fields = await browser.evaluate(`return { hosted: __page.fields, own: __page.pageField }`)
  check('its fields are the hosted model\'s, and the page\'s own are not', fields.hosted.join() === 'email' && fields.own.join() === 'title', JSON.stringify(fields))

  await browser.waitFor(`__page.socket()`, { label: 'the handle\'s socket open' })
  const hops = (await seen()).filter(s => s.path === '/hosted/h1/ws')
  check('the socket upgraded through the forward, the owner\'s credential in place of the page\'s',
    hops.length >= 1 && hops.every(h => h.from === 'Bearer studio-token' && h.forwarded === 'Bearer owner-token'), JSON.stringify(hops))

  // A row written by someone else, with no reload and no call from this page.
  const poked = await fetch(`${ORIGIN}/__hosted-create?id=2&email=grace@hosted.test`).then(r => r.json())
  check('another client writes to the hosted app', poked.status === 200 || poked.status === 201, JSON.stringify(poked))
  await browser.waitFor(`document.querySelectorAll('#rows tr').length === 2`, { label: 'the pushed row in the table' })
  check('the live list takes the row the hosted app announced', (await rows()).includes('grace@hosted.test'), JSON.stringify(await rows()))

  // A write from this page rides the open socket, so the forward's HTTP side
  // sees no POST for it.
  const httpBefore = (await seen()).filter(s => s.path === '/hosted/h1/api/customers').length
  await browser.fill('#add input[name=email]', 'lin@page.test')
  await browser.clickAt('#add button')
  await browser.waitFor(`document.querySelectorAll('#rows tr').length === 3`, { label: 'the saved row in the table' })
  check('a form saves to the hosted app', (await rows()).includes('lin@page.test'), JSON.stringify(await rows()))
  const httpAfter = (await seen()).filter(s => s.path === '/hosted/h1/api/customers').length
  check('and the save went over the socket, not the forward\'s HTTP side', httpAfter === httpBefore, `${httpBefore} → ${httpAfter}`)

  check('the page threw nothing', browser.errors.length === 0, browser.errors.join('\n         '))
} catch (e) {
  failed++
  console.log(`  FAIL ${e.message}`)
  console.log(`         rows: ${JSON.stringify(await rows().catch(() => null))} errors: ${JSON.stringify(browser.errors)}`)
} finally {
  await browser.close()
  stop()
}

console.log(failed ? `\n${failed} failed` : '\nconnect-app: all passed')
process.exit(failed ? 1 : 0)
