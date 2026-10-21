// test/derived-null.test.ts
//
// FJS-2614: a comparison over a NULL column is SQL UNKNOWN and NOT keeps it
// UNKNOWN, while the read coerces a Boolean @derived to false. So a row read as
// false matched neither where: { x: false } nor where: { x: true } -- the
// catalog's own overdue example, for every task with no due date. A derived
// field answers what the read shows, so the filter must find it.
import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  model Task {
    id          Int       @id
    dueAt       DateTime?
    completedAt DateTime?
    label       String?
    flag        Boolean?

    overdue    Boolean @derived(dueAt < now() && completedAt == null)
    notOverdue Boolean @derived(!(dueAt < now() && completedAt == null))
    notUrgent  Boolean @derived(label != 'urgent')
    tagged     Boolean @derived(label in ['a', 'b'])
    notTagged  Boolean @derived(!(label in ['a', 'b']))
    unflagged  Boolean @derived(!flag)
  }
`
const PAST = new Date(Date.now() - 3600_000).toISOString()

async function seeded() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  await sys.task.create({ data: { id: 1 } })                                   // every column null
  await sys.task.create({ data: { id: 2, dueAt: PAST, label: 'urgent', flag: true } })
  return db
}
const ids = (rows: any[]) => rows.map((r) => r.id)
const where = async (db: any, w: any) => ids(await db.task.findMany({ where: w, orderBy: { id: 'asc' } }))

describe('a Boolean @derived over a null column filters as it reads', () => {
  test('the read and both filters agree on every field', async () => {
    const db = await seeded()
    const rows = await db.task.findMany({ orderBy: { id: 'asc' } })
    for (const field of ['overdue', 'notOverdue', 'notUrgent', 'tagged', 'notTagged', 'unflagged']) {
      const asTrue  = rows.filter((r: any) => r[field] === true).map((r: any) => r.id)
      const asFalse = rows.filter((r: any) => r[field] === false).map((r: any) => r.id)
      expect({ field, ids: await where(db, { [field]: true }) }).toEqual({ field, ids: asTrue })
      expect({ field, ids: await where(db, { [field]: false }) }).toEqual({ field, ids: asFalse })
    }
    db.$close()
  })

  test('! negates what the expression reads: no due date is not overdue', async () => {
    const db = await seeded()
    const [none, past] = await db.task.findMany({ orderBy: { id: 'asc' } })
    expect([none.overdue, none.notOverdue]).toEqual([false, true])
    expect([past.overdue, past.notOverdue]).toEqual([true, false])
    expect(await where(db, { overdue: false })).toEqual([1])
    expect(await where(db, { notOverdue: true })).toEqual([1])
    db.$close()
  })

  test('!= over a null reads as !(==): a missing label is not urgent', async () => {
    const db = await seeded()
    const [none, urgent] = await db.task.findMany({ orderBy: { id: 'asc' } })
    expect([none.notUrgent, urgent.notUrgent]).toEqual([true, false])
    expect([none.tagged, none.notTagged, none.unflagged]).toEqual([false, true, true])
    db.$close()
  })
})

// FJS-2710 / FJS-D1107: `+ - *` and round() over Int and Float operands. A null
// operand makes the sum null, so the comparison over it is false on the read
// and in the filter alike.
describe('arithmetic in @derived', () => {
  const ARITH = `
    model Line {
      id        Int  @id
      a         Int
      b         Int?
      unitPrice Int
      quantity  Int
      c         Int     @derived(a * b)
      total     Int     @derived(round(unitPrice * quantity * 0.01))
      under     Boolean @derived(a * 4 < b * 1)
    }
  `
  test('the value reads, filters and sorts', async () => {
    const db: any = await createClient({ db: ':memory:', schema: ARITH })
    const sys = db.asSystem()
    await sys.line.create({ data: { id: 1, a: 3, b: 4, unitPrice: 333, quantity: 7 } })
    await sys.line.create({ data: { id: 2, a: 1, b: null, unitPrice: 50, quantity: 1 } })
    expect((await sys.line.findMany({ where: { c: 12 } })).map((r: any) => r.id)).toEqual([1])
    expect((await sys.line.findMany({ orderBy: { id: 'asc' } })).map((r: any) => [r.c, r.total, r.under]))
      .toEqual([[12, 23, false], [null, 1, false]])
    expect((await sys.line.findMany({ where: { under: false } })).map((r: any) => r.id).sort()).toEqual([1, 2])
    expect((await sys.line.findMany({ orderBy: { total: 'desc' } })).map((r: any) => r.id)).toEqual([1, 2])
    db.$close()
  })

  test.each([
    ['x Int @derived(a * label)', /'label' is String, and \* takes Int or Float operands/],
    ['x Int @derived(a + flag)', /'flag' is Boolean/],
    ['x String @derived(a * 2)', /declares String and the expression produces Int/],
    ['@@scope(s, a * label > 1)', /'label' is String/],
    ['@@allow(read, secret * 2 > 1)', /'secret' is @encrypted, so the column holds an encoding/],
  ])('%s is refused by name', async (decl, message) => {
    const schema = `model T { id Int @id  a Int  label String?  flag Boolean?  secret Int? @encrypted  ${decl} }`
    await expect(createClient({ db: ':memory:', schema, encryptionKey: 'a'.repeat(64) })).rejects.toThrow(message)
  })
})
