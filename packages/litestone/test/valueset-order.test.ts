// The order a picker offers — the third value-set axis (`FJS-D121`).
//
// What makes this axis worth separating from the other two is that it changes
// NOTHING legal, and every assertion here is arranged around that: a set with a
// declared order accepts and refuses exactly what the same set without one
// does. So the claims are:
//
//   1. **It is on the SET, not the binding.** Strength went the other way
//      (`FJS-D120`) because one list is legitimately enforced on one field and
//      offered on another; an order has no such case, and two fields bound to
//      one set read one order.
//   2. **Unstated emits nothing.** The default is the label column ascending
//      and is resolved on the client where the label is, so a set that says
//      nothing about order travels byte-identical to before — a schema is not
//      the place to restate a default that has one owner elsewhere.
//   3. **A column that cannot be sorted is refused BY NAME at parse.** An order
//      naming a column that is not there, or one whose order is not the values'
//      order, is otherwise a list that loads alphabetically forever with
//      nothing said — the exact silence this axis exists to end.
//
// Every refusal is paired with the legal shape one column away (`FJS-351`): a
// check that refused every `order` would satisfy a suite that only asked
// about the refusals.

import { describe, it, expect } from 'bun:test'
import { parse, createClient, generateJsonSchema } from '../src/index.js'

const BASE = `
model Swatch {
  id        Int      @id
  name      String   @unique
  sortOrder Int      @default(999)
  retired   Boolean  @default(false)
  secret    String?  @guarded
  blob      Json?
  note      String?  @transient
  @@label(name)
  @@scope(current, retired == false)
}
model Product {
  id     Int     @id
  color  String? @values(Swatches)
  accent String? @values(Swatches)
}
`

const ordered   = (clause: string) => BASE + `valueset Swatches { source Swatch order ${clause} }`
const unordered = BASE + `valueset Swatches { source Swatch }`

const bindOf = (src: string, field = 'color') =>
  generateJsonSchema(parse(src).schema).$defs.Product.properties[field]['x-values']

const errorsOf = (src: string) => {
  const p = parse(src)
  return p.valid ? '' : p.errors.join('\n')
}

describe('valueset order — what a picker offers first', () => {
  it('parses a bare column as ascending', () => {
    expect(parse(ordered('sortOrder')).schema.valuesets[0].order)
      .toEqual([{ field: 'sortOrder', dir: 'asc' }])
  })

  it('takes a direction per column, and a list of them', () => {
    expect(parse(ordered('sortOrder desc, name')).schema.valuesets[0].order)
      .toEqual([{ field: 'sortOrder', dir: 'desc' }, { field: 'name', dir: 'asc' }])
  })

  // The key after `order` is an IDENT too, so the loop has to stop on it. A
  // greedy read here would swallow `value` and report it as a missing column.
  it('stops at the next key rather than eating it', () => {
    const p = parse(BASE + `valueset Swatches { source Swatch order sortOrder value name }`)
    expect(p.valid).toBe(true)
    expect(p.schema.valuesets[0].order).toEqual([{ field: 'sortOrder', dir: 'asc' }])
    expect(p.schema.valuesets[0].valueField).toBe('name')
  })

  it('refuses the same column twice', () => {
    expect(errorsOf(ordered('name, name desc'))).toMatch(/order names 'name' twice/)
  })

  // ── it is on the set, so every binding reads one order ───────────────────
  it('reaches both bindings of one set, identically', () => {
    const src = ordered('sortOrder, name')
    expect(bindOf(src, 'color').order).toEqual(bindOf(src, 'accent').order)
    expect(bindOf(src, 'color').order).toEqual([
      { field: 'sortOrder', dir: 'asc' }, { field: 'name', dir: 'asc' },
    ])
  })

  it('emits nothing when the set states nothing', () => {
    const bind = bindOf(unordered)
    expect('order' in bind).toBe(false)
    // And the rest of the binding is unchanged, which is the half that says
    // the default lives elsewhere rather than having moved here.
    expect(bind.label).toBe('name')
  })

  // ── refusals, each beside the legal column one along ─────────────────────
  const refusals: Array<[string, string, RegExp]> = [
    ['a column that is not there', 'position',  /order 'position' is not a field on 'Swatch'/],
    ['@guarded',                   'secret',    /@guarded — the Data boundary refuses an orderBy naming it/],
    ['Json',                       'blob',      /its text sorts, its structure does not/],
    ['@transient',                 'note',      /never stored/],
  ]

  for (const [what, column, message] of refusals) {
    it(`refuses ${what}, by name`, () => {
      expect(errorsOf(ordered(column))).toMatch(message)
      // The control: the same declaration one column along is accepted, so the
      // refusal is about this column and not about `order` existing.
      expect(errorsOf(ordered('sortOrder'))).toBe('')
    })
  }

  // ── it is not membership ─────────────────────────────────────────────────
  //
  // The whole reason order was held out of `FJS-D120`. Two clients over two
  // schemas that differ only in the order clause accept and refuse the same
  // values, which is the property a suite can state and prose cannot.
  it('changes nothing about what the column may hold', async () => {
    const rows = { data: [
      { id: 1, name: 'Ochre', sortOrder: 5, retired: true },
      { id: 2, name: 'Clay',  sortOrder: 1 },
    ] }
    const scoped = (clause: string) =>
      BASE + `valueset Swatches { source Swatch value name scope current${clause} }`

    for (const schema of [scoped(''), scoped(' order sortOrder desc, name')]) {
      const db = await createClient({ schema, db: ':memory:' })
      await db.swatch.createMany(rows)
      await db.product.create({ data: { id: 1, color: 'Clay' } })
      await expect(db.product.create({ data: { id: 2, color: 'Ochre' } }))
        .rejects.toThrow(/Ochre is not in Swatches/)
      expect(await db.product.count()).toBe(1)
    }
  })
})

