// An include through an implicit many-to-many answers the target's lifecycle
// the way every other read of that target does (FJS-2002).
//
// The m2m branch builds its own SQL through the join table, so nothing appends
// the soft-delete, template and window filters unless it does. Before it did,
// `message.findMany({ include: { tasks: true } })` returned a removed task while
// `where: { tasks: { none: {} } }` over the same rows said there was none.

import { test, expect } from 'bun:test'
import { makeTestClient } from '../src/testing.js'

const SCHEMA = `
model Message {
  id    Int    @id
  title String
  tasks Task[]
  holds Hold[]
  forms Form[]
}

model Task {
  id       Int       @id
  title    String
  deletedAt DateTime?
  messages Message[]
  @@softDelete
}

model Hold {
  id        Int       @id
  label     String
  expiresAt DateTime
  messages  Message[]
  @@expires(expiresAt)
}

model Form {
  id         Int       @id
  label      String
  isTemplate Boolean   @default(false)
  messages   Message[]
  @@hasTemplates
}
`

async function seeded() {
  const { db } = await makeTestClient(SCHEMA)
  await db.task.create({ data: { id: 1, title: 'live' } })
  await db.task.create({ data: { id: 2, title: 'removed' } })
  const past = new Date(Date.now() - 86_400_000).toISOString()
  const next = new Date(Date.now() + 86_400_000).toISOString()
  await db.hold.create({ data: { id: 1, label: 'in force', expiresAt: next } })
  await db.hold.create({ data: { id: 2, label: 'expired', expiresAt: next } })
  await db.form.create({ data: { id: 1, label: 'instance' } })
  await db.form.create({ data: { id: 2, label: 'template' } })
  await db.message.create({ data: {
    id: 1, title: 'm',
    tasks: { connect: [{ id: 1 }, { id: 2 }] },
    holds: { connect: [{ id: 1 }, { id: 2 }] },
    forms: { connect: [{ id: 1 }, { id: 2 }] },
  } })
  // A connect refuses a target out of view, so each one leaves view after it.
  await db.task.remove({ where: { id: 2 } })
  await db.hold.update({ where: { id: 2 }, data: { expiresAt: past } })
  await db.form.update({ where: { id: 2 }, data: { isTemplate: true } })
  return db
}

test('an m2m include leaves out the soft-removed target', async () => {
  const db = await seeded()
  const [m] = await db.message.findMany({ include: { tasks: true } }) as any[]
  expect(m.tasks.map((t: any) => t.title)).toEqual(['live'])
  db.$close()
})

test('an m2m include takes withDeleted and onlyDeleted', async () => {
  const db = await seeded()
  const [all]  = await db.message.findMany({ include: { tasks: { withDeleted: true } } }) as any[]
  expect(all.tasks.map((t: any) => t.title).sort()).toEqual(['live', 'removed'])
  const [gone] = await db.message.findMany({ include: { tasks: { onlyDeleted: true } } }) as any[]
  expect(gone.tasks.map((t: any) => t.title)).toEqual(['removed'])
  db.$close()
})

test('an m2m include leaves out the expired and the template target', async () => {
  const db = await seeded()
  const [m] = await db.message.findMany({ include: { holds: true, forms: true } }) as any[]
  expect(m.holds.map((h: any) => h.label)).toEqual(['in force'])
  expect(m.forms.map((f: any) => f.label)).toEqual(['instance'])
  db.$close()
})

test('an m2m _count counts what the include returns', async () => {
  const db = await seeded()
  const [m] = await db.message.findMany({
    include: { _count: { select: { tasks: true, holds: true, forms: true } } },
  }) as any[]
  expect(m._count).toEqual({ tasks: 1, holds: 1, forms: 1 })
  db.$close()
})

// FJS-2096: the count takes the relation's where, as the has-many count does.
test('an m2m _count takes its where, alone and beside the lifecycle', async () => {
  const { db } = await makeTestClient(`
model Message {
  id    Int    @id
  tasks Task[]
}

model Task {
  id        Int       @id
  title     String
  deletedAt DateTime?
  messages  Message[]
  @@softDelete
}
`)
  await db.task.create({ data: { id: 1, title: 'a' } })
  await db.task.create({ data: { id: 2, title: 'b' } })
  await db.task.create({ data: { id: 3, title: 'a' } })
  await db.message.create({ data: { id: 1, tasks: { connect: [{ id: 1 }, { id: 2 }, { id: 3 }] } } })
  const count = async (spec: any) => {
    const [m] = await db.message.findMany({ include: { _count: { select: spec } } }) as any[]
    return m._count
  }
  expect(await count({ tasks: { where: { title: 'a' } } })).toEqual({ tasks: 2 })
  expect(await count({ tasks: true, onlyA: { relation: 'tasks', where: { title: 'a' } } })).toEqual({ tasks: 3, onlyA: 2 })
  await db.task.remove({ where: { id: 3 } })
  expect(await count({ tasks: { where: { title: 'a' } } })).toEqual({ tasks: 1 })
  db.$close()
})
