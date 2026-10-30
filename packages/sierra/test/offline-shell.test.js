/**
 * test/offline-shell.test.js — the shell the build writes.
 *
 * Phase 3 of the Homestead work. `example`'s `verify:shell` is what proves the
 * worker actually serves a page with no network; these are the claims a browser
 * cannot make cheaply — what is IN the precache list, what is deliberately out
 * of it, and that a build emitting different files gets a different cache name.
 *
 * The last one is the failure a precached shell invites: a device that keeps
 * serving the release it first saw. It is asserted here rather than only in the
 * browser because a reproducible build gives unchanged sources the same hashes,
 * so a rebuild in a drive proves nothing unless something really moved — which
 * is a mistake that version of the drive actually made.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { inspect } from 'node:util'
import wire from '../../notifications/test/fixtures/push-message.json'

import { tmpDir } from './tmp.js'
import { writeOfflineShell } from '../src/postbuild/offline-shell.js'

const ROOT = tmpDir('offline-shell-')
let out
let n = 0

async function build(files) {
  out = join(ROOT, `b${++n}`)
  for (const [name, body] of Object.entries(files)) {
    const full = join(out, name)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body, 'utf8')
  }
  return out
}

const PAGE = '<html><head><title>x</title></head><body><div id="app"></div></body></html>'

beforeEach(() => { /* each test builds its own output */ })
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }) })

const sw = async (dir) => readFile(join(dir, 'sw.js'), 'utf8')
const shellOf = (src) => JSON.parse(src.match(/const SHELL\s+= (\[.*?\])\n/s)[1])
const versionOf = (src) => src.match(/const VERSION = "(\w+)"/)[1]
const dbOf = (src) => JSON.parse(src.match(/const DB\s+= (\[.*?\])\n/s)[1])

describe('nothing is written for an app that did not ask', () => {
  test('no config, no worker', async () => {
    const dir = await build({ 'index.html': PAGE })
    expect(await writeOfflineShell(undefined, dir)).toBe(null)
    await expect(readFile(join(dir, 'sw.js'), 'utf8')).rejects.toThrow()
  })
})

describe('what a shell is made of', () => {
  test('code and pages, and the scope', async () => {
    const dir = await build({
      'index.html':        PAGE,
      'assets/app.js':     'export {}',
      'assets/app.css':    'body{}',
      'assets/logo.svg':   '<svg/>',
    })
    await writeOfflineShell(true, dir)
    const shell = shellOf(await sw(dir))
    expect(shell).toContain('/')
    expect(shell).toContain('/index.html')
    expect(shell).toContain('/assets/app.js')
    expect(shell).toContain('/assets/app.css')
    expect(shell).toContain('/assets/logo.svg')
  })

  test('a photograph is not part of the shell', async () => {
    // The byte budget is the whole reason for a list rather than "everything":
    // precaching a product catalog's images is a download a person did not
    // agree to.
    const dir = await build({
      'index.html':         PAGE,
      'assets/app.js':      'export {}',
      'media/hero.png':     'not really a png',
      'downloads/terms.pdf': '%PDF',
    })
    await writeOfflineShell(true, dir)
    const shell = shellOf(await sw(dir))
    expect(shell).not.toContain('/media/hero.png')
    expect(shell).not.toContain('/downloads/terms.pdf')
  })

  test('the device database is never precached, and is cached on first open when db is asked for', async () => {
    // ~540 kB precached for every visitor was a download for people who never
    // open a synced screen (FJS-3688).
    const files = {
      'index.html':                       PAGE,
      'assets/app.js':                    'export {}',
      'assets/local-db-worker-AbC_12.js': 'export {}',
      'fjs-device-schema.json':           '{}',
      'fjs-sqlite/index.js':              'export {}',
      'fjs-sqlite/sqlite3.wasm':          'wasm',
    }
    const DB = ['/assets/local-db-worker-AbC_12.js', '/fjs-device-schema.json', '/fjs-sqlite/index.js', '/fjs-sqlite/sqlite3.wasm']

    const dbDir = await build(files)
    const line  = await writeOfflineShell({ db: true }, dbDir)
    const src   = await sw(dbDir)
    expect(shellOf(src)).toContain('/assets/app.js')
    for (const url of DB) expect(shellOf(src)).not.toContain(url)
    expect(dbOf(src)).toEqual(DB)
    expect(line).toMatch(/device db \d+ kB, cached on first open/)

    const plainDir = await build(files)
    await writeOfflineShell(true, plainDir)
    const plain = await sw(plainDir)
    for (const url of DB) expect(shellOf(plain)).not.toContain(url)
    expect(plain).not.toContain('const DB')
  })

  test('a device that holds a database gets its engine at install and at activate', async () => {
    // At install, so a release does not strand rows the device already holds;
    // at activate, because a first visit opened the database before this
    // worker claimed the page and its fetches never reached the handler.
    const dir = await build({ 'index.html': PAGE, 'fjs-sqlite/sqlite3.wasm': 'wasm' })
    await writeOfflineShell({ db: true }, dir)
    const src = await sw(dir)
    expect(src).toContain('c.addAll(SHELL)).then(warmDb)')
    expect(src).toMatch(/clients\.claim\(\)\n\s+await warmDb\(\)/)
    expect(src).toContain('navigator.storage.getDirectory()')
  })

  test('include widens it by name', async () => {
    const dir = await build({
      'index.html':     PAGE,
      'assets/app.js':  'export {}',
      'media/hero.png': 'not really a png',
    })
    await writeOfflineShell({ include: ['media/hero.png'] }, dir)
    expect(shellOf(await sw(dir))).toContain('/media/hero.png')
  })

  test('the worker is never in its own precache list', async () => {
    // It would be cached at its first version and the app would never see a
    // release — the precise failure the version digest exists to prevent.
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    await writeOfflineShell(true, dir)
    expect(shellOf(await sw(dir))).not.toContain('/sw.js')
  })

  test('every page of a static build, not just index.html', async () => {
    const dir = await build({
      'index.html':          PAGE,
      'about/index.html':    PAGE,
      'products/a/index.html': PAGE,
      'assets/app.js':       'export {}',
    })
    await writeOfflineShell(true, dir)
    const shell = shellOf(await sw(dir))
    expect(shell).toContain('/about/index.html')
    expect(shell).toContain('/products/a/index.html')
  })
})

