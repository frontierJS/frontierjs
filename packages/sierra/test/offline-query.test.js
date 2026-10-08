/**
 * test/offline-query.test.js — the read a resource must already hold.
 *
 * `FJS-D307` picked C: the cache in `list-cache.js` plus a DECLARATION, because
 * B alone only ever answers a question somebody happened to ask earlier and
 * *which screens did I visit before I lost signal* is not predictable.
 *
 * **Every test here is a pairing, and the reason is the failure this feature
 * fails by.** A warm writes under `listKey(service, query, directives)` and a
 * later `load()` reads under the same key — so a warm keyed even slightly
 * differently fills a slot nothing reads, and NOTHING about the app looks
 * different until somebody is in a basement. The cases that matter are
 * therefore always *warmed, then offline, then read*, and never *the warm ran*.
 *
 * The other half is what a warm may touch. `resource.load()` writes the store
 * the screen is rendering; a warm runs in the background under a question
 * nobody is looking at, so going through `load()` would swap a visible list.
 *
 * The network is the only fake. The schemas come from the build's own
 * `generateSchemas`, so `x-sync` is what litestone emits.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let _proxy
let _client

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => _client,
}))

const { generateSchemas }  = await import('../src/build/schema-plugin.js')
const { registerSchemas }  = await import('../src/resource/schema-registry.js')
const { createResource }   = await import('../src/resource/resource.js')
const { warmOffline, offlineServices, offlineStatus, declareOffline, _resetOffline } = await import('../src/resource/offline.js')
const { listCache, listKey, _resetListCache } = await import('../src/resource/list-cache.js')

// `Sheet` declares `@@sync`, `Plain` does not — which is the whole permission
// story: rows are only ever written to a device for a model whose schema said
// they could be (`FJS-D298`).
const SOURCE = `
model Sheet { id String @id @default(uuid())  name String  closedAt DateTime?  @@gate("0.0.0.0")  @@sync(server) }
model Roster { id String @id @default(uuid())  name String                     @@gate("0.0.0.0")  @@sync(read) }
model Plain { id String @id @default(uuid())  name String                      @@gate("0.0.0.0") }
`

/** A failure the client attaches no code to — a request that never got a reply. */
const offline = () => Promise.reject(new TypeError('Failed to fetch'))

/**
 * The Junction client, faked at the seam `resource.js` actually reaches — the
 * `connect` half beside the `resource` half, because the warm is armed off the
 * socket and the resource is built off the same object.
 */
function makeClient({ connected = true } = {}) {
  const handlers = {}
  return {
    connected,
    on:      (event, fn) => { (handlers[event] ??= []).push(fn) },
    emit:    (event) => (handlers[event] ?? []).forEach(fn => fn()),
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: (() => {
        let rows = []
        const subs = new Set()
        return {
          get: () => rows,
          set: (next) => { rows = next; subs.forEach(fn => fn(rows)) },
          subscribe: (fn) => { fn(rows); subs.add(fn); return () => subs.delete(fn) },
        }
      })(),
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: function (q, d) { return _proxy.find(q, d).then(r => { const rows = r?.data ?? []; this.store.set(rows); return rows }) },
    }),
  }
}

let warned

