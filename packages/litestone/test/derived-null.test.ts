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
