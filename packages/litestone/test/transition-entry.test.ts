// test/transition-entry.test.ts
//
// Where a row under `@@transitions` may START (`FJS-D470`, `FJS-1257`).
//
// Every move of a state column is graded, and a create has no from-state, so a
// create naming a gated destination reached it without the move: a USER(4)
// created a LeaveRequest `approved` that the same caller could not `approve`,
// and nothing on the row said which path it took. The column's @default is the
// one entry, for every principal, `asSystem()` included (`FJS-D502`).
//
// Every refusal is paired with the same call landing on the default, because a
// guard that refused every create naming the column would pass a test that
// only asked about the refusal.

import { describe, test, expect } from 'bun:test'
import { createClient, parse, Factory, GatePlugin, TransitionViolationError } from '../src/index.js'

const SCHEMA = `
enum LeaveState { requested  approved  refused  cancelled }
model User { id Int @id  @@auth }
model LeaveRequest {
  id     Int        @id @default(autoincrement())
  reason String
  status LeaveState @default(requested)
  @@unique([reason])
  @@gate("4.4.5.5")
  @@transitions(status,
    approve: requested -> approved  @gate(5),
    refuse:  requested -> refused   @gate(5),
    cancel:  requested -> cancelled
  )
}
model Flag {
  id   Int     @id @default(autoincrement())
  on   Boolean @default(false)
  @@transitions(on, raise: false -> true, lower: true -> false)
}`

async function env() {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
  })
  return { db, sys: db.asSystem(), user: db.$setAuth({ id: 1, level: 4 }) }
}

describe('a create names no state but the entry', () => {
  test('the USER(4) of FJS-1257: approve is refused, and so is starting approved', async () => {
    const { user } = await env()
    const row = await user.leaveRequest.create({ data: { reason: 'a' } })
    await expect(user.leaveRequest.transition(row.id, 'approve')).rejects.toThrow(/level 5/)
    const err = await user.leaveRequest.create({ data: { reason: 'b', status: 'approved' } }).catch(e => e)
    expect(err).toBeInstanceOf(TransitionViolationError)
    expect(err.message).toContain("starts at 'requested'")
  })

  test('naming the entry, or nothing, lands at the entry', async () => {
    const { user } = await env()
    expect((await user.leaveRequest.create({ data: { reason: 'a' } })).status).toBe('requested')
    expect((await user.leaveRequest.create({ data: { reason: 'b', status: 'requested' } })).status).toBe('requested')
  })

  test('asSystem() is held too, and walks a row there by its moves', async () => {
    const { sys } = await env()
    await expect(sys.leaveRequest.create({ data: { reason: 'a', status: 'approved' } }))
      .rejects.toBeInstanceOf(TransitionViolationError)
    const row = await sys.leaveRequest.create({ data: { reason: 'b' } })
    expect((await sys.leaveRequest.transition(row.id, 'approve')).status).toBe('approved')
  })

  test('createMany refuses the batch naming an off-entry state, and takes the one that does not', async () => {
    const { user, sys } = await env()
    await expect(user.leaveRequest.createMany({ data: [{ reason: 'a' }, { reason: 'b', status: 'refused' }] }))
      .rejects.toBeInstanceOf(TransitionViolationError)
    expect(await sys.leaveRequest.count()).toBe(0)
    await user.leaveRequest.createMany({ data: [{ reason: 'a' }, { reason: 'b', status: 'requested' }] })
    expect(await sys.leaveRequest.count()).toBe(2)
  })

  // `update: []` keeps upsertMany insert-only: its conflict half is graded as an
  // update (`FJS-1700`), and this USER(4) is below the model's update gate.
  test("upsert's create half and upsertMany's insert are creates", async () => {
    const { user, sys } = await env()
    await expect(user.leaveRequest.upsert({
      where: { reason: 'a' }, create: { reason: 'a', status: 'approved' }, update: {},
    })).rejects.toBeInstanceOf(TransitionViolationError)
    await expect(user.leaveRequest.upsertMany({ data: [{ reason: 'b', status: 'approved' }], conflictTarget: ['reason'], update: [] }))
      .rejects.toBeInstanceOf(TransitionViolationError)
    expect(await sys.leaveRequest.count()).toBe(0)
    await user.leaveRequest.upsert({ where: { reason: 'a' }, create: { reason: 'a' }, update: {} })
    await user.leaveRequest.upsertMany({ data: [{ reason: 'b', status: 'requested' }], conflictTarget: ['reason'], update: [] })
    expect(await sys.leaveRequest.count()).toBe(2)
  })

  test('a Boolean machine compares its entry as a boolean', async () => {
    const { sys } = await env()
    await expect(sys.flag.create({ data: { on: true } })).rejects.toBeInstanceOf(TransitionViolationError)
    expect((await sys.flag.create({ data: { on: false } })).on).toBe(false)
  })
})

describe('a machine without an entry', () => {
  test('is refused at parse, naming the column', () => {
    const { errors } = parse(`
      enum S { a  b }
      model M {
        id     Int @id
        status S
        @@transitions(status, go: a -> b)
      }`)
    expect(errors.join('\n')).toMatch(/@@transitions\(status\).*no @default/)
  })
})

// ─── a Factory asked for a state further along ───────────────────────────────

describe('a Factory walks the declared moves to the state it was asked for', () => {
  const WALK = `
enum S { draft  review  published  archived  gone }
model Doc {
  id     Int @id @default(autoincrement())
  title  String
  status S   @default(draft)
  @@transitions(status,
    submit:  draft  -> review,
    approve: review -> published,
    archive: [draft, published] -> archived,
    never:   draft  -> gone @gate(9)
  )
}`

  test('the fewest moves, announced like any other, and the entry needs none', async () => {
    const seen: string[] = []
    const db = await createClient({ schema: WALK, db: ':memory:', onEvent: { transition: (e: { transition: string }) => { seen.push(e.transition) } } })
    const docs = new (class extends Factory { model = 'Doc'; definition = () => ({ title: 't' }) })(db.asSystem())
    expect((await docs.create({ status: 'published' })).status).toBe('published')
    expect((await docs.create({ status: 'archived' })).status).toBe('archived')
    expect((await docs.create({ status: 'draft' })).status).toBe('draft')
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual(['submit', 'approve', 'archive'])
    db.$close()
  })

  test('a state no move reaches is refused by name, and nothing is written', async () => {
    const db = await createClient({ schema: WALK, db: ':memory:' })
    const docs = new (class extends Factory { model = 'Doc'; definition = () => ({ title: 't' }) })(db.asSystem())
    await expect(docs.create({ status: 'gone' })).rejects.toThrow(/no declared move leads from 'draft' to 'gone'/)
    expect(await db.asSystem().doc.count()).toBe(0)
    db.$close()
  })
})
