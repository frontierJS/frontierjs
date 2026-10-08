// test/write-plans.test.ts
//
// A write verb PLANS and one executor runs the plan
// (IDEAS/litestone-by-construction.md § Step 5). A plan is a value — the
// statement, its binds, whether it carries RETURNING, what it announces — so
// it is read here through the `PLAN` seam and never run: every expectation
// below is the SQL the verb ran BEFORE it was split, captured from the query
// tap, and the refactor is graded against it. The seam is a symbol exported
// from `client.js` and not from `index.js`: a plan is on no public surface. It
// reaches the planner through the same door the verb does (hooks, value sets,
// stamps), so a plan on a @sequence model bumps its counters and a belongsTo
// nested write lands; none of these models carries either. `upsertMany` is
// the one write that does not plan: which half a row falls in is decided by
// what earlier rows of the same batch wrote.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'
import { PLAN } from '../src/core/client.js'

const NOW = '2026-10-08T00:00:00.000Z'
const PLAIN  = `model Item { id Int @id @default(autoincrement())  name String  n Int }`
const SOFT   = `model Item { id Int @id @default(autoincrement())  name String  n Int  deletedAt DateTime?  @@softDelete }`
const POLICY = `
model User { id Int @id  @@auth }
model Doc {
  id Int @id @default(autoincrement())  title String  ownerId Int
  @@allow('read', ownerId == auth().id)
  @@allow('create', ownerId == auth().id)
  @@allow('update', ownerId == auth().id)
  @@allow('delete', ownerId == auth().id)
}`
const LOGGED = `
database main  { path env("MAIN_DB", "./main.db") }
database audit { path "./audit/" driver logger }
model Item { id Int @id @default(autoincrement())  name String  n Int  @@db(main) @@log(audit) }`

type Plan = {
  verb: string, op: string, returning: boolean, batch: boolean,
  statements: { sql: string, params: unknown[], refusal?: unknown }[],
  count: { sql: string, params: unknown[] } | null,
  where: { sql: string, params: unknown[] } | null,
  announce: { mode: string, event: string, operation: string, where?: unknown },
}
type Planner = { [PLAN](verb: string, args: unknown): Promise<Plan | null> }

const plain  = () => createClient({ schema: PLAIN,  db: ':memory:', now: () => NOW })
const soft   = () => createClient({ schema: SOFT,   db: ':memory:', now: () => NOW })
const policy = () => createClient({ schema: POLICY, db: ':memory:', now: () => NOW })
async function logged() {
  const dir = mkdtempSync(join(tmpdir(), 'ls-plans-'))
  mkdirSync(join(dir, 'audit'), { recursive: true })
  return createClient({
    schema: LOGGED, now: () => NOW, onLog: () => {},
    databases: { main: { path: join(dir, 'main.db') }, audit: { path: join(dir, 'audit') } },
  })
}

const collection = (event: string, operation: string, where?: unknown) => ({ mode: 'collection', event, operation, where })

