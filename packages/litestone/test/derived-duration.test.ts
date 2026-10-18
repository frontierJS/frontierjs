// test/derived-duration.test.ts
//
// FJS-2005: `@derived` could compare a column to now() and nothing else, so
// "due within 2 days" had no schema spelling and could not be filtered, sorted
// or paginated by on the server. `now() + 2d` is the offset, in the duration
// literal `@@commitment(on: createdAt + 14d)` already reads.
import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Task {
    id          Int       @id
    dueAt       DateTime?
    completedAt DateTime?

    soon    Boolean @derived(dueAt >= now() && dueAt < now() + 2d && completedAt == null)
    stale   Boolean @derived(dueAt < now() - 1wk)
    urgency Int     @derived(dueAt < now() ? 3 : dueAt < now() + 2d ? 2 : dueAt < now() + 6d ? 1 : 0)
  }
`
const HOURS = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

async function seeded() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  await sys.task.create({ data: { id: 1, dueAt: HOURS(-24 * 10) } })  // ten days overdue
  await sys.task.create({ data: { id: 2, dueAt: HOURS(-2) } })        // just overdue
  await sys.task.create({ data: { id: 3, dueAt: HOURS(24) } })        // tomorrow
  await sys.task.create({ data: { id: 4, dueAt: HOURS(24 * 4) } })    // in four days
  await sys.task.create({ data: { id: 5, dueAt: HOURS(24 * 30) } })   // next month
  await sys.task.create({ data: { id: 6, dueAt: HOURS(24), completedAt: HOURS(-1) } })
  return db
}
const ids = (rows: any[]) => rows.map((r) => r.id)
const modelWith = (expr: string) => `model T { id Int @id  d DateTime  x Boolean @derived(${expr}) }`
const errorsOf = (expr: string) => parse(modelWith(expr)).errors.join('\n')

describe('now() + <duration> in @derived', () => {
  test('the offset moves the instant: filter, sort and read all see it', async () => {
    const db = await seeded()
    expect(ids(await db.task.findMany({ where: { soon: true }, orderBy: { id: 'asc' } }))).toEqual([3])
    expect(ids(await db.task.findMany({ where: { stale: true } }))).toEqual([1])
    expect(ids(await db.task.findMany({ orderBy: [{ urgency: 'desc' }, { id: 'asc' }] }))).toEqual([1, 2, 3, 6, 4, 5])
    const rows = await db.task.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.urgency)).toEqual([3, 3, 2, 1, 0, 2])
    db.$close()
  })

  test('a negative offset reads the same as a minus', () => {
    const a = parse(modelWith('d < now() - 3d'))
    const b = parse(modelWith('d < now() -3d'))
    expect(a.errors).toEqual([])
    expect(JSON.stringify(a.schema.models[0].fields[2].attributes))
      .toEqual(JSON.stringify(b.schema.models[0].fields[2].attributes))
  })

  test('an offset that is not a whole duration is refused where it is written', () => {
    expect(errorsOf('d < now() + 1.5h')).toMatch(/whole number/)
    expect(errorsOf('d < now() + 3kg')).toMatch(/not a duration/)
    expect(errorsOf('d < now() + 3')).toMatch(/not a duration/)
    expect(errorsOf('d < now() + d')).toMatch(/duration/)
  })

  test('only now() takes an offset', () => {
    expect(errorsOf('d + 2d < now()')).toMatch(/Expected RPAREN/)
  })
})

// FJS-2135: the row policies take it too; `test/policy-interpreters.test.ts`
// grades the SQL and JS halves against each other.
describe('a row policy takes it at startup', () => {
  test.each([
    ['@@allow(read, dueAt < now() + 2d)'],
    ['@@scope(soon, dueAt < now() + 2d)'],
  ])('%s', async (attr) => {
    const db: any = await createClient({ db: ':memory:', schema: `model Task { id Int @id  dueAt DateTime?  ${attr} }` })
    db.$close()
  })
})

// FJS-2629: @derived read SQLite's own clock, so `createClient({ now })` never
// reached it and a suite frozen at 2020 read a 2021 due date as overdue.
describe('@derived reads the client clock', () => {
  const FROZEN = '2020-01-01T00:00:00.000Z'
  const rows = async (now: any) => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA, now })
    const sys = db.asSystem()
    await sys.task.create({ data: { id: 1, dueAt: '2019-12-31T00:00:00.000Z' } })  // a day before FROZEN
    await sys.task.create({ data: { id: 2, dueAt: '2020-01-02T00:00:00.000Z' } })  // a day after
    await sys.task.create({ data: { id: 3, dueAt: '2021-06-01T00:00:00.000Z' } })  // far after
    return db
  }

  test('read, filter and sort see the injected instant', async () => {
    const db = await rows(() => new Date(FROZEN))
    const all = await db.task.findMany({ orderBy: { id: 'asc' } })
    expect(all.map((r: any) => r.urgency)).toEqual([3, 2, 0])
    expect(all.map((r: any) => r.stale)).toEqual([false, false, false])
    expect(ids(await db.task.findMany({ where: { soon: true } }))).toEqual([2])
    expect(ids(await db.task.findMany({ orderBy: [{ urgency: 'desc' }, { id: 'asc' }] }))).toEqual([1, 2, 3])
    expect((await db.task.findUnique({ where: { id: 3 } })).urgency).toBe(0)
    db.$close()
  })

  test('a clock that moves is read again by the next statement', async () => {
    let at = FROZEN
    const db = await rows(() => at)
    expect(ids(await db.task.findMany({ where: { urgency: 3 } }))).toEqual([1])
    at = '2020-01-03T00:00:00.000Z'
    expect(ids(await db.task.findMany({ where: { urgency: 3 }, orderBy: { id: 'asc' } }))).toEqual([1, 2])
    db.$close()
  })

  test('no clock injected means the wall clock', async () => {
    const db = await rows(undefined)
    expect((await db.task.findUnique({ where: { id: 3 } })).urgency).toBe(3)
    db.$close()
  })
})
