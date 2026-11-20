// test/zoned-instant.test.ts
//
// FJS-D963 / FJS-D1434: `DateTime @zoned(date, time, zonePath)` is an instant
// litestone derives from a wall clock and the zone it is read in. It is
// written on create, refused from the app, recomputed on a write to either
// source, and a write to the zone recomputes every child through the relation
// in the same unit, with `@@exclude` graded over the new instants (FJS-3381).
// A wall clock in a spring-forward gap resolves to the later side.

import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'

const SCHEMA = `
scope person(employeeId)

model Site {
  id       Int     @id
  name     String
  timeZone String  @zone @default("UTC")
  shifts   Shift[]
}

model Shift {
  id         Int      @id
  employeeId Int
  siteId     Int
  site       Site     @relation(fields: [siteId], references: [id])
  onDate     String   @date
  startLocal String   @time
  endLocal   String   @time
  startsAt   DateTime @zoned(onDate, startLocal, site.timeZone)
  endsAt     DateTime @zoned(onDate, endLocal, site.timeZone)
  @@exclude(person, range: [startsAt, endsAt])
}
`

const errs = (src: string) => parse(src).errors.join('\n')

async function seed() {
  const { createClient } = await import('../src/index.js')
  const db = (await createClient({ db: ':memory:', schema: SCHEMA })) as any
  const sys = db.asSystem()
  const ny    = await sys.site.create({ data: { name: 'ny', timeZone: 'America/New_York' } })
  const tokyo = await sys.site.create({ data: { name: 'tokyo', timeZone: 'Asia/Tokyo' } })
  return { db, sys, ny, tokyo }
}
const refusal = (p: Promise<any>) => p.then(() => null, (e: any) => e)

describe('@zoned on a DateTime — parse (FJS-D1434)', () => {
  test('the three-argument form parses, sources first and the zone last', () => {
    const r = parse(SCHEMA)
    expect(r.errors).toEqual([])
    const shift = r.schema.models.find((m: any) => m.name === 'Shift')
    const at = shift.fields.find((f: any) => f.name === 'startsAt').attributes.find((a: any) => a.kind === 'zoned')
    expect(at.path).toEqual(['site', 'timeZone'])
    expect(at.sources).toEqual(['onDate', 'startLocal'])
  })

  test('a one-argument @zoned on a DateTime is refused by name', () => {
    expect(errs(SCHEMA.replace('@zoned(onDate, startLocal, site.timeZone)', '@zoned(site.timeZone)')))
      .toContain('@zoned(site.timeZone) on a DateTime names its wall clock')
  })

  test('the sources must be a String @date and a String @time on this model', () => {
    expect(errs(SCHEMA.replace('@zoned(onDate, startLocal, site.timeZone)', '@zoned(startLocal, onDate, site.timeZone)')))
      .toContain("'startLocal' must be a String @date")
    expect(errs(SCHEMA.replace('@zoned(onDate, startLocal, site.timeZone)', '@zoned(onDate, nope, site.timeZone)')))
      .toContain("no field 'nope' on this model")
  })

  test('a wall clock takes the one-argument form only', () => {
    expect(errs(SCHEMA.replace('onDate     String   @date', 'onDate     String   @date @zoned(onDate, startLocal, site.timeZone)')))
      .toContain('a String @date or @time takes one argument')
  })
})

