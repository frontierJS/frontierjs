// vector.test.ts — the two vector paths, and the oracle that holds them equal.
//
// `FJS-1193` / `FJS-D331`. The extension is an optional accelerator and the JS
// path in `core/vector.js` is the mechanism, which means there are two
// implementations of one comparison. The repo has been here once already —
// `@@allow` compiles to SQL and evaluates in JS, and `FJS-195` is the record of
// what happens when two such halves drift — so the ruling makes the oracle a
// condition rather than an extra.
//
// ─── What is graded, and what each part could not catch alone ─────────────
//
// **The guards.** Both are measured failure modes rather than defensive
// coding, and both are silent: a zero vector scores NULL, NULL sorts first, and
// the row that failed to embed becomes the best match for every query with a
// 200; and a null column makes `vec_distance_cosine` throw, so one un-embedded
// row fails the whole read instead of losing. A unit test is the only thing
// that can assert the first, because by the time a read sees it everything is
// already valid.
//
// **The oracle.** `cosineDistance()` against `vec_distance_cosine` over the
// same bytes. Nothing else can catch the two paths disagreeing, and the ways
// they could are not exotic: an operand order, a similarity where a distance
// belongs, a zero-norm answering 0 instead of null.
//
// ─── The skip, and how to not have it ─────────────────────────────────────
//
// `sqlite-vec` is deliberately NOT a dependency of this package — `FJS-D331`
// makes it a thing a server installs, and declaring it here would make every
// app install a platform binary to get a feature the ruling says is optional.
// So the oracle is a NAMED SKIP when the package is absent, on the same footing
// as this repo's Chrome and network skips.
//
//   bun add -d sqlite-vec           in packages/litestone, to run it
//   FJS_REQUIRE_VEC=1 bun run test  to make the skip fatal instead
//
// The skip is the honest state and not a hole being hidden: what it costs is
// that the JS path is still graded on every run and the AGREEMENT is not.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createRequire }        from 'node:module'
import {
  BYTES_PER_DIM, readVector, toVectorBytes, isZeroVector,
  refuseUnstorable, cosineDistance, scoreByDistance,
} from '../src/core/vector.js'

// ─── fixtures ─────────────────────────────────────────────────────────────

const f32  = (...v: number[]) => Float32Array.from(v)
const bytes = (...v: number[]) => new Uint8Array(f32(...v).buffer)

// Deterministic, because an oracle that disagrees on one seed in fifty and is
// re-run until green is worse than no oracle.
function seeded(seed: number, dim: number) {
  let s = seed >>> 0
  const a = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    a[i] = (s / 0xffffffff) - 0.5
  }
  return a
}

function loadVec(): { db: any, close: () => void } | null {
  try {
    const { Database } = require('bun:sqlite')
    const vec = createRequire(import.meta.url)('sqlite-vec')
    const db  = new Database(':memory:')
    db.loadExtension(vec.getLoadablePath())
    db.prepare('select vec_version() v').get()
    return { db, close: () => db.close() }
  } catch {
    return null
  }
}

const vec = loadVec()
if (!vec && process.env.FJS_REQUIRE_VEC === '1')
  throw new Error('FJS_REQUIRE_VEC=1 but sqlite-vec did not load — run `bun add -d sqlite-vec` here')

// ─── layout ───────────────────────────────────────────────────────────────

describe('what a stored vector is', () => {
  it('is four bytes a dimension', () => {
    expect(BYTES_PER_DIM).toBe(4)
    expect(toVectorBytes([1, 2, 3, 4], 4).byteLength).toBe(16)
  })

  it('round-trips exactly', () => {
    const out = readVector(toVectorBytes([0.5, -0.25, 1, 2], 4), 4)
    expect(Array.from(out)).toEqual([0.5, -0.25, 1, 2])
  })

  it('reads a view into a larger buffer at its own offset', () => {
    // A driver may hand back a view rather than a fresh buffer, and
    // `new Float32Array(bytes.buffer)` would then read from byte 0 — a wrong
    // distance with nothing raised, which is the reason readVector takes the
    // offset instead of assuming it.
    const backing = new Uint8Array(32)
    backing.set(bytes(9, 9, 9, 9), 16)
    const view = new Uint8Array(backing.buffer, 16, 16)
    expect(Array.from(readVector(view, 4))).toEqual([9, 9, 9, 9])
  })

  it('refuses a stored value of the wrong length by name', () => {
    expect(() => readVector(new Uint8Array(13), 4)).toThrow(/13 bytes, expected 16/)
  })
})

