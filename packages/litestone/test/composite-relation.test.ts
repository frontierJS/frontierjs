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

describe('the policy forms that cross a composite relation', () => {
  const withPolicy = (model: string, rule: string, src = SRC) =>
    src.replace(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`), `model ${model} {$1\n  ${rule}\n}`)

  async function asUser(schema: string) {
    const db: any = await createClient({ schema, db: ':memory:' })
    await seed(db.asSystem())
    return db.$setAuth({ id: 'u1' })
  }

  it('check(person) delegates to the row\'s own person', async () => {
    const schema = withPolicy('Person', `@@allow('read', role == 'organizer')`,
      withPolicy('Assignment', `@@allow('read', check(person))`))
    const me = await asUser(schema)
    expect(ids(await me.assignment.findMany({ where: { scheduleId: 's1' } }))).toEqual(['a1', 'a3'])
  })

  it('assignments.some(…) tests the shift\'s own assignments', async () => {
    const me = await asUser(withPolicy('Shift', `@@allow('read', assignments.some(personId == 'bob'))`))
    expect(ids(await me.shift.findMany({}))).toEqual(['am'])
  })

  it('a create is graded by the person the payload names, not the first in its schedule', async () => {
    const me = await asUser(withPolicy('Shift', '@@gate(0)', withPolicy('Person', '@@gate(0)',
      withPolicy('Assignment', `@@allow('read', true)\n  @@allow('create', person.role == 'organizer')`))))
    await expect(me.assignment.create({ data: { id: 'b1', scheduleId: 's1', shiftId: 'pm', personId: 'bob' } }))
      .rejects.toThrow()
    expect(await me.assignment.create({ data: { id: 's9', scheduleId: 's1', shiftId: 'pm', personId: 'sam' } }))
      .toMatchObject({ id: 's9' })
  })

  it('a composite relation compared as ONE value is refused by name', async () => {
    await expect(createClient({ schema: withPolicy('Assignment', `@@allow('read', person == auth())`), db: ':memory:' }))
      .rejects.toThrow(/'person' relates over \(scheduleId, personId\)/)
  })
})

describe('a select that names a composite relation carries every key column', () => {
  it('and hands back only what was asked for', async () => {
    const db: any = await createClient({ schema: SRC, db: ':memory:' })
    await seed(db)
    const rows = await db.assignment.findMany({ where: { scheduleId: 's1' }, select: { id: true, person: { select: { name: true } } }, orderBy: { id: 'asc' } })
    expect(rows).toEqual([
      { id: 'a1', person: { name: 'Sam' } },
      { id: 'a2', person: { name: 'Bob' } },
      { id: 'a3', person: { name: 'Sam' } },
    ])
  })
})

describe('the soft-delete cascade follows every column of the key', () => {
  const CASCADE = `
model Shift {
  id          String @id
  scheduleId  String
  deletedAt   DateTime?
  assignments Assignment[]
  @@unique([scheduleId, id])
  @@softDelete(cascade)
}

model Assignment {
  id          String @id
  scheduleId  String
  shiftId     String
  shift       Shift @relation(fields: [scheduleId, shiftId], references: [scheduleId, id])
  deletedAt   DateTime?
  notes       Note[]
  @@unique([scheduleId, id])
  @@softDelete(cascade)
}

model Note {
  id           String @id
  scheduleId   String
  assignmentId String
  assignment   Assignment @relation(fields: [scheduleId, assignmentId], references: [scheduleId, id])
  deletedAt    DateTime?
  @@softDelete
}
`
  it('removes and restores the removed shift\'s own subtree, and no sibling\'s', async () => {
    const db: any = await createClient({ schema: CASCADE, db: ':memory:' })
    for (const id of ['am', 'pm']) await db.shift.create({ data: { id, scheduleId: 's1' } })
    await db.assignment.create({ data: { id: 'a1', scheduleId: 's1', shiftId: 'am' } })
    await db.assignment.create({ data: { id: 'a2', scheduleId: 's1', shiftId: 'pm' } })
    await db.note.create({ data: { id: 'n1', scheduleId: 's1', assignmentId: 'a1' } })
    await db.note.create({ data: { id: 'n2', scheduleId: 's1', assignmentId: 'a2' } })

    await db.shift.remove({ where: { id: 'am' } })
    expect(ids(await db.assignment.findMany({}))).toEqual(['a2'])
    expect(ids(await db.note.findMany({}))).toEqual(['n2'])

    await db.shift.restore({ where: { id: 'am' } })
    expect(ids(await db.assignment.findMany({}))).toEqual(['a1', 'a2'])
    expect(ids(await db.note.findMany({}))).toEqual(['n1', 'n2'])
  })
})

describe('a tree walk over a composite self-relation', () => {
  it('is refused by name', async () => {
    const db: any = await createClient({ schema: `
model Node {
  id          String @id
  scheduleId  String
  parentId    String?
  parent      Node?  @relation(fields: [scheduleId, parentId], references: [scheduleId, id])
  children    Node[]
  @@unique([scheduleId, id])
}`, db: ':memory:' })
    await expect(db.node.findMany({ recursive: true }))
      .rejects.toThrow(/'Node\.parent' relates over \(scheduleId, parentId\), and a tree walk follows a single column/)
  })
})

// FJS-2784: SQLite wants the referenced columns to be a key, and `id` alone
// being unique does not count. Unrefused, every write to BOTH tables threw a
// bare 'foreign key mismatch', the parent's included.
describe('a relation whose references are not a key of the target', () => {
  const schema = (shiftAttrs: string, ref = '[scheduleId, id]') => `
model Schedule {
  id     String @id
  shifts Shift[]
}
model Shift {
  id          String @id
  scheduleId  String
  schedule    Schedule @relation(fields: [scheduleId], references: [id])
  code        String
  assignments Assignment[]
  ${shiftAttrs}
}
model Assignment {
  id          String @id
  scheduleId  String
  shiftId     String
  shift       Shift @relation(fields: [scheduleId, shiftId], references: ${ref})
}`

  it('is refused at load, naming the cure', async () => {
    await expect(createClient({ schema: schema(''), db: ':memory:' }))
      .rejects.toThrow(/references \[scheduleId, id\] are not a key of 'Shift'.*Add @@unique\(\[scheduleId, id\]\) to Shift/)
  })

  it('is refused for a single column that is not unique', async () => {
    const one = schema('').replace('[scheduleId, shiftId], references: [scheduleId, id]', '[shiftId], references: [code]')
    await expect(createClient({ schema: one, db: ':memory:' }))
      .rejects.toThrow(/references \[code\] are not a key of 'Shift'.*Add @unique to Shift\.code/)
  })

  it('builds once a @@unique over exactly those columns exists', async () => {
    const db: any = await createClient({ schema: schema('@@unique([scheduleId, id])'), db: ':memory:' })
    await db.schedule.create({ data: { id: 's1' } })
    await db.shift.create({ data: { id: 'am', scheduleId: 's1', code: 'a' } })
    await db.assignment.create({ data: { id: 'a1', scheduleId: 's1', shiftId: 'am' } })
  })

  it('builds over a single @unique column', async () => {
    const one = schema('').replace('[scheduleId, shiftId], references: [scheduleId, id]', '[shiftId], references: [code]')
      .replace('code        String', 'code        String @unique')
    await createClient({ schema: one, db: ':memory:' })
  })
})
