// identifying-keys.test.ts — which columns identify a row TO A PERSON.
//
// `@@label` answers it for one column and pickers already read it. Nothing
// answered it for a SET, so a generated table ranked its columns by the order
// they happen to sit in the file — presentation decided by an edit somebody
// made for an unrelated reason, invisibly.
//
// The whole design turns on the composite case, so the pairing below is not
// ceremony. Under row tenancy every business key leads with the tenant column
// (`@@unique([workspaceId, name])`), so a per-field boolean marks `sku` in a
// database-per-tenant app and NOTHING in a row-tenant one — and a ranking that
// finds no identifying column does not fail, it falls through to the next tier
// and looks like it worked. Every exclusion here is therefore asserted beside a
// column of the same model that must SURVIVE it, or a rule that dropped
// everything would satisfy each row on its own.
//
// ONLY MODELS THAT HAVE ONE CARRY THE KEY — absent is the ordinary answer, so
// the no-unique row is what keeps the emit honest.

import { test, expect, describe } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateJsonSchema } from '../src/jsonschema.js'

function defs(src: string) {
  const r = parse(src)
  if (!r.valid) throw new Error(r.errors!.map((e: any) => e.message ?? e).join('\n'))
  return generateJsonSchema(r.schema!, { mode: 'full' })!.$defs! as Record<string, any>
}

const identify = (src: string, model: string) => defs(src)[model]['x-identify']

describe('x-identify — a database-per-tenant shape', () => {
  const SRC = `
database main { path ":memory:" }

model Product {
  id       String @id @default(cuid())
  sku      String @unique
  name     String
  variants Variant[]
}

model Variant {
  id        String  @id @default(cuid())
  productId String
  product   Product @relation(fields: [productId], references: [id])
  color     String
  size      String
  @@unique([productId, color, size])
}

model Note {
  id   String @id @default(cuid())
  body String
}
`

  test('a single-column @unique identifies, and the plain column beside it does not', () => {
    expect(identify(SRC, 'Product')).toEqual(['sku'])
  })

  test('a model with no unique carries no key at all', () => {
    expect(defs(SRC).Note).not.toHaveProperty('x-identify')
  })

  test('the foreign key is subtracted and the rest of its tuple survives', () => {
    // Both halves in one assertion on purpose: dropping the whole tuple and
    // keeping the whole tuple each satisfy half of this and neither is right.
    expect(identify(SRC, 'Variant')).toEqual(['color', 'size'])
  })
})

describe('x-identify — a row-tenancy shape', () => {
  const SRC = `
database main { path ":memory:" }
tenancy { strategy row  column workspaceId  claim workspaceId }

model Workspace {
  id      String @id @default(cuid())
  slug    String @unique(global)
  secrets Secret[]
  volumes Volume[]
}

model Secret {
  id          String    @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  name        String
  token       String    @unique @guarded
  @@unique([workspaceId, name])
}

model Volume {
  id          String    @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  label       String
  @@unique([workspaceId, label])
}
`

  test('the tenant column leads the tuple and the name behind it is what identifies', () => {
    // The row the whole design exists for: a per-field boolean answers nothing
    // here, because `name` is unique only in company with `workspaceId`.
    expect(identify(SRC, 'Secret')).toEqual(['name'])
    expect(identify(SRC, 'Volume')).toEqual(['label'])
  })

  test('a protected unique is excluded, and the ordinary one on the same model is not', () => {
    // `token` is the unique most models have, so a rule that kept it would
    // answer *token* for half a schema.
    expect(identify(SRC, 'Secret')).not.toContain('token')
    expect(identify(SRC, 'Secret')).toContain('name')
  })

  test('a global unique is kept whole — it is unique across the installation on purpose', () => {
    expect(identify(SRC, 'Workspace')).toEqual(['slug'])
  })
})

describe('x-identify — the constraints that identify nothing', () => {
  const SRC = `
database main { path ":memory:" }

model Account {
  id        String  @id @default(cuid())
  handle    String  @unique
  legacyRef String? @unique @system
  email     String?
  isPrimary Boolean @default(false)
  ownerId   String?
  @@unique([email], where: isPrimary == true)
}

model Member {
  id       String  @id @default(cuid())
  code     String  @unique
  alias    String?
  region   String?
  @@unique([alias, region], nullsDistinct: true)
}
`

  test('a partial unique constrains only some rows, so it identifies none of them', () => {
    // Paired with `handle`: a rule that read no @@unique at all passes the
    // first half of this and fails the second.
    const keys = identify(SRC, 'Account')
    expect(keys).not.toContain('email')
    expect(keys).toContain('handle')
  })

  test('a @system unique is a handle the server assigned, not a name a reader knows', () => {
    expect(identify(SRC, 'Account')).not.toContain('legacyRef')
    expect(identify(SRC, 'Account')).toEqual(['handle'])
  })

  test('nullsDistinct says the tuple is merely unique WHEN PRESENT', () => {
    const keys = identify(SRC, 'Member')
    expect(keys).not.toContain('alias')
    expect(keys).not.toContain('region')
    expect(keys).toEqual(['code'])
  })
})
