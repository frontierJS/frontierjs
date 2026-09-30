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

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openChrome } from '../src/drive.js'

const CHROME = (() => {
  if (process.env.FJS_CHROME) return process.env.FJS_CHROME
  try { return execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim() } catch { return null }
})()

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

describe.skipIf(!CHROME)('the drive', () => {
  let http, origin, work

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'mesa-drive-test-'))
    http = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${http.address().port}/`
  })

  afterAll(async () => {
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
})
