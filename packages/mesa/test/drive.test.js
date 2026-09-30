// @vitest-environment node
//
// drive.test.js — `@frontierjs/mesa/drive` in a real Chrome, for the two things
// an APP's drive asks of it that this repo's spec runner never did.
//
// A kept profile has to survive a relaunch: an offline app's rows live in
// IndexedDB, and a drive that writes, closes and reopens on a fresh profile
// passes whether or not the app persisted anything. And a [Mesa] warning is a
// render the framework survived but corrupted, so it lands in errors while a
// page's own warning does not.
//
// The page is served over http: about:blank is an opaque origin and has no
// storage to keep.
//
// `findChrome` is tested without a browser, its world passed in, because the
// answer a caller SKIPS on has to be right on a machine that has none.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openChrome, findChrome, createNetwork } from '../src/drive.js'

const CHROME = findChrome()

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

describe.skipIf(!CHROME)('the drive', () => {
  let http, origin, work
  const upgraded = new Set()

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'mesa-drive-test-'))
    http = createServer((req, res) => {
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
    origin = `http://127.0.0.1:${http.address().port}/`
  })

  afterAll(async () => {
    for (const sock of upgraded) sock.destroy()
    if (http) await new Promise((r) => http.close(r))
    rmSync(work, { recursive: true, force: true })
  })

  test('a kept profile carries IndexedDB across close and relaunch', async () => {
    const profile = join(work, 'kept')
    const first = await openChrome({ profile })
    await first.navigate(origin, 'window.put')
    await first.evaluate(`return await put('written')`)
    await first.close()
    expect(existsSync(profile)).toBe(true)

    const second = await openChrome({ profile })
    await second.navigate(origin, 'window.get')
    expect((await second.evaluate(`return await get()`)).v).toBe('written')
    await second.close()
  }, 60000)

  test('a temp profile is gone after close, so the next launch starts empty', async () => {
    const first = await openChrome()
    await first.navigate(origin, 'window.put')
    await first.evaluate(`return await put('written')`)
    await first.close()

    const second = await openChrome()
    await second.navigate(origin, 'window.get')
    expect((await second.evaluate(`return await get()`)).v).toBe('absent')
    await second.close()
  }, 60000)

  test('a [Mesa] warning is an error and a page warning is not', async () => {
    const b = await openChrome()
    await b.navigate(origin)
    await b.evaluate(`console.warn('[Mesa] duplicate key'); console.warn('page chatter'); return true`)
    await new Promise((r) => setTimeout(r, 100))
    expect(b.errors).toEqual(['console.warn: [Mesa] duplicate key'])
    await b.close()
  }, 60000)

  test('on() hears what the collected errors pass over, until it unsubscribes', async () => {
    const b = await openChrome()
    await b.navigate(origin)
    const heard = []
    const off = b.on('Runtime.consoleAPICalled', (p) => heard.push(`${p.type}: ${p.args[0].value}`))
    await b.evaluate(`console.warn('page chatter'); return true`)
    await new Promise((r) => setTimeout(r, 100))
    off()
    await b.evaluate(`console.warn('after'); return true`)
    await new Promise((r) => setTimeout(r, 100))
    expect(heard).toEqual(['warning: page chatter'])
    expect(b.errors).toEqual([])
    await b.close()
  }, 60000)

  test('args reach Chrome, and send() is the browser-level call', async () => {
    const b = await openChrome({ args: ['--user-agent=fjs-drive-probe'] })
    await b.navigate(origin)
    expect(await b.evaluate(`return navigator.userAgent`)).toBe('fjs-drive-probe')
    const { targetInfos } = await b.send('Target.getTargets')
    expect(targetInfos.some((t) => t.type === 'page' && t.url === origin)).toBe(true)
    await b.close()
  }, 60000)

  test('offline refuses the network and severs the app socket, but not vite-hmr', async () => {
    const b = await openChrome()
    const net = await createNetwork(b)
    await b.navigate(origin + 'sockets', 'window.app.readyState === 1 && window.hmr.readyState === 1')
    expect(await b.evaluate(`return await reach()`)).toBe('reached')

    const inside = await net.withOffline(() => b.evaluate(`
      return reach().then((r) => ({ r, app: app.readyState, hmr: hmr.readyState }))
    `))
    expect(inside.r).toBe('refused')
    expect(inside.app).toBeGreaterThanOrEqual(2)
    expect(inside.hmr).toBe(1)
    expect(net.severed).toBe(1)

    // The page opened no new socket, so there is none to wait for.
    await b.evaluate(`window.app = null; return true`)
    expect(await net.waitOnline({ tries: 20 })).toBe(true)
    expect(await b.evaluate(`return await reach()`)).toBe('reached')
    await b.close()
  }, 60000)

  test('a page loaded before createNetwork has no registry, and goOffline says so', async () => {
    const b = await openChrome()
    await b.navigate(origin + 'sockets', 'window.app.readyState === 1')
    const net = await createNetwork(b)
    expect(await net.goOffline()).toBe(null)
    await net.goOnline()
    await b.close()
  }, 60000)
})

const world = ({ have = [], files = [], env = {} } = {}) => ({
  run:    (bin) => have.includes(bin),
  exists: (p)   => files.includes(p),
  env,
})

describe('findChrome', () => {
  test('takes the first candidate on PATH', () => {
    expect(findChrome({ ...world({ have: ['chromium'] }) })).toBe('chromium')
  })

  test('takes an absolute candidate that exists', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(findChrome({ ...world({ files: [mac] }) })).toBe(mac)
  })

  test('null when there is none — a fact about the machine, not a failure', () => {
    expect(findChrome({ ...world() })).toBe(null)
  })

  test('$FJS_CHROME wins over anything installed', () => {
    const named = '/opt/chrome-131/chrome'
    expect(findChrome({ ...world({ have: ['google-chrome'], files: [named], env: { FJS_CHROME: named } }) }))
      .toBe(named)
  })

  test('$FJS_CHROME naming nothing is null, NOT a fallback', () => {
    // An installed google-chrome must not answer here, or a person who pinned
    // a version silently gets a different browser.
    expect(findChrome({ ...world({ have: ['google-chrome'], env: { FJS_CHROME: '/gone/chrome' } }) }))
      .toBe(null)
  })

  test('$FJS_CHROME may name something on PATH', () => {
    expect(findChrome({ ...world({ have: ['my-chrome'], env: { FJS_CHROME: 'my-chrome' } }) }))
      .toBe('my-chrome')
  })
})

test('openChrome throws, rather than exiting, when $FJS_CHROME names nothing', async () => {
  const was = process.env.FJS_CHROME
  process.env.FJS_CHROME = '/gone/chrome'
  try {
    await expect(openChrome()).rejects.toThrow(/\$FJS_CHROME names \/gone\/chrome/)
  } finally {
    if (was === undefined) delete process.env.FJS_CHROME
    else process.env.FJS_CHROME = was
  }
})

test('openChrome refuses the flags it owns, before launching anything', async () => {
  await expect(openChrome({ args: ['--remote-debugging-port=9222'] })).rejects.toThrow(/--remote-debugging-port is the driver's own flag/)
  await expect(openChrome({ args: ['--user-data-dir=/tmp/x'] })).rejects.toThrow(/--user-data-dir is the driver's own flag/)
})