// ─── the two guards ───────────────────────────────────────────────────────

describe('the guards, which are the silent failures', () => {
  it('refuses a zero vector at the write, saying why the read cannot', () => {
    expect(isZeroVector(f32(0, 0, 0, 0))).toBe(true)
    expect(() => toVectorBytes([0, 0, 0, 0], 4)).toThrow(/every dimension is zero/)
    expect(() => toVectorBytes([0, 0, 0, 0], 4)).toThrow(/NULL sorts first/)
  })

  it('does not mistake a vector that merely contains zeros', () => {
    expect(isZeroVector(f32(0, 0, 1, 0))).toBe(false)
    expect(() => toVectorBytes([0, 0, 1, 0], 4)).not.toThrow()
  })

  it('refuses NaN and Infinity, which sort unpredictably rather than losing', () => {
    expect(() => toVectorBytes([1, NaN, 0, 0], 4)).toThrow(/dimension 1 is NaN/)
    expect(() => toVectorBytes([1, Infinity, 0, 0], 4)).toThrow(/dimension 1 is Infinity/)
  })

  it('refuses the wrong dimension and says the dimension is the column\'s', () => {
    expect(() => refuseUnstorable(f32(1, 0, 0), 4)).toThrow(/got 3 dimensions/)
    expect(() => refuseUnstorable(f32(1), 4)).toThrow(/got 1 dimension\b/)
  })

  it('drops an un-embedded row instead of failing the read', () => {
    // The extension throws on a null operand, which turns a backfill in
    // progress into a 500 on every similarity read. The JS path has to lose the
    // row, not the query.
    const rows = [
      { id: 1, e: bytes(1, 0, 0, 0) },
      { id: 2, e: null },
      { id: 3, e: bytes(0, 1, 0, 0) },
    ]
    const out = scoreByDistance(rows, f32(1, 0, 0, 0), { column: 'e', dim: 4 })
    expect(out.map(r => r.id)).toEqual([1, 3])
  })
})

// ─── the distance ─────────────────────────────────────────────────────────

describe('cosine distance', () => {
  it('is a DISTANCE and not a similarity', () => {
    // The roadmap sketch this replaced read `threshold: 0.8 // cosine
    // similarity`. Compared the other way round a cutoff keeps the worst
    // matches and returns rows either way, which is why FJS-D329 ships the
    // number rather than the knob.
    expect(cosineDistance(f32(1, 0), f32(1, 0))).toBeCloseTo(0, 6)
    expect(cosineDistance(f32(1, 0), f32(0, 1))).toBeCloseTo(1, 6)
    expect(cosineDistance(f32(1, 0), f32(-1, 0))).toBeCloseTo(2, 6)
  })

  it('ignores magnitude, which is what makes it cosine', () => {
    expect(cosineDistance(f32(2, 0), f32(1, 0))).toBeCloseTo(0, 6)
    expect(cosineDistance(f32(7, 7), f32(1, 1))).toBeCloseTo(0, 6)
  })

  it('answers null for a zero-norm operand, as the extension does', () => {
    expect(cosineDistance(f32(0, 0), f32(1, 0))).toBeNull()
    expect(cosineDistance(f32(1, 0), f32(0, 0))).toBeNull()
  })

  it('refuses a dimension mismatch rather than comparing a prefix', () => {
    expect(() => cosineDistance(f32(1, 0, 0), f32(1, 0))).toThrow(/cannot compare 3 dimensions to 2/)
  })
})

