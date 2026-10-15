/**
 * test/local-db.test.js — the device's own SQLite as a read store.
 *
 * `FJS-D307`'s storage swap. The engine itself is litestone's and is driven in a
 * real browser by that package's own `test:browser`; what is under test HERE is
 * the seam — when sierra writes to it, when it reads from it, and what happens
 * when it cannot answer.
 *
 * **The order in the catch is the whole of it.** A `load()` that cannot reach
 * the server asks the local database FIRST, because SQL can answer a question
 * this screen has never asked — a different filter, a different page, a
 * different sort — where the list cache can only replay the exact one it was
 * given. What that buys is only real if `null` means *cannot answer* and falls
 * through rather than rendering as an empty list, so every case below is a
 * pairing: the database answering, and the database declining.
 *
 * The client is a fake because the real one needs a browser. What it is NOT is
 * a stand-in for the QUERY: the arguments handed to it are asserted as the
 * arguments the server's own derived find builds, since the two being the same
 * shape is the reason this is a swap rather than a translation layer.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let _proxy
let _client
// What the live list says of its last answer — a window with a page 2.
let _hasMore = false

vi.mock('@frontierjs/sierra/resource', () => ({ getClient: () => _client }))

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { createResource }  = await import('../src/resource/resource.js')
const { _resetListCache, listCache, listKey } = await import('../src/resource/list-cache.js')
const { warmOffline, _resetOffline } = await import('../src/resource/offline.js')
const { writeThrough, readLocal, localDbConfigured, _resetLocalDb, _useLocalDbClient } =
  await import('../src/resource/local-db.js')
const { createJunctionClient } = await import('../../junction/src/client/index.ts')

const SOURCE = `
model Sheet { id String @id @default(uuid())  name String  closedAt DateTime?  @@gate("0.0.0.0")  @@sync(server) }
model Plain { id String @id @default(uuid())  name String                      @@gate("0.0.0.0") }
model Note  { id Int @id  body String  version Int @version                     @@gate("0.0.0.0")  @@sync(server) }
`

const offline = () => Promise.reject(new TypeError('Failed to fetch'))

// ─── the fake device ──────────────────────────────────────────────────────
//
// A litestone browser client answers `$models` with its ACCESSORS and is driven
// through `asSystem()`. Both are the real contract: the accessor list is what
// the module looks a model up in rather than deriving a name, and `asSystem()`
// is the ruling — a cache replays what the server already gave this caller and
// does not re-decide it (`FJS-D307`).
let _device
/**
 * `rows` SEEDS the table rather than being the answer to every read.
 *
 * It was the answer, and that made the sharpest test here pass against a device
 * nothing had ever written to: *a question the warm never asked is answered
 * offline* is a claim about a row having been STORED, and a fake that answers
 * regardless cannot tell a hydrated device from an empty one — which is the
 * exact confusion the feature is about. So the fake keeps what it is given.
 */
