// A nested `select` on an include through an implicit many-to-many narrows the
// target's columns the way it does on the has-many and belongsTo branches
// (FJS-2015). The m2m branch builds its own SELECT through the join table and
// answered `t.*` whatever the caller named.

import { test, expect } from 'bun:test'
import { makeTestClient } from '../src/testing.js'

const SCHEMA = `
model Message {
  id    Int    @id
  title String
  tasks Task[]
}

model Task {
  id       Int       @id
  title    String
  secret   String
  messages Message[]
}
`

async function seeded() {
  const { db } = await makeTestClient(SCHEMA)
  await db.task.create({ data: { id: 1, title: 'one', secret: 's1' } })
  await db.task.create({ data: { id: 2, title: 'two', secret: 's2' } })
  await db.message.create({ data: { id: 1, title: 'm', tasks: { connect: [{ id: 1 }, { id: 2 }] } } })
  return db
}

test('include: { tasks: { select: { id: true } } } answers ids alone', async () => {
  const db = await seeded()
  const m = await db.message.findUnique({ where: { id: 1 }, include: { tasks: { select: { id: true } } } })
  expect(m.tasks.map((t: any) => t).sort((a: any, b: any) => a.id - b.id)).toEqual([{ id: 1 }, { id: 2 }])
})

test('select: { tasks: { select: { title: true } } } answers the named column alone', async () => {
  const db = await seeded()
  const m = await db.message.findUnique({ where: { id: 1 }, select: { id: true, tasks: { select: { title: true } } } })
  expect(m.tasks.map((t: any) => t.title).sort()).toEqual(['one', 'two'])
  for (const t of m.tasks) expect(Object.keys(t)).toEqual(['title'])
})

test('the other end narrows too, and an include without a select still answers whole rows', async () => {
  const db = await seeded()
  const t = await db.task.findUnique({ where: { id: 1 }, include: { messages: { select: { id: true } } } })
  expect(t.messages).toEqual([{ id: 1 }])
  const whole = await db.message.findUnique({ where: { id: 1 }, include: { tasks: true } })
  expect(Object.keys(whole.tasks[0]).sort()).toEqual(['id', 'secret', 'title'])
})
