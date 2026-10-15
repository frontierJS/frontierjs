// `@from` — what it correlates on, and what it refuses.
//
// Two defects, one attribute, both silent:
//
//   • **FJS-377** — a composite-key relation correlated on its FIRST column
//     alone, so the aggregate counted every row sharing that column. The grid
//     below is built so each candidate join gives a different answer: correct
//     is 3/5/7, a join on `workspaceId` alone gives 8/8/7, one on `userId`
//     alone 10/5/10. Nothing raised it — the number is a count of real rows,
//     and it answers a question nobody asked.
//
//   • **FJS-395** — a write NAMING a @from field was accepted and dropped. It
//     was the one virtual field kind that did not refuse by name: @computed,
//     @derived, @generated, @transient, @system and @guarded all throw a
//     sentence saying which attribute and why.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

// ─── composite correlation (FJS-377) ─────────────────────────────────────────

const COMPOSITE = `
model Membership {
  id          Int    @id @default(autoincrement())
  workspaceId Int
  userId      Int
  noteCount   Int    @from(Note, count: true)
  spend       Int    @from(Note, sum: cost)
  anyNote     Boolean @from(Note, exists: true)
  latest      Note?  @from(Note, last: true)
  notes       Note[]
  @@unique([workspaceId, userId])
}
model Note {
  id          Int        @id @default(autoincrement())
  workspaceId Int
  userId      Int
  cost        Int        @default(1)
  member      Membership @relation(fields: [workspaceId, userId], references: [workspaceId, userId])
}
`

// (workspace, user, how many notes) — no two rows share both key columns, and
// each single column is shared by two rows.
const GRID = [[1, 10, 3], [1, 20, 5], [2, 10, 7]]

async function grid(schema = COMPOSITE) {
  const db: any = await createClient({ db: ':memory:', schema })
  const sys = db.asSystem()
  for (const [workspaceId, userId] of GRID) await sys.membership.create({ data: { workspaceId, userId } })
  for (const [workspaceId, userId, n] of GRID)
    for (let i = 0; i < n; i++) await sys.note.create({ data: { workspaceId, userId, cost: 10 } })
  return { db, sys }
}