function makeDevice({ models = ['sheet'], rows = [], fail = null, fts = false, lockedUpdate = false, lockedDelete = false, softDelete = false } = {}) {
  const calls = []
  const held = new Map(rows.map(r => [r.id, r]))
  const table = {
    upsertMany: (args) => {
      calls.push(['upsertMany', args])
      if (fail) return Promise.reject(fail)
      // Litestone's refusal under @@softDelete (`FJS-D923`): the conflict half
      // names `deletedAt` when `update:` is absent and a row carries it.
      if (softDelete) {
        const named = args.update == null
          ? args.data.some(r => r?.deletedAt !== undefined)
          : [args.update].flat().includes('deletedAt')
        if (named) return Promise.reject(Object.assign(new Error('upsertMany() cannot write Sheet.deletedAt'),
          { name: 'SoftDeleteWriteError' }))
      }
      // Litestone's refusal for an update gate of 9, which the system client
      // takes too: upsertMany grades its conflict half unless `update: []`.
      if (lockedUpdate && !(Array.isArray(args.update) && !args.update.length))
        return Promise.reject(Object.assign(new Error('"Sheet.update" is LOCKED'),
          { code: 'ACCESS_DENIED', operation: 'update', required: 9 }))
      for (const row of args.data) held.set(row.id, row)
      return Promise.resolve({ count: args.data.length })
    },
    // A `where` of plain values is applied, an absent column reading as null,
    // because what a whole answer takes off is decided by which held rows the
    // question reaches — a fake answering every row would take off rows the
    // question never named and pass.
    findMany: (args) => {
      calls.push(['findMany', args])
      if (fail) return Promise.reject(fail)
      const where = Object.entries(args?.where ?? {})
      return Promise.resolve([...held.values()].filter(r => where.every(([k, v]) => (r[k] ?? null) === v)))
    },
    deleteMany: (args) => {
      calls.push(['deleteMany', args])
      if (lockedDelete) return Promise.reject(Object.assign(new Error('"Sheet.delete" is LOCKED'),
        { code: 'ACCESS_DENIED', operation: 'delete', required: 9 }))
      const keys = args?.where?.id?.in
      if (keys) for (const k of keys) held.delete(k)
      else held.clear()
      return Promise.resolve({ count: 0 })
    },
    // Litestone's own answer for a model with no `@@fts`: a refusal by name,
    // which is a throw and so *cannot answer* here.
    search: (q, args) => {
      calls.push(['search', q, args])
      if (!fts) return Promise.reject(new Error(`Sheet.search() requires @@fts`))
      return Promise.resolve([...held.values()].filter(r => String(r.name ?? '').includes(q)))
    },
  }
  const client = {
    $models: models,
    $close: () => Promise.resolve(true),
    asSystem: () => Object.fromEntries(models.map(m => [m, table])),
  }
  return { client, calls, held: () => [...held.keys()], systemUsed: () => calls.length > 0 }
}

/** Configure the module and hand it the fake instead of opening a worker. */
const useDevice = (d, config = {}) => _useLocalDbClient(d?.client ?? null, config)

beforeEach(async () => {
  _resetLocalDb()
  _resetListCache()
  _resetOffline()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  _hasMore = false

  _proxy = {
    find:    () => Promise.resolve({ data: [{ id: 'S1', name: 'from the server' }], total: 1 }),
    get:     (id) => Promise.resolve({ id }),
    create:  (d) => Promise.resolve({ ...d }),
    patch:   (id, d) => Promise.resolve({ ...d }),
    remove:  () => Promise.resolve({}),
    restore: () => Promise.resolve({}),
    invoke:  () => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const handlers = {}
  _client = {
    connected: false,
    callHeaders: () => ({}),
    on: (e, fn) => { (handlers[e] ??= []).push(fn) },
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: (() => {
        let rows = []
        return { get: () => rows, set: (n) => { rows = n }, subscribe: (fn) => { fn(rows); return () => {} } }
      })(),
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: function (q, d) { return _proxy.find(q, d).then(r => { const rows = r?.data ?? []; this.store.set(rows); return rows }) },
      hasMore: () => _hasMore,
    }),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-localdb-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)

  _device = makeDevice()
})

afterEach(() => { vi.restoreAllMocks(); _resetLocalDb() })

const sheets = (opts = {}) => createResource('sheets', { model: 'Sheet', ...opts })

// ─── off unless asked ─────────────────────────────────────────────────────

describe('an app that did not ask for one', () => {
  test('is not configured, and neither half does anything', async () => {
    expect(localDbConfigured()).toBe(false)
    expect(await writeThrough('Sheet', [{ id: 'A' }])).toBe(false)
    expect(await readLocal('Sheet', {}, {})).toBeNull()
  })

  test('and a load that cannot reach the server still falls back to the list cache', async () => {
    const r = sheets()
    await r.load({})
    _proxy.find = offline
    const rows = await r.load({})
    expect(rows[0].id).toBe('S1')
    expect(r.cachedAt()).toBeTypeOf('number')
  })
})

// ─── the model has to have said so ────────────────────────────────────────

describe('only a @@sync model has a table here', () => {
  test('a model the device schema never carried is declined, not invented', async () => {
    useDevice(makeDevice({ models: ['sheet'] }))
    expect(await writeThrough('Plain', [{ id: 'A' }])).toBe(false)
    expect(await readLocal('Plain', {}, {})).toBeNull()
  })

  // The accessor is asked of the CLIENT rather than derived from the model
  // name. Litestone decides how a model becomes a table accessor, and a second
  // derivation here would be right until the day it was not — and wrong then in
  // the way that answers an empty list rather than an error.
  test('the accessor comes from the client, whatever the name looks like', async () => {
    const d = makeDevice({ models: ['inventoryMovement'] })
    useDevice(d)
    expect(await writeThrough('InventoryMovement', [{ id: 1 }])).toBe(true)
    expect(d.calls[0][0]).toBe('upsertMany')
  })
})

