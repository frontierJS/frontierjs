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

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateJsonSchema } from '../src/jsonschema.js'

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
