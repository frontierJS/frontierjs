// `@label` on an enum MEMBER — the human text for one code.
//
// The gap it closes: a member's own name was the only thing a picker could
// show, so an enum whose codes are `tier_1`/`tier_2` had nowhere to say what
// they mean, and `starter` rendered as `starter`. `@label` already existed on
// a FIELD and already meant exactly this (it emits `title`); this is the same
// attribute reaching the one other place it obviously belongs.
//
// Two rules this suite exists to hold.
//
// **A label and a doc comment stay two things.** A doc comment is captured per
// member already and becomes documentation — what the code MEANS, for a reader
// of the schema. A label is what a person sees in a picker. Fusing them gives
// one string doing both jobs badly, which is why the parser takes the label
// separately rather than promoting the comment.
//
// **The emission is additive.** `x-labels` sits beside `enum`, which stays a
// plain array of codes. The spec-compliant spelling is
// `oneOf: [{const, title}]`, and it was refused deliberately: the `enum` array
// is what three readers validate against, so changing its shape to carry
// presentation is three chances to break validation. An enum that labels
// nothing must emit exactly what it emitted before, and that is asserted.

import { describe, it, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { generateJsonSchema } from '../src/jsonschema.js'
import { generateDDL } from '../src/core/ddl.js'
import { createClient } from '../src/index.js'

const SCHEMA = `
enum Plan {
  starter    @label("Starter")
  pro        @label("Pro")
  enterprise
}

enum Bare {
  a
  b
}

model Account {
  id    Int     @id
  plan  Plan
  tags  Plan[]
}
`

const parsed = () => {
  const r = parse(SCHEMA)
  if (!r.valid) throw new Error(`fixture does not parse: ${r.errors.join('; ')}`)
  return r.schema
}

describe('@label on an enum member', () => {
  it('parses onto the member and leaves the code alone', () => {
    const plan = parsed().enums.find(e => e.name === 'Plan')!
    expect(plan.values.map(v => v.name)).toEqual(['starter', 'pro', 'enterprise'])
    expect(plan.values[0].label).toBe('Starter')
    // Stated by nobody, so absent rather than defaulted to its own name — a
    // reader has to be able to tell "call it this" from "nobody said".
    expect(plan.values[2].label).toBeUndefined()
  })

  it('emits x-labels beside the enum array, holding only the stated ones', () => {
    const def = generateJsonSchema(parsed()).$defs.Plan as Record<string, unknown>
    expect(def.enum).toEqual(['starter', 'pro', 'enterprise'])
    expect(def['x-labels']).toEqual({ starter: 'Starter', pro: 'Pro' })
  })

  it('leaves an unlabelled enum byte-identical to before', () => {
    const def = generateJsonSchema(parsed()).$defs.Bare
    expect(def).toEqual({ type: 'string', enum: ['a', 'b'], title: 'Bare' })
    expect('x-labels' in def).toBe(false)
  })

  it('carries the labels through inlineEnums, on a field and on an array', () => {
    // Inlining exists so a consumer need not resolve a $ref. A label map left
    // behind here is a picker showing codes or text depending on a flag it
    // never sees.
    const js    = generateJsonSchema(parsed(), { inlineEnums: true })
    const props = (js.$defs.Account as { properties: Record<string, any> }).properties

    expect(props.plan['x-labels']).toEqual({ starter: 'Starter', pro: 'Pro' })
    expect(props.tags.items['x-labels']).toEqual({ starter: 'Starter', pro: 'Pro' })
  })

  it('refuses any other attribute on a member, naming the member', () => {
    const r = parse('enum E {\n  a @unique\n}')
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/member 'a'/)
    expect(r.errors[0]).toMatch(/@unique is not allowed/)
  })

  it('refuses a duplicate label rather than letting the last one win', () => {
    const r = parse('enum E {\n  a @label("x") @label("y")\n}')
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/duplicate @label/)
  })
})

// ─── a quoted member ─────────────────────────────────────────────────────────