// ─── what crosses, and how ────────────────────────────────────────────────

describe('keeping what the server answered', () => {
  test('rows go in as ONE call, not one call per row', async () => {
    const d = makeDevice()
    useDevice(d)
    await writeThrough('Sheet', [{ id: 'A' }, { id: 'B' }, { id: 'C' }])
    expect(d.calls.length).toBe(1)
    expect(d.calls[0][0]).toBe('upsertMany')
    expect(d.calls[0][1].data.length).toBe(3)
  })

  test('an empty answer writes nothing at all', async () => {
    const d = makeDevice()
    useDevice(d)
    expect(await writeThrough('Sheet', [])).toBe(false)
    expect(d.calls.length).toBe(0)
  })

  // A write-through is a side effect of a read that already succeeded, so a
  // device that cannot write must not take the screen down with it.
  test('a device that refuses the write is reported, not thrown', async () => {
    useDevice(makeDevice({ fail: new Error('quota') }))
    expect(await writeThrough('Sheet', [{ id: 'A' }])).toBe(false)
  })

  // An append-only ledger, `@@gate("5.5.9.9")`: no row of it ever changes on
  // the server, so replaying insert-only loses nothing (`FJS-1700`).
  test('a model whose update gate is LOCKED is kept insert-only, not dropped', async () => {
    const d = makeDevice({ lockedUpdate: true })
    useDevice(d)
    expect(await writeThrough('Sheet', [{ id: 'A' }])).toBe(true)
    expect(d.calls.map(c => c[1].update)).toEqual([undefined, []])
  })

  // `deletedAt` belongs to remove() and restore(), so the conflict half may not
  // name it (`FJS-D923`); the insert half still carries it (`FJS-2763`).
  test('a @@softDelete model is kept: the conflict half skips deletedAt', async () => {
    const d = makeDevice({ softDelete: true })
    useDevice(d)
    const rows = [{ id: 'A', name: 'a', deletedAt: null }]
    expect(await writeThrough('Sheet', rows)).toBe(true)
    expect(d.held()).toEqual(['A'])
    const last = d.calls.at(-1)[1]
    expect(last.data).toEqual(rows)
    expect(last.update).toEqual(['id', 'name'])
  })

  test('and any other refusal is still reported, never retried', async () => {
    const d = makeDevice({ fail: Object.assign(new Error('denied'), { code: 'ACCESS_DENIED', operation: 'update', required: 8 }) })
    useDevice(d)
    expect(await writeThrough('Sheet', [{ id: 'A' }])).toBe(false)
    expect(d.calls.length).toBe(1)
  })
})

// ─── the read, and the arguments it builds ────────────────────────────────

