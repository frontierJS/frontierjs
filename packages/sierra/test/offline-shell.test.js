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
  test('it never writes to the cache at runtime', async () => {
    // A runtime cache would eventually answer a read with a row the live layer
    // believes it has already corrected. Asserted against the SOURCE, because a
    // behavioural test would pass on the day one was added.
    const dir = await build({ 'index.html': PAGE })
    await writeOfflineShell(true, dir)
    const src = await sw(dir)
    expect(/\.put\(/.test(src)).toBe(false)
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