describe('scoring orders nearest first and carries the number', () => {
  it('sorts ascending by distance and stamps _distance', () => {
    const rows = [
      { id: 'far',  e: bytes(-1, 0, 0, 0) },
      { id: 'near', e: bytes(1, 0, 0, 0) },
      { id: 'mid',  e: bytes(0, 1, 0, 0) },
    ]
    const out = scoreByDistance(rows, f32(1, 0, 0, 0), { column: 'e', dim: 4 })
    expect(out.map(r => r.id)).toEqual(['near', 'mid', 'far'])
    expect(out[0]._distance).toBeCloseTo(0, 6)
    expect(out[2]._distance).toBeCloseTo(2, 6)
  })

  it('honors take, and refuses a zero query vector', () => {
    const rows = [{ id: 1, e: bytes(1, 0, 0, 0) }, { id: 2, e: bytes(0, 1, 0, 0) }]
    expect(scoreByDistance(rows, f32(1, 0, 0, 0), { column: 'e', dim: 4, take: 1 })).toHaveLength(1)
    expect(() => scoreByDistance(rows, f32(0, 0, 0, 0), { column: 'e', dim: 4 }))
      .toThrow(/every dimension is zero/)
  })
})

// ─── the oracle ───────────────────────────────────────────────────────────

describe('the oracle — JS against the extension', () => {
  if (!vec) {
    it.skip('sqlite-vec is not installed — `bun add -d sqlite-vec` here to grade the agreement', () => {})
    return
  }

  const sqlDistance = (a: Float32Array, b: Float32Array) =>
    vec.db.prepare('select vec_distance_cosine(?, ?) d')
      .get(new Uint8Array(a.buffer), new Uint8Array(b.buffer)).d

  it('agrees on the fixed cases', () => {
    const cases: [number[], number[]][] = [
      [[1, 0], [1, 0]], [[1, 0], [0, 1]], [[1, 0], [-1, 0]],
      [[2, 0], [1, 0]], [[0.5, -0.25], [-0.5, 0.25]], [[3, 4], [4, 3]],
    ]
    for (const [a, b] of cases) {
      const js  = cosineDistance(f32(...a), f32(...b))
      const sql = sqlDistance(f32(...a), f32(...b))
      expect(js).toBeCloseTo(sql, 5)
    }
  })

  it('agrees over 200 seeded pairs at 1536 dimensions', () => {
    // The real dimension, because float32 accumulation order is where two
    // implementations of a dot product actually part company, and it only shows
    // up at length.
    let worst = 0
    for (let i = 0; i < 200; i++) {
      const a = seeded(i * 2 + 1, 1536)
      const b = seeded(i * 2 + 2, 1536)
      const js  = cosineDistance(a, b) as number
      const sql = sqlDistance(a, b)
      worst = Math.max(worst, Math.abs(js - sql))
    }
    // float32 in the store, float64 in the JS accumulator: they cannot be bit
    // equal, and a bound is the honest assertion. A regression that swapped a
    // similarity for a distance moves this by 1, not by 1e-6.
    expect(worst).toBeLessThan(1e-5)
  })

  it('agrees that a zero vector is null rather than zero', () => {
    // The whole reason the write is refused. If these two ever disagreed, the
    // JS path would rank a failed embedding last and the SQL path first.
    expect(sqlDistance(f32(0, 0, 0, 0), f32(1, 0, 0, 0))).toBeNull()
    expect(cosineDistance(f32(0, 0, 0, 0), f32(1, 0, 0, 0))).toBeNull()
  })

  it('agrees on the ORDER, which is the thing a caller actually sees', () => {
    const dim  = 64
    const q    = seeded(999, dim)
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i, e: new Uint8Array(seeded(i + 1, dim).buffer),
    }))
    const jsOrder = scoreByDistance(rows, q, { column: 'e', dim }).map(r => r.id)

    const db = vec.db
    db.run('create table if not exists o(id integer primary key, e blob)')
    db.run('delete from o')
    const ins = db.prepare('insert into o values (?, ?)')
    for (const r of rows) ins.run(r.id, r.e)
    const sqlOrder = db
      .prepare('select id from o where e is not null order by vec_distance_cosine(e, ?) asc')
      .all(new Uint8Array(q.buffer)).map((r: any) => r.id)

    expect(jsOrder).toEqual(sqlOrder)
  })
})

// ─── the engine capability ────────────────────────────────────────────────