describe('answering a read from the device', () => {
  // The arguments the SERVER's derived find builds, which is the reason this is
  // a swap and not a translation: a junction service over a litestone model
  // passes the caller's filters through as the `where` and its directives as
  // the rest. A shape invented here would drift from that with nothing saying so.
  test('the query becomes the where and the directives become the rest', async () => {
    const d = makeDevice({ rows: [{ id: 'L1' }] })
    useDevice(d)
    await readLocal('Sheet', { closedAt: null }, { limit: 40, offset: 10, orderBy: '-id', select: 'id,name' })
    expect(d.calls[0][1]).toEqual({
      where:   { closedAt: null },
      limit:   40,
      offset:  10,
      orderBy: [{ id: 'desc' }],
      select:  { id: true, name: true },
    })
  })

  // `orderBy` and `select` do NOT travel as themselves, and this is the one
  // assertion that says so. A screen states the wire's spelling because that is
  // what a URL carries; SQLite takes the structured form and THROWS on the
  // other — and the throw falls through to the list cache underneath, which
  // answers the same question with the same rows. So the whole feature was off
  // and every drive was green (`FJS-1179`). The translation is junction's, the
  // same function the server compiles its own SQL from.
  test('the two directives that do not travel as themselves are translated, not passed', async () => {
    const d = makeDevice({ rows: [] })
    useDevice(d)
    await readLocal('Sheet', {}, { orderBy: 'name,-closedAt', select: ['id'] })
    expect(d.calls[0][1].orderBy).toEqual([{ name: 'asc' }, { closedAt: 'desc' }])
    expect(d.calls[0][1].select).toEqual({ id: true })
  })

  test('a directive nobody stated is not invented', async () => {
    const d = makeDevice({ rows: [] })
    useDevice(d)
    await readLocal('Sheet', {}, {})
    expect(d.calls[0][1]).toEqual({ where: {} })
  })

  // A `$search` dropped on the way to the device is a read of the whole table,
  // stored as the screen's rows: every offline search box showing every row as
  // matching (`FJS-1311`). It goes to the engine's own `search()`, the call the
  // server's derived find makes, and a device with no FTS index refuses it —
  // which is *cannot answer*, never the table.
  test('a search is answered by the device index, and never by the whole table', async () => {
    const d = makeDevice({ fts: true, rows: [{ id: 'L1', name: 'tachyon drive' }, { id: 'L2', name: 'unrelated' }] })
    useDevice(d)
    const rows = await readLocal('Sheet', { closedAt: null }, { search: 'tachyon', limit: 20 })
    expect(rows.map(r => r.id)).toEqual(['L1'])
    expect(d.calls).toEqual([['search', 'tachyon', { where: { closedAt: null }, limit: 20 }]])
  })

  test('a search the device has no index for is null, not every row', async () => {
    const d = makeDevice({ rows: [{ id: 'L1', name: 'tachyon drive' }, { id: 'L2', name: 'unrelated' }] })
    useDevice(d)
    expect(await readLocal('Sheet', {}, { search: 'tachyon', limit: 20 })).toBeNull()
    expect(d.calls.some(([m]) => m === 'findMany')).toBe(false)
  })

  // `null` is *cannot answer* and `[]` is *no rows*, and the two must never be
  // the same value: one falls through to the list cache and the other is a
  // legitimate empty screen.
  test('a device that cannot answer says null, and an empty table says []', async () => {
    useDevice(makeDevice({ rows: [], fail: new Error('no such table') }))
    expect(await readLocal('Sheet', {}, {})).toBeNull()

    _resetLocalDb()
    useDevice(makeDevice({ rows: [] }))
    expect(await readLocal('Sheet', {}, {})).toEqual([])
  })
})

// ─── the order inside the catch ───────────────────────────────────────────

describe('a load that cannot reach the server', () => {
  test('is answered by SQL, under a question the screen never asked before', async () => {
    const r = sheets()
    // Nothing has been loaded, so the list cache holds nothing for this
    // question — which is exactly the case the cache cannot serve and the
    // database can.
    useDevice(makeDevice({ rows: [{ id: 'FROM-SQL', name: 'local' }] }))
    _proxy.find = offline

    const rows = await r.load({ closedAt: null }, { limit: 5 })
    expect(rows.map(x => x.id)).toEqual(['FROM-SQL'])
    expect(r.store.get().map(x => x.id)).toEqual(['FROM-SQL'])
    expect(r.cachedAt()).toBeTypeOf('number')
  })

  test('and falls through to the list cache when the device declines', async () => {
    const r = sheets()
    await r.load({})                       // the list cache now holds this one
    useDevice(makeDevice({ fail: new Error('no such table') }))
    _proxy.find = offline

    const rows = await r.load({})
    expect(rows[0].id).toBe('S1')
  })

  // The device is empty until a write-through has landed, and an empty table
  // renders exactly like a list that is genuinely empty. The cache below may
  // hold the SERVER's own answer to this question, so nothing is the weaker
  // answer and defers — which is the opposite of the rule one line up, where a
  // device that cannot answer at all also defers.
  test('an EMPTY device defers to the cache rather than emptying the screen', async () => {
    const r = sheets()
    await r.load({})
    useDevice(makeDevice({ rows: [] }))
    _proxy.find = offline

    const rows = await r.load({})
    expect(rows.map(x => x.id)).toEqual(['S1'])
  })

  test('and an empty device still beats a throw when nothing remembers the question', async () => {
    const r = sheets()
    useDevice(makeDevice({ rows: [] }))
    _proxy.find = offline

    expect(await r.load({ closedAt: null })).toEqual([])
  })

  test('a search the device cannot answer does not render the whole table', async () => {
    const r = sheets()
    useDevice(makeDevice({ rows: [{ id: 'L1', name: 'tachyon drive' }, { id: 'L2', name: 'unrelated' }] }))
    _proxy.find = offline

    await expect(r.load({}, { search: 'tachyon' })).rejects.toThrow(/Failed to fetch/)
    expect(r.store.get()).toEqual([])
    expect(r.cachedAt()).toBeNull()
  })

  // The rule the cache underneath already follows, and the one thing neither
  // store may do: a 403 means this caller may not read these rows NOW.
  test('a REFUSAL is never answered from the device', async () => {
    const r = sheets()
    useDevice(makeDevice({ rows: [{ id: 'FROM-SQL' }] }))
    _proxy.find = () => Promise.reject(Object.assign(new Error('Forbidden'), { code: 403 }))

    await expect(r.load({})).rejects.toThrow(/Forbidden/)
  })
})