describe('@zoned on a DateTime — the derived instant (FJS-3381)', () => {
  test('a create writes the instant from the wall clock and the parent’s zone', async () => {
    const { sys, ny } = await seed()
    const s = await sys.shift.create({ data: { employeeId: 1, siteId: ny.id, onDate: '2026-07-01', startLocal: '09:00', endLocal: '17:00' } })
    expect(s.startsAt).toBe('2026-07-01T13:00:00.000Z')
    expect(s.endsAt).toBe('2026-07-01T21:00:00.000Z')
  })

  test('a wall clock in the spring-forward gap resolves to the later side', async () => {
    const { sys, ny } = await seed()
    const s = await sys.shift.create({ data: { employeeId: 1, siteId: ny.id, onDate: '2026-03-08', startLocal: '02:30', endLocal: '04:00' } })
    expect(s.startsAt).toBe('2026-03-08T07:30:00.000Z')
  })

  test('an app write to the instant is refused by name, system included', async () => {
    const { sys, ny } = await seed()
    const e = await refusal(sys.shift.create({ data: {
      employeeId: 1, siteId: ny.id, onDate: '2026-07-01', startLocal: '09:00', endLocal: '17:00', startsAt: '2026-07-01T00:00:00.000Z' } }))
    expect(e?.name).toBe('ValidationError')
    expect(JSON.stringify(e?.errors ?? e?.message)).toContain('startsAt is @zoned(onDate, startLocal, site.timeZone)')
    const s = await sys.shift.create({ data: { employeeId: 1, siteId: ny.id, onDate: '2026-07-01', startLocal: '09:00', endLocal: '17:00' } })
    expect((await refusal(sys.shift.update({ where: { id: s.id }, data: { endsAt: '2026-07-02T00:00:00.000Z' } })))?.name).toBe('ValidationError')
  })

  test('a write to a wall clock, the day or the relation recomputes the instant', async () => {
    const { sys, ny, tokyo } = await seed()
    const s = await sys.shift.create({ data: { employeeId: 1, siteId: ny.id, onDate: '2026-07-01', startLocal: '09:00', endLocal: '17:00' } })
    expect((await sys.shift.update({ where: { id: s.id }, data: { startLocal: '10:00' } })).startsAt).toBe('2026-07-01T14:00:00.000Z')
    expect((await sys.shift.update({ where: { id: s.id }, data: { onDate: '2026-12-01' } })).startsAt).toBe('2026-12-01T15:00:00.000Z')
    const moved = await sys.shift.update({ where: { id: s.id }, data: { siteId: tokyo.id } })
    expect(moved.startsAt).toBe('2026-12-01T01:00:00.000Z')
    expect(moved.endsAt).toBe('2026-12-01T08:00:00.000Z')
  })

  test('a zone write recomputes every child through the relation', async () => {
    const { sys, tokyo } = await seed()
    const s = await sys.shift.create({ data: { employeeId: 1, siteId: tokyo.id, onDate: '2026-07-01', startLocal: '10:00', endLocal: '12:00' } })
    expect(s.startsAt).toBe('2026-07-01T01:00:00.000Z')
    await sys.site.update({ where: { id: tokyo.id }, data: { timeZone: 'Europe/London' } })
    const after = await sys.shift.findUnique({ where: { id: s.id } })
    expect(after.startsAt).toBe('2026-07-01T09:00:00.000Z')
    expect(after.endsAt).toBe('2026-07-01T11:00:00.000Z')
    await sys.site.updateMany({ where: { id: tokyo.id }, data: { timeZone: 'Asia/Tokyo' } })
    expect((await sys.shift.findUnique({ where: { id: s.id } })).startsAt).toBe('2026-07-01T01:00:00.000Z')
  })

  test('a zone write that moves a child onto another of its person’s shifts is refused, and nothing moves', async () => {
    const { sys, ny, tokyo } = await seed()
    await sys.shift.create({ data: { employeeId: 1, siteId: ny.id, onDate: '2026-07-01', startLocal: '09:00', endLocal: '17:00' } })
    const s = await sys.shift.create({ data: { employeeId: 1, siteId: tokyo.id, onDate: '2026-07-01', startLocal: '10:00', endLocal: '12:00' } })
    const e = await refusal(sys.site.update({ where: { id: tokyo.id }, data: { timeZone: 'America/Los_Angeles' } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect((await sys.site.findUnique({ where: { id: tokyo.id } })).timeZone).toBe('Asia/Tokyo')
    expect((await sys.shift.findUnique({ where: { id: s.id } })).startsAt).toBe('2026-07-01T01:00:00.000Z')
  })
})
