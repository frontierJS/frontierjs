// An include's orderBy, limit and offset are read on every relation kind (FJS-2692).
//
// `include: { areas: { orderBy: { position: 'desc' }, limit: 1 } }` answered
// every parent's areas ascending and uncapped: the where was read and the other
// two were accepted and dropped, so a caller trusted an order and a cap it never
// got. The window is PER PARENT -- an include is one batched query across every
// parent, and a cap on the batch would hand the first parent everything.
//
// `take` and `skip` are not Litestone's spelling at the top level and are not
// inside an include either.

import { describe, it, expect } from 'bun:test'
import { makeTestClient } from '../src/testing.js'

const SCHEMA = `
model Survey {
  id    Int    @id
  title String
  areas Area[]
  tags  Tag[]
  lead  Lead?
}

model Area {
  id       Int    @id
  surveyId Int
  survey   Survey @relation(fields: [surveyId], references: [id])
  position Int
  name     String
}

model Lead {
  id       Int     @id
  surveyId Int     @unique
  survey   Survey  @relation(fields: [surveyId], references: [id])
  rank     Int
}

model Tag {
  id      Int      @id
  name    String
  rank    Int
  surveys Survey[]
}
`

async function seeded() {
  const { db } = await makeTestClient(SCHEMA)
  await db.survey.create({ data: { id: 1, title: 's1' } })
  await db.survey.create({ data: { id: 2, title: 's2' } })
  // Insertion order is not position order, so ascending-by-rowid and a real sort differ.
  const areas: [number, number, number, string][] = [
    [1, 1, 2, 'b'], [2, 1, 3, 'c'], [3, 1, 1, 'a'],
    [4, 2, 5, 'e'], [5, 2, 4, 'd'],
  ]
  for (const [id, surveyId, position, name] of areas)
    await db.area.create({ data: { id, surveyId, position, name } })
  for (const [id, name, rank] of [[1, 'x', 2], [2, 'y', 3], [3, 'z', 1]] as const)
    await db.tag.create({ data: { id, name, rank, surveys: { connect: [{ id: 1 }, { id: 2 }] } } })
  return db
}

const names = (rows: any[]) => rows.map(r => r.name)

describe('hasMany include', () => {

  it('orderBy orders each parent\'s rows', async () => {
    const db   = await seeded()
    const rows = await db.survey.findMany({
      orderBy: { id: 'asc' },
      include: { areas: { orderBy: { position: 'desc' } } },
    })
    expect(names(rows[0].areas)).toEqual(['c', 'b', 'a'])
    expect(names(rows[1].areas)).toEqual(['e', 'd'])
  })

  it('limit caps each parent, not the batch', async () => {
    const db   = await seeded()
    const rows = await db.survey.findMany({
      orderBy: { id: 'asc' },
      include: { areas: { orderBy: { position: 'desc' }, limit: 1 } },
    })
    expect(names(rows[0].areas)).toEqual(['c'])
    expect(names(rows[1].areas)).toEqual(['e'])
  })

  it('offset skips within each parent', async () => {
    const db   = await seeded()
    const rows = await db.survey.findMany({
      orderBy: { id: 'asc' },
      include: { areas: { orderBy: { position: 'asc' }, offset: 1, limit: 1 } },
    })
    expect(names(rows[0].areas)).toEqual(['b'])
    expect(names(rows[1].areas)).toEqual(['e'])
  })

  it('composes with an explicit select', async () => {
    const db   = await seeded()
    const rows = await db.survey.findMany({
      orderBy: { id: 'asc' },
      include: { areas: { select: { name: true }, orderBy: { position: 'desc' }, limit: 2 } },
    })
    expect(rows[0].areas).toEqual([{ name: 'c' }, { name: 'b' }])
  })

  it('take and skip are refused by name, as at the top level', async () => {
    const db = await seeded()
    await expect(db.survey.findMany({ include: { areas: { take: 1 } } } as any))
      .rejects.toThrow(/'take' is not a Litestone option.*limit/)
    await expect(db.survey.findMany({ include: { areas: { skip: 1 } } } as any))
      .rejects.toThrow(/'skip' is not a Litestone option.*offset/)
  })

  it('a limit that is not a non-negative integer is refused', async () => {
    const db = await seeded()
    await expect(db.survey.findMany({ include: { areas: { limit: -1 } } } as any)).rejects.toThrow(/limit/)
    await expect(db.survey.findMany({ include: { areas: { offset: 'x' } } } as any)).rejects.toThrow(/offset/)
  })
})

describe('hasOne include', () => {
  it('limit and offset are refused where at most one row can come back', async () => {
    const db = await seeded()
    await expect(db.survey.findMany({ include: { lead: { limit: 1 } } } as any)).rejects.toThrow(/limit/)
  })
})

describe('belongsTo include', () => {
  it('orderBy and limit are refused where at most one row can come back', async () => {
    const db = await seeded()
    await expect(db.area.findMany({ include: { survey: { orderBy: { id: 'asc' } } } } as any))
      .rejects.toThrow(/orderBy/)
    await expect(db.area.findMany({ include: { survey: { limit: 1 } } } as any))
      .rejects.toThrow(/limit/)
  })
})

describe('manyToMany include', () => {
  it('orders and caps each parent', async () => {
    const db   = await seeded()
    const rows = await db.survey.findMany({
      orderBy: { id: 'asc' },
      include: { tags: { orderBy: { rank: 'desc' }, limit: 2 } },
    })
    expect(names(rows[0].tags)).toEqual(['y', 'x'])
    expect(names(rows[1].tags)).toEqual(['y', 'x'])
  })
})

describe('an order the include cannot honour', () => {
  it('a relation-hop orderBy is refused rather than dropped', async () => {
    const db = await seeded()
    await expect(db.survey.findMany({
      include: { areas: { orderBy: { survey: { title: 'asc' } } } },
    } as any)).rejects.toThrow(/orderBy/)
  })
})