describe('the engine says which path it is', () => {
  it('the browser engine declares null, and says why in the file', async () => {
    const src = await Bun.file(
      new URL('../src/engines/sqlite-wasm.js', import.meta.url)).text()
    expect(src).toContain('vector: null')
    // The reason is load-bearing: absent-by-oversight and
    // absent-by-construction read identically from core/engine.js.
    expect(src).toContain('SQLITE_OMIT_LOAD_EXTENSION')
  })

  it('does not load the extension at open, and arms idempotently', async () => {
    // The regression this exists for: arming in `open()` made every connection
    // 5.6x more expensive (0.115 ms -> 0.650 ms measured) and timed out the
    // erpnext corpus test, because litestone opens a connection per migration
    // diff, per template clone, per tenant and two per database — almost none
    // of which run a similarity query.
    const engine = (await import('../src/engines/bun-sqlite.js')).default
    const db = engine.open(':memory:')
    try {
      const fresh = () => { try { db.prepare('select vec_version() v').get(); return true } catch { return false } }
      expect(fresh()).toBe(false)          // open() armed nothing

      if (!engine.vector) return           // no sqlite-vec here; the skip above says so
      engine.vector.arm(db)
      expect(fresh()).toBe(true)
      engine.vector.arm(db)                // second call is a no-op, not a reload
      expect(fresh()).toBe(true)
    } finally { db.close() }
  })

  it('refuses an engine that claims the capability without naming a function', async () => {
    const { setEngine, clearEngine, currentEngine } = await import('../src/core/engine.js')

    // `current` is module-level and `bun test` shares one process across files,
    // so registering a stub here is registering it for every file that runs
    // after this one. The first cut of this test left the engine CLEARED and
    // 238 tests in other files failed with `no SQL engine is registered` — a
    // failure that reproduces in the suite and never in this file alone.
    const held = currentEngine()
    const put  = () => { clearEngine(); if (held) setEngine(held) }

    try {
      const base = { name: 'stub', sync: true, open: () => ({}) }
      expect(() => setEngine({ ...base, vector: {} })).toThrow(/vector.cosineDistance/)
      expect(() => setEngine({ ...base, vector: { cosineDistance: '' } })).toThrow(/vector.cosineDistance/)
      // A name with no way to arm a connection is a promise nothing keeps.
      expect(() => setEngine({ ...base, vector: { cosineDistance: 'f' } })).toThrow(/vector.arm/)
      expect(() => setEngine({ ...base, vector: { cosineDistance: 'f', arm: () => {} } })).not.toThrow()
      expect(() => setEngine({ ...base, vector: null })).not.toThrow()
    } finally { put() }

    expect(currentEngine()?.name).toBe(held?.name)
  })
})

// ─── the language half ────────────────────────────────────────────────────
//
// `@vector(n)` and `orderBy: { col: { near: v } }`, end to end against a real
// client. Nothing below is skipped for want of `sqlite-vec`: `FJS-D331` makes
// the extension an accelerator and the JS path the mechanism, so every one of
// these runs on whatever is installed. What the extension changes is which
// half is being graded — which is why the last describe runs the SAME battery
// under both and compares the answers.

import { createClient } from '../src/index.js'
import { parse }        from '../src/core/parser.js'

const vbytes = (...v: number[]) => new Uint8Array(Float32Array.from(v).buffer)
const model  = (field: string) => `model Doc {\n  id Int @id\n  kind String\n  ${field}\n}`
const refusal = (src: string) => { const r = parse(src); return r.valid ? null : r.errors[0] }

