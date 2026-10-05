// `x-extensible` — which models take custom fields a workspace declares, and
// the column those fields live under (`FJS-D487`, `FJS-1388`).
//
// The keys themselves are per tenant and stay out of the shared schema; a
// client reads this to know it should ask the service for them. A fact, not a
// refusal: absent means the model declares none. Asserted as a PAIR over one
// schema, because a key that always fires and one that never does each pass a
// one-sided test.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateJsonSchema } from '../src/jsonschema.js'

const PAIR = `
  enum FieldKind { text number }
  model CustomField {
    id    Int    @id
    model String
    key   String
    type  FieldKind
    @@unique([model, key])
  }
  model Customer {
    id     Int    @id
    name   String
    fields Json   @default("{}")
    @@extensible(fields, declaredBy: CustomField)
  }
  model Tag {
    id   Int    @id
    name String
  }`

const defs = (mode?: 'create' | 'update' | 'full') =>
  (generateJsonSchema(parse(PAIR).schema, mode ? { mode } : undefined) as any).$defs

describe('x-extensible', () => {
  it('names the column on the model that declares it and on no other', () => {
    const d = defs()
    expect(d.Customer['x-extensible']).toBe('fields')
    expect('x-extensible' in d.Tag).toBe(false)
    expect('x-extensible' in d.CustomField).toBe(false)
  })

  it('is on every mode, since it does not depend on writing a row', () => {
    for (const mode of ['create', 'update', 'full'] as const)
      expect(defs(mode).Customer['x-extensible']).toBe('fields')
  })
})
