// test/write-events.test.ts
//
// WHICH write methods announce, and in which of the two shapes. One row per
// method, because nothing anywhere asserted this and the answer was wrong for
// seven of eleven: `createMany`, `updateMany`, `upsertMany`, `removeMany`,
// `deleteMany`, `delete` and `restore` all fired NOTHING (FJS-307). A bulk
// write in a job left every open tab holding rows that no longer exist, with
// nothing above the Data boundary able to see that it had happened.
//
// The invariant this file holds: **every write announces, and every event says
// whether it can name the row.**
//
//   scope: 'row'         — one row changed. `result` is that row, or null when
//                          `select: false` skipped the RETURNING
//   scope: 'collection'  — `count` rows matching `where` changed, and this
//                          statement never built them
//
// The discriminator is STATED, never inferred: `result: null` is not one fact,
// and a consumer that reads it as *no rows* drops the `select: false` case
// while a consumer that reads it as *many rows* invents a bulk write.
//
// A write that matched nothing announces nothing — a filter that hit no rows
// must not send every open tab back to the server.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Widget {
    id        Int      @id
    name      String
    status    String   @default("draft")
    deletedAt DateTime?
    @@softDelete
  }

  model Plain {
    id   Int    @id
    name String
  }
`

// The emitter defers one event-loop tick (setImmediate) and the tap dispatch
// is scheduled inside it. Two yields, not one.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)))

type Ev = { event: string; operation?: string; scope?: string; count?: number; result?: unknown; where?: unknown }

let db: Record<string, never> & Record<string, { [m: string]: (a?: unknown) => Promise<unknown> }>
let seen: Ev[]

beforeEach(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA }) as never
  seen = []
  ;(db as never as { $tapEvents(f: (e: Ev) => void): void }).$tapEvents((e) => { seen.push(e) })
})

/**
 * Run a write, let the emitter settle, answer what it announced.
 *
 * It settles BEFORE clearing as well as after. An arrange write's event is
 * scheduled, not delivered, so clearing first and acting immediately puts the
 * setup's own event in the act's results — every assertion here read the
 * `create` that seeded the row rather than the write under test.
 */
async function announced(fn: () => Promise<unknown>): Promise<Ev[]> {
  await settle()
  seen.length = 0
  await fn()
  await settle()
  return seen
}

const shape = (e: Ev) => `${e.event}/${e.operation} ${e.scope} n=${e.count} row=${e.result ? 'yes' : 'no'}`

describe('every write announces (FJS-307)', () => {

  // ── The row half ─────────────────────────────────────────────────────────

  test('create — one row, named', async () => {
    const [e, ...rest] = await announced(() => db.widget.create({ data: { id: 1, name: 'a' } }))
    expect(shape(e!)).toBe('create/create row n=1 row=yes')
    expect(rest).toEqual([])
  })

  test('update — one row, named', async () => {
    await db.widget.create({ data: { id: 1, name: 'a' } })
    const [e] = await announced(() => db.widget.update({ where: { id: 1 }, data: { name: 'b' } }))
    expect(shape(e!)).toBe('update/update row n=1 row=yes')
  })

  test('upsert — one row, named', async () => {
    const [e] = await announced(() => db.widget.upsert({
      where: { id: 1 }, create: { id: 1, name: 'a' }, update: { name: 'b' },
    }))
    expect(e!.scope).toBe('row')
    expect(e!.result).toBeTruthy()
  })

  test('remove — one row, named', async () => {
    await db.widget.create({ data: { id: 1, name: 'a' } })
    const [e] = await announced(() => db.widget.remove({ where: { id: 1 } }))
    expect(shape(e!)).toBe('remove/remove row n=1 row=yes')
  })

  // Had its row all along — the pre-DELETE SELECT — and announced nothing,
  // while its sibling `remove` fired from the same region. `remove` is the
  // event because a hard delete and a soft one are the same thing to a list.
  test('delete — one row, named, and it announces as remove', async () => {
    await db.widget.create({ data: { id: 1, name: 'a' } })
    const [e] = await announced(() => db.widget.delete({ where: { id: 1 } }))
    expect(shape(e!)).toBe('remove/delete row n=1 row=yes')
  })

  // RETURNING already built every row and the caller is handed them, so the
  // memory a per-row announcement costs is spent either way.
  test('restore — one row event per restored row', async () => {
    await db.widget.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    await db.widget.removeMany({ where: { status: 'draft' } })
    const evs = await announced(() => db.widget.restore({ where: { status: 'draft' } }))
    expect(evs).toHaveLength(2)
    expect(evs.map(shape)).toEqual([
      'update/restore row n=1 row=yes',
      'update/restore row n=1 row=yes',
    ])
  })

  // The case that proves `scope` has to be stated rather than read off
  // `result`: a row write with no row. Junction dropped this one silently for
  // as long as the tap existed.
  test('select: false — still row-scoped, and result is null', async () => {
    const [e] = await announced(() => db.widget.create({ data: { id: 1, name: 'a' }, select: false }))
    expect(shape(e!)).toBe('create/create row n=1 row=no')
    expect(e!.result).toBeNull()
  })

  // ── The collection half ──────────────────────────────────────────────────

  test('createMany — collection, counted', async () => {
    const [e, ...rest] = await announced(() => db.widget.createMany({
      data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }],
    }))
    expect(shape(e!)).toBe('create/createMany collection n=3 row=no')
    expect(rest).toEqual([])
  })

  test('updateMany — collection, counted, carrying the caller’s where', async () => {
    await db.widget.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    const [e] = await announced(() => db.widget.updateMany({
      where: { status: 'draft' }, data: { name: 'z' },
    }))
    expect(shape(e!)).toBe('update/updateMany collection n=2 row=no')
    expect(e!.where).toEqual({ status: 'draft' })
  })

  // An upsert is a create for some rows and an update for others, and the split
  // is known only on a logged model. `update` is the answer that is right for
  // the conflicting majority.
  test('upsertMany — collection, announced as update', async () => {
    const [e] = await announced(() => db.widget.upsertMany({
      data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
    }))
    expect(shape(e!)).toBe('update/upsertMany collection n=2 row=no')
  })

  test('removeMany — collection, on a soft-delete model', async () => {
    await db.widget.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    const [e] = await announced(() => db.widget.removeMany({ where: { status: 'draft' } }))
    expect(shape(e!)).toBe('remove/removeMany collection n=2 row=no')
  })

  // The hard branch of removeMany is a different statement in a different
  // block, so it is a different assertion.
  test('removeMany — collection, on a model with no soft delete', async () => {
    await db.plain.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    const [e] = await announced(() => db.plain.removeMany({ where: {} }))
    expect(shape(e!)).toBe('remove/removeMany collection n=2 row=no')
  })

  test('deleteMany — collection, counted', async () => {
    await db.widget.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    const [e] = await announced(() => db.widget.deleteMany({ where: { status: 'draft' } }))
    expect(shape(e!)).toBe('remove/deleteMany collection n=2 row=no')
  })

  // ── Nothing changed, nothing said ────────────────────────────────────────

  test('a bulk write matching no rows announces nothing', async () => {
    await db.widget.create({ data: { id: 1, name: 'a' } })
    expect(await announced(() => db.widget.updateMany({ where: { name: 'no-such' }, data: { name: 'z' } }))).toEqual([])
    expect(await announced(() => db.widget.removeMany({ where: { name: 'no-such' } }))).toEqual([])
    expect(await announced(() => db.widget.deleteMany({ where: { name: 'no-such' } }))).toEqual([])
    expect(await announced(() => db.widget.createMany({ data: [] }))).toEqual([])
  })

  // `updateMany` with a payload the model does not declare strips to nothing,
  // reports the matched count and writes NOTHING to those rows — so there is no
  // change to announce, and a reload sent to every tab would be pure noise.
  test('updateMany that writes no columns announces nothing', async () => {
    await db.widget.create({ data: { id: 1, name: 'a' } })
    let r: { count: number } | undefined
    const evs = await announced(async () => {
      r = await db.widget.updateMany({ where: { id: 1 }, data: { notAColumn: 1 } }) as { count: number }
    })
    expect(r!.count).toBe(1)
    expect(evs).toEqual([])
  })

  // ── The discriminator is total ───────────────────────────────────────────

  test('every event carries a scope and a count', async () => {
    seen.length = 0
    await db.widget.create({ data: { id: 1, name: 'a' } })
    await db.widget.createMany({ data: [{ id: 2, name: 'b' }] })
    await db.widget.update({ where: { id: 1 }, data: { name: 'a2' } })
    await db.widget.updateMany({ where: { status: 'draft' }, data: { name: 'z' } })
    await db.widget.upsertMany({ data: [{ id: 3, name: 'c' }] })
    await db.widget.remove({ where: { id: 1 } })
    await db.widget.restore({ where: { id: 1 } })
    await db.widget.removeMany({ where: { status: 'draft' } })
    await db.widget.delete({ where: { id: 2 }, withDeleted: true })
    await db.widget.deleteMany({ where: {}, withDeleted: true })
    await settle()

    expect(seen.length).toBeGreaterThan(0)
    for (const e of seen) {
      expect(['row', 'collection']).toContain(e.scope)
      expect(typeof e.count).toBe('number')
      expect(e.count).toBeGreaterThan(0)
      // A collection event never carries a row, and a row-scoped one is the
      // only place a row can appear.
      if (e.scope === 'collection') expect(e.result ?? null).toBeNull()
    }
  })

  // An app that subscribes to nothing must not pay for the payload. The guard
  // leads in both helpers, which is only observable by the write still working.
  test('no subscriber, no cost, no throw', async () => {
    const quiet = await createClient({ db: ':memory:', schema: SCHEMA }) as never as typeof db
    await quiet.widget.createMany({ data: [{ id: 1, name: 'a' }] })
    await quiet.widget.updateMany({ where: {}, data: { name: 'b' } })
    await quiet.widget.deleteMany({ where: {} })
    await settle()
    expect(await quiet.widget.count()).toBe(0)
  })
})

// The dial for the trade the collection form makes: always correct, always
// coarse. `rows` buys precision with memory proportional to the batch, so it is
// opt-in, per CALL with a client-level floor — the call site is the only place
// the batch size is knowable, since one model carries both a three-row cancel
// and a two-million-row purge. `FJS-D34`.
describe('announce — collection · rows · none', () => {

  const three = () => db.widget.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] })

  test('the default is one collection event', async () => {
    await three()
    const evs = await announced(() => db.widget.updateMany({ where: { status: 'draft' }, data: { name: 'z' } }))
    expect(evs.map(shape)).toEqual(['update/updateMany collection n=3 row=no'])
  })

  test("announce: 'rows' is one event per row, each carrying it", async () => {
    await three()
    const evs = await announced(() => db.widget.updateMany({
      where: { status: 'draft' }, data: { name: 'z' }, announce: 'rows',
    }))
    expect(evs).toHaveLength(3)
    expect(new Set(evs.map(e => e.scope))).toEqual(new Set(['row']))
    expect(evs.map(e => (e.result as { id: number }).id)).toEqual([1, 2, 3])
  })

  test("announce: 'none' is silence, which is not the same as having no subscribers", async () => {
    await three()
    expect(await announced(() => db.widget.updateMany({
      where: { status: 'draft' }, data: { name: 'z' }, announce: 'none',
    }))).toEqual([])
  })

  test('every bulk method takes the dial', async () => {
    await three()
    const at = async (fn: () => Promise<unknown>) => (await announced(fn)).map(e => e.scope)
    expect(await at(() => db.widget.createMany({ data: [{ id: 8, name: 'h' }, { id: 9, name: 'i' }], announce: 'rows' })))
      .toEqual(['row', 'row'])
    expect(await at(() => db.widget.removeMany({ where: { id: 8 }, announce: 'rows' }))).toEqual(['row'])
    expect(await at(() => db.widget.deleteMany({ where: { id: 9 }, announce: 'rows' }))).toEqual(['row'])
  })

  // The compromise the collection form has to make and this one does not: at the
  // `rows` tier the create/update split is already computed, so each half
  // announces truthfully instead of the whole batch calling itself an update.
  test("upsertMany at the rows tier announces create and update apart", async () => {
    await three()
    const evs = await announced(() => db.widget.upsertMany({
      data: [{ id: 1, name: 'existing' }, { id: 99, name: 'brand-new' }], announce: 'rows',
    }))
    expect(evs.map(e => `${e.event}:${(e.result as { name: string }).name}`).sort())
      .toEqual(['create:brand-new', 'update:existing'])
  })

  // ── Precedence: option → client → 'collection' ────────────────────────────

  test('the client sets the floor and a call overrides it', async () => {
    const loud = await createClient({ db: ':memory:', schema: SCHEMA, announce: 'rows' }) as never as typeof db
    const got: Ev[] = []
    ;(loud as never as { $tapEvents(f: (e: Ev) => void): void }).$tapEvents((e) => { got.push(e) })

    await loud.widget.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    await settle()
    expect(got.map(e => e.scope)).toEqual(['row', 'row'])          // the client's floor

    got.length = 0
    await loud.widget.updateMany({ where: {}, data: { name: 'z' }, announce: 'collection' })
    await settle()
    expect(got.map(e => e.scope)).toEqual(['collection'])           // the call wins
  })

  // ── The refusals ─────────────────────────────────────────────────────────

  // Not a fallback to the default: `announce: 'row'` is somebody who wanted
  // per-row announcements, and quietly handing them the coarse one is the class
  // of bug FJS-307 closed.
  test('an unknown value is refused by name, before the write', async () => {
    await db.widget.create({ data: { id: 1, name: 'a' } })
    const err = await db.widget.updateMany({
      where: {}, data: { name: 'z' }, announce: 'row',
    }).catch((e: Error & { status?: number }) => e) as Error & { status?: number }

    expect(err.name).toBe('InvalidAnnounceError')
    expect(err.status).toBe(400)
    expect(err.message).toContain("'collection', 'rows', 'none'")
    // Refused BEFORE the statement — the row is untouched.
    expect((await db.widget.findUnique({ where: { id: 1 } }) as { name: string }).name).toBe('a')
  })

  test('a bad client default is refused at construction', async () => {
    const err = await createClient({ db: ':memory:', schema: SCHEMA, announce: 'loud' } as never)
      .catch((e: Error) => e) as Error
    expect(err.name).toBe('InvalidAnnounceError')
    expect(err.message).toContain('createClient')
  })

  // ── What it must not cost, and what it must not leak ──────────────────────

  // The opt-in is ANDed with the audience. An app that declares `rows` and has
  // no subscriber must not pay for a RETURNING whose rows are thrown away — the
  // same guard that keeps the write path free for an app that taps nothing.
  test('no subscriber, no RETURNING', async () => {
    const quiet = await createClient({ db: ':memory:', schema: SCHEMA, announce: 'rows' }) as never as typeof db
    const sql: string[] = []
    ;(quiet as never as { $tapQuery(f: (e: { sql?: string }) => void): void }).$tapQuery((e) => { if (e.sql) sql.push(e.sql) })

    await quiet.widget.createMany({ data: [{ id: 1, name: 'a' }] })
    await quiet.widget.updateMany({ where: {}, data: { name: 'z' } })
    await quiet.widget.deleteMany({ where: {} })
    await settle()

    expect(sql.filter(s => s.includes('RETURNING'))).toEqual([])
    expect(await quiet.widget.count()).toBe(0)
  })

  // Every other event path hands over a row that went through `read()`. A bulk
  // row comes straight off RETURNING, so it has to be shaped here or a
  // subscriber receives a column the schema says nobody may read.
  test('an announced row is shaped, not raw off RETURNING', async () => {
    const secrets = await createClient({
      db: ':memory:',
      schema: `model Vault { id Int @id  name String  token String @guarded(all) }`,
    }) as never as typeof db
    const got: Ev[] = []
    ;(secrets as never as { $tapEvents(f: (e: Ev) => void): void }).$tapEvents((e) => { got.push(e) })

    await (secrets as never as { asSystem(): typeof db }).asSystem()
      .vault.createMany({ data: [{ id: 1, name: 'a', token: 'sssh' }] })
    await settle()
    got.length = 0

    await secrets.vault.updateMany({ where: {}, data: { name: 'b' }, announce: 'rows' })
    await settle()

    expect(got).toHaveLength(1)
    const row = got[0]!.result as Record<string, unknown>
    expect(row.name).toBe('b')
    expect('token' in row).toBe(false)
  })
})

describe('onEvent sees the same two shapes', () => {

  // `$tapEvents` and `onEvent` are two audiences for one emitter, so a shape
  // reaching one and not the other is the drift this asserts against.
  test('a config-time onEvent receives collection events too', async () => {
    const got: Ev[] = []
    const client = await createClient({
      db: ':memory:', schema: SCHEMA,
      onEvent: { change: (e: Ev) => { got.push(e) } },
    }) as never as typeof db

    await client.widget.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    await settle()

    expect(got).toHaveLength(1)
    expect(got[0]!.scope).toBe('collection')
    expect(got[0]!.count).toBe(2)
  })
})