describe('@vector — what the schema accepts', () => {
  it('declares a dimension on a Bytes column', () => {
    const r = parse(model('embedding Bytes @vector(1536)'))
    expect(r.valid).toBe(true)
    const f = r.schema.models[0].fields.find((x: any) => x.name === 'embedding')
    expect(f.attributes.find((a: any) => a.kind === 'vector')).toEqual({ kind: 'vector', dim: 1536 })
  })

  it('refuses every shape where the bytes would not be a vector', () => {
    expect(refusal(model('embedding String @vector(4)'))).toMatch(/requires a Bytes field/)
    expect(refusal(model('embedding Bytes @vector(0)'))).toMatch(/positive whole number/)
    expect(refusal(model('embedding Bytes @vector(1.5)'))).toMatch(/positive whole number/)
    // Encoded bytes are the sharp one: ciphertext is a valid blob of the right
    // length and ranks by nothing at all.
    expect(refusal(model('embedding Bytes @vector(4) @encrypted'))).toMatch(/rank by nothing/)
    // @hashed is refused a rule earlier — it wants a String column — so this
    // asserts the refusal and not the sentence, which belongs to that rule.
    expect(refusal(model('embedding Bytes @vector(4) @hashed'))).toBeTruthy()
    expect(refusal(model('embedding Bytes @vector(4) @unique'))).toMatch(/near or far, never equal/)
    expect(refusal(model('embedding Bytes @vector(4) @computed'))).toMatch(/needs a stored column/)
    expect(refusal(`model Doc {\n  id Int @id\n  embedding Bytes @vector(4)\n  @@fts([embedding])\n}`))
      .toMatch(/FTS5 indexes text/)
  })

  it('emits a length CHECK and no index', async () => {
    const { generateDDL } = await import('../src/core/ddl.js')
    const ddl = generateDDL(parse(model('embedding Bytes? @vector(4)')).schema)
    expect(ddl).toContain('"embedding" BLOB')
    expect(ddl).toContain('length("embedding") = 16')
    // No b-tree over a distance — measured, vec0 was slower than a plain scan.
    expect(ddl).not.toMatch(/CREATE INDEX[^;]*embedding/)
  })
})

describe('@vector — the write boundary', () => {
  let db: any
  beforeAll(async () => { db = await createClient({ schema: model('embedding Bytes? @vector(4)'), db: ':memory:' }) })
  afterAll(async () => { await db?.$close() })

  const write = (id: number, embedding: any) => db.doc.create({ data: { id, kind: 'a', embedding } })

  it('stores a usable vector and a null one', async () => {
    await expect(write(1, vbytes(1, 0, 0, 0))).resolves.toBeTruthy()
    await expect(write(2, null)).resolves.toBeTruthy()
  })

  it('refuses a zero vector, which the CHECK cannot see', async () => {
    // The severe one. Its distance is NULL, NULL sorts first, and the row is
    // the best match for every query with a 200 — so the write is the only
    // place it can be refused.
    await expect(write(3, vbytes(0, 0, 0, 0))).rejects.toThrow(/every-dimension zero/)
  })

  it('refuses a NaN and a wrong length', async () => {
    await expect(write(4, vbytes(1, NaN, 0, 0))).rejects.toThrow(/NaN at dimension 1/)
    await expect(write(5, vbytes(1, 0, 0))).rejects.toThrow(/expected 16/)
  })
})

// ─── retrieval, and it is the same read on both engines ───────────────────

const Q   = [1, 0, 0, 0]
const NEAR = { embedding: { near: Q } }

// Swap the registered engine for one that declares no vector capability, which
// is what a browser and an un-installed server are. The engine is module-level
// and `bun test` shares one process across files, so the restore is not tidy —
// leaving it cleared failed 238 tests in other files once.
async function onTheJsPath<T>(fn: () => Promise<T>): Promise<T> {
  const { setEngine, clearEngine, currentEngine } = await import('../src/core/engine.js')
  const held = currentEngine() as any
  if (!held?.vector) return fn()
  try {
    clearEngine()
    setEngine({ ...held, vector: null })
    return await fn()
  } finally { clearEngine(); setEngine(held) }
}

async function corpus() {
  const db = await createClient({ schema: model('embedding Bytes? @vector(4)'), db: ':memory:' })
  await db.doc.create({ data: { id: 1, kind: 'a', embedding: vbytes(1, 0, 0, 0) } })   // exact
  await db.doc.create({ data: { id: 2, kind: 'b', embedding: vbytes(0, 1, 0, 0) } })   // orthogonal
  await db.doc.create({ data: { id: 3, kind: 'a', embedding: vbytes(-1, 0, 0, 0) } })  // opposite
  await db.doc.create({ data: { id: 4, kind: 'a', embedding: null } })                 // un-embedded
  return db
}

