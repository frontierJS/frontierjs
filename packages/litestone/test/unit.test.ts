// test/unit.test.ts
//
// `@unit` — what the number counts. The promise the tests exist to hold is a
// NEGATIVE one: declaring a unit changes no stored value and emits no DDL, so
// most of this asks a real database what it did and finds it did nothing. The
// positive half is that the symbol resolves to a dimension, which is what every
// reader downstream is given, and that a symbol resolving to nothing is refused
// rather than emitted.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateJsonSchema } from '../src/jsonschema.js'
import { generateDDL } from '../src/core/ddl.js'
import { checkRules } from '../src/core/advise.js'
import { MEASURE_UNITS, unitInfo, convertUnit, LENGTH_UNITS, BYTE_UNITS } from '@frontierjs/toolbelt/units'

const field = (decl: string) => parse(`model M {\n  id Int @id @default(autoincrement())\n  ${decl}\n}`)
const err   = (decl: string) => field(decl).errors.join(' | ')

describe('what may be declared', () => {
  test('every symbol the table holds parses on a numeric column', () => {
    for (const symbols of Object.values(MEASURE_UNITS))
      for (const s of symbols) {
        const r = field(`v Int @unit("${s}")`)
        expect({ s, valid: r.valid, errors: r.errors }).toEqual({ s, valid: true, errors: [] })
      }
  })

  test('a bare symbol and a quoted one are the same declaration', () => {
    const bare = field('v Int @unit(ms)').schema.models[0].fields[1].attributes
    const quot = field('v Int @unit("ms")').schema.models[0].fields[1].attributes
    expect(bare).toEqual(quot)
    expect(bare).toEqual([{ kind: 'unit', symbol: 'ms' }])
  })

  test('a symbol the table does not hold is refused, and the refusal lists what exists', () => {
    const msg = err('v Int @unit(furlong)')
    expect(msg).toContain('no such unit')
    // Every dimension is named, or a reader is told what is wrong and not what
    // is right — which is the half of a refusal that gets acted on.
    for (const d of Object.keys(MEASURE_UNITS)) expect(msg).toContain(d)
  })

  test('a wrong CASE is a wrong unit, and is answered with the one that was meant', () => {
    // MB is a megabyte and Mb a megabit in every tool a reader has used, so the
    // symbol is not folded — which makes naming the near miss the whole of the
    // help.
    expect(err('v Int @unit(MS)')).toContain("Did you mean 'ms'?")
    expect(err('v Int @unit(Kg)')).toContain("Did you mean 'kg'?")
  })

  test('a unit counts a number, so a non-numeric column is refused', () => {
    expect(err('v String @unit(kg)')).toContain('@unit requires an Int or Float field, got String')
    expect(err('v Boolean @unit(kg)')).toContain('got Boolean')
    expect(field('v Float @unit(kg)').valid).toBe(true)
  })

  test('an array is refused — the unit describes one value', () => {
    expect(err('v Int[] @unit(kg)')).toContain('cannot be an array')
  })

  test('@money already is a unit, so the pair is refused', () => {
    expect(err('v Int @money(USD) @unit(kg)')).toContain('a currency is already the unit')
  })

  test('@scale composes, because it says where the point sits and not what is counted', () => {
    expect(field('v Int @scale(3) @unit(kg)').valid).toBe(true)
  })

  test('a `type` block is graded too, because its fields reach the same schema', () => {
    // The trap this closes: `@scale`/`@money` are refused inside a `type`
    // outright, so their validation never had to look there. `@unit` is legal
    // there and IS emitted there, so a models-only walk would have left the
    // exact declaration this attribute exists to remove.
    const r = parse('type Box { w String @unit(kgg) }\nmodel M { id Int @id }')
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain("Type 'Box', field 'w'")
  })
})

describe('what it does to the database — nothing', () => {
  test('no CHECK, no column change: the DDL is what it would have been', () => {
    const withUnit = generateDDL(parse('model M { id Int @id\n v Int @unit(kg) }').schema)
    const without  = generateDDL(parse('model M { id Int @id\n v Int }').schema)
    expect(withUnit).toBe(without)
  })

  test('the value stored is the value sent, and it comes back unchanged', async () => {
    // The whole contract. A unit that converted would make the number a caller
    // reads different from the one they wrote, which is what `@money`'s minor
    // units deliberately do not do either.
    const db: any = await createClient({
      schema: 'model Job { id Int @id @default(autoincrement())\n timeout Int @unit(s)\n size Int @unit(MB)\n share Float @unit("%") }',
      db: ':memory:',
    })
    const row = await db.job.create({ data: { timeout: 300, size: 5, share: 12.5 } })
    expect({ timeout: row.timeout, size: row.size, share: row.share })
      .toEqual({ timeout: 300, size: 5, share: 12.5 })
    const back = await db.job.findUnique({ where: { id: row.id } })
    expect({ timeout: back.timeout, size: back.size, share: back.share })
      .toEqual({ timeout: 300, size: 5, share: 12.5 })
    await db.$close()
  })

  test('a fraction is not refused — a unit is not a scale', async () => {
    // `@scale` refuses one because the column holds minor units; `@unit(kg)` on
    // a Float says nothing about the point, so 1.5 kg is an ordinary value.
    const db: any = await createClient({
      schema: 'model M { id Int @id @default(autoincrement())\n w Float @unit(kg) }', db: ':memory:',
    })
    expect((await db.m.create({ data: { w: 1.5 } })).w).toBe(1.5)
    await db.$close()
  })
})