describe('an enum member may be a quoted string (`FJS-593`)', () => {
  // A closed set in the wild is usually written for a person to read. Measured
  // over seven published schemas, 283 Frappe Select fields declare a set `.lite`
  // could not express, and almost every one is blocked by a space and nothing
  // else — `On Hold`, `To Receive and Bill`, `Grand Total`.
  //
  // The stored value IS the string: no second name, nothing translates. That is
  // Postgres's answer; Prisma's `@map` is the other one and buys a code-name at
  // the price of a bidirectional layer on every read and write. `@label` is
  // already the display override, which is the third thing neither needs to be.
  const SRC = `model Order {
  id     Int @id @default(autoincrement())
  status S   @default("To Receive and Bill")
  @@transitions(status, complete: "To Receive and Bill" -> Completed)
}
enum S {
  Draft
  "To Receive and Bill"
  Completed
}
`

  test('it parses, and the member is just its string', () => {
    const r = parse(SRC)
    expect(r.errors).toEqual([])
    expect(r.schema.enums[0].values.map((v: any) => v.name))
      .toEqual(['Draft', 'To Receive and Bill', 'Completed'])
  })

  test('a quoted member that IS an identifier is the same member, not a second one', () => {
    // The reading FJS-564 gave the redundant array default: a language that
    // refuses its own behaviour spelled another way fails a port on a line that
    // means what the tree already does. So it parses — and collides.
    expect(parse('model M { id Int @id  s S }\nenum S { Draft "Draft" }').errors.join(' '))
      .toMatch(/duplicate member 'Draft'/)
    expect(parse('model M { id Int @id  s S }\nenum S { "Draft" Completed }').valid).toBe(true)
  })

  test('the empty string is not a member', () => {
    expect(parse('model M { id Int @id  s S }\nenum S { "" }').errors.join(' '))
      .toMatch(/may not be the empty string/)
  })

  test('the CHECK carries it, and an apostrophe is escaped rather than closing the literal', () => {
    const r = parse('model M { id Int @id @default(autoincrement())  s S }\nenum S { Draft "Don\'t ship" }')
    expect(r.errors).toEqual([])
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain(`CHECK ("s" IN ('Draft', 'Don''t ship'))`)

    // It has to EXECUTE, which is the whole reason the escape is there.
    const db = new Database(':memory:')
    for (const st of ddl.split(';').map(x => x.trim()).filter(Boolean)) db.run(st + ';')
    db.run(`INSERT INTO m (s) VALUES ('Don''t ship')`)
    expect(() => db.run(`INSERT INTO m (s) VALUES ('Nope')`)).toThrow(/CHECK constraint failed/)
    expect(db.query('SELECT s FROM m').all()).toEqual([{ s: "Don't ship" }])
  })

  test('a default, a transition and a write all name it the same way', async () => {
    const db = await createClient({ schema: SRC, db: ':memory:' })
    const row = await db.order.create({ data: {} })
    expect(row.status).toBe('To Receive and Bill')

    const moved = await db.order.update({ where: { id: row.id }, data: { status: 'Completed' } })
    expect(moved.status).toBe('Completed')

    await expect(db.order.create({ data: { status: 'Nope' } }))
      .rejects.toThrow(/must be one of: Draft, To Receive and Bill, Completed/)
  })

  test('the JSON Schema enumerates the strings, so a picker needs nothing taught', () => {
    const js: any = generateJsonSchema(parse(SRC).schema)
    expect(js.$defs.S.enum).toEqual(['Draft', 'To Receive and Bill', 'Completed'])
  })

  test('an UNNAMED move onto a quoted member is refused', () => {
    // Same reasoning as the boolean rule one step along: `-> refunded` reads as
    // `refund`, and a sentence does not name an action.
    const src = 'model O { id Int @id  s S\n  @@transitions(s, Draft -> "To Receive and Bill")\n}\nenum S { Draft "To Receive and Bill" }'
    expect(parse(src).errors.join(' ')).toMatch(/a move onto a quoted member must be named/)
  })
})
