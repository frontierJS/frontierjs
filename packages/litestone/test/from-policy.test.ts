// A @from aggregate is read off the target's rows, so the target's row policy
// decides which rows it counts.
//
// The aggregate is a correlated subquery built once at startup and a `@@allow`
// binds auth per request, so `count:`/`sum:`/`max:`/`min:`/`exists:` answered
// over every row that exists — 2 kids where the caller can read 1 (found by
// Transit, 2026-10-03). `last:` was already repicked under the policy (FJS-224).
// The value is recomputed under the policy now, and naming it in a `where` or
// an `orderBy` is refused, since those run the startup SQL.
//
// Every case is paired with a system read, which must still see every row: a
// fix that zeroed every aggregate would satisfy a suite that only asked the
// narrow answer (`FJS-351`).

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Parent {
  id        Int     @id
  name      String
  kids      Kid[]
  lastKid   Kid?    @from(Kid, last: true)
  kidCount  Int     @from(Kid, count: true)
  kidSum    Int     @from(Kid, sum: score)
  maxKid    Int?    @from(Kid, max: id)
  minScore  Int?    @from(Kid, min: score)
  anyHigh   Boolean @from(Kid, exists: true, where: "score > 50")
  tags      Tag[]
  tagCount  Int     @from(Tag, count: true)
  @@allow(read, true)
}
model Kid {
  id       Int    @id
  parentId Int
  parent   Parent @relation(fields: [parentId], references: [id])
  owner    String
  score    Int
  @@allow(read, owner == auth().id)
}
model Tag {
  id       Int    @id
  parentId Int
  parent   Parent @relation(fields: [parentId], references: [id])
  @@gate(0)
}
`

async function seeded() {
  const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
  const sys = db.asSystem() as any
  await sys.parent.create({ data: { id: 1, name: 'p1' } })
  await sys.parent.create({ data: { id: 2, name: 'p2' } })
  await sys.kid.create({ data: { id: 1, parentId: 1, owner: 'u1', score: 10 } })
  await sys.kid.create({ data: { id: 2, parentId: 1, owner: 'u2', score: 90 } })
  await sys.kid.create({ data: { id: 3, parentId: 2, owner: 'u2', score: 5 } })
  await sys.tag.create({ data: { id: 1, parentId: 1 } })
  await sys.tag.create({ data: { id: 2, parentId: 1 } })
  const u1 = db.$setAuth({ id: 'u1' }) as any
  return { db, sys, u1 }
}

describe('@from aggregate under the target\'s row policy', () => {
  it('counts only the rows the caller can read', async () => {
    const { u1 } = await seeded()
    const p = await u1.parent.findFirst({ where: { id: 1 } })
    expect(p.lastKid?.id).toBe(1)
    expect(p.kidCount).toBe(1)
    expect(p.kidSum).toBe(10)
    expect(p.maxKid).toBe(1)
    expect(p.minScore).toBe(10)
    expect(p.anyHigh).toBe(false)
    // Tag declares no policy: its count is the startup SQL's, unchanged.
    expect(p.tagCount).toBe(2)
  })

  it('answers the empty aggregate for a parent with no readable rows', async () => {
    const { u1 } = await seeded()
    const p = await u1.parent.findFirst({ where: { id: 2 } })
    expect(p.kidCount).toBe(0)
    expect(p.kidSum).toBe(0)
    expect(p.maxKid).toBeNull()
    expect(p.minScore).toBeNull()
    expect(p.anyHigh).toBe(false)
  })

  it('narrows findMany, a select, and an include of the parent', async () => {
    const { u1 } = await seeded()
    const rows = await u1.parent.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.kidCount)).toEqual([1, 0])
    const sel = await u1.parent.findMany({ select: { name: true, kidCount: true }, orderBy: { id: 'asc' } })
    expect(sel).toEqual([{ name: 'p1', kidCount: 1 }, { name: 'p2', kidCount: 0 }])
    const tag = await u1.tag.findFirst({ where: { id: 1 }, include: { parent: true } })
    expect(tag.parent.kidCount).toBe(1)
    expect(tag.parent.maxKid).toBe(1)
  })

  it('answers over every row as system', async () => {
    const { sys } = await seeded()
    const p = await sys.parent.findFirst({ where: { id: 1 } })
    expect(p.lastKid?.id).toBe(2)
    expect(p.kidCount).toBe(2)
    expect(p.kidSum).toBe(100)
    expect(p.maxKid).toBe(2)
    expect(p.minScore).toBe(10)
    expect(p.anyHigh).toBe(true)
    expect(await sys.parent.count({ where: { kidCount: { gt: 1 } } })).toBe(1)
  })

  it('refuses a where or an orderBy naming a policied aggregate, and allows an unpolicied one', async () => {
    const { u1 } = await seeded()
    await expect(u1.parent.findMany({ where: { kidCount: { gt: 1 } } })).rejects.toThrow(/kidCount/)
    await expect(u1.parent.findMany({ where: { OR: [{ maxKid: 2 }, { id: 9 }] } })).rejects.toThrow(/maxKid/)
    await expect(u1.parent.findMany({ orderBy: { kidCount: 'desc' } })).rejects.toThrow(/kidCount/)
    const rows = await u1.parent.findMany({ where: { tagCount: { gt: 1 } }, orderBy: { tagCount: 'desc' } })
    expect(rows.map((r: any) => r.id)).toEqual([1])
  })

  it('refuses one named through a relation or inside an include', async () => {
    const { u1 } = await seeded()
    await expect(u1.tag.findMany({ where: { parent: { is: { kidCount: { gt: 1 } } } } })).rejects.toThrow(/kidCount/)
    await expect(u1.kid.findMany({ include: { parent: { where: { kidCount: 1 } } } })).rejects.toThrow(/kidCount/)
  })
})

describe('a @from field named through a relation', () => {
  it('filters on it as system, and on an unpolicied one as a caller', async () => {
    const { sys, u1 } = await seeded()
    const where = { parent: { is: { kidCount: { gt: 1 } } } }
    expect((await sys.tag.findMany({ where })).map((r: any) => r.id)).toEqual([1, 2])
    expect(await sys.tag.count({ where })).toBe(2)
    expect(await sys.tag.count({ where: { parent: { is: { kidCount: { gt: 2 } } } } })).toBe(0)
    expect(await u1.tag.count({ where: { parent: { is: { tagCount: { gt: 1 } } } } })).toBe(2)
  })

  it('correlates at every depth of a nested relation filter', async () => {
    const { sys } = await seeded()
    const where = { parent: { is: { tags: { some: { parent: { is: { kidCount: 2 } } } } } } }
    expect(await sys.tag.count({ where })).toBe(2)
    expect(await sys.kid.count({ where: { parent: { is: { kidCount: 1 } } } })).toBe(1)
    expect(await sys.kid.count({ where: { parent: { is: { kidCount: 2 } } } })).toBe(2)
  })
})

// ─── @from(rel, column) under the PARENT's row policy (FJS-1305) ──────────────
// The value is a column of a row the caller may not be allowed to read, so it
// is recomputed under the parent's policy after the read, as an aggregate is.

const TO_ONE_POLICY = `
model Room {
  id    Int    @id
  owner String
  label String
  size  Int
  full  Boolean @default(false)
  seats Seat[]
  @@allow(read, owner == auth().id)
}
model Seat {
  id        Int     @id
  roomId    Int
  room      Room    @relation(fields: [roomId], references: [id])
  roomLabel String  @from(room, label)
  roomFull  Boolean @from(room, full)
  @@allow(read, true)
}
`

describe('@from(rel, column) under the parent\'s row policy', () => {
  async function seeded() {
    const db  = await createClient({ schema: TO_ONE_POLICY, db: ':memory:' })
    const sys = db.asSystem() as any
    await sys.room.create({ data: { id: 1, owner: 'u1', label: 'mine', size: 3, full: true } })
    await sys.room.create({ data: { id: 2, owner: 'u2', label: 'theirs', size: 3 } })
    await sys.seat.create({ data: { id: 1, roomId: 1 } })
    await sys.seat.create({ data: { id: 2, roomId: 2 } })
    return { sys, u1: db.$setAuth({ id: 'u1' }) as any }
  }

  it('reads null where the parent is not the caller\'s to read, the value where it is', async () => {
    const { u1 } = await seeded()
    const rows = await u1.seat.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.roomLabel)).toEqual(['mine', null])
    expect(rows.map((r: any) => r.roomFull)).toEqual([true, null])
  })

  it('refuses naming it in a where while the parent\'s policy applies, and answers as system', async () => {
    const { sys, u1 } = await seeded()
    await expect(u1.seat.findMany({ where: { roomLabel: 'theirs' } })).rejects.toThrow(/roomLabel/)
    const all = await sys.seat.findMany({ orderBy: { id: 'asc' } })
    expect(all.map((r: any) => r.roomLabel)).toEqual(['mine', 'theirs'])
  })
})