// ─── the write-through, through the resource ──────────────────────────────

describe('a load that DID reach the server', () => {
  test('keeps its rows on the device, without the screen waiting on a disk', async () => {
    const d = makeDevice()
    useDevice(d)
    const r = sheets()
    await r.load({})
    // Not awaited by `load()`, so the assertion is on the next turn rather than
    // on the call — which is the behaviour, not a test convenience.
    await new Promise(res => setTimeout(res, 0))
    expect(d.calls.some(c => c[0] === 'upsertMany')).toBe(true)
  })

  test('and a model that never declared @@sync keeps nothing', async () => {
    const d = makeDevice({ models: ['plain'] })
    useDevice(d)
    const r = createResource('plains', { model: 'Plain' })
    await r.load({})
    await new Promise(res => setTimeout(res, 0))
    expect(d.calls.length).toBe(0)
  })
})

// ─── FJS-2256: a row the server no longer answers leaves the device ───────
//
// The device was only ever UPSERTED into, so a row deleted on the server — by
// this screen or anybody — stayed and answered every offline read: an online
// remove answered 200, an online reload listed none, and offline the device
// still listed the row. Two ways off: the remove itself, and an answer that was
// the whole of its `where` taking off what it did not name.

describe('a row the server no longer answers leaves the device', () => {
  const tick = () => new Promise(res => setTimeout(res, 0))

  test('a remove that landed takes the row off', async () => {
    const d = makeDevice({ rows: [{ id: 'S1', name: 'a' }, { id: 'S2', name: 'b' }] })
    useDevice(d)
    await sheets().service.remove('S1')
    await tick()
    expect(d.held()).toEqual(['S2'])
  })

  // The stressor's own sequence: removed elsewhere, the reload online answers
  // none, and the offline read must agree with it rather than with last week.
  test('an online reload answering none empties the question, and offline agrees', async () => {
    const d = makeDevice({ rows: [{ id: 'F1', name: 'followed' }] })
    useDevice(d)
    const r = sheets()
    _proxy.find = () => Promise.resolve({ data: [], total: 0 })
    await r.load({})
    await tick()
    expect(d.held()).toEqual([])

    _proxy.find = offline
    expect(await r.load({})).toEqual([])
  })

  test('a whole answer takes off only what its own where reaches', async () => {
    const d = makeDevice({ rows: [
      { id: 'S1', name: 'kept', closedAt: null },
      { id: 'S2', name: 'gone', closedAt: null },
      { id: 'S3', name: 'another question', closedAt: '2026-10-01' },
    ] })
    useDevice(d)
    _proxy.find = () => Promise.resolve({ data: [{ id: 'S1', name: 'kept', closedAt: null }], total: 1 })
    await sheets().load({ closedAt: null })
    await tick()
    expect(d.held().sort()).toEqual(['S1', 'S3'])
  })

  // A window names a slice of its `where`. Taking off what a slice left out
  // would empty the rest of the table on every paged list.
  test('a window with a page 2 takes nothing off', async () => {
    const d = makeDevice({ rows: [{ id: 'S1' }, { id: 'S2' }] })
    useDevice(d)
    _hasMore = true
    await sheets().load({}, { limit: 1 })
    await tick()
    expect(d.held().sort()).toEqual(['S1', 'S2'])
  })

  test('nor does a page past the first, or a search', async () => {
    const d = makeDevice({ rows: [{ id: 'S1' }, { id: 'S2' }] })
    useDevice(d)
    await sheets().load({}, { offset: 20 })
    await sheets().load({}, { search: 'from' })
    await tick()
    expect(d.calls.some(c => c[0] === 'deleteMany')).toBe(false)
  })

  test('the warm is an answer too, and an empty one is kept as empty', async () => {
    const d = makeDevice({ rows: [{ id: 'OLD', closedAt: null }] })
    useDevice(d)
    _proxy.find = () => Promise.resolve({ data: [], total: 0 })
    sheets({ offlineQuery: { query: { closedAt: null } } })

    const report = await warmOffline()
    expect(report).toEqual([{ service: 'sheets', rows: 0, kept: true }])
    expect(d.held()).toEqual([])
  })

  test('and a warm whose envelope says there is more takes nothing off', async () => {
    const d = makeDevice({ rows: [{ id: 'OLD' }] })
    useDevice(d)
    _proxy.find = () => Promise.resolve({ data: [{ id: 'S1' }], total: 2 })
    sheets({ offlineQuery: { query: {} } })
    await warmOffline()
    expect(d.held().sort()).toEqual(['OLD', 'S1'])
  })

  // `@@gate("5.5.9.9")`: nothing removes such a row on the server either, and
  // the rows that did arrive are still kept.
  test('a device whose delete is LOCKED keeps the answer and warns once', async () => {
    const d = makeDevice({ rows: [{ id: 'OLD' }], lockedDelete: true })
    useDevice(d)
    expect(await writeThrough('Sheet', [{ id: 'S1' }], { where: {}, idField: 'id' })).toBe(true)
    expect(d.held().sort()).toEqual(['OLD', 'S1'])
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  test('a held remove, replayed and acknowledged, takes the row off', async () => {
    const d = makeDevice({ rows: [{ id: 'S1' }, { id: 'S2' }] })
    useDevice(d)
    const { pendingQueue, drainPending, _resetPendingQueue } = await import('../src/resource/pending.js')
    _resetPendingQueue()
    const q = pendingQueue()
    await q.ready
    await q.add({ service: 'sheets', model: 'Sheet', method: 'remove', id: 'S1', idField: 'id' })
    await drainPending({ callHeaders: () => ({}), service: () => ({ remove: () => Promise.resolve({ id: 'S1' }) }) })
    expect(d.held()).toEqual(['S2'])
    _resetPendingQueue()
  })
})

// ─── FJS-2250: one row with no network ────────────────────────────────────
//
// `load()` answered an outage from the device and `record(id)` answered null,
// so a detail screen opened offline said the row did not exist while the list
// before it had just shown it. Driven through Junction's REAL client, because
// `record()` is its view and a fake would have no `ready`, no `error()` and no
// node for the answer to land in.

describe('record(id) with no network', () => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    _client = createJunctionClient({ url: 'http://localhost:3000' })
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
  })
  afterEach(() => vi.unstubAllGlobals())

  test('answers the row the device holds, with no failure on the view', async () => {
    useDevice(makeDevice({ rows: [{ id: 'S1', name: 'held' }, { id: 'S2', name: 'other' }] }))
    const row = sheets().record('S1')
    expect(await row.ready).toEqual({ id: 'S1', name: 'held' })
    expect(row.error()).toBeNull()
    row.release()
  })

  test('a row the device does not hold is still the outage it was', async () => {
    useDevice(makeDevice({ rows: [{ id: 'S2', name: 'other' }] }))
    const row = sheets().record('S1')
    expect(await row.ready).toBeNull()
    expect(row.error()).toEqual({ status: 0, code: 'TypeError' })
    row.release()
  })

  // A 403 is this caller's answer NOW; a copy taken when they could read the
  // row must not overrule it.
  test('a refusal is never answered from the device', async () => {
    const d = makeDevice({ rows: [{ id: 'S1', name: 'held' }] })
    useDevice(d)
    vi.stubGlobal('fetch', () => Promise.resolve(json({ name: 'Forbidden', message: 'no', code: 403 }, 403)))
    const row = sheets().record('S1')
    expect(await row.ready).toBeNull()
    expect(row.error().status).toBe(403)
    expect(d.calls.length).toBe(0)
    row.release()
  })

  // A held edit of a row opened offline carried no version and replayed as a
  // 400 (`FJS-1299`); the device's copy is a read of the version it holds.
  test('the version of the device\'s row is the one this screen read', async () => {
    useDevice(makeDevice({ models: ['note'], rows: [{ id: 7, body: 'held', version: 4 }] }))
    const notes = createResource('notes', { model: 'Note' })
    const row = notes.record(7)
    await row.ready
    expect(notes.version(7)).toBe(4)
    row.release()
  })
})

