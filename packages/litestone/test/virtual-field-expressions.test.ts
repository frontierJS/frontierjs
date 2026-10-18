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
// Each is refused by name before a query runs.
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

describe('a @derived naming a field with no column', () => {
  test('refuses one naming a @from field', async () => {
    await expect(build(schema('noAdults Boolean @derived(adults < 1)')))
      .rejects.toThrow(/Shift\.noAdults: 'adults' is @from/)
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
