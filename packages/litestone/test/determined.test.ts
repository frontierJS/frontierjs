/**
 * determined.test.ts — a column a create policy pins to the caller crosses to
 * the client as `x-determined`, so a generated form offers no choice for it
 * (`FJS-1229`, `FJS-D492`).
 */

import { describe, test, expect } from 'bun:test'
import { createClient, generateJsonSchema } from '../src/index.js'

const HEAD = `
model User {
  id String @id
  @@auth
}
`

const model = async (body: string) => {
  const db = await createClient({ db: ':memory:', schema: HEAD + `
model Event {
  id     String @id
  name   String
  hostId String
  host   User @relation(fields: [hostId], references: [id])
  ${body}
}` })
  return (generateJsonSchema(db.$schema) as any).$defs.Event
}

describe('x-determined', () => {
  test('a create policy pinning a column to auth().id names it', async () => {
    const def = await model(`@@allow('create', hostId == auth().id)`)
    expect(def['x-determined']).toEqual({ hostId: 'auth().id' })
  })

  test('operand order and a top-level && conjunct do not matter', async () => {
    const def = await model(`@@allow('create', name != '' && auth().id == hostId)`)
    expect(def['x-determined']).toEqual({ hostId: 'auth().id' })
  })

  test('an allow that leaves the column free reopens the choice', async () => {
    const def = await model(`
      @@allow('create', hostId == auth().id)
      @@allow('create', name == 'open')`)
    expect(def['x-determined']).toBeUndefined()
  })

  test('a pin under || is not a pin', async () => {
    const def = await model(`@@allow('create', hostId == auth().id || name == 'open')`)
    expect(def['x-determined']).toBeUndefined()
  })

  test('a read policy on the column determines nothing', async () => {
    const def = await model(`@@allow('read', hostId == auth().id)`)
    expect(def['x-determined']).toBeUndefined()
  })
})

describe('x-pick-where', () => {
  // FJS-1672
  const withSchedule = async (body: string) => {
    const db = await createClient({ db: ':memory:', schema: HEAD + `
model Schedule {
  id     String @id
  hostId String
  host   User @relation(fields: [hostId], references: [id])
}
model Booking {
  id         String @id
  scheduleId String
  schedule   Schedule @relation(fields: [scheduleId], references: [id])
  ${body}
}` })
    return (generateJsonSchema(db.$schema) as any).$defs.Booking
  }

  test('a one-hop == auth() conjunct names the rows the picker may offer', async () => {
    const def = await withSchedule(`@@allow('create', schedule.hostId == auth().id)`)
    expect(def['x-pick-where']).toEqual({ scheduleId: { hostId: 'auth().id' } })
  })

  test('an allow that leaves the relation free reopens the choice', async () => {
    const def = await withSchedule(`
      @@allow('create', schedule.hostId == auth().id)
      @@allow('create', true)`)
    expect(def['x-pick-where']).toBeUndefined()
  })

  test('a pin under || is not a pin', async () => {
    const def = await withSchedule(`@@allow('create', schedule.hostId == auth().id || scheduleId == 'x')`)
    expect(def['x-pick-where']).toBeUndefined()
  })
})
