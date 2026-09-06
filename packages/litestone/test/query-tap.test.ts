// test/query-tap.test.ts
//
// What the query tap says it ran, against what SQLite actually ran.
//
// `$tapQuery` fires once per statement — that is the shape of the event, whose
// `sql` field is singular. An `include` is a SECOND statement against a
// DIFFERENT table, and it was reported nowhere: `fireQuery` runs before
// `withIncludes`, so neither the count nor the parent's `duration` covered it.
// Measured before the fix, on a hundred authors with one include: the tap said
// one statement and SQLite ran two. Nested, or two siblings: one against three.
//
// Includes are batched (`WHERE fk IN (…)`), so the gap is one event per
// relation level and never N+1 — which is what makes it survivable enough to
// have lasted, and useless enough as telemetry to be worth closing.
//
// Every row here counts REAL executions rather than trusting the tap: the
// statement objects are wrapped at prepare time, so the assertion is against
// what bun:sqlite was asked to do. A test that compared the tap to itself would
// pass with the fix reverted.

import { describe, test, expect } from 'bun:test'
import { readFileSync }           from 'node:fs'
import { createClient }           from '../src/index.js'

const SCHEMA = `
  model Author { id Int @id  name String  books Book[]  tags Tag[] }
  model Tag    { id Int @id  label String  authors Author[] }
  model Book   { id Int @id  title String  authorId Int
                 author  Author  @relation(fields: [authorId], references: [id])
                 reviews Review[] }
  model Review { id Int @id  stars Int  bookId Int
                 book Book @relation(fields: [bookId], references: [id]) }
`

/**
 * A client that counts statement EXECUTIONS.
 *
 * Wrapped at `prepare`/`query` time, before a single row is written, because a
 * statement is cached after its first prepare — instrumenting later misses
 * every SQL the seed already compiled, which is how the first measurement here
 * undercounted `findUnique`.
 */
async function counting() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const raw: any = db.$rawDbs.main ?? Object.values(db.$rawDbs)[0]
  const execs: string[] = []

  const wrap = (st: any, sql: string) => {
    for (const m of ['all', 'get', 'run', 'values', 'iterate'] as const) {
      const o = st[m]
      if (typeof o !== 'function') continue
      st[m] = function (...a: any[]) { execs.push(sql); return o.apply(this, a) }
    }
    return st
  }
  for (const m of ['prepare', 'query'] as const) {
    const orig = raw[m]
    if (typeof orig !== 'function') continue
    raw[m] = function (sql: any, ...r: any[]) { return wrap(orig.call(this, sql, ...r), String(sql)) }
  }

  const sys = db.asSystem()
  for (let i = 1; i <= 20; i++) {
    await sys.author.create({ data: { id: i, name: `A${i}` } })
    await sys.book.create({   data: { id: i, title: `B${i}`, authorId: i } })
    await sys.review.create({ data: { id: i, stars: 5, bookId: i } })
    await sys.tag.create({    data: { id: i, label: `T${i}` } })
  }
  await sys.author.update({ where: { id: 1 }, data: { tags: { connect: [{ id: 1 }, { id: 2 }] } } })

  const tapped: any[] = []
  db.$tapQuery((e: any) => tapped.push(e))

  return {
    sys,
    async measure(fn: () => Promise<unknown>) {
      tapped.length = 0
      execs.length  = 0
      await fn()
      return { tapped: [...tapped], execs: [...execs] }
    },
  }
}

// ─── one statement, one event ─────────────────────────────────────────────

