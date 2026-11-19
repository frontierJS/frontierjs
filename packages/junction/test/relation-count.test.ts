// test/relation-count.test.ts — `$count`, a relation count over the wire (FJS-2734, FJS-D945).
//
// Litestone answers `include: { _count: { select: { surveys: { where } } } }` as
// `row._count.surveys`, graded against the target's read policy. Without a wire
// spelling, "surveys in range per service area" was one aggregate per area.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../../litestone/src/index.js'
import { createApp }              from '../src/core/app.ts'
import { createService }          from '../src/core/service.ts'
import { request }                 from '../src/testing/index.ts'

const SCHEMA = `
  model Area {
    id      Int      @id
    name    String
    surveys Survey[]
    notes   Note[]
  }
  model Survey {
    id    Int    @id
    day   String
    areas Area[]
  }
  model Note {
    id     Int    @id
    body   String
    area   Area   @relation(fields: [areaId], references: [id])
    areaId Int
  }
`

async function mkApp() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as any
  const sys = db.asSystem()
  await sys.area.create({ data: { id: 1, name: 'north' } })
  await sys.area.create({ data: { id: 2, name: 'south' } })
  await sys.survey.create({ data: { id: 1, day: '2026-01-05', areas: { connect: [{ id: 1 }, { id: 2 }] } } })
  await sys.survey.create({ data: { id: 2, day: '2026-02-05', areas: { connect: [{ id: 1 }] } } })
  await sys.survey.create({ data: { id: 3, day: '2026-03-05', areas: { connect: [{ id: 1 }] } } })
  await sys.note.create({ data: { id: 1, body: 'x', areaId: 2 } })
  const app = createApp({ db: db as never })
  for (const [name, model] of [['areas', 'Area'], ['surveys', 'Survey'], ['notes', 'Note']])
    app.services.register(createService({ name, model, db: db as never } as never))
  await app._startForTest()
  return { app }
}

const countsOf = (body: any) =>
  Object.fromEntries((body.data ?? body).map((r: any) => [r.name, r._count]))

describe('$count over HTTP', () => {
  test('a bare name counts the relation', async () => {
    const { app } = await mkApp()
    const res = await request(app).get('/areas?$count=surveys,notes&$orderBy=id')
    expect(res.status).toBe(200)
    expect(countsOf(res.body)).toEqual({ north: { surveys: 3, notes: 0 }, south: { surveys: 1, notes: 1 } })
  })

  test('a JSON value filters the target', async () => {
    const { app } = await mkApp()
    const where = { day: { $gte: '2026-02-01' } }
    const res = await request(app).get(`/areas?$count=${encodeURIComponent(JSON.stringify({ surveys: { where } }))}`)
    expect(res.status).toBe(200)
    expect(countsOf(res.body)).toEqual({ north: { surveys: 2 }, south: { surveys: 0 } })
  })

  test('a structure on the query string filters the target', async () => {
    const { app } = await mkApp()
    const res = await request(app).get(`/areas?${encodeURIComponent('$count[surveys][where][day][$lt]')}=2026-02-01`)
    expect(res.status).toBe(200)
    expect(countsOf(res.body)).toEqual({ north: { surveys: 1 }, south: { surveys: 1 } })
  })

  test('sits beside $populate on one row', async () => {
    const { app } = await mkApp()
    const res = await request(app).get('/areas/2?$populate=notes&$count=surveys')
    expect(res.status).toBe(200)
    const row = res.body as any
    expect(row._count).toEqual({ surveys: 1 })
    expect(row.notes.map((n: any) => n.id)).toEqual([1])
  })

  test('a value outside the grammar is refused by name', async () => {
    const { app } = await mkApp()
    for (const bad of ['{"surveys":', encodeURIComponent('{"surveys":{"limit":2}}'), encodeURIComponent('{"surveys":7}')]) {
      const res = await request(app).get(`/areas?$count=${bad}`)
      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body)).toContain('$count')
    }
  })
})

describe('$count in process', () => {
  test('directives.count takes the structure', async () => {
    const { app } = await mkApp()
    const out = await app.service('areas').find({}, {
      directives: { count: { surveys: { where: { day: { $lt: '2026-03-01' } } } }, orderBy: 'id' },
    } as never) as any
    expect(countsOf(out)).toEqual({ north: { surveys: 2 }, south: { surveys: 1 } })
  })
})
