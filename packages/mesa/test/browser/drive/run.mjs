/*
 * run.mjs — `@frontierjs/mesa/drive` itself, launching real browsers.
 *
 *   node test/browser/drive/run.mjs             every spec
 *   node test/browser/drive/run.mjs signal      specs whose filename matches
 *   node test/browser/drive/run.mjs --verbose   print the passing rows too
 *
 * Needs Chrome on PATH or `$FJS_CHROME`.
 *
 * The other drives use one browser and ask what a page does. These ask what the
 * DRIVER does across launches — a kept profile surviving a relaunch, a browser
 * that stopped answering, a signal to the process that launched it — so each
 * spec opens and closes its own, and the runner's shared browser is only the
 * harness. `test/drive.test.js` keeps what needs no browser: `findChrome` over
 * a fake host, and the refusals `openChrome` makes before launching anything.
 *
 * The page is served over http on port 0: about:blank is an opaque origin and
 * has no storage to keep.
 */
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openChrome, createNetwork } from '../../../src/drive.js'
import { runSpecs } from '../drive.mjs'

const HERE  = fileURLToPath(new URL('.', import.meta.url))
const DRIVE = new URL('../../../src/drive.js', import.meta.url).href

const argv    = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const filters = argv.filter((a) => !a.startsWith('--'))

const PAGE = `<!doctype html><title>drive</title><script>
  window.put = (v) => new Promise((ok, fail) => {
    const open = indexedDB.open('drive', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => fail(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(v, 'k')
      tx.oncomplete = () => { open.result.close(); ok(true) }
    }
  })
  window.get = () => new Promise((ok) => {
    const open = indexedDB.open('drive', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onsuccess = () => {
      const req = open.result.transaction('kv').objectStore('kv').get('k')
      req.onsuccess = () => { open.result.close(); ok({ v: req.result ?? 'absent' }) }
    }
  })
</script>`

// The app's socket and a vite-hmr one, both on the page's own origin, which is
// the arrangement a dev server that proxies the API makes.
const SOCKETS = `<!doctype html><title>sockets</title><script>
  const url = location.origin.replace('http', 'ws')
  window.app = new WebSocket(url + '/app')
  window.hmr = new WebSocket(url + '/hmr', 'vite-hmr')
  window.reach = () => fetch('/ping', { cache: 'no-store' }).then(() => 'reached', () => 'refused')
</script>`

// ─── the server ─────────────────────────────────────────────────────────────

const work     = mkdtempSync(join(tmpdir(), 'mesa-drive-test-'))
const upgraded = new Set()
const http = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.setHeader('cache-control', 'no-store')
  res.end(req.url === '/sockets' ? SOCKETS : PAGE)
})
// Enough of a WebSocket server to open one and hold it: the handshake, and
// the subprotocol echoed back, or Chrome fails the vite-hmr socket.
http.on('upgrade', (req, sock) => {
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  const proto = req.headers['sec-websocket-protocol']
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` + (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : '') + '\r\n')
  sock.on('error', () => {})
  upgraded.add(sock)
})
await new Promise((r) => http.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${http.address().port}/`

// ─── a launch in another process ────────────────────────────────────────────

// A child process, because the subject is what a signal does to a PROCESS.
// It reports the profile its launch made, so the parent can see the browser
// was still swept on the way out.
function launchChild(withHost, signal = 'SIGTERM') {
  const script = `
    import { readdirSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { openChrome } from '${DRIVE}'
    ${withHost ? `process.on('SIGTERM', async () => {
      await new Promise((r) => setTimeout(r, 200))
      console.log('host shutdown finished')
      process.exit(0)
    })` : ''}
    const before = new Set(readdirSync(tmpdir()))
    await openChrome()
    const profile = readdirSync(tmpdir()).find((n) => n.startsWith('fjs-drive-') && !before.has(n))
    console.log('up ' + profile)
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child never came up: ' + out)) }, 20000)
    child.stdout.on('data', () => {
      const m = out.match(/up (\S+)/)
      if (!m) return
      clearTimeout(t)
      child.kill(signal)
      child.on('exit', (code) => resolve({ code, out, profile: join(tmpdir(), m[1]) }))
    })
  })
}

/** How many processes hold `profile` open. */
const holders = (profile) =>
  spawnSync('pgrep', ['-f', `user-data-dir=${profile}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).length

// ─── run ────────────────────────────────────────────────────────────────────

const { infra, failures } = await runSpecs({
  origin,
  specDir: join(HERE, 'specs'),
  filters,
  verbose,
  extend: () => ({ origin, work, openChrome, createNetwork, launchChild, holders }),
})

for (const sock of upgraded) sock.destroy()
await new Promise((r) => http.close(r))
rmSync(work, { recursive: true, force: true })
process.exit(failures || infra ? 1 : 0)