describe('the version', () => {
  test('two builds emitting the same files share a cache name', async () => {
    const a = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    const b = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    await writeOfflineShell(true, a)
    await writeOfflineShell(true, b)
    expect(versionOf(await sw(a))).toBe(versionOf(await sw(b)))
  })

  test('a build emitting a different file does not', async () => {
    const a = await build({ 'index.html': PAGE, 'assets/app.ABC.js': 'export {}' })
    const b = await build({ 'index.html': PAGE, 'assets/app.DEF.js': 'export {}' })
    await writeOfflineShell(true, a)
    await writeOfflineShell(true, b)
    expect(versionOf(await sw(a))).not.toBe(versionOf(await sw(b)))
  })
})

describe('registration', () => {
  test('every page registers it, once', async () => {
    const dir = await build({ 'index.html': PAGE, 'about/index.html': PAGE })
    await writeOfflineShell(true, dir)
    for (const p of ['index.html', 'about/index.html']) {
      const html = await readFile(join(dir, p), 'utf8')
      expect(html.match(/serviceWorker\.register/g)?.length).toBe(1)
    }
  })

  test('running twice does not register twice', async () => {
    // The pipeline is re-run by any build, and a page that accumulated one
    // snippet per run would be a page that grows.
    const dir = await build({ 'index.html': PAGE })
    await writeOfflineShell(true, dir)
    await writeOfflineShell(true, dir)
    const html = await readFile(join(dir, 'index.html'), 'utf8')
    expect(html.match(/serviceWorker\.register/g)?.length).toBe(1)
  })
})

