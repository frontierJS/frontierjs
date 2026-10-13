// A relation over a composite key is joined on EVERY pair (FJS-2790).
//
// `buildRelationMap` used to keep `fields[0]` and `references[0]`, so a relation
// over `(scheduleId, personId)` was joined on `scheduleId` alone. Nothing threw:
// an include answered every sibling in the schedule under each parent, and a
// one-hop policy path graded a row by the first Person in the schedule rather
// than its own — Invariant 6 enforced against the wrong row. The fixture shares
// its first column on purpose, which is the only shape that tells the two apart.

import { describe, it, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/core/client.js'

const SRC = `
model Schedule {
  id     String @id
  people Person[]
  shifts Shift[]
}

model Person {
  id          String @id
  scheduleId  String
  schedule    Schedule @relation(fields: [scheduleId], references: [id])
  name        String
  role        String
  assignments Assignment[]
  @@unique([scheduleId, id])
}

model Shift {
  id          String @id
  scheduleId  String
  schedule    Schedule @relation(fields: [scheduleId], references: [id])
  name        String
  assignments Assignment[]
  adults      Int @from(Assignment, count: true)
  @@unique([scheduleId, id])
}

model Assignment {
  id          String @id
  scheduleId  String
  shiftId     String
  shift       Shift  @relation(fields: [scheduleId, shiftId], references: [scheduleId, id], onDelete: Cascade)
  personId    String
  person      Person @relation(fields: [scheduleId, personId], references: [scheduleId, id])
}
`

// Organizers may be read through; staff may not. The policy names the RELATED
// row, which is the path that used to read the schedule's first Person.
const GATED = SRC.replace(
  /model Assignment \{([\s\S]*?)\n\}/,
  `model Assignment {$1\n  @@allow('read', person.role == 'organizer')\n}`)

async function seed(db: any) {
  await db.schedule.create({ data: { id: 's1' } })
  await db.schedule.create({ data: { id: 's2' } })
  // bob is written LAST, so a first-column join that picks the last-written row
  // answers bob everywhere.
  await db.person.create({ data: { id: 'sam', scheduleId: 's1', name: 'Sam', role: 'organizer' } })
  await db.person.create({ data: { id: 'bob', scheduleId: 's1', name: 'Bob', role: 'staff' } })
  await db.person.create({ data: { id: 'zed', scheduleId: 's2', name: 'Zed', role: 'organizer' } })
  await db.shift.create({ data: { id: 'am', scheduleId: 's1', name: 'Morning' } })
  await db.shift.create({ data: { id: 'pm', scheduleId: 's1', name: 'Evening' } })
  await db.shift.create({ data: { id: 'x', scheduleId: 's2', name: 'Other' } })
  for (const [id, shiftId, personId] of [['a1', 'am', 'sam'], ['a2', 'am', 'bob'], ['a3', 'pm', 'sam']])
    await db.assignment.create({ data: { id, scheduleId: 's1', shiftId, personId } })
  await db.assignment.create({ data: { id: 'a4', scheduleId: 's2', shiftId: 'x', personId: 'zed' } })
}

const ids = (rows: any[]) => rows.map(r => r.id).sort()

describe('a composite relation is joined on every column', () => {
  let db: any
  beforeEach(async () => {
    db = await createClient({ schema: SRC, db: ':memory:' })
    await seed(db)
  })

  it('a belongsTo include answers the row\'s OWN parent', async () => {
    const rows = await db.assignment.findMany({ where: { scheduleId: 's1' }, include: { person: true }, orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => [r.id, r.person?.id])).toEqual([['a1', 'sam'], ['a2', 'bob'], ['a3', 'sam']])
  })

  it('a hasMany include answers the parent\'s OWN children', async () => {
    const rows = await db.shift.findMany({ where: { scheduleId: 's1' }, include: { assignments: true }, orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => [r.id, ids(r.assignments)])).toEqual([['am', ['a1', 'a2']], ['pm', ['a3']]])
  })

  it('an include _count counts the parent\'s own children', async () => {
    const rows = await db.shift.findMany({ where: { scheduleId: 's1' }, include: { _count: { select: { assignments: true } } }, orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r._count.assignments)).toEqual([2, 1])
  })

  it('@from(count) counts the parent\'s own children', async () => {
    const rows = await db.shift.findMany({ where: { scheduleId: 's1' }, orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.adults)).toEqual([2, 1])
  })

  it('a relation filter reads each row\'s own related row', async () => {
    expect(ids(await db.assignment.findMany({ where: { person: { is: { role: 'staff' } } } }))).toEqual(['a2'])
    expect(ids(await db.shift.findMany({ where: { assignments: { some: { personId: 'bob' } } } }))).toEqual(['am'])
    expect(ids(await db.shift.findMany({ where: { assignments: { none: {} } } }))).toEqual([])
  })

  it('an orderBy across a relation sorts by each row\'s own related row', async () => {
    const rows = await db.assignment.findMany({ where: { scheduleId: 's1' }, orderBy: [{ person: { name: 'asc' } }, { id: 'asc' }] })
    expect(rows.map((r: any) => r.id)).toEqual(['a2', 'a1', 'a3'])
  })

  it('a nested create fills every column of the key from its parent', async () => {
    await db.shift.create({ data: {
      id: 'late', scheduleId: 's1', name: 'Late',
      assignments: { create: [{ id: 'a9', personId: 'bob' }] },
    } })
    expect(await db.assignment.findUnique({ where: { id: 'a9' } }))
      .toMatchObject({ scheduleId: 's1', shiftId: 'late', personId: 'bob' })
  })

  it('a connect fills every column of the key from its target', async () => {
    await db.assignment.create({ data: {
      id: 'a8', shiftId: 'pm', scheduleId: 's1',
      person: { connect: { id: 'bob' } },
    } })
    expect(await db.assignment.findUnique({ where: { id: 'a8' }, include: { person: true } }))
      .toMatchObject({ personId: 'bob', person: { id: 'bob' } })
  })
})

describe('a policy path over a composite relation grades the row by its own related row', () => {
  it('reads exactly the rows whose own person qualifies', async () => {
    const sys = await createClient({ schema: GATED, db: ':memory:' })
    await seed(sys.asSystem())
    // Policies filter a caller; asSystem() reads every row.
    expect(ids(await sys.$setAuth({ id: 'u1' }).assignment.findMany({ where: { scheduleId: 's1' } }))).toEqual(['a1', 'a3'])
    expect(ids(await sys.asSystem().assignment.findMany({ where: { scheduleId: 's1' } }))).toEqual(['a1', 'a2', 'a3'])
  })
})
