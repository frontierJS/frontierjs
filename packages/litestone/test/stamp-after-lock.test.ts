// FJS-2153: `@default(now())` and `@updatedAt` are read from the client's clock
// AFTER the write holds the transaction lock, so a row that commits after
// another transaction carries a time no earlier than that transaction's own
// stamps. A 'received at' column can then be compared to a commit; before, the
// stamp was taken while the write still queued behind the lock.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Event {
  id         Int      @id @default(autoincrement())
  name       String   @default('x')
  receivedAt DateTime @default(now())
  touchedAt  DateTime @updatedAt
}
`

const tick = () => new Promise(r => setTimeout(r, 5))

// A transaction holds the lock open while a create from outside it queues, and
// the clock moves before the lock is released.
async function queuedCreate(create: (db: any) => Promise<any>) {
  let t = Date.parse('2026-01-01T00:00:00.000Z')
  const db = await createClient({ schema: SCHEMA, db: ':memory:', now: () => new Date(t) })
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const holder = db.$transaction(async () => { await gate })
  await tick()
  const pending = create(db)
  await tick()
  t += 100
  const releasedAt = new Date(t).toISOString()
  release()
  await holder
  return { row: await pending, releasedAt }
}

describe('generated clock stamps are taken under the lock (FJS-2153)', () => {
  it('create() stamps after the lock it waited on', async () => {
    const { row, releasedAt } = await queuedCreate(db => db.event.create({ data: {} }))
    expect(new Date(row.receivedAt).toISOString() >= releasedAt).toBe(true)
    expect(new Date(row.touchedAt).toISOString() >= releasedAt).toBe(true)
  })

  it('a stated value still wins', async () => {
    const stated = '2020-02-02T00:00:00.000Z'
    const { row } = await queuedCreate(db => db.event.create({ data: { receivedAt: stated } }))
    expect(new Date(row.receivedAt).toISOString()).toBe(stated)
  })
})

// FJS-2568: the single-statement upsert is one planned INSERT … ON CONFLICT, so
// its INSERT clock columns were stamped while it was planned and the statement
// ran later, under the lock.
describe('the single-statement upsert stamps under the lock too (FJS-2568)', () => {
  it('upsert() that inserts stamps after the lock it waited on', async () => {
    const { row, releasedAt } = await queuedCreate(db =>
      db.event.upsert({ where: { id: 1 }, create: { name: 'a' }, update: { name: 'b' } }))
    expect(new Date(row.receivedAt).toISOString() >= releasedAt).toBe(true)
    expect(new Date(row.touchedAt).toISOString() >= releasedAt).toBe(true)
  })

  it('a stated value still wins', async () => {
    const stated = '2020-02-02T00:00:00.000Z'
    const { row } = await queuedCreate(db =>
      db.event.upsert({ where: { id: 1 }, create: { name: 'a', receivedAt: stated }, update: { name: 'b' } }))
    expect(new Date(row.receivedAt).toISOString()).toBe(stated)
  })
})