describe('the byte budget', () => {
  // `FJS-D302`: a ceiling with a baseline that ratchets down only. A ceiling
  // this framework picked would be wrong for every app; a number nothing
  // enforces is the thing that was already there and was never read.

  const baselineOf = async (dir) =>
    JSON.parse(await readFile(join(dir, 'offline-baseline.json'), 'utf8')).shellKB

  test('a first build adopts whatever it costs today', async () => {
    // Refusing one would make the feature un-adoptable: there is no other way
    // for an app that already exists to start being graded.
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    const line = await writeOfflineShell(true, dir, dir)
    expect(line).toMatch(/baseline adopted at \d+ kB/)
    expect(await baselineOf(dir)).toBeGreaterThan(0)
  })

  test('the number graded is what goes over the WIRE', async () => {
    // Brotli, because that is what a server sends. Raw is printed for reading a
    // build and is not the thing a person waits for.
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'x'.repeat(200_000) })
    const line = await writeOfflineShell(true, dir, dir)
    expect(line).toMatch(/kB over the wire \(\d+ kB gzip, \d+ kB raw\)/)
    // Two hundred thousand identical characters compress to nothing, so a
    // budget over RAW bytes would report 200 kB for a download of about none.
    expect(await baselineOf(dir)).toBeLessThan(20)
  })

  test('a build that grows FAILS, and says both numbers', async () => {
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    await writeFile(join(dir, 'offline-baseline.json'), JSON.stringify({ shellKB: 0 }), 'utf8')
    await expect(writeOfflineShell(true, dir, dir))
      .rejects.toThrow(/offline shell is \d+ kB over the wire and the baseline is 0 kB/)
  })

  test('the refusal prints as its message, without a stack', async () => {
    // Vite prints a failed build with util.inspect, and a stack of rolldown
    // frames buried the command that fixes it.
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    await writeFile(join(dir, 'offline-baseline.json'), JSON.stringify({ shellKB: 0 }), 'utf8')
    const err = await writeOfflineShell(true, dir, dir).catch(e => e)
    expect(inspect(err)).toBe(err.message)
    expect(err.message).toMatch(/\n {4}FJS_OFFLINE_BASELINE=update bun run build\n/)
  })

  test('a build that shrinks passes and does NOT rewrite the file on its own', async () => {
    // A file that changes on every build is a diff nobody reads, and the
    // lowering is somebody's decision to record.
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    await writeFile(join(dir, 'offline-baseline.json'), JSON.stringify({ shellKB: 9999 }), 'utf8')
    const line = await writeOfflineShell(true, dir, dir)
    expect(line).toMatch(/kB under the baseline/)
    expect(await baselineOf(dir)).toBe(9999)
  })

  test('FJS_OFFLINE_BASELINE=update is the deliberate act', async () => {
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    await writeFile(join(dir, 'offline-baseline.json'), JSON.stringify({ shellKB: 0 }), 'utf8')
    process.env.FJS_OFFLINE_BASELINE = 'update'
    try {
      // It must not throw, and it must write the real number — this is the
      // escape for a feature somebody chose to pay for.
      const line = await writeOfflineShell(true, dir, dir)
      expect(line).toMatch(/baseline written/)
      expect(await baselineOf(dir)).toBeGreaterThan(0)
    } finally {
      delete process.env.FJS_OFFLINE_BASELINE
    }
  })

  test('the baseline lives in the SOURCE tree, not the output', async () => {
    // A build empties its own output, so a baseline written there is gone
    // before the next build can read it — which is how the first version of
    // this adopted a new baseline on every single run.
    const dir  = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    const src  = join(dir, 'src-root')
    await mkdir(src, { recursive: true })
    await writeOfflineShell(true, dir, src)
    await expect(readFile(join(src, 'offline-baseline.json'), 'utf8')).resolves.toContain('shellKB')
    await expect(readFile(join(dir, 'offline-baseline.json'), 'utf8')).rejects.toThrow()
  })
})