describe('the tap counts every statement an include runs', () => {

  test('no include: one event, one statement — the control', async () => {
    const c = await counting()
    const { tapped, execs } = await c.measure(() => c.sys.author.findMany({}))
    expect(execs).toHaveLength(1)
    expect(tapped).toHaveLength(1)
    expect(tapped[0].operation).toBe('findMany')
  })

  test('one include: two statements, two events', async () => {
    const c = await counting()
    const { tapped, execs } = await c.measure(() => c.sys.author.findMany({ include: { books: true } }))
    expect(execs).toHaveLength(2)
    expect(tapped).toHaveLength(2)
    expect(tapped.map((t: any) => t.operation)).toEqual(['findMany', 'include'])
  })

  test('a nested include is a third statement and a third event', async () => {
    const c = await counting()
    const { tapped, execs } = await c.measure(() =>
      c.sys.author.findMany({ include: { books: { include: { reviews: true } } } }))
    expect(execs).toHaveLength(3)
    expect(tapped).toHaveLength(3)
  })

  test('two sibling includes are two statements beside the parent', async () => {
    const c = await counting()
    const { tapped, execs } = await c.measure(() =>
      c.sys.book.findMany({ include: { author: true, reviews: true } }))
    expect(execs).toHaveLength(3)
    expect(tapped).toHaveLength(3)
  })

  test('a many-to-many hydration is reported too', async () => {
    const c = await counting()
    const { tapped, execs } = await c.measure(() => c.sys.author.findMany({ include: { tags: true } }))
    expect(execs).toHaveLength(2)
    expect(tapped).toHaveLength(2)
    expect(tapped[1].operation).toBe('include')
  })

  test('a _count include says it is a count', async () => {
    // Its own operation because the parent vocabulary already separates `count`
    // from `findMany`, and a consumer classifying statements needs the same
    // split one level down.
    const c = await counting()
    const { tapped, execs } = await c.measure(() =>
      c.sys.author.findMany({ include: { _count: { select: { books: true } } } }))
    expect(execs).toHaveLength(2)
    expect(tapped.map((t: any) => t.operation)).toEqual(['findMany', 'include:count'])
  })
})

// ─── what the event says ──────────────────────────────────────────────────

describe('an include event describes the statement it ran', () => {

  test('the model is the relation TARGET, not the model the read started from', async () => {
    const c = await counting()
    const { tapped } = await c.measure(() => c.sys.author.findMany({ include: { books: true } }))
    expect(tapped[0].model).toBe('author')
    expect(tapped[1].model).toBe('book')
  })

  test('it carries sql, params, a duration and a row count', async () => {
    const c = await counting()
    const { tapped } = await c.measure(() => c.sys.author.findMany({ include: { books: true } }))
    const inc = tapped[1]
    expect(inc.sql).toMatch(/FROM "book"/)
    expect(Array.isArray(inc.params)).toBe(true)
    expect(typeof inc.duration).toBe('number')
    expect(inc.rowCount).toBe(20)
    expect(inc.database).toBe('main')
  })

  test('nothing is emitted when nothing is listening', async () => {
    // The guard is the same one the parent statement's timer is behind, so an
    // app with no tap pays for none of this.
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1, name: 'A' } })
    await sys.book.create({ data: { id: 1, title: 'B', authorId: 1 } })

    const seen: unknown[] = []
    const stop = db.$tapQuery((e: unknown) => seen.push(e))
    stop()
    await sys.author.findMany({ include: { books: true } })
    expect(seen).toHaveLength(0)
  })
})

// ─── the declared vocabulary is the emitted one ───────────────────────────

describe('every operation the client emits is declared', () => {

  // The tripwire, and the reason it greps rather than restates: `QueryEvent`
  // exists TWICE — hand-written in `index.d.ts` and generated into an app's own
  // types by `typegen.js` — and the generated one is a CLOSED union. Before
  // this test it omitted `aggregate`, `exists`, `groupBy` and `upsert`, every
  // one of which the client had always emitted, so an app switching on
  // `event.operation` was handed a type that refuses real events.
  const emitted = () => {
    const src = readFileSync(new URL('../src/core/client.js', import.meta.url), 'utf8')
    const ops = new Set<string>()
    for (const m of src.matchAll(/fireQuery\(\{ operation: '([a-zA-Z:]+)'/g))          ops.add(m[1]!)
    for (const m of src.matchAll(/runInclude\(\w+, rel\.targetModel, '([a-zA-Z:]+)'/g)) ops.add(m[1]!)
    return ops
  }

  const declaredIn = (path: string, re: RegExp) => {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8')
    const line = src.match(re)
    if (!line) throw new Error(`no QueryEvent.operation declaration found in ${path}`)
    return new Set([...line[0].matchAll(/'([a-zA-Z:]+)'/g)].map(m => m[1]!))
  }

  test('the client emits a set worth grading', () => {
    // A guard on the guard: if the greps stop matching, the two tests below
    // pass vacuously against an empty set.
    expect(emitted().size).toBeGreaterThan(15)
    expect(emitted()).toContain('include')
  })

  test("index.d.ts declares every one of them", () => {
    const missing = [...emitted()].filter(op => !declaredIn('../src/index.d.ts', /operation: '[^\n]*/).has(op))
    expect(missing).toEqual([])
  })

  test('and so does the type an app generates', () => {
    const missing = [...emitted()].filter(op => !declaredIn('../src/tools/typegen.js', /operation: '[^\n]*/).has(op))
    expect(missing).toEqual([])
  })
})
