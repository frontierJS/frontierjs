// test/virtual-field-expressions.test.ts
//
// FJS-2778 — an expression compiled to SQL names COLUMNS, and a field with none
// (`@from`, `@computed`, `@derived`, `@transient`) is a name SQLite reads as a
// string literal. Beside `adults Int @from(Assignment, count: true)`:
//   - `@derived(adults < 1)` read false on a shift with no adults while
//     `where: { noAdults: true }` found it;
//   - `@@allow(update, adults > 0)` let `updateMany` and `count` through on
//     every row, since `'adults' > 0` is true;
//   - `@@allow(read, event.enrolled > 4)` built and answered every read
//     with a raw `no such column`, and `@@scope` the same at `$scope`;
//   - `@@check("adults >= 1")` parsed valid and died on the build.
// Each is refused by name before a query runs — except the @derived, which
// FJS-D1364 lets read the @from by splicing its subquery (the first describe).
import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const schema = (shift = '', event = '') => `
model Event {
  id       Int     @id
  title    String?
  shifts   Shift[]
  enrolled Int     @from(Shift, count: true)
  ${event}
}
model Shift {
  id          Int          @id
  eventId     Int
  event       Event        @relation(fields: [eventId], references: [id])
  assignments Assignment[]
  adults      Int          @from(Assignment, count: true)
  ${shift}
}
model Assignment {
  id      Int   @id
  shiftId Int
  shift   Shift @relation(fields: [shiftId], references: [id])
}`

const build = (s: string) => createClient({ db: ':memory:', schema: s })

// FJS-D1364: a @derived may name an @from aggregate. It splices that @from's
// subquery, so the read and the filter agree; under the target's read policy it
// is answered again from the recount, and the filter is refused as the @from's is.
describe('a @derived naming an @from', () => {
  const policied = (shift: string) => schema(`${shift}\n  @@allow(read, true)`, '@@allow(read, true)')
    .replace(/model Assignment \{([^}]*)\}/, (_, body) =>
      `model Assignment {${body}  ownerId String\n  @@allow(read, ownerId == auth().id)\n  @@allow(create, true)\n}`)
  const seeded = async (s: string) => {
    const db: any = await build(s)
    const sys = db.asSystem()
    await sys.event.create({ data: { id: 1 } })
    for (const id of [1, 2, 3]) await sys.shift.create({ data: { id, eventId: 1 } })
    for (const [id, shiftId, ownerId] of [[1, 1, 'u1'], [2, 2, 'u1'], [3, 2, 'u2']] as const)
      await sys.assignment.create({ data: { id, shiftId, ...(s.includes('ownerId') ? { ownerId } : {}) } })
    return db
  }
  const byId = (rows: any[], key: string) => Object.fromEntries(rows.map(r => [r.id, r[key]]))

  test('reads and filters the same answer', async () => {
    const db = await seeded(schema('short Boolean @derived(adults * 2 < 3)'))
    const sys = db.asSystem()
    expect(byId(await sys.shift.findMany(), 'short')).toEqual({ 1: true, 2: false, 3: true })
    expect((await sys.shift.findMany({ where: { short: true }, orderBy: { id: 'asc' } })).map((r: any) => r.id)).toEqual([1, 3])
    db.$close()
  })

  test('a caller the target policy narrows reads it from the recount, select or not', async () => {
    const db = await seeded(policied('short Boolean @derived(adults * 2 < 3)'))
    const u1 = db.$setAuth({ id: 'u1' })
    const rows = await u1.shift.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => [r.adults, r.short])).toEqual([[1, true], [1, true], [0, true]])
    expect(await u1.shift.findMany({ select: { short: true }, orderBy: { id: 'asc' } }))
      .toEqual([{ short: true }, { short: true }, { short: true }])
    db.$close()
  })

  test('that caller is refused the filter and the sort, as the @from is', async () => {
    const db = await seeded(policied('short Boolean @derived(adults * 2 < 3)'))
    const u1 = db.$setAuth({ id: 'u1' })
    await expect(u1.shift.findMany({ where: { short: true } })).rejects.toThrow(/"short" is @derived over an @from aggregate of Assignment/)
    await expect(u1.shift.findMany({ orderBy: { short: 'asc' } })).rejects.toThrow(/"short" is @derived over an @from/)
    db.$close()
  })

  test('an aggregate over it is refused, as one over an @from is', async () => {
    const db = await seeded(schema('short Boolean @derived(adults * 2 < 3)'))
    await expect(db.asSystem().shift.aggregate({ _count: { distinct: 'short' } })).rejects.toThrow(/it is @derived over an @from/)
    db.$close()
  })

  // The recompute is a second compilation of the same expression, so it is held
  // to the SQL: a policy that admits every row recounts what SQLite counted.
  test.each([
    'x Boolean @derived(adults * 2 < 3)',
    'x Boolean @derived(!(adults == 1))',
    'x Boolean @derived(adults != 2 && adults > 0)',
    'x Boolean @derived(adults in [0, 2])',
    'x Boolean @derived(top * adults > 1)',
    'x Boolean @derived(top * adults == null)',
    'x Boolean @derived(!(top * adults > 1))',
    'x Int @derived(adults > 1 ? adults * 10 : round(adults * 0.5))',
    'x Int @derived(top - adults)',
  ])('the recompute agrees with the SQL: %s', async (decl) => {
    const open = schema(`top Int?\n  ${decl}\n  @@allow(read, true)`, '@@allow(read, true)')
      .replace(/model Assignment \{([^}]*)\}/, (_, body) => `model Assignment {${body}  @@allow(read, true)\n}`)
    const db: any = await build(open)
    const sys = db.asSystem()
    await sys.event.create({ data: { id: 1 } })
    for (const [id, top] of [[1, 3], [2, null], [3, 1]] as const) await sys.shift.create({ data: { id, eventId: 1, top } })
    for (const [id, shiftId] of [[1, 1], [2, 2], [3, 2]] as const) await sys.assignment.create({ data: { id, shiftId } })
    const sql = byId(await sys.shift.findMany(), 'x')
    expect(byId(await db.$setAuth({ id: 'u1' }).shift.findMany(), 'x')).toEqual(sql)
    db.$close()
  })

  test('refuses an @from that picks a row, and a to-one @from that reads one', async () => {
    await expect(build(schema('latest Assignment? @from(Assignment, last: true)\n  x Boolean @derived(latest == null)')))
      .rejects.toThrow(/Shift\.x: 'latest' is @from\(…, first\/last\) — a row of another model/)
    await expect(build(schema('few Boolean @derived(adults < 2)', '').replace(
      'model Assignment {', 'model Note {\n  id Int @id\n  shiftId Int\n  shift Shift @relation(fields: [shiftId], references: [id])\n  few Boolean @from(shift, few)\n}\nmodel Assignment {')
      .replace('  assignments Assignment[]', '  assignments Assignment[]\n  notes Note[]')))
      .rejects.toThrow(/Note\.few: @from\(shift, few\) reads a @derived over an @from on Shift/)
  })
  test('refuses one naming a relation field', async () => {
    await expect(build(schema('none Boolean @derived(assignments == null)')))
      .rejects.toThrow(/Shift\.none: 'assignments' is not a stored column/)
  })
})

