// A locked child travels with a parent's onDelete: Cascade (FJS-3120, FJS-D1281).
//
// `@@gate delete 9` reads "nothing may remove this row". SQLite's cascade ran
// past it, so deleting the parent removed every locked child and the gate was
// graded against the verb and not the effect. The parent delete is refused,
// as Restrict would, whenever the cascade would take a row of a model that
// grades LOCKED at delete. A parent with no such child row is still deletable.

import { describe, it, expect } from 'bun:test'
import { createClient, ForeignKeyError } from '../src/index.js'

const SCHEMA = `
model User {
  id   Int     @id
  role String?
  @@auth
}

model Incident {
  id      Int              @id
  title   String
  posts   IncidentUpdate[]
  notes   Note[]
  @@gate(0.4.4.4)
}

model IncidentUpdate {
  id         Int      @id
  incident   Incident @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  incidentId Int
  body       String
  @@gate(0.4.9.9)
}

model Note {
  id         Int      @id
  incident   Incident @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  incidentId Int
  body       String
  @@gate(0.4.4.4)
}
`

const USER = { id: 1, role: 'member' }

async function seeded() {
  const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
  const sys = db.asSystem()
  await sys.incident.create({ data: { id: 1, title: 'down' } })
  await sys.incident.create({ data: { id: 2, title: 'quiet' } })
  await sys.incidentUpdate.create({ data: { incidentId: 1, body: 'investigating' } })
  await sys.note.create({ data: { incidentId: 2, body: 'fyi' } })
  return { db, sys }
}

describe('a locked child blocks its parent delete (FJS-3120)', () => {
  it('delete is refused for a gated caller and the child survives', async () => {
    const { db, sys } = await seeded()
    const err = await db.$setAuth(USER).incident.delete({ where: { id: 1 } }).then(() => null, (e: any) => e)
    expect(err).toBeInstanceOf(ForeignKeyError)
    expect(err.message).toContain('IncidentUpdate')
    expect(await sys.incident.count()).toBe(2)
    expect(await sys.incidentUpdate.count()).toBe(1)
  })

  it('asSystem is refused too: 9 is not reachable by anyone', async () => {
    const { sys } = await seeded()
    const err = await sys.incident.delete({ where: { id: 1 } }).then(() => null, (e: any) => e)
    expect(err).toBeInstanceOf(ForeignKeyError)
    expect(await sys.incidentUpdate.count()).toBe(1)
  })

  it('deleteMany is refused and nothing is removed', async () => {
    const { db, sys } = await seeded()
    const err = await db.$setAuth(USER).incident.deleteMany({ where: {} }).then(() => null, (e: any) => e)
    expect(err).toBeInstanceOf(ForeignKeyError)
    expect(await sys.incident.count()).toBe(2)
  })

  it('remove on a parent with no locked child row still goes, cascading the open child', async () => {
    const { db, sys } = await seeded()
    await db.$setAuth(USER).incident.delete({ where: { id: 2 } })
    expect(await sys.incident.count()).toBe(1)
    expect(await sys.note.count()).toBe(0)
  })

  it('a parent that has no children is deletable', async () => {
    const { db, sys } = await seeded()
    await sys.incident.create({ data: { id: 3, title: 'empty' } })
    await db.$setAuth(USER).incident.delete({ where: { id: 3 } })
    expect(await sys.incident.count()).toBe(2)
  })
})
