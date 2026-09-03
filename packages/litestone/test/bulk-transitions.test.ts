// test/bulk-transitions.test.ts
//
// What a BULK write may not do to a state machine (FJS-671).
//
// `updateMany` matches rows with a WHERE and never reads them, so there is no
// `from` state to grade — and that made the whole of `@@transitions`, its
// per-move `@gate`s and its `@system` markings unreachable through one verb.
// `FJS-044` ruled the skip deliberate: a power tool whose caller takes
// responsibility. What that ruling could not weigh is the capability grid and
// `access.snapshot.md`, both later, and the snapshot states a move's gate with
// no per-verb qualification — so the artefact a reviewer reads certified
// enforcement one verb did not apply.
//
// Every refusal here is PAIRED with the same call one column different, and
// with the same move through `update()`, because a guard that refused the bulk
// verb outright would satisfy any test that only asked about the refusal
// (`FJS-351`). The power-tool reasoning survives and is asserted: every other
// column on the model is still bulk-writable, in the same call.

import { describe, test, expect } from 'bun:test'
import { createClient, GatePlugin, BulkTransitionError } from '../src/index.js'

const SCHEMA = `
enum DocState { draft  review  published  archived }
model User { id Int @id  @@auth }
model Doc {
  id     Int      @id @default(autoincrement())
  title  String
  note   String?
  status DocState @default(draft)
  @@gate("4.4.4.4")
  @@transitions(status,
    submit:  draft  -> review,
    approve: review -> published @gate(5),
    seize:   draft  -> published @system
  )
}`

async function env() {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
  })
  const sys = db.asSystem()
  for (let i = 1; i <= 6; i++) await sys.doc.create({ data: { title: `d${i}` } })
  await sys.doc.updateMany({ where: { id: { in: [2, 5] } }, data: { status: 'review' } })
  return { db, sys, at: (level: number) => db.$setAuth({ id: 1, level }) }
}

const state = async (sys: { doc: { findMany: (a: unknown) => Promise<{ id: number, status: string }[]> } }) =>
  (await sys.doc.findMany({ orderBy: { id: 'asc' } })).map(r => `${r.id}:${r.status}`).join(' ')

// ─── the three the bulk verb reached around ──────────────────────────────────

describe('a bulk write may not name a transitions field', () => {
  test('a @gate(5) move: update() refuses a level-4 caller and so does updateMany', async () => {
    const { db, sys, at } = await env()
    const caller = at(4)
    await expect(caller.doc.update({ where: { id: 2 }, data: { status: 'published' } }))
      .rejects.toThrow(/level 5/)
    await expect(caller.doc.updateMany({ where: { id: 5 }, data: { status: 'published' } }))
      .rejects.toBeInstanceOf(BulkTransitionError)
    // Neither row moved, which is the assertion — a refusal that threw after
    // writing would read identically from the caller's side.
    expect(await state(sys)).toBe('1:draft 2:review 3:draft 4:draft 5:review 6:draft')
    // …and the same move IS makeable, one level up, one row at a time.
    await at(5).doc.update({ where: { id: 2 }, data: { status: 'published' } })
    expect(await state(sys)).toContain('2:published')
    db.$close()
  })

  test('a @system move: no level answers it through either verb', async () => {
    const { db, sys, at } = await env()
    await expect(at(7).doc.update({ where: { id: 1 }, data: { status: 'published' } }))
      .rejects.toThrow(/@system/)
    await expect(at(7).doc.updateMany({ where: { id: 1 }, data: { status: 'published' } }))
      .rejects.toBeInstanceOf(BulkTransitionError)
    expect(await state(sys)).toContain('1:draft')
    db.$close()
  })

  test('a move the schema does not declare', async () => {
    const { db, sys, at } = await env()
    await expect(at(4).doc.updateMany({ where: { id: 3 }, data: { status: 'archived' } }))
      .rejects.toBeInstanceOf(BulkTransitionError)
    expect(await state(sys)).toContain('3:draft')
    db.$close()
  })
})

// ─── FJS-044's reasoning, kept ───────────────────────────────────────────────

describe('the power tool survives — one KEY is refused, not the verb', () => {
  test('every other column is still bulk-writable', async () => {
    const { db, sys, at } = await env()
    const r = await at(4).doc.updateMany({ where: {}, data: { note: 'swept' } })
    expect(r.count).toBe(6)
    expect((await sys.doc.findMany({})).every((d: { note: string }) => d.note === 'swept')).toBe(true)
    db.$close()
  })

  test('a model declaring no @@transitions is untouched', async () => {
    const db = await createClient({
      schema: `model Tag { id Int @id @default(autoincrement())  name String  status String }`,
      db: ':memory:',
    })
    await db.asSystem().tag.create({ data: { name: 'a', status: 'x' } })
    expect((await db.tag.updateMany({ where: {}, data: { status: 'y' } })).count).toBe(1)
    db.$close()
  })

  test('the refusal names the field, the verb and both ways forward', async () => {
    const { db, at } = await env()
    const err = await at(4).doc.updateMany({ where: {}, data: { status: 'review' } })
      .then(() => null, (e: Error) => e) as BulkTransitionError
    expect(err.name).toBe('BulkTransitionError')
    expect(err.model).toBe('Doc')
    expect(err.field).toBe('status')
    // 400, not 403: no level and no grant answers it, because the VERB is wrong
    // rather than the caller — which is the whole difference from a gate refusal.
    expect((err as unknown as { status: number }).status).toBe(400)
    expect((err as unknown as { retryable: boolean }).retryable).toBe(false)
    expect(err.message).toContain('updateMany()')
    expect(err.message).toContain("transition(id, '<move>')")
    expect(err.message).toContain('db.doc.update(')
    db.$close()
  })
})

// ─── upsertMany's update half is the same write ──────────────────────────────

describe('upsertMany', () => {
  test("its update: half is refused and its insert half is not", async () => {
    const { db, sys } = await env()
    // The insert half is a CREATE and has no from-state to grade, so a status
    // in `data` is legitimate — asserted first, or the refusal below could be
    // the whole verb rather than the one key.
    await sys.doc.upsertMany({
      data: [{ id: 90, title: 'made', status: 'review' }],
      conflictTarget: ['id'],
      update: { title: 'made' },
    })
    expect(await state(sys)).toContain('90:review')

    await expect(db.$setAuth({ id: 1, level: 4 }).doc.upsertMany({
      data: [{ id: 91, title: 'x' }],
      conflictTarget: ['id'],
      update: { status: 'published' },
    })).rejects.toBeInstanceOf(BulkTransitionError)
    db.$close()
  })
})

// ─── asSystem() bypasses, and says so ────────────────────────────────────────

describe('asSystem() keeps the power tool and is audible', () => {
  test('a system bulk write moves the column and warns', async () => {
    const { db, sys } = await env()
    const said: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { said.push(a.join(' ')) }
    try {
      const r = await sys.doc.updateMany({ where: { id: 4 }, data: { status: 'published' } })
      expect(r.count).toBe(1)
    } finally { console.warn = warn }
    expect(await state(sys)).toContain('4:published')
    // `update()` announces its own bypass through `emitTransitionEvent`, which a
    // bulk write never reaches — so without this the system path would have been
    // the one silent bypass of the two.
    expect(said.some(s => s.includes('SYSTEM bypassed @@transitions on doc.status'))).toBe(true)
    db.$close()
  })
})
