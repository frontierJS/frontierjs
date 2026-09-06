// `@@label(field)` — which column identifies a row of this model to a person.
//
// FHIR calls it `display`. Without it, the only mechanism is a scan of eight
// hardcoded column names in the consumer, and every step down that ladder is a
// worse answer given silently (`FJS-392`).
//
// The substance here is the REFUSALS. A picker sorts by this column and
// searches it with `contains`, so a value the database cannot order and match
// is not a display column however readable it looks on screen — and a schema
// that accepts one produces a list of `1, 2, 3` with nothing saying why.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateJsonSchema } from '../src/jsonschema.js'

const errorsFor = (src: string) => {
  const r = parse(src)
  return r.valid ? [] : (r.errors as string[])
}

/** One model, one extra field, one @@label at it. */
const withField = (decl: string, target = decl.trim().split(/\s+/)[0]) => `model C {
  id Int @id
  ${decl}
  @@label(${target})
}`

describe('@@label parses', () => {
  it('names a field and lands on the model', () => {
    const r = parse(`model C {
  id Int @id
  fullName String
  @@label(fullName)
}`)
    expect(r.valid).toBe(true)
    expect(r.schema.models[0].attributes.find((a: any) => a.kind === 'labelField'))
      .toEqual({ kind: 'labelField', field: 'fullName' })
  })

  it('accepts the case it exists for — a @generated column', () => {
    // The consumer's scan skips every `readOnly` column, so a composed full
    // name is exactly what it cannot reach and what this attribute is for.
    expect(errorsFor(`model C {
  id Int @id
  firstName String
  lastName  String
  fullName  String? @generated(\`{firstName} {lastName}\`, stored)
  @@label(fullName)
}`)).toEqual([])
  })

  it('refuses a quoted field name, and says which attribute the caller wanted', () => {
    const r = parse(`model C {
  id Int @id
  name String
  @@label("name")
}`)
    expect(r.valid).toBe(false)
    expect(r.errors!.join('\n')).toContain('@@label takes a field NAME, not a string')
    // The near-miss is `@label("…")` on the field, which is a caption.
    expect(r.errors!.join('\n')).toContain('@label("…") on that field')
  })

  it('refuses a second one — a model has one display column', () => {
    expect(errorsFor(`model C {
  id Int @id
  name  String
  title String
  @@label(name) @@label(title)
}`).join('\n')).toContain('duplicate @@label')
  })

  it('refuses a field that is not there', () => {
    expect(errorsFor(`model C {
  id Int @id
  name String
  @@label(nope)
}`).join('\n')).toContain(`@@label references unknown field 'nope'`)
  })
})

describe('@@label refuses what a picker cannot render, by name', () => {
  const cases: Array<[string, string, string]> = [
    ['a relation',   `o O @relation(fields: [oId], references: [id])\n  oId Int`, 'is a relation'],
    ['an array',     `tags String[]`,          'is an array'],
    ['an enum',      `s S`,                    'is an enum'],
    ['a non-String', `num Int`,                'is Int, and a display column is String'],
    ['@computed',    `name String @computed`,  'is @computed'],
    ['@transient',   `name String @transient`, 'is @transient'],
    ['@guarded',     `name String @guarded`,   'is @guarded'],
    ['@encrypted',   `name String @encrypted`, 'is @encrypted'],
    ['@hashed',      `name String @hashed`,    'is @hashed'],
    ['@omit(all)',   `name String @omit(all)`, 'is @omit(all)'],
  ]

  for (const [what, decl, expected] of cases) {
    it(`refuses ${what}`, () => {
      const target = decl.trim().split(/\s+/)[0]
      const src = `enum S { a b }
model O { id Int @id }
${withField(decl, target)}`
      const errs = errorsFor(src).join('\n')
      expect(errs).toContain('@@label')
      expect(errs).toContain(expected)
    })
  }

  it('says how to fix the non-String case rather than only refusing it', () => {
    // A number IS sometimes what a person recognizes (an invoice number), so
    // the refusal names the route: compose a String from it.
    expect(errorsFor(withField('num Int')).join('\n')).toContain('@generated(`{num}`)')
  })

  it('allows @omit — which is lists-only, and a picker is not a list of rows', () => {
    expect(errorsFor(withField('name String @omit'))).toEqual([])
  })
})

describe('@@label reaches the client as x-label-field', () => {
  const parsed = parse(`model Customer {
  id Int @id
  firstName String
  lastName  String
  fullName  String? @generated(\`{firstName} {lastName}\`, stored)
  @@label(fullName)
}`)

  it('is on every mode — which column identifies a row does not depend on writing one', () => {
    for (const mode of ['create', 'update', 'full'] as const) {
      const s = generateJsonSchema(parsed.schema, { mode }) as any
      expect(s.$defs.Customer['x-label-field']).toBe('fullName')
    }
  })

  it('names a column that is NOT in the create-mode registry, and that is correct', () => {
    // A generated column is `full`-mode only. The consumer reads `row[shown]`
    // off a fetched row, so the name is all it needs — checking it against the
    // registry's own properties is what would break this.
    const create = generateJsonSchema(parsed.schema, { mode: 'create' }) as any
    expect('fullName' in create.$defs.Customer.properties).toBe(false)
    expect(create.$defs.Customer['x-label-field']).toBe('fullName')
  })

  it('is absent on a model that declared none', () => {
    const s = generateJsonSchema(parse(`model C { id Int @id  name String }`).schema) as any
    expect('x-label-field' in s.$defs.C).toBe(false)
  })

  it('is not x-labels — the two answer different questions', () => {
    // `x-labels` maps an enum member to its caption; this names a column.
    const s = generateJsonSchema(parse(`enum P { pro @label("Pro") }
model C {
  id Int @id
  name String
  plan P
  @@label(name)
}`).schema) as any
    expect(s.$defs.C['x-label-field']).toBe('name')
    expect(s.$defs.P['x-labels']).toEqual({ pro: 'Pro' })
  })
})
