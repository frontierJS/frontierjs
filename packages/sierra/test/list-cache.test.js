/**
 * test/list-cache.test.js — what this screen last saw.
 *
 * Phase 3 of the Homestead work. The service worker makes the app OPEN with no
 * network; this makes it have something in it, because a working shell over
 * empty tables reads to a person as *the data is gone*.
 *
 * Three rules are under test and each one is a refusal:
 *
 *   · only a model that declared `@@sync` is kept — putting rows a gate let
 *     this caller read onto a disk outlives the session, so it is the app's
 *     word and never a default;
 *   · it answers on SILENCE and never on a refusal — a 403 means this caller
 *     may not read these rows now, and serving a copy taken when they could is
 *     the one thing a cache here must never do;
 *   · it does not speak while the network works, so the online path is
 *     unchanged.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let ROWS = []
let finding = null
let _store = []
let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    on: () => () => {},
    resource: () => ({
      service: _proxy,
      store: {
        get: () => _store,
        subscribe: (fn) => { fn(_store); return () => {} },
        set: (rows) => { _store = rows },
      },
      hasMore: () => false,
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: async (q, d) => {
        if (finding) return finding(q, d)
        const r = await _proxy.find(q, d)
        _store = r?.data ?? []
        return _store
      },
    }),
  }),
}))

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { createResource }  = await import('../src/junction/resource.js')
const { listCache, listKey, _resetListCache } = await import('../src/junction/list-cache.js')

const SOURCE = `
model Sheet { id String @id @default(uuid())  name String  @@gate("0.0.0.0")  @@sync(server) }
model Plain { id Int    @id                   name String  @@gate("0.0.0.0") }
`

const offline = () => Promise.reject(new TypeError('Failed to fetch'))
const forbidden = () => Promise.reject(Object.assign(new Error('nope'), { code: 403 }))

beforeEach(async () => {
  _resetListCache()
  _store = []
  finding = null
  ROWS = [{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }]
  _proxy = {
    find:    () => Promise.resolve({ data: ROWS, total: ROWS.length }),
    get:     () => Promise.resolve({}),
    create:  (d) => Promise.resolve({ ...d }),
    patch:   (id, d) => Promise.resolve(d),
    remove:  () => Promise.resolve({}),
    restore: () => Promise.resolve({}),
    invoke:  () => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-listcache-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

describe('the key is the question', () => {
  test('two filters are two lists', () => {
    expect(listKey('s', { a: 1 }, null)).not.toBe(listKey('s', { a: 2 }, null))
  })

  test('the same filter written in a different order is one list', () => {
    // Otherwise the cache holds two copies and each screen only ever reads its
    // own, which looks exactly like a cache that is not working.
    expect(listKey('s', { a: 1, b: 2 }, null)).toBe(listKey('s', { b: 2, a: 1 }, null))
  })
})

describe('a syncable model', () => {
  test('a load that cannot reach the server answers what it last saw', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    expect(await sheets.load({}, null)).toHaveLength(2)
    expect(sheets.cachedAt()).toBe(null)

    finding = offline
    const again = await sheets.load({}, null)
    expect(again).toHaveLength(2)
    expect(again[0].name).toBe('one')
    // A number here is the screen's licence to say *as of then, from this
    // device* rather than pretending the rows are current.
    expect(typeof sheets.cachedAt()).toBe('number')
  })

  test('the rows go into the same store the live layer writes', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    await sheets.load({}, null)
    _store = []
    finding = offline
    await sheets.load({}, null)
    expect(_store).toHaveLength(2)
  })

  test('a REFUSAL is never answered from the cache', async () => {
    // 403 means this caller may not read these rows now. Serving a copy taken
    // when they could is the one thing this must never do.
    const sheets = createResource('sheets', { model: 'Sheet' })
    await sheets.load({}, null)
    finding = forbidden
    await expect(sheets.load({}, null)).rejects.toThrow(/nope/)
  })

  test('with nothing remembered the failure is the failure', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    finding = offline
    await expect(sheets.load({}, null)).rejects.toThrow(/Failed to fetch/)
  })

  test('a different query does not answer from another query\'s list', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    await sheets.load({ name: 'one' }, null)
    finding = offline
    await expect(sheets.load({ name: 'two' }, null)).rejects.toThrow(/Failed to fetch/)
  })
})

describe('a model that declared nothing', () => {
  test('is kept nowhere', async () => {
    const plains = createResource('plains', { model: 'Plain' })
    await plains.load({}, null)
    expect(listCache().list()).toEqual([])

    finding = offline
    await expect(plains.load({}, null)).rejects.toThrow(/Failed to fetch/)
  })
})

describe('a composed list', () => {
  // `composed` says the service's find answers more than the rows. It is not a
  // word about the basement, and it used to be one: its read skipped `load()`,
  // the only path that falls back, so the list read nothing offline (FJS-1281).
  test('offline, it answers what the device holds', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    // Warmed the way a device is: an ordinary list over the same question.
    sheets.list({ state: 'local' })
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))

    _proxy.find = offline
    finding = offline
    const list = sheets.list({ state: 'local', composed: true })
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    expect(list.error).toBe(null)
    expect(list.rows).toHaveLength(2)
    expect(typeof sheets.cachedAt()).toBe('number')
  })

  test('a refusal still refuses', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    await sheets.load({}, null)

    _proxy.find = forbidden
    finding = forbidden
    const list = sheets.list({ state: 'local', composed: true })
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    expect(list.error?.code).toBe(403)
    expect(list.rows).toEqual([])
  })
})