describe('what the worker will not do', () => {
  test('it writes to the cache at runtime only for the device database files', async () => {
    // A runtime cache would eventually answer a read with a row the live layer
    // believes it has already corrected. Asserted against the SOURCE, because a
    // behavioural test would pass on the day one was added.
    const dir = await build({ 'index.html': PAGE, 'fjs-sqlite/sqlite3.wasm': 'wasm' })
    await writeOfflineShell(true, dir)
    expect(/\.put\(/.test(await sw(dir))).toBe(false)

    await writeOfflineShell({ db: true }, dir)
    const src = await sw(dir)
    expect(src.match(/\.put\(/g)).toHaveLength(1)
    expect(src).toMatch(/if \(DB\.includes\(url\.pathname\)\) \{[^]*?c\.put\(url\.pathname/)
  })

  test('it answers only for a precached path or a navigation', async () => {
    const dir = await build({ 'index.html': PAGE })
    await writeOfflineShell(true, dir)
    const src = await sw(dir)
    expect(src).toContain("if (req.method !== 'GET') return")
    expect(src).toContain('if (!SHELL.includes(url.pathname)) return')
    expect(src).toContain("if (url.origin !== self.location.origin) return")
  })
})

describe('push: true', () => {
  // `FJS-D1442`: push is the same worker's second duty, and a push-only app
  // adopts no offline shell to get it.

  // Run, not grepped: a clean string is not proof of valid JS (Invariant 15),
  // and the listeners a worker registers are what the browser will dispatch to.
  const listenersOf = (src) => {
    const on = {}
    const self = { addEventListener: (type, fn) => { on[type] = fn }, skipWaiting() {}, clients: { claim() {} } }
    new Function('self', 'caches', src)(self, {})
    return Object.keys(on).sort()
  }

  test('alone, it writes a worker that precaches nothing and intercepts nothing', async () => {
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    const line = await writeOfflineShell(undefined, dir, dir, true)
    expect(line).toMatch(/push only, nothing precached/)
    const src = await sw(dir)
    expect(src).not.toMatch(/const SHELL/)
    expect(listenersOf(src)).toEqual(['activate', 'install', 'notificationclick', 'push'])
  })

  test('alone, it is not graded against the shell budget', async () => {
    // There is no shell to weigh, and a baseline file written for one would
    // be a number an app that never asked for offline has to keep.
    const dir = await build({ 'index.html': PAGE })
    await writeOfflineShell(undefined, dir, dir, true)
    await expect(readFile(join(dir, 'offline-baseline.json'), 'utf8')).rejects.toThrow()
  })

  test('alone, it still sweeps a shell an earlier build left', async () => {
    // An app that turned offline off keeps the last shell on every device
    // that installed it, unless the next worker deletes it.
    const dir = await build({ 'index.html': PAGE })
    await writeOfflineShell(undefined, dir, dir, true)
    const deleted = []
    let activate
    const self = { addEventListener: (t, fn) => { if (t === 'activate') activate = fn }, clients: { claim() {} } }
    const caches = { keys: async () => ['fjs-shell-abc', 'app-own'], delete: async (n) => { deleted.push(n) } }
    new Function('self', 'caches', await sw(dir))(self, caches)
    let done
    activate({ waitUntil: (p) => { done = p } })
    await done
    expect(deleted).toEqual(['fjs-shell-abc'])
  })

  test('alone, every page registers it once', async () => {
    const dir = await build({ 'index.html': PAGE, 'about/index.html': PAGE })
    await writeOfflineShell(undefined, dir, dir, true)
    await writeOfflineShell(undefined, dir, dir, true)
    for (const p of ['index.html', 'about/index.html']) {
      const html = await readFile(join(dir, p), 'utf8')
      expect(html.match(/serviceWorker\.register/g)?.length).toBe(1)
    }
  })

  test('beside offline, the shell is unchanged', async () => {
    const dir = await build({ 'index.html': PAGE, 'assets/app.js': 'export {}' })
    await writeOfflineShell(true, dir, dir, true)
    const src = await sw(dir)
    expect(shellOf(src)).toContain('/assets/app.js')
    expect(listenersOf(src)).toEqual(['activate', 'fetch', 'install', 'notificationclick', 'push'])
  })

  // The worker run against stand-ins for the two browser calls it makes.
  const pushWorker = async (clients = []) => {
    const dir = await build({ 'index.html': PAGE })
    await writeOfflineShell(undefined, dir, dir, true)
    const on = {}, shown = [], opened = []
    const self = {
      addEventListener: (t, fn) => { on[t] = fn },
      location: { origin: 'https://app.test' },
      registration: { showNotification: async (title, opts) => { shown.push({ title, ...opts }) } },
      clients: { matchAll: async () => clients, openWindow: async (u) => { opened.push(u) } },
    }
    new Function('self', 'caches', await sw(dir))(self, {})
    const fire = async (type, event) => {
      let done
      on[type]({ ...event, waitUntil: (p) => { done = p } })
      await done
    }
    return { fire, shown, opened }
  }

  // The notifications driver test decrypts its own output to this `payload`, so
  // the two ends of the wire cannot drift apart without one of them failing.
  test('a push shows the payload, with its topic as the tag', async () => {
    const { fire, shown } = await pushWorker()
    await fire('push', { data: { json: () => wire.payload } })
    expect(shown).toEqual([wire.shown])
  })

  test('a push that is not JSON is still shown', async () => {
    const { fire, shown } = await pushWorker()
    await fire('push', { data: { json: () => { throw new SyntaxError('x') }, text: () => 'hello' } })
    expect(shown).toEqual([{ title: '', body: 'hello', data: { url: undefined }, tag: undefined }])
  })

  test('a click focuses an open tab and navigates it', async () => {
    const calls = []
    const tab = { focus: async () => { calls.push('focus') }, navigate: async (u) => { calls.push(u) } }
    const { fire, opened } = await pushWorker([tab])
    let closed = false
    await fire('notificationclick', { notification: { close: () => { closed = true }, data: { url: '/orders/7' } } })
    expect(closed).toBe(true)
    expect(calls).toEqual(['focus', 'https://app.test/orders/7'])
    expect(opened).toEqual([])
  })

  test('a click with no tab open opens one, at the scope when the payload named no url', async () => {
    const { fire, opened } = await pushWorker()
    await fire('notificationclick', { notification: { close() {}, data: {} } })
    expect(opened).toEqual(['https://app.test/'])
  })

  test('offline alone carries no push handler', async () => {
    const dir = await build({ 'index.html': PAGE })
    await writeOfflineShell(true, dir, dir)
    expect(listenersOf(await sw(dir))).toEqual(['activate', 'fetch', 'install'])
  })

  test('anything but a boolean is refused', async () => {
    const dir = await build({ 'index.html': PAGE })
    await expect(writeOfflineShell(undefined, dir, dir, { always: true }))
      .rejects.toThrow(/`push` takes true or false/)
    await expect(readFile(join(dir, 'sw.js'), 'utf8')).rejects.toThrow()
  })

  test('false writes nothing', async () => {
    const dir = await build({ 'index.html': PAGE })
    expect(await writeOfflineShell(undefined, dir, dir, false)).toBe(null)
  })
})