beforeEach(async () => {
  _resetOffline()
  _resetListCache()
  warned = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => warned.push(args.join(' ')))

  _client = makeClient()

  _proxy = {
    find:    (q)  => Promise.resolve({ data: [{ id: 'S1', name: 'open', closedAt: null, _q: q }], total: 1 }),
    get:     (id) => Promise.resolve({ id, name: 'as read' }),
    create:  (d)  => Promise.resolve({ ...d }),
    patch:   (id, d) => Promise.resolve({ ...d }),
    remove:  ()   => Promise.resolve({}),
    restore: ()   => Promise.resolve({}),
    invoke:  ()   => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-offline-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

afterEach(() => { vi.restoreAllMocks() })

const OPEN = { query: { closedAt: null } }

const sheets = (opts = {}) => createResource('sheets', { model: 'Sheet', ...opts })

// ─── the declaration ──────────────────────────────────────────────────────

describe('a resource says what it must hold', () => {
  test('declaring it registers the service; declaring nothing registers nothing', () => {
    sheets({ offlineQuery: OPEN })
    expect(offlineServices()).toEqual(['sheets'])

    _resetOffline()
    sheets()
    expect(offlineServices()).toEqual([])
  })

  // The contradiction, and the reason it cannot be silent: nothing is written
  // to a device for a model that never declared `@@sync`, so a warm would fill
  // nothing — and the outage is where that would otherwise be discovered.
  test('on a model with no @@sync it is refused by name, and nothing is registered', () => {
    createResource('plains', { model: 'Plain', offlineQuery: OPEN })
    expect(offlineServices()).toEqual([])
    expect(warned.join('\n')).toMatch(/offlineQuery needs @@sync on model Plain/)
  })
})

// FJS-1280: `@@sync(read)` is the word for a model held on a device and never
// written there, so it is permission enough for the read — a roster in a
// basement without declaring a collision policy that is not true.
describe('a model held with @@sync(read) may be warmed', () => {
  test('it is registered, with no refusal, and answers offline', async () => {
    const r = createResource('rosters', { model: 'Roster', offlineQuery: {} })
    expect(offlineServices()).toEqual(['rosters'])
    expect(warned.join('\n')).not.toMatch(/offlineQuery needs @@sync/)

    await warmOffline()
    _proxy.find = offline
    const rows = await r.load({})
    expect(rows[0].id).toBe('S1')
  })
})

// ─── the pairing that is the whole feature ────────────────────────────────

describe('a screen nobody opened still has its rows', () => {
  // The case `FJS-D307` exists for. The resource is created, the warm runs, and
  // the screen is loaded for the FIRST TIME with no network — which under B
  // alone answers nothing at all, because B only remembers a read that arrived.
  test('warmed, then offline, the declared question answers from the device', async () => {
    const r = sheets({ offlineQuery: OPEN })
    const report = await warmOffline()
    expect(report).toEqual([{ service: 'sheets', rows: 1, kept: false }])

    _proxy.find = offline
    const rows = await r.load(OPEN.query)
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('S1')
    expect(r.cachedAt()).toBeTypeOf('number')
  })

  // The honest bound, and it earns a test of its own because the feature reads
  // like a replica and is not one. A cache keyed by the QUESTION answers the
  // question it was given and no other; a screen wanting a second one declares
  // a second resource.
  test('a question that was NOT declared still fails offline', async () => {
    const r = sheets({ offlineQuery: OPEN })
    await warmOffline()

    _proxy.find = offline
    await expect(r.load({ closedAt: { not: null } })).rejects.toThrow(/Failed to fetch/)
  })

  // The key is one function and it has to stay one function. A second
  // derivation on the warm side fills a slot no load looks under, which is
  // invisible until the outage — so the two are asserted to agree by asking the
  // cache directly under the key `load()` would build.
  test('the warm writes under the key a load reads', async () => {
    sheets({ offlineQuery: OPEN })
    await warmOffline()
    const hit = await listCache().recall(listKey('sheets', OPEN.query, null))
    expect(hit?.rows?.[0]?.id).toBe('S1')
  })

  test('the declared filters are what actually goes to the server', async () => {
    sheets({ offlineQuery: { query: { closedAt: null }, directives: { limit: 7 } } })
    let asked = null
    _proxy.find = (q, d) => { asked = { q, d }; return Promise.resolve({ data: [], total: 0 }) }
    await warmOffline()
    expect(asked).toEqual({ q: { closedAt: null }, d: { limit: 7 } })
  })
})

// ─── what a warm may touch ────────────────────────────────────────────────

describe('a warm runs behind a screen, so it may not move one', () => {
  // `load()` writes the store the screen renders. A warm runs under a question
  // nobody is looking at, so routing it through `load()` would swap a visible
  // list for rows the person did not ask for — the feature breaking the screen
  // it exists to protect.
  test('the store the screen is showing is not touched', async () => {
    const r = sheets({ offlineQuery: OPEN })
    await r.load({ closedAt: { not: null } })
    const showing = r.store.get().map(x => x.id)

    _proxy.find = () => Promise.resolve({ data: [{ id: 'OTHER', name: 'warmed' }], total: 1 })
    await warmOffline()

    expect(r.store.get().map(x => x.id)).toEqual(showing)
    expect(r.store.get().some(x => x.id === 'OTHER')).toBe(false)
  })
})

// ─── when it runs ─────────────────────────────────────────────────────────

describe('armed like the queue', () => {
  test('a declaration made while the socket is up warms without being asked', async () => {
    sheets({ offlineQuery: OPEN })
    await new Promise(r => setTimeout(r, 0))
    expect(await listCache().recall(listKey('sheets', OPEN.query, null))).toBeTruthy()
  })

  // Re-warming on reconnect is what keeps what is held from being a copy of
  // last Tuesday — and `connect` rather than `navigator.onLine`, because the
  // socket says this client can talk to that server where the browser only says
  // the interface is up.
  test('and again on every reconnect', async () => {
    sheets({ offlineQuery: OPEN })
    await new Promise(r => setTimeout(r, 0))

    _proxy.find = () => Promise.resolve({ data: [{ id: 'FRESH', name: 'later' }], total: 1 })
    _client.emit('connect')
    await new Promise(r => setTimeout(r, 0))

    const hit = await listCache().recall(listKey('sheets', OPEN.query, null))
    expect(hit.rows[0].id).toBe('FRESH')
  })

  // The ordinary boot: a device that opened with no signal. The declaration is
  // made — resource modules are evaluated at import (Invariant 18) — and there
  // is nothing to warm from until the socket comes up.
  test('declared while the socket is down, warmed when it comes up', async () => {
    _client = makeClient({ connected: false })
    sheets({ offlineQuery: OPEN })
    await new Promise(r => setTimeout(r, 0))
    expect(await listCache().recall(listKey('sheets', OPEN.query, null))).toBeNull()

    _client.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    expect(await listCache().recall(listKey('sheets', OPEN.query, null))).toBeTruthy()
  })

  // And the ordering underneath it. A declaration made before `initJunction`
  // has run must not mark the app armed against a client that does not exist —
  // it did, and then nothing warmed for the life of the tab, which is the
  // failure this whole feature would have shipped as. Asked of `declareOffline`
  // directly, because `createResource` cannot be reached without a client.
  test('a declaration made before the client exists arms when one arrives', async () => {
    _client = null
    declareOffline({ service: 'early', find: () => Promise.resolve([{ id: 'E1' }]) })
    expect(offlineServices()).toEqual(['early'])
    expect(await listCache().recall(listKey('early', {}, null))).toBeNull()

    _client = makeClient()
    declareOffline({ service: 'late', find: () => Promise.resolve([{ id: 'L1' }]) })
    await new Promise(r => setTimeout(r, 0))
    expect(await listCache().recall(listKey('early', {}, null))).toBeTruthy()
  })
})

// ─── the failure path ─────────────────────────────────────────────────────

describe('a warm that cannot reach the server', () => {
  // The ordinary case, not a failure: a device that has been offline since it
  // booted warms nothing and must not throw doing it. Reported per service so a
  // screen can say what it holds.
  test('is reported per service and does not throw', async () => {
    sheets({ offlineQuery: OPEN })
    _proxy.find = offline
    const report = await warmOffline()
    expect(report[0].service).toBe('sheets')
    expect(report[0].error).toMatch(/Failed to fetch/)
  })

  // The two are told apart by their QUERY rather than by call order, because a
  // declaration warms the moment it is made — so a counter here would be
  // consumed by the automatic warm and the test would grade the wrong call.
  test('and one service failing does not stop the next being held', async () => {
    createResource('a', { model: 'Sheet', offlineQuery: { query: { tag: 'a' } } })
    createResource('b', { model: 'Sheet', offlineQuery: { query: { tag: 'b' } } })

    _proxy.find = (q) => (q.tag === 'a'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve({ data: [{ id: 'B1' }], total: 1 }))

    const report = await warmOffline()
    expect(report.map(r => r.service)).toEqual(['a', 'b'])
    expect(report[0].error).toBeTruthy()
    expect(report[1].rows).toBe(1)
  })
})

// ─── what the device says it holds ────────────────────────────────────────

describe('offlineStatus() — the last warm, readable by an app (FJS-1374)', () => {
  test('before any warm it says nothing ran, and names what was declared', () => {
    _client = makeClient({ connected: false })
    sheets({ offlineQuery: OPEN })
    const s = offlineStatus()
    expect(s.report()).toBeNull()
    expect(s.ranAt()).toBeNull()
    expect(s.services()).toEqual(['sheets'])
  })

  test('after a warm it holds that warm\'s report and when it ran', async () => {
    sheets({ offlineQuery: OPEN })
    _proxy.find = offline
    const before = Date.now()
    const report = await warmOffline()
    const s = offlineStatus()
    expect(s.report()).toEqual(report)
    expect(s.report()[0].error).toMatch(/Failed to fetch/)
    expect(s.ranAt()).toBeGreaterThanOrEqual(before)
  })

  test('the warm the socket arms lands on it without the app calling warmOffline', async () => {
    sheets({ offlineQuery: OPEN })
    await vi.waitFor(() => expect(offlineStatus().report()).toEqual([{ service: 'sheets', rows: 1, kept: false }]))
  })

  test('a subscriber hears each warm, and stops hearing after it unsubscribes', async () => {
    _client = makeClient({ connected: false })
    sheets({ offlineQuery: OPEN })
    const heard = []
    const off = offlineStatus().subscribe(s => heard.push(s.report()))
    await warmOffline()
    expect(heard).toEqual([[{ service: 'sheets', rows: 1, kept: false }]])
    off()
    await warmOffline()
    expect(heard.length).toBe(1)
  })
})
