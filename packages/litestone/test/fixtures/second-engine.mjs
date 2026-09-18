// fixtures/second-engine.mjs — Litestone's client on a runtime that is not Bun.
//
// Run by `test/engine-seam.test.ts` as:
//
//   node --conditions=browser --no-warnings test/fixtures/second-engine.mjs
//
// `--conditions=browser` is what makes this worth running, and it now resolves
// BOTH of this package's conditional subpaths: `#sql-engine` to
// `engines/none.js`, so nothing imports `bun:sqlite` and no engine is
// registered, and `#host` to `host/browser.js`, so the path arithmetic, the
// refusals and the `AsyncLocalStorage` shim under test are the browser's. That
// is the browser's situation rehearsed on a runtime a test can spawn. What
// follows registers `node:sqlite` from the OUTSIDE, exactly as a browser host
// registers SQLite's wasm build, and then drives the ordinary client.
//
// The shim was wrong on the first run this existed for: it restored the
// previous store in a `finally`, which fires at the callee's first `await`
// rather than when the call ends, and `gate-refusal` arrived as a thrown
// *read outside a call*. Nothing else in the tree would have found that.
//
// Every line printed starts `OK <step>` or `FAIL <step>`; the test asserts on
// the step names, because a fixture that prints nothing also contains no
// 'FAIL'.
//
// Nothing here is a product. `node:sqlite` is a conformance FIXTURE — a second
// real SQLite whose API Litestone was not written against — and this package
// does not ship a Node engine or promise one.

import { DatabaseSync } from 'node:sqlite'
import { setEngine, currentEngine } from '../../src/core/engine.js'

// The whole adapter. `node:sqlite` splits `prepare()` from the statement the
// same way Bun does, but `run()` is a statement method only, so a database-level
// `run(sql, ...params)` is compiled and thrown away here — which is what the
// caller wants, since `core/client.js`'s own cache is the thing that decides
// what to keep (`wrapDb`).
const wrap = (raw) => {
  const stmt = (sql) => {
    const s = raw.prepare(sql)
    return { get: (...a) => s.get(...a), all: (...a) => s.all(...a), run: (...a) => s.run(...a) }
  }
  return {
    prepare: stmt,
    query:   stmt,
    run:     (sql, ...params) => raw.prepare(sql).run(...params),
    close:   () => raw.close(),
  }
}

setEngine({
  name: 'node:sqlite',
  sync: true,
  open: (path, { readonly = false } = {}) => wrap(new DatabaseSync(path, { readOnly: readonly })),
})

const say = (ok, step, note = '') => console.log(`${ok ? 'OK' : 'FAIL'} ${step}${note ? ' · ' + note : ''}`)
const step = async (name, fn) => {
  try { const v = await fn(); say(v !== false, name, v === true || v === false ? '' : JSON.stringify(v).slice(0, 60)) }
  catch (err) { say(false, name, err.message.split('\n')[0].slice(0, 120)); process.exitCode = 1 }
}

say(typeof globalThis.Bun === 'undefined' && currentEngine().name === 'node:sqlite',
    'engine-is-not-bun', currentEngine().name)

const { createClient } = await import('../../src/index.js')

const SCHEMA = `
model Shelf {
  id     String @id @default(uuid())
  label  String
  counts Count[]
  @@gate("2")
}
model Count {
  id        String    @id @default(uuid())
  shelfId   String
  shelf     Shelf     @relation(fields: [shelfId], references: [id])
  counted   Int
  deletedAt DateTime?
  @@gate("2")
  @@softDelete
  @@index([shelfId])
}`

const guest = await createClient({ schema: SCHEMA, db: ':memory:' })
const db    = guest.asSystem()

const shelf = await db.shelf.create({ data: { label: 'A1' } })
await step('create',           async () => (await db.count.create({ data: { shelfId: shelf.id, counted: 4 } })).counted === 4)
await step('relation-include', async () => (await db.shelf.findMany({ include: { counts: true } }))[0].counts.length === 1)
await step('groupBy',          async () => (await db.count.groupBy({ by: ['shelfId'], _sum: { counted: true } }))[0]._sum.counted === 4)
await step('aggregate',        async () => (await db.count.aggregate({ _avg: { counted: true } }))._avg.counted === 4)
await step('transaction',      async () => await db.$transaction(async tx => {
  await tx.count.create({ data: { shelfId: shelf.id, counted: 9 } })
  return await tx.count.count()
}) === 2)
await step('softDelete',       async () => {
  const rows = await db.count.findMany({ orderBy: { counted: 'asc' } })
  await db.count.delete({ where: { id: rows[0].id } })
  return await db.count.count() === 1
})
await step('orderBy-limit',    async () => (await db.count.findMany({ orderBy: { counted: 'desc' }, limit: 1 }))[0].counted === 9)

// The gate is enforced at the Data boundary and the boundary does not move
// because the engine did (Invariant 6). A client with no standing reads nothing.
await step('gate-refusal', async () => {
  try { await guest.count.findMany(); return false }
  catch (err) { return err.code === 'ACCESS_DENIED' }
})