// One list, run twice. A query added here is graded on both paths by
// construction, which is the only thing that keeps two implementations of one
// comparison from drifting apart.
const BATTERY: Array<[string, any]> = [
  ['nearest first',       { orderBy: NEAR }],
  ['where composes',      { where: { kind: 'a' }, orderBy: NEAR }],
  ['limit pages',         { orderBy: NEAR, limit: 2 }],
  ['offset pages',        { orderBy: NEAR, limit: 2, offset: 1 }],
  ['descending',          { orderBy: { embedding: { near: Q, dir: 'desc' } } }],
  ['select narrows',      { select: { id: true, kind: true }, orderBy: NEAR }],
  ['select unlocks',      { select: { id: true, embedding: true }, orderBy: NEAR }],
  ['a second sort key breaks ties',
                          { orderBy: [{ embedding: { near: [0, 0, 1, 0] } }, { id: 'desc' }] }],
]

describe('@vector — retrieval is an ordering', () => {
  let db: any
  beforeAll(async () => { db = await corpus() })
  afterAll(async () => { await db?.$close() })

  const near = (extra: any = {}) => db.doc.findMany({ orderBy: NEAR, ...extra })

  it('orders nearest first', async () => {
    expect((await near()).map((r: any) => r.id)).toEqual([1, 2, 3])
  })

  it('drops the un-embedded row rather than failing the read', async () => {
    // The extension THROWS on a null operand, so without the guard one row
    // added before its embedding job ran would 500 every similarity read. The
    // JS path drops it for the same reason rather than scoring undefined.
    expect((await near()).map((r: any) => r.id)).not.toContain(4)
  })

  it('composes with where and limit, which is the whole argument for an orderBy', async () => {
    expect((await near({ where: { kind: 'a' } })).map((r: any) => r.id)).toEqual([1, 3])
    expect((await near({ limit: 2 })).map((r: any) => r.id)).toEqual([1, 2])
    expect((await near({ limit: 2, offset: 1 })).map((r: any) => r.id)).toEqual([2, 3])
  })

  it('carries the distance it sorted by (`FJS-D329`)', async () => {
    // No cutoff option, deliberately: a cosine threshold is a number every
    // corpus guesses differently, so the app gets the value.
    const rows = await near()
    expect(rows.map((r: any) => Math.round(r._distance * 1000) / 1000)).toEqual([0, 1, 2])
    expect((await db.doc.findFirst({ orderBy: NEAR }))._distance).toBeCloseTo(0, 5)
    expect((await db.doc.findManyAndCount({ orderBy: NEAR, limit: 1 })).rows[0]._distance).toBeCloseTo(0, 5)
  })

  it('keeps the distance through a narrowed select, which trims to fields', async () => {
    const [row] = await near({ select: { id: true } })
    expect(Object.keys(row).sort()).toEqual(['_distance', 'id'])
  })

  it('leaves the column out of the payload until it is asked for (`FJS-D328`)', async () => {
    // 4 bytes a dimension is 6 kB on a 1536-dimension column, so twenty rows of
    // a list carry 123 kB nobody asked for. asSystem() does not lift it: this
    // is a size rule and not an access one.
    expect(await db.doc.findFirst({ where: { id: 1 } })).not.toHaveProperty('embedding')
    expect(await db.asSystem().doc.findFirst({ where: { id: 1 } })).not.toHaveProperty('embedding')
    expect(await db.doc.findFirst({ where: { id: 1 }, select: { id: true, embedding: true } }))
      .toHaveProperty('embedding')
  })

  it('refuses a query vector the column cannot be compared to', async () => {
    await expect(db.doc.findMany({ orderBy: { embedding: { near: [1, 0, 0] } } }))
      .rejects.toThrow(/got 3 dimensions/)
    await expect(db.doc.findMany({ orderBy: { embedding: { near: [0, 0, 0, 0] } } }))
      .rejects.toThrow(/every dimension is zero/)
  })

  it('refuses a bare sort on the column, which would order by opaque bytes', async () => {
    await expect(db.doc.findMany({ orderBy: { embedding: 'asc' } }))
      .rejects.toThrow(/sorts by nothing on its own/)
  })

  it('refuses a near that is not the first sort key, on either engine', async () => {
    // The rule exists so the two implementations cannot answer different
    // ORDERS: a key in front of the distance groups the rows, and JS can only
    // reproduce SQLite's grouping by restating its comparison rules.
    await expect(db.doc.findMany({ orderBy: [{ kind: 'asc' }, { embedding: { near: Q } }] }))
      .rejects.toThrow(/must be the first sort key/)
    await expect(onTheJsPath(() =>
      db.doc.findMany({ orderBy: [{ kind: 'asc' }, { embedding: { near: Q } }] })))
      .rejects.toThrow(/must be the first sort key/)
  })

  it('refuses a cursor over a distance, naming the column', async () => {
    // A keyset cursor resumes from a value the ROW holds; a distance belongs to
    // the query vector. Without this the caller met a demand for a lat and lng.
    await expect(db.doc.findManyCursor({ limit: 2, orderBy: NEAR }))
      .rejects.toThrow(/is a @vector, and a cursor pages by a value the row holds/)
  })

  it('refuses aggregating the column, naming @vector rather than @omit(all)', async () => {
    await expect(db.doc.aggregate({ _max: { embedding: true } }))
      .rejects.toThrow(/is @vector\(4\)/)
  })

  it('qualifies the distance column under a JOIN', async () => {
    // The expression begins with a function rather than with its column, so the
    // relation builder's leading-identifier rewrite never fired on one and the
    // column reached SQLite unqualified — `ambiguous column name` the moment
    // the joined table carried the same name. True of `@point` since it shipped.
    const j = await createClient({ schema: `
model Tag { id Int @id embedding Bytes? docs Doc[] }
model Doc { id Int @id tagId Int tag Tag @relation(fields: [tagId], references: [id]) embedding Bytes? @vector(4) }`,
      db: ':memory:' })
    try {
      await j.tag.create({ data: { id: 1 } })
      await j.doc.create({ data: { id: 1, tagId: 1, embedding: vbytes(1, 0, 0, 0) } })
      const rows = await j.doc.findMany({ orderBy: [{ embedding: { near: Q } }, { tag: { id: 'asc' } }] })
      expect(rows.map((r: any) => r.id)).toEqual([1])
    } finally { await j.$close() }
  })
})