// ─── recent(Model.column, clock) — the head ─────────────────────────────────
//
// The learned half (`FJS-964`). It is not a sort key and the tests are arranged
// around that: the head is a SEPARATE bounded query, so what the schema carries
// is three names and the tail order beside it, not a fourth ordering column.
//
// Every refusal here is a way to be silently wrong rather than broken. Ranking
// a column that does not hold values of this set offers a list of things that
// are not in it; ranking by the wrong clock draws a plausible order. So both
// are refused at parse, and each is paired with the accepted shape.

const RANKED = `
model Person {
  id    Int    @id
  name  String @unique
  tasks Task[]
  @@label(name)
}
model Task {
  id         Int       @id
  title      String
  assigneeId Int?
  assignee   Person?   @relation(fields: [assigneeId], references: [id])
  createdAt  DateTime  @default(now())
}
model Thing {
  id     Int      @id
  who    Int?     @values(People)
  seenAt DateTime @default(now())
}
`

const ranked = (clause: string) => RANKED + `valueset People { source Person order ${clause} }`

const headOf = (src: string) => {
  const js = generateJsonSchema(parse(src).schema)
  return js.$defs.Thing.properties.who['x-values']
}

describe('recent(…) — the values this caller reached for last', () => {
  it('parses the model, the column and the clock', () => {
    expect(parse(ranked('recent(Task.assigneeId, createdAt)')).schema.valuesets[0].recent)
      .toEqual({ model: 'Task', field: 'assigneeId', clock: 'createdAt' })
  })

  // The head and the page are two different questions, so they are two fields
  // rather than one mixed ordering array — the client asks a rank for the first
  // and sends an `orderBy` for the second.
  it('leaves the columns after it as the order of the page beneath', () => {
    const vs = parse(ranked('recent(Task.assigneeId, createdAt), name desc')).schema.valuesets[0]
    expect(vs.recent.field).toBe('assigneeId')
    expect(vs.order).toEqual([{ field: 'name', dir: 'desc' }])
  })

  it('travels as three names beside the order', () => {
    const bind = headOf(ranked('recent(Task.assigneeId, createdAt), name'))
    expect(bind.recent).toEqual({ model: 'Task', field: 'assigneeId', clock: 'createdAt' })
    expect(bind.order).toEqual([{ field: 'name', dir: 'asc' }])
  })

  it('emits nothing when the set declares no head', () => {
    expect('recent' in headOf(ranked('name'))).toBe(false)
  })

  // A head cannot follow a sort key: it IS the first N entries, so a column
  // before it would be ordering a list the head sits on top of.
  it('refuses a head that is not first, and a second one', () => {
    expect(errorsOf(ranked('name, recent(Task.assigneeId, createdAt)'))).toMatch(/comes first and only once/)
    expect(errorsOf(ranked('recent(Task.assigneeId, createdAt), recent(Task.assigneeId, createdAt)')))
      .toMatch(/comes first and only once/)
  })

  const headRefusals: Array<[string, string, RegExp]> = [
    ['a model that is not there',  'recent(Nope.assigneeId, createdAt)', /'Nope' is not a model in this schema/],
    ['a column that is not there', 'recent(Task.nope, createdAt)',       /'nope' is not a field on 'Task'/],
    ['a column of other values',   'recent(Task.title, createdAt)',      /does not hold values of this set/],
    ['a clock that is not there',  'recent(Task.assigneeId, nope)',      /It declares: createdAt/],
    ['a clock that is not a date', 'recent(Task.assigneeId, title)',     /is String, and a head is ordered by WHEN/],
  ]

  for (const [what, clause, message] of headRefusals) {
    it(`refuses ${what}, by name`, () => {
      expect(errorsOf(ranked(clause))).toMatch(message)
      // The control: the legitimate shape one name away is accepted, so the
      // refusal is about the name and not about `recent(…)` existing.
      expect(errorsOf(ranked('recent(Task.assigneeId, createdAt)'))).toBe('')
    })
  }

  // The other way a column can legitimately hold this set's values: it is bound
  // to the set rather than being a foreign key to it. `Thing.who` is a String
  // column with `@values(People)` on it, which the FK check cannot see.
  it('accepts a column bound to the set, not only a foreign key', () => {
    expect(errorsOf(ranked('recent(Thing.who, seenAt)'))).toBe('')
  })

  // Nothing about a head is a rule: the same two schemas accept and refuse the
  // same values, which is what keeps this axis out of membership's way.
  it('changes nothing about what the column may hold', async () => {
    for (const clause of ['name', 'recent(Task.assigneeId, createdAt), name']) {
      const db = await createClient({ schema: ranked(clause), db: ':memory:' })
      await db.person.createMany({ data: [{ id: 1, name: 'Ada' }] })
      await db.thing.create({ data: { id: 1, who: 1 } })
      await expect(db.thing.create({ data: { id: 2, who: 99 } }))
        .rejects.toThrow(/99 is not in People/)
      expect(await db.thing.count()).toBe(1)
    }
  })
})