describe('a policy naming a field with no column', () => {
  test('refuses @@allow naming a @from on its own model', async () => {
    await expect(build(schema(`@@allow(update, adults > 0)`)))
      .rejects.toThrow(/Shift: 'adults' is @from, so there is no column to compare — in @@allow\/@@deny/)
  })
  test('refuses @@allow naming a @from across a hop', async () => {
    await expect(build(schema(`@@allow(read, event.enrolled > 4)`)))
      .rejects.toThrow(/Shift: 'event\.enrolled' is @from on Event, so there is no column to correlate on/)
  })
  test('refuses @@scope naming a @from across a hop', async () => {
    await expect(build(schema(`@@scope(busy, event.enrolled > 4)`)))
      .rejects.toThrow(/'event\.enrolled' is @from on Event.*@@scope\(busy/)
  })
  test('accepts a policy over stored columns, here and across the hop', async () => {
    const db: any = await build(schema(`@@allow(read, eventId > 0 && event.title != null)`))
    db.$close()
  })
})

describe('a @@check naming a field with no column', () => {
  test('refuses one naming a @from field, by model and check', () => {
    const r = parse(schema(`@@check("adults >= 1")`))
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/Model 'Shift': @@check\("adults >= 1"\) names 'adults', which is not a stored column/)
  })
  test('refuses one naming a relation path, by the path and with the cure', () => {
    const r = parse(`
model Event { id Int @id }
model Shift { id Int @id
  eventId Int
  event Event @relation(fields: [eventId], references: [id])
  @@check("event.id = eventId && 'event.x' != ''") }`)
    expect(r.valid).toBe(false)
    const msg = r.errors.join('\n')
    expect(msg).toMatch(/names 'event\.id', a path through the relation 'event'.*composite @relation/)
    expect(msg).not.toMatch(/names 'event\.x'/)
    expect(msg).not.toMatch(/names 'event', which is not a stored column/)
  })
  test('refuses a field @check naming one', () => {
    const r = parse(schema(`n Int @check("n <= adults")`))
    expect(r.errors.join('\n')).toMatch(/Model 'Shift', field 'n': @check\("n <= adults"\) names 'adults'/)
  })
  test('accepts one over stored columns, and a quoted word that names one', () => {
    expect(parse(schema(`n Int\n  @@check("n >= 0 and eventId > 0")`)).valid).toBe(true)
    expect(parse(schema(`label String @check("label != 'adults'")`)).valid).toBe(true)
  })
})
