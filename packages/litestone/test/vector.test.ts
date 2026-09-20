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

import { describe, it, expect } from 'bun:test'
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
