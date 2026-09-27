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

vi.mock('@frontierjs/sierra/junction', () => ({ getClient: () => _client }))

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { createResource }  = await import('../src/junction/resource.js')
const { _resetListCache, listCache, listKey } = await import('../src/junction/list-cache.js')
const { warmOffline, _resetOffline } = await import('../src/junction/offline.js')
const { writeThrough, readLocal, localDbConfigured, _resetLocalDb, _useLocalDbClient } =
  await import('../src/junction/local-db.js')

const SOURCE = `
model Sheet { id String @id @default(uuid())  name String  closedAt DateTime?  @@gate("0.0.0.0")  @@sync(server) }
model Plain { id String @id @default(uuid())  name String                      @@gate("0.0.0.0") }
`

const offline = () => Promise.reject(new TypeError('Failed to fetch'))

// ─── the fake device ──────────────────────────────────────────────────────
//
// A litestone browser client answers `$models` with its ACCESSORS and is driven
// through `asSystem()`. Both are the real contract: the accessor list is what
// the module looks a model up in rather than deriving a name, and `asSystem()`
// is the ruling — a cache replays what the server already gave this caller and
// does not re-decide it (`FJS-D307`).
let device
/**
 * `rows` SEEDS the table rather than being the answer to every read.
 *
 * It was the answer, and that made the sharpest test here pass against a device
 * nothing had ever written to: *a question the warm never asked is answered
 * offline* is a claim about a row having been STORED, and a fake that answers
 * regardless cannot tell a hydrated device from an empty one — which is the
 * exact confusion the feature is about. So the fake keeps what it is given.
 */
function makeDevice({ models = ['sheet'], rows = [], fail = null, fts = false } = {}) {
  const calls = []
  const held = new Map(rows.map(r => [r.id, r]))
  const table = {
    upsertMany: (args) => {
      calls.push(['upsertMany', args])
      if (fail) return Promise.reject(fail)
      for (const row of args.data) held.set(row.id, row)
      return Promise.resolve({ count: args.data.length })
    },
    findMany: (args) => {
      calls.push(['findMany', args])
      return fail ? Promise.reject(fail) : Promise.resolve([...held.values()])
    },
    deleteMany: (args) => { calls.push(['deleteMany', args]); held.clear(); return Promise.resolve({ count: 0 }) },
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
  return { client, calls, systemUsed: () => calls.length > 0 }
}

/** Configure the module and hand it the fake instead of opening a worker. */
const useDevice = (d, config = {}) => _useLocalDbClient(d?.client ?? null, config)

beforeEach(async () => {
  _resetLocalDb()
  _resetListCache()
  _resetOffline()
  vi.spyOn(console, 'warn').mockImplementation(() => {})

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
    }),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-localdb-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)

  device = makeDevice()
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
    const rows = await r.load({ name: 'something else' }, { limit: 5, orderBy: '-id' })
    expect(rows.map(x => x.id)).toEqual(['S1'])
  })

  // The control for the case above: take the device away and the same load has
  // nothing to answer from, because the warm's cache entry is under the warm's
  // own key. Without this the test above passes on a cache hit nobody noticed.
  test('and with no device the same load has nothing — the cache holds only the warm\'s own question', async () => {
    const r = sheets({ offlineQuery: OPEN })
    await warmOffline()

    _proxy.find = offline
    await expect(r.load({ name: 'something else' }, { limit: 5, orderBy: '-id' })).rejects.toThrow()
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
    const { declareOffline } = await import('../src/junction/offline.js')
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
    const { declareOffline } = await import('../src/junction/offline.js')
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