describe('a plan is a value, and reading one writes nothing', () => {
  test('plain where', async () => {
    const db = await plain()
    await db.item.createMany({ data: [{ name: 'a', n: 7 }, { name: 'b', n: 7 }] })
    const t = db.item as never as Planner

    const um = await t[PLAN]('updateMany', { where: { n: 7 }, data: { name: 'y' } })
    expect(um).toMatchObject({
      verb: 'updateMany', op: 'update', returning: false, batch: false,
      statements: [{ sql: 'UPDATE "item" SET "name" = ? WHERE "n" = ?', params: ['y', 7] }],
      where: { sql: '"n" = ?', params: [7] },
      announce: collection('update', 'updateMany', { n: 7 }),
    })

    const dm = await t[PLAN]('deleteMany', { where: { n: 7 } })
    expect(dm).toMatchObject({
      verb: 'deleteMany', op: 'delete', returning: false,
      statements: [{ sql: 'DELETE FROM "item" WHERE "n" = ?', params: [7] }],
      announce: collection('remove', 'deleteMany', { n: 7 }),
    })

    // A hard-delete model: removeMany is deleteMany under its own name.
    const rm = await t[PLAN]('removeMany', { where: { n: 7 } })
    expect(rm).toMatchObject({
      verb: 'removeMany', op: 'delete', returning: false,
      statements: [{ sql: 'DELETE FROM "item" WHERE "n" = ?', params: [7] }],
      announce: collection('remove', 'removeMany', { n: 7 }),
    })

    // One statement per row, each carrying its own binds; no where to announce.
    const cm = await t[PLAN]('createMany', { data: [{ name: 'd', n: 1 }, { name: 'e', n: 2 }] })
    expect(cm).toMatchObject({
      verb: 'createMany', op: 'create', returning: false, batch: true, where: null,
      statements: [
        { sql: 'INSERT INTO "item" ("name", "n") VALUES (?, ?)', params: ['d', 1] },
        { sql: 'INSERT INTO "item" ("name", "n") VALUES (?, ?)', params: ['e', 2] },
      ],
      announce: { mode: 'collection', event: 'create', operation: 'createMany' },
    })
    expect(cm!.announce.where).toBeUndefined()

    // Planned four times, written never.
    expect(await db.item.count()).toBe(2)
    expect(await db.item.findMany({ select: { name: true } })).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  test('an empty SET plans a count and no statement', async () => {
    const db = await plain()
    const t = db.item as never as Planner
    const p = await t[PLAN]('updateMany', { where: { n: 7 }, data: {} })
    expect(p).toMatchObject({
      verb: 'updateMany', statements: [], returning: false,
      count: { sql: 'SELECT COUNT(*) AS n FROM "item" WHERE "n" = ?', params: [7] },
    })
  })

  test('a policy under $setAuth is folded into the where, binds after the caller\'s', async () => {
    const db = await policy()
    await db.asSystem().doc.createMany({ data: [{ title: 'a', ownerId: 1 }, { title: 'b', ownerId: 2 }] })
    const t = db.$setAuth({ id: 1 }).doc as never as Planner

    expect(await t[PLAN]('updateMany', { where: { title: 'a' }, data: { title: 'z' } })).toMatchObject({
      statements: [{ sql: 'UPDATE "doc" SET "title" = ? WHERE ("title" = ?) AND ("ownerId" = ?)', params: ['z', 'a', 1] }],
      where: { sql: '("title" = ?) AND ("ownerId" = ?)', params: ['a', 1] },
      announce: collection('update', 'updateMany', { title: 'a' }),
    })
    expect(await t[PLAN]('deleteMany', { where: { title: 'z' } })).toMatchObject({
      statements: [{ sql: 'DELETE FROM "doc" WHERE ("title" = ?) AND ("ownerId" = ?)', params: ['z', 1] }],
      announce: collection('remove', 'deleteMany', { title: 'z' }),
    })
    expect(await t[PLAN]('removeMany', { where: { title: 'c' } })).toMatchObject({
      statements: [{ sql: 'DELETE FROM "doc" WHERE ("title" = ?) AND ("ownerId" = ?)', params: ['c', 1] }],
      announce: collection('remove', 'removeMany', { title: 'c' }),
    })
    // A create policy is graded in JS on the payload, not in the statement.
    expect(await t[PLAN]('createMany', { data: [{ title: 'c', ownerId: 1 }] })).toMatchObject({
      statements: [{ sql: 'INSERT INTO "doc" ("title", "ownerId") VALUES (?, ?)', params: ['c', 1] }],
      announce: { mode: 'collection', event: 'create', operation: 'createMany' },
    })
    expect(await db.asSystem().doc.count()).toBe(2)
  })

  test('a soft-delete model: the filter joins the where, and removeMany is a stamp', async () => {
    const db = await soft()
    const t = db.item as never as Planner

    expect(await t[PLAN]('updateMany', { where: { n: 7 }, data: { name: 'y' } })).toMatchObject({
      statements: [{ sql: 'UPDATE "item" SET "name" = ? WHERE ("deletedAt" IS NULL AND "n" = ?)', params: ['y', 7] }],
    })
    expect(await t[PLAN]('removeMany', { where: { name: 'y' } })).toMatchObject({
      verb: 'removeMany', op: 'remove', returning: false,
      statements: [{ sql: 'UPDATE "item" SET "deletedAt" = ? WHERE ("deletedAt" IS NULL AND "name" = ?)', params: [NOW, 'y'] }],
      where: { sql: '("deletedAt" IS NULL AND "name" = ?)', params: ['y'] },
      softCascade: { ts: NOW },
      announce: collection('remove', 'removeMany', { name: 'y' }),
    })
    // deleteMany bypasses the soft filter: the removed rows go too.
    expect(await t[PLAN]('deleteMany', { where: { n: 7 } })).toMatchObject({
      op: 'delete',
      statements: [{ sql: 'DELETE FROM "item" WHERE "n" = ?', params: [7] }],
    })
  })

  test('a logged model takes RETURNING on every verb', async () => {
    const db = await logged()
    const t = db.item as never as Planner
    expect(await t[PLAN]('updateMany', { where: { n: 7 }, data: { name: 'y' } })).toMatchObject({
      returning: true, logs: true,
      statements: [{ sql: 'UPDATE "item" SET "name" = ? WHERE "n" = ? RETURNING *', params: ['y', 7] }],
    })
    expect(await t[PLAN]('createMany', { data: [{ name: 'd', n: 1 }] })).toMatchObject({
      returning: true, logs: true,
      statements: [{ sql: 'INSERT INTO "item" ("name", "n") VALUES (?, ?) RETURNING *', params: ['d', 1] }],
    })
    expect(await t[PLAN]('removeMany', { where: { n: 1 } })).toMatchObject({
      returning: true,
      statements: [{ sql: 'DELETE FROM "item" WHERE "n" = ? RETURNING *', params: [1] }],
    })
    expect(await t[PLAN]('deleteMany', { where: { n: 7 } })).toMatchObject({
      returning: true,
      statements: [{ sql: 'DELETE FROM "item" WHERE "n" = ? RETURNING *', params: [7] }],
    })
    expect(await db.item.count()).toBe(0)
  })

  test('a verb that is not planned is refused by name, and the seam is no key of the table', async () => {
    const db = await plain()
    const t = db.item as never as Planner
    await expect(t[PLAN]('upsertMany', { data: [{ name: 'x', n: 1 }] })).rejects.toThrow(/\[PLAN\]\(upsertMany\): not a planned write/)
    expect(await t[PLAN]('createMany', { data: [] })).toBeNull()
    expect(Object.keys(db.item).some(k => /plan/i.test(k))).toBe(false)
    expect(Object.keys(db.$setAuth({ id: 1 }).item).some(k => /plan/i.test(k))).toBe(false)
    expect(typeof (db.$setAuth({ id: 1 }).item as never as Planner)[PLAN]).toBe('function')
  })
})

// ─── the single-row verbs ────────────────────────────────────────────────────
//
// Step 5b: `create`, `update`, `remove`, `delete` and the one-statement
// `upsert` plan too. A single-row plan carries `result` — the row the
// statement reached, read and shaped — `refuse`, the ladder that explains a
// row it did not reach, and `announce` as `{ event, operation }` for the row
// event. The SQL is again what each verb ran before it was split.

const VERSION = `model Item { id Int @id @default(autoincrement())  name String  n Int  v Int @version }`
const UNIQ    = `model Item { id Int @id @default(autoincrement())  slug String @unique  name String  n Int }`
const row = (event: string, operation: string) => ({ event, operation })

describe('a single-row verb plans, and the executor hands back the row', () => {
  test('plain: create, update, remove, delete', async () => {
    const db = await plain()
    await db.item.createMany({ data: [{ name: 'a', n: 7 }, { name: 'b', n: 7 }] })
    const t = db.item as never as Planner

    expect(await t[PLAN]('create', { data: { name: 'c', n: 8 } })).toMatchObject({
      verb: 'create', op: 'create', returning: true, batch: false, where: null, bare: false,
      statements: [{ sql: 'INSERT INTO "item" ("name", "n") VALUES (?, ?) RETURNING *', params: ['c', 8] }],
      announce: row('create', 'create'), result: { select: undefined, include: undefined }, refuse: null,
    })
    // select: false with nothing nested and no trail skips the RETURNING.
    expect(await t[PLAN]('create', { data: { name: 'c', n: 8 }, select: false })).toMatchObject({
      returning: false,
      statements: [{ sql: 'INSERT INTO "item" ("name", "n") VALUES (?, ?)', params: ['c', 8] }],
      result: { select: false },
    })
    expect(await t[PLAN]('update', { where: { id: 1 }, data: { name: 'y' } })).toMatchObject({
      verb: 'update', op: 'update', returning: true, bare: true,
      statements: [{ sql: 'UPDATE "item" SET "name" = ? WHERE "id" = ? RETURNING *', params: ['y', 1] }],
      where: { sql: '"id" = ?', params: [1] },
      announce: row('update', 'update'),
      refuse: { where: { sql: '"id" = ?', params: [1] }, transition: null, version: null, sealSelf: [], seal: { sql: '"id" = ?', params: [1], op: 'update' } },
    })
    expect(await t[PLAN]('update', { where: { id: 1 }, data: { name: 'y' }, select: false })).toMatchObject({
      returning: false,
      statements: [{ sql: 'UPDATE "item" SET "name" = ? WHERE "id" = ?', params: ['y', 1] }],
    })
    // A patch naming nothing plans the read-back and announces nothing (FJS-368).
    expect(await t[PLAN]('update', { where: { id: 1 }, data: {} })).toMatchObject({
      statements: [], announce: null,
      count: { sql: 'SELECT * FROM "item" WHERE "id" = ?', params: [1] },
    })
    // A hard-delete model: remove is delete under its own name, with RETURNING.
    expect(await t[PLAN]('remove', { where: { id: 1 } })).toMatchObject({
      verb: 'remove', op: 'delete', returning: true, prefetch: true,
      statements: [{ sql: 'DELETE FROM "item" WHERE "id" = ? RETURNING *', params: [1] }],
      announce: row('remove', 'remove'), refuse: { seal: { sql: '"id" = ?', params: [1], op: 'remove' } },
    })
    // delete reads its row AHEAD of the statement, so a @from can still correlate to it.
    expect(await t[PLAN]('delete', { where: { id: 1 } })).toMatchObject({
      verb: 'delete', op: 'delete', returning: false, prefetch: true,
      statements: [{ sql: 'DELETE FROM "item" WHERE "id" = ?', params: [1] }],
      announce: row('remove', 'delete'), refuse: { seal: { op: 'delete' } },
    })
    await expect(t[PLAN]('delete', { where: {} })).rejects.toThrow(/requires a where clause/)

    // Planned seven times, written never.
    expect(await db.item.count()).toBe(2)
  })

  test('a policy under $setAuth is folded into the where; a create is graded in JS', async () => {
    const db = await policy()
    await db.asSystem().doc.createMany({ data: [{ title: 'a', ownerId: 1 }, { title: 'b', ownerId: 2 }] })
    const t = db.$setAuth({ id: 1 }).doc as never as Planner
    expect(await t[PLAN]('update', { where: { id: 1 }, data: { title: 'z' } })).toMatchObject({
      statements: [{ sql: 'UPDATE "doc" SET "title" = ? WHERE ("id" = ?) AND ("ownerId" = ?) RETURNING *', params: ['z', 1, 1] }],
      refuse: { where: { sql: '"id" = ?', params: [1] }, seal: { sql: '("id" = ?) AND ("ownerId" = ?)', params: [1, 1] } },
    })
    expect(await t[PLAN]('remove', { where: { id: 1 } })).toMatchObject({
      statements: [{ sql: 'DELETE FROM "doc" WHERE ("id" = ?) AND ("ownerId" = ?) RETURNING *', params: [1, 1] }],
    })
    expect(await t[PLAN]('delete', { where: { id: 1 } })).toMatchObject({
      statements: [{ sql: 'DELETE FROM "doc" WHERE ("id" = ?) AND ("ownerId" = ?)', params: [1, 1] }],
    })
    expect(await t[PLAN]('create', { data: { title: 'c', ownerId: 1 } })).toMatchObject({
      statements: [{ sql: 'INSERT INTO "doc" ("title", "ownerId") VALUES (?, ?) RETURNING *', params: ['c', 1], refusal: null }],
    })
    // A create policy refuses in the planner, before any statement exists.
    await expect(t[PLAN]('create', { data: { title: 'c', ownerId: 2 } })).rejects.toThrow(/Create denied/)
    expect(await db.asSystem().doc.count()).toBe(2)
  })

  test('a soft-delete model: remove is a stamp with its cascade, delete bypasses the filter', async () => {
    const db = await soft()
    const t = db.item as never as Planner
    expect(await t[PLAN]('update', { where: { id: 1 }, data: { name: 'y' } })).toMatchObject({
      statements: [{ sql: 'UPDATE "item" SET "name" = ? WHERE ("deletedAt" IS NULL AND "id" = ?) RETURNING *', params: ['y', 1] }],
    })
    expect(await t[PLAN]('remove', { where: { id: 1 } })).toMatchObject({
      verb: 'remove', op: 'remove', returning: true, softCascade: { ts: NOW },
      statements: [{ sql: 'UPDATE "item" SET "deletedAt" = ? WHERE ("deletedAt" IS NULL AND "id" = ?) RETURNING *', params: [NOW, 1] }],
      refuse: { seal: { sql: '("deletedAt" IS NULL AND "id" = ?)', params: [1], op: 'remove' } },
    })
    expect(await t[PLAN]('delete', { where: { id: 1 } })).toMatchObject({
      op: 'delete', statements: [{ sql: 'DELETE FROM "item" WHERE "id" = ?', params: [1] }],
    })
  })

  test('a logged model takes RETURNING on every single-row verb, select: false included', async () => {
    const db = await logged()
    const t = db.item as never as Planner
    expect(await t[PLAN]('create', { data: { name: 'd', n: 1 }, select: false })).toMatchObject({
      returning: true, logs: true,
      statements: [{ sql: 'INSERT INTO "item" ("name", "n") VALUES (?, ?) RETURNING *', params: ['d', 1] }],
    })
    expect(await t[PLAN]('update', { where: { id: 1 }, data: { name: 'y' }, select: false })).toMatchObject({
      returning: true, logs: true,
      statements: [{ sql: 'UPDATE "item" SET "name" = ? WHERE "id" = ? RETURNING *', params: ['y', 1] }],
    })
    expect(await t[PLAN]('remove', { where: { id: 1 } })).toMatchObject({ returning: true, logs: true })
    expect(await t[PLAN]('delete', { where: { id: 1 } })).toMatchObject({ returning: false, prefetch: true, logs: true })
    expect(await db.item.count()).toBe(0)
  })

  test('@version: the compare-and-swap is in the WHERE and the refusal names it', async () => {
    const db = await createClient({ schema: VERSION, db: ':memory:', now: () => NOW })
    await db.item.createMany({ data: [{ name: 'a', n: 7 }] })
    const t = db.item as never as Planner
    expect(await t[PLAN]('update', { where: { id: 1 }, data: { name: 'y', v: 1 } })).toMatchObject({
      statements: [{ sql: 'UPDATE "item" SET "name" = ?, "v" = "v" + 1 WHERE ("id" = ?) AND "v" = ? RETURNING *', params: ['y', 1, 1] }],
      refuse: { version: { field: 'v', expect: 1 }, seal: { sql: '("id" = ?) AND "v" = ?', params: [1, 1] } },
    })
    // A version-only patch writes nothing and still asks the precondition.
    expect(await t[PLAN]('update', { where: { id: 1 }, data: { v: 1 } })).toMatchObject({
      statements: [], announce: null, refuse: { version: { field: 'v', expect: 1 }, seal: null },
    })
    await expect(t[PLAN]('update', { where: { id: 1 }, data: { name: 'y' } })).rejects.toThrow(/not opened from a current copy/)
  })

  test('the one-statement upsert is a plan the verb chooses, and announces nothing', async () => {
    const db = await createClient({ schema: UNIQ, db: ':memory:' })
    await db.item.createMany({ data: [{ slug: 'a', name: 'a', n: 1 }] })
    const t = db.item as never as Planner
    expect(await t[PLAN]('upsert', { where: { slug: 'b' }, create: { slug: 'b', name: 'x', n: 2 }, update: { name: 'y' } })).toMatchObject({
      verb: 'upsert', op: 'upsert', returning: true, bare: true, announce: null, logs: false,
      statements: [{ sql: 'INSERT INTO "item" ("slug", "name", "n") VALUES (?, ?, ?) ON CONFLICT("slug") DO UPDATE SET "name" = ? RETURNING *', params: ['b', 'x', 2, 'y'] }],
    })
    // Off the fast path there is no one statement to plan.
    expect(await t[PLAN]('upsert', { where: { slug: 'b' }, create: { slug: 'b', name: 'x', n: 2 }, update: {} })).toBeNull()
    expect(await db.item.count()).toBe(1)
  })
})