// ─── hydration — the tables are filled on purpose ─────────────────────────
//
// What phase 4 owed last. The device used to be only as full as what a screen
// HAPPENED to read, so somebody who never opened a screen before losing signal
// had an empty database and `@@sync`'s read direction was a claim with nothing
// behind it. The warm a resource already declares now fills the tables too.
//
// **The pairing here is not device-answers / device-declines, it is a question
// the warm never asked.** A warm that filled only the cache passes any
// assertion made about the declared question, because the cache holds exactly
// that one — so the only honest test is a DIFFERENT question, which a cache
// cannot answer and a query engine can.

describe('the warm fills the device rather than the cache', () => {
  const OPEN = { query: { closedAt: null } }

  test('a declared read reaches the tables, and the report says it did', async () => {
    const d = makeDevice()
    useDevice(d)
    sheets({ offlineQuery: OPEN })

    const report = await warmOffline()
    expect(report).toEqual([{ service: 'sheets', rows: 1, kept: true }])
    expect(d.calls[0][0]).toBe('upsertMany')
    expect(d.calls[0][1].data.map(x => x.id)).toEqual(['S1'])
  })

  test('and with no device it is reported as kept: false rather than assumed', async () => {
    sheets({ offlineQuery: OPEN })
    const report = await warmOffline()
    expect(report).toEqual([{ service: 'sheets', rows: 1, kept: false }])
  })

  // The whole of it. Nothing has opened this screen, the warm asked one
  // question, and the screen asks another — which is the case the cache
  // underneath cannot serve at all.
  test('a question the warm never asked is answered offline', async () => {
    // Seeded with NOTHING. Every row this answers with was put there by the
    // warm, which is the only version of this assertion worth making.
    useDevice(makeDevice())
    const r = sheets({ offlineQuery: OPEN })
    await warmOffline()

    _proxy.find = offline
    const rows = await r.load({}, { limit: 5, orderBy: '-id' })
    expect(rows.map(x => x.id)).toEqual(['S1'])
  })

  // The control for the case above: take the device away and the same load has
  // nothing to answer from, because the warm's cache entry is under the warm's
  // own key. Without this the test above passes on a cache hit nobody noticed.
  test('and with no device the same load has nothing — the cache holds only the warm\'s own question', async () => {
    const r = sheets({ offlineQuery: OPEN })
    await warmOffline()

    _proxy.find = offline
    await expect(r.load({}, { limit: 5, orderBy: '-id' })).rejects.toThrow()
  })

  // ── `FJS-D337`: the declared window is the DEVICE's ─────────────────────
  //
  // One grain, not two. With the tables holding the rows, a slot keyed by the
  // declared question is a second answer to something SQL answers anyway — and
  // a narrower one, since it replays that question and no other.
  test('a model the device kept gets no keyed slot', async () => {
    useDevice(makeDevice())
    sheets({ offlineQuery: OPEN })

    const report = await warmOffline()
    expect(report).toEqual([{ service: 'sheets', rows: 1, kept: true }])
    expect(await listCache().recall(listKey('sheets', OPEN.query, null))).toBeNull()
  })

  // The condition the ruling turns on, and the reason it is not read off the
  // config: `localDb()` answers null on any failure by design, so a device that
  // says `db: true` and cannot write is the case that would otherwise render an
  // empty screen with nothing said. Driven all the way to a load, because *the
  // slot exists* and *the screen reads it* are two claims.
  test('and one it could not keep falls back to the slot, which the screen reads', async () => {
    useDevice(makeDevice({ fail: new Error('no quota') }))
    const r = sheets({ offlineQuery: OPEN })

    const report = await warmOffline()
    expect(report).toEqual([{ service: 'sheets', rows: 1, kept: false, error: 'no quota' }])
    expect(await listCache().recall(listKey('sheets', OPEN.query, null))).toBeTruthy()

    _proxy.find = offline
    const rows = await r.load(OPEN.query)
    expect(rows.map(x => x.id)).toEqual(['S1'])
  })

  // A resource over no model — a status read, a projection — declares a read
  // the cache can hold and the device cannot, because there is no table for it.
  test('a declaration with no model keeps nothing and says so', async () => {
    const d = makeDevice()
    useDevice(d)
    const { declareOffline } = await import('../src/resource/offline.js')
    declareOffline({ service: 'status', find: () => Promise.resolve([{ id: 1 }]) })

    const report = await warmOffline()
    expect(report).toEqual([{ service: 'status', rows: 1, kept: false }])
    expect(d.calls.length).toBe(0)
  })
})