describe('@from across a composite key (FJS-377)', () => {
  it('counts the rows matching EVERY key column, not the first', async () => {
    const { sys } = await grid()
    const rows = await sys.membership.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.noteCount)).toEqual([3, 5, 7])
  })

  it('sums and exists correlate the same way', async () => {
    const { sys } = await grid()
    const rows = await sys.membership.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.spend)).toEqual([30, 50, 70])
    expect(rows.map((r: any) => r.anyNote)).toEqual([true, true, true])
  })

  it('picks the last row by the whole key', async () => {
    const { sys } = await grid()
    const rows = await sys.membership.findMany({ orderBy: { id: 'asc' } })
    // Notes are created grid-order, so the last note of (1,10) is id 3.
    expect(rows.map((r: any) => r.latest?.id)).toEqual([3, 8, 15])
    for (const r of rows) {
      expect(r.latest.workspaceId).toBe(r.workspaceId)
      expect(r.latest.userId).toBe(r.userId)
    }
  })

  it('repicks under a row policy on the whole key', async () => {
    // A policy on the target sends `last:` down the ROW_NUMBER() repick rather
    // than the id the startup subquery chose — the other place the correlation
    // is spelled, and the one a single-column partition would silently merge.
    const { db } = await grid(COMPOSITE.replace(
      'model Note {', 'model Note {\n  @@allow(\'read\', cost > 0)'))
    const rows = await db.$setAuth({ id: 1 }).membership.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.latest?.id)).toEqual([3, 8, 15])
    expect(rows.map((r: any) => [r.latest.workspaceId, r.latest.userId]))
      .toEqual([[1, 10], [1, 20], [2, 10]])
  })

  it('a select naming only the @from field still correlates', async () => {
    // The key columns are injected into the SQL and out of the answer; with a
    // composite key that is every column of it, not the first.
    const { db } = await grid(COMPOSITE.replace(
      'model Note {', 'model Note {\n  @@allow(\'read\', cost > 0)'))
    const rows = await db.$setAuth({ id: 1 })
      .membership.findMany({ select: { id: true, noteCount: true, latest: true }, orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.noteCount)).toEqual([3, 5, 7])
    expect(rows.map((r: any) => r.latest?.id)).toEqual([3, 8, 15])
    expect(rows[0].workspaceId).toBeUndefined()
  })

  it('a single-column relation is unchanged', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Author {
  id        Int    @id
  noteCount Int    @from(Note, count: true)
  notes     Note[]
}
model Note {
  id       Int    @id @default(autoincrement())
  authorId Int
  author   Author @relation(fields: [authorId], references: [id])
}
` })
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1 } })
    await sys.author.create({ data: { id: 2 } })
    for (let i = 0; i < 4; i++) await sys.note.create({ data: { authorId: 1 } })
    const rows = await sys.author.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.noteCount)).toEqual([4, 0])
  })
})

// ─── writing one (FJS-395) ───────────────────────────────────────────────────

const WRITE = `
model Author {
  id        Int    @id
  first     String
  noteCount Int    @from(Note, count: true)
  notes     Note[]
}
model Note {
  id       Int    @id @default(autoincrement())
  authorId Int
  author   Author @relation(fields: [authorId], references: [id])
}
`

describe('writing a @from field (FJS-395)', () => {
  it('refuses a create naming it, by name', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    const p = db.asSystem().author.create({ data: { id: 1, first: 'A', noteCount: 99 } })
    await expect(p).rejects.toThrow(/noteCount is @from\(Note, count\)/)
    await expect(p).rejects.toThrow(/cannot be written/)
  })

  it('refuses an update naming it', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1, first: 'A' } })
    await expect(sys.author.update({ where: { id: 1 }, data: { noteCount: 42 } }))
      .rejects.toThrow(/@from/)
  })

  it('says where the value comes from instead', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    try {
      await db.asSystem().author.create({ data: { id: 1, first: 'A', noteCount: 99 } })
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.message).toMatch(/Write the Note rows it counts instead/)
    }
  })

  it('a write that leaves it alone still lands, and it reads the count', async () => {
    const db: any = await createClient({ db: ':memory:', schema: WRITE })
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1, first: 'A' } })
    await sys.note.create({ data: { authorId: 1 } })
    expect((await sys.author.findUnique({ where: { id: 1 } })).noteCount).toBe(1)
  })
})

// ─── a nested create's returned row (FJS-2388) ──────────────────────────────

const NESTED = `
model Account {
  id         Int     @id @default(autoincrement())
  name       String
  orderCount Int     @from(Order, count: true)
  hasOrders  Boolean @from(Order, exists: true)
  orders     Order[]
}
model Order {
  id        Int     @id @default(autoincrement())
  accountId Int
  account   Account @relation(fields: [accountId], references: [id])
}
`

describe('a write that lands children answers @from after they land (FJS-2388)', () => {
  it('create with a nested hasMany create', async () => {
    const db: any = await createClient({ db: ':memory:', schema: NESTED })
    const made = await db.asSystem().account.create({ data: { name: 'a', orders: { create: [{}, {}] } } })
    const again = await db.asSystem().account.findUnique({ where: { id: made.id } })
    expect(again.orderCount).toBe(2)
    expect(made.orderCount).toBe(2)
    expect(made.hasOrders).toBe(true)
  })

  it('update with a nested hasMany create', async () => {
    const db: any = await createClient({ db: ':memory:', schema: NESTED })
    const sys = db.asSystem()
    const a = await sys.account.create({ data: { name: 'a' } })
    expect(a.orderCount).toBe(0)
    const made = await sys.account.update({ where: { id: a.id }, data: { orders: { create: [{}, {}, {}] } } })
    expect(made.orderCount).toBe(3)
    expect(made.hasOrders).toBe(true)
  })
})

// ─── @from avg (FJS-2679) ────────────────────────────────────────────────────

const AVERAGE = `
model Template {
  id       Int      @id @default(autoincrement())
  name     String
  average  Float?   @from(Score, avg: points)
  scores   Score[]
}
model Score {
  id         Int      @id @default(autoincrement())
  templateId Int
  points     Int
  template   Template @relation(fields: [templateId], references: [id])
}
`

describe('@from(avg:) is the mean of a column, filterable and sortable (FJS-2679)', () => {
  async function seeded() {
    const db: any = await createClient({ db: ':memory:', schema: AVERAGE })
    const sys = db.asSystem()
    for (const name of ['low', 'high', 'empty']) await sys.template.create({ data: { name } })
    for (const [templateId, points] of [[1, 1], [1, 2], [2, 4], [2, 5]]) await sys.score.create({ data: { templateId, points } })
    return sys
  }

  it('reads the mean, and null where there is nothing to average', async () => {
    const sys = await seeded()
    const rows = await sys.template.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.average)).toEqual([1.5, 4.5, null])
  })

  it('filters and sorts by it', async () => {
    const sys = await seeded()
    const over = await sys.template.findMany({ where: { average: { gt: 2 } } })
    expect(over.map((r: any) => r.name)).toEqual(['high'])
    const ordered = await sys.template.findMany({ where: { average: { not: null } }, orderBy: { average: 'desc' } })
    expect(ordered.map((r: any) => r.name)).toEqual(['high', 'low'])
  })
})

// ─── @from(rel, column): a parent's column onto the child (FJS-1305, FJS-D911) ─
//
// `@from` had no to-one form, so `@derived(state.category)`'s refusal pointed at
// a spelling that did not parse and a parent's column could not reach a child at
// all. The same SQL a policy's `rel.column` path builds, as a read-time field.

const TO_ONE = `
enum Category { backlog started done }
model State {
  id       Int      @id @default(autoincrement())
  name     String
  category Category @default(backlog)
  deleted  Boolean  @default(false)
  issues   Issue[]
}
model Issue {
  id            Int       @id @default(autoincrement())
  title         String
  stateId       Int?
  state         State?    @relation(fields: [stateId], references: [id])
  stateCategory Category? @from(state, category)
}
model Event {
  id        Int     @id @default(autoincrement())
  capacity  Int
  enrolled  Int     @from(Enrollment, count: true)
  big       Boolean @derived(capacity > 7)
  enrollments Enrollment[]
  shifts    Shift[]
}
model Enrollment {
  id      Int   @id @default(autoincrement())
  eventId Int
  event   Event @relation(fields: [eventId], references: [id])
}
model Shift {
  id       Int   @id @default(autoincrement())
  eventId  Int
  event    Event @relation(fields: [eventId], references: [id])
  enrolled Int   @from(event, enrolled)
  big      Boolean @from(event, big)
  capacity Int   @from(event, capacity)
}
`

describe('@from(rel, column) reads a column off the parent', () => {
  async function seeded() {
    const db: any = await createClient({ db: ':memory:', schema: TO_ONE })
    const sys = db.asSystem()
    await sys.state.create({ data: { name: 'Todo', category: 'backlog' } })
    await sys.state.create({ data: { name: 'Doing', category: 'started' } })
    await sys.issue.create({ data: { title: 'a', stateId: 1 } })
    await sys.issue.create({ data: { title: 'b', stateId: 2 } })
    await sys.issue.create({ data: { title: 'c' } })
    return { db, sys }
  }

  it('brings the value over, null for an absent parent, and follows the parent', async () => {
    const { sys } = await seeded()
    const rows = await sys.issue.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.stateCategory)).toEqual(['backlog', 'started', null])
    await sys.state.update({ where: { id: 1 }, data: { category: 'done' } })
    const after = await sys.issue.findMany({ orderBy: { id: 'asc' } })
    expect(after.map((r: any) => r.stateCategory)).toEqual(['done', 'started', null])
  })

  it('filters and sorts by it, and a write naming it is refused', async () => {
    const { sys } = await seeded()
    const started = await sys.issue.findMany({ where: { stateCategory: 'started' } })
    expect(started.map((r: any) => r.title)).toEqual(['b'])
    const ordered = await sys.issue.findMany({ where: { stateCategory: { not: null } }, orderBy: { stateCategory: 'desc' } })
    expect(ordered.map((r: any) => r.title)).toEqual(['b', 'a'])
    await expect(sys.issue.create({ data: { title: 'x', stateCategory: 'done' } })).rejects.toThrow(/@from\(state, category\)/)
  })

  it('reads through select, and the parent column a child alone is asked for', async () => {
    const { sys } = await seeded()
    const rows = await sys.issue.findMany({ select: { title: true, stateCategory: true }, orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.stateCategory)).toEqual(['backlog', 'started', null])
  })

  it('reads a parent column that is itself an @from or a @derived (a subquery inside a subquery)', async () => {
    const db: any = await createClient({ db: ':memory:', schema: TO_ONE })
    const sys = db.asSystem()
    await sys.event.create({ data: { capacity: 10 } })
    await sys.event.create({ data: { capacity: 5 } })
    for (const eventId of [1, 1, 1, 2]) await sys.enrollment.create({ data: { eventId } })
    await sys.shift.create({ data: { eventId: 1 } })
    await sys.shift.create({ data: { eventId: 2 } })
    const rows = await sys.shift.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.enrolled)).toEqual([3, 1])
    expect(rows.map((r: any) => r.big)).toEqual([true, false])
    expect(rows.map((r: any) => r.capacity)).toEqual([10, 5])
    const busy = await sys.shift.findMany({ where: { enrolled: { gt: 2 } } })
    expect(busy.map((r: any) => r.id)).toEqual([1])
  })
})

describe('@from(rel, column) is refused by name when it cannot resolve', () => {
  const schema = (field: string, extra = '') => `
model Parent { id Int @id
  label String
  secret String @guarded
  kids Kid[]
  ${extra}
}
model Kid { id Int @id
  parentId Int
  parent Parent @relation(fields: [parentId], references: [id])
  ${field}
}`
  const refusal = async (s: string) => {
    try { (await createClient({ db: ':memory:', schema: s }) as any).$close(); return '' }
    catch (e: any) { return String(e.message).replace(/\s+/g, ' ') }
  }

  it('accepts the legitimate spelling', async () => {
    expect(await refusal(schema('label String @from(parent, label)'))).toBe('')
  })
  it('names a first argument that is not a field here', async () => {
    expect(await refusal(schema('label String @from(nope, label)'))).toMatch(/'nope' is not a field on 'Kid'/)
  })
  it('names a first argument that is not a to-one relation', async () => {
    expect(await refusal(schema('label String @from(parentId, label)'))).toMatch(/not a to-one relation/)
  })
  it('names a column the parent lacks', async () => {
    expect(await refusal(schema('label String @from(parent, nope)'))).toMatch(/'nope' does not exist on 'Parent'/)
  })
  it('refuses a protected column and a wrong type', async () => {
    expect(await refusal(schema('s String @from(parent, secret)'))).toMatch(/@guarded/)
    expect(await refusal(schema('label Int @from(parent, label)'))).toMatch(/field type must be 'String'/)
  })
})
