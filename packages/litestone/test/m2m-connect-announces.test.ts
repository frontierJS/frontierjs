// A many-to-many connect, disconnect or set written through ONE side announces
// on the OTHER side's model too (FJS-2013).
//
// The join row is the only thing written, so the joined row's own columns never
// change and no event named it. A live list over `where: { tasks: { none: {} } }`
// holds the promoted message until a reload, since its own channel said nothing.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Message {
  id    Int    @id
  title String
  tasks Task[]
}

model Task {
  id       Int       @id
  title    String
  messages Message[]
}
`

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)))

type Ev = { event: string; model: string; operation?: string; scope?: string; result?: { id?: number } | null }

let db: any
let seen: Ev[]

beforeEach(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA })
  await db.message.create({ data: { id: 1, title: 'a' } })
  await db.message.create({ data: { id: 2, title: 'b' } })
  await db.task.create({ data: { id: 1, title: 't' } })
  seen = []
  db.$tapEvents((e: Ev) => { seen.push(e) })
})

const messageUpdates = () => seen.filter(e => e.model === 'Message' && e.event === 'update')

describe('m2m nested write announces the joined model', () => {
  test('connect', async () => {
    await db.task.update({ where: { id: 1 }, data: { messages: { connect: [{ id: 1 }, { id: 2 }] } } })
    await settle()
    expect(seen.some(e => e.model === 'Task' && e.event === 'update')).toBe(true)
    const m = messageUpdates()
    expect(m.map(e => e.result?.id).sort()).toEqual([1, 2])
    expect(m.every(e => e.scope === 'row')).toBe(true)
  })

  test('disconnect', async () => {
    await db.task.update({ where: { id: 1 }, data: { messages: { connect: [{ id: 1 }, { id: 2 }] } } })
    await settle()
    seen.length = 0
    await db.task.update({ where: { id: 1 }, data: { messages: { disconnect: { id: 1 } } } })
    await settle()
    expect(messageUpdates().map(e => e.result?.id)).toEqual([1])
  })

  test('set', async () => {
    await db.task.update({ where: { id: 1 }, data: { messages: { connect: [{ id: 1 }] } } })
    await settle()
    seen.length = 0
    await db.task.update({ where: { id: 1 }, data: { messages: { set: [{ id: 2 }] } } })
    await settle()
    // 1 left the relation, 2 joined it
    expect(messageUpdates().map(e => e.result?.id).sort()).toEqual([1, 2])
  })

  test('a connect that was already joined announces nothing on the joined model', async () => {
    await db.task.update({ where: { id: 1 }, data: { messages: { connect: [{ id: 1 }] } } })
    await settle()
    seen.length = 0
    await db.task.update({ where: { id: 1 }, data: { messages: { connect: [{ id: 1 }] } } })
    await settle()
    expect(messageUpdates()).toEqual([])
  })

  test('an event inside a rolled-back transaction is never delivered', async () => {
    await db.$transaction(async (tx: any) => {
      await tx.task.update({ where: { id: 1 }, data: { messages: { connect: [{ id: 1 }] } } })
      throw new Error('boom')
    }).catch(() => {})
    await settle()
    expect(messageUpdates()).toEqual([])
  })
})