// ── `FJS-1279`: the device's foreign keys are real ─────────────────────────
//
// `deviceSchema()` keeps a relation between two models that both declared
// `@@sync`, so on the device a child's batch naming a parent the device does
// not hold yet is refused WHOLE. The order the warm writes in was the order the
// resources were declared — which an app controls only by the order its modules
// happen to evaluate — and a refusal was one warning per document.
describe('the warm against a device with real foreign keys', () => {
  /** A device whose `line` table refuses a batch naming a sheet it does not hold. */
  function fkDevice() {
    const held  = { sheet: new Map(), line: new Map() }
    const order = []
    const table = (name) => ({
      upsertMany: ({ data }) => {
        order.push(name)
        if (name === 'line' && data.some(r => !held.sheet.has(r.sheetId)))
          return Promise.reject(new Error(`Line: data[0] of ${data.length} failed — nothing in the batch was written. SQLITE_CONSTRAINT_FOREIGNKEY`))
        for (const r of data) held[name].set(r.id, r)
        return Promise.resolve({ count: data.length })
      },
    })
    const client = {
      $models: ['sheet', 'line'],
      $close: () => Promise.resolve(true),
      asSystem: () => ({ sheet: table('sheet'), line: table('line') }),
    }
    return { client, held, order }
  }

  const declare = async (service, model, rows) => {
    const { declareOffline } = await import('../src/resource/offline.js')
    declareOffline({ service, model, find: () => Promise.resolve(rows) })
  }

  test('a child declared before its parent still lands', async () => {
    const d = fkDevice()
    useDevice(d)
    await declare('lines',  'Line',  [{ id: 'L1', sheetId: 'S1' }])
    await declare('sheets', 'Sheet', [{ id: 'S1', name: 'one' }])

    const report = await warmOffline()
    expect(report).toEqual([
      { service: 'lines',  rows: 1, kept: true },
      { service: 'sheets', rows: 1, kept: true },
    ])
    expect([...d.held.line.keys()]).toEqual(['L1'])
  })

  // A child naming a parent outside the parent's own window can never land, and
  // that is said — on the report, and once per MODEL rather than per document.
  test('a batch the device never accepts is on the report and warned by name', async () => {
    const d = fkDevice()
    useDevice(d)
    await declare('lines', 'Line', [{ id: 'L1', sheetId: 'NOT-HELD' }])
    await declare('sheets', 'Sheet', [{ id: 'S1', name: 'one' }])

    const report = await warmOffline()
    expect(report[0]).toMatchObject({ service: 'lines', rows: 1, kept: false })
    expect(report[0].error).toMatch(/SQLITE_CONSTRAINT_FOREIGNKEY/)
    expect(report[1]).toEqual({ service: 'sheets', rows: 1, kept: true })
    expect(console.warn.mock.calls.flat().join('\n')).toMatch(/Line/)
  })

  test('two models failing are two warnings', async () => {
    useDevice(makeDevice({ models: ['sheet', 'plain'], fail: new Error('no quota') }))
    await writeThrough('Sheet', [{ id: 'S1' }])
    await writeThrough('Plain', [{ id: 'P1' }])
    const said = console.warn.mock.calls.map(c => String(c[0]))
    expect(said.filter(l => l.includes('Sheet')).length).toBe(1)
    expect(said.filter(l => l.includes('Plain')).length).toBe(1)
  })
})