describe('the two paths answer the same thing', () => {
  if (!vec) {
    it.skip('sqlite-vec is not installed — with only one path there is nothing to compare', () => {})
    return
  }

  it('the whole battery, compiled and scored, row for row', async () => {
    // The condition on `core/vector.js` existing. `FJS-D331` puts both paths in
    // service precisely so neither rots, and this is what a rot would fail.
    const db = await corpus()
    try {
      for (const [label, args] of BATTERY) {
        const compiled = await db.doc.findMany(args)
        const scored   = await onTheJsPath(() => db.doc.findMany(args))
        expect(`${label}: ${JSON.stringify(scored.map((r: any) => r.id))}`)
          .toBe(`${label}: ${JSON.stringify(compiled.map((r: any) => r.id))}`)
        for (let i = 0; i < compiled.length; i++) {
          expect(scored[i]._distance).toBeCloseTo(compiled[i]._distance, 5)
          expect(Object.keys(scored[i]).sort()).toEqual(Object.keys(compiled[i]).sort())
        }
      }
    } finally { await db.$close() }
  })

  it('and the refusals, which are the other half of an answer', async () => {
    const db = await corpus()
    const both = async (fn: (c: any) => Promise<any>) => {
      const one = await fn(db).then(() => null, (e: any) => e.message)
      const two = await onTheJsPath(() => fn(db).then(() => null, (e: any) => e.message))
      return [one, two]
    }
    try {
      for (const bad of [[1, 0, 0], [0, 0, 0, 0], null]) {
        const [a, b] = await both(c => c.doc.findMany({ orderBy: { embedding: { near: bad } } }))
        expect(b).toBe(a)
        expect(a).toBeTruthy()
      }
    } finally { await db.$close() }
  })
})