describe('what reaches a reader', () => {
  const schema = parse(
    'type Box { w Int @unit(cm) }\n' +
    'model M { id Int @id\n t Int @unit(s)\n r Int @unit(mo)\n box Json @type(Box) }').schema

  test('x-unit carries the symbol and the dimension', () => {
    const p: any = generateJsonSchema(schema, { mode: 'read' }).$defs.M.properties
    expect(p.t['x-unit']).toEqual({ symbol: 's', dimension: 'duration' })
  })

  test('a calendar unit reaches a reader like any other', () => {
    // `mo` has no conversion factor, and that is the KIT's refusal rather than
    // the schema's: the fact is expressible and only the arithmetic is not.
    const p: any = generateJsonSchema(schema, { mode: 'read' }).$defs.M.properties
    expect(p.r['x-unit']).toEqual({ symbol: 'mo', dimension: 'duration' })
  })

  test('a field inside a `type` carries it too', () => {
    const d: any = generateJsonSchema(schema, { mode: 'read' }).$defs.Box.properties
    expect(d.w['x-unit']).toEqual({ symbol: 'cm', dimension: 'length' })
  })

  test('it is on the write modes as well, since a form renders the box it writes', () => {
    for (const mode of ['create', 'update'] as const) {
      const p: any = generateJsonSchema(schema, { mode }).$defs.M.properties
      expect({ mode, unit: p.t['x-unit'] }).toEqual({ mode, unit: { symbol: 's', dimension: 'duration' } })
    }
  })
})

describe('the advice that makes the declaration takeable', () => {
  const hits = (src: string) =>
    checkRules(parse(`model M {\n  id Int @id\n  ${src}\n}`).schema)
      .filter(r => r.id === 'unit-in-the-column-name').map(r => r.field)

  test('a unit in the identifier is reported, and the message states the spelling', () => {
    const [found] = checkRules(parse('model M { id Int @id\n timeoutSeconds Int }').schema)
      .filter(r => r.id === 'unit-in-the-column-name')
    expect(found.field).toBe('timeoutSeconds')
    expect(found.message).toContain('timeout Int @unit(s)')
  })

  test('a column that already answers is not asked again', () => {
    expect(hits('durationMs Int @unit(ms)')).toEqual([])
    expect(hits('priceCents Int @money(USD)')).toEqual([])
  })

  test('the suffix must be a camelCase boundary, or ordinary English fires it', () => {
    // Each of these ENDS in a suffix's letters and is not a measurement. A rule
    // that fired on them would be one nobody reads.
    for (const decl of ['alarms Int', 'holidays Int', 'signedIn Int', 'items Int', 'admins Int'])
      expect({ decl, hits: hits(decl) }).toEqual({ decl, hits: [] })
  })

  test('a bare unit name is left alone — there would be no name left', () => {
    expect(hits('ms Int')).toEqual([])
  })

  test('only a number carries a unit', () => {
    expect(hits('workingHours String')).toEqual([])
    expect(hits('openHours Json')).toEqual([])
  })
})

describe('the table behind it', () => {
  test('length and information are READ from the kit, not restated beside it', () => {
    // One origin: a unit added to LENGTH is a unit a schema can declare, with
    // no second list to remember.
    expect(MEASURE_UNITS.length).toEqual([...LENGTH_UNITS])
    expect(MEASURE_UNITS.information).toEqual([...BYTE_UNITS])
  })

  test('a calendar unit carries no factor, and converting one is refused by name', () => {
    expect(unitInfo('mo')!.factor).toBeNull()
    expect(() => convertUnit(3, 'mo', 'd')).toThrow('calendar unit')
    expect(convertUnit(1500, 'ms', 's')).toBe(1.5)
  })

  test('converting across dimensions is refused rather than answered', () => {
    expect(() => convertUnit(1, 'kg', 'm')).toThrow('measures mass')
  })
})
