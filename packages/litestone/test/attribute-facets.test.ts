// Attribute legality asked of a FACET rather than of a pair.
//
// The parser refuses `@unique` over a randomly-encrypted column, with a good
// message, because somebody hit it. The same failure recurs one attribute over
// and was ruled nowhere — `@unique` over a field with no column vanishes, and
// `@@unique` over one takes the whole table down at boot with SQLite's words
// about something nobody wrote (`FJS-721`).
//
// The boundary that decides what lands here: this file is what cannot be
// EXPRESSED. What is merely legal and wrong is `advise.js`, whose own contract
// is that every rule in it parses — `@@fts` over an encrypted column is one of
// those and is deliberately not repeated here.
//
// So the questions are asked of the field once — what does the column
// physically HOLD — and each rule reads the answer. Which is what makes the
// next virtual kind, and the next encoding, arrive covered.
//
// Every refusal here is PAIRED with the acceptance of a schema one attribute
// different (`FJS-351`). A rule that refuses the correct spelling too proves
// nothing about the mistake.
import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'

const refuses = (schema: string, pattern: RegExp) => {
  const p = parse(schema)
  expect(p.valid).toBe(false)
  expect(p.errors.join('\n')).toMatch(pattern)
}
const accepts = (schema: string) => {
  const p = parse(schema)
  expect({ valid: p.valid, errors: p.errors }).toEqual({ valid: true, errors: [] })
}

describe('a constraint or an index over a field with no column', () => {
  const CASES = [
    { kind: '@computed', name: 'c', decl: `c String @computed`,                 unique: `c String @computed @unique` },
    { kind: '@derived',  name: 'b', decl: `q Int\n  b Boolean @derived(q > 5)`, unique: `q Int\n  b Boolean @derived(q > 5) @unique` },
  ] as const

  for (const { kind, name, decl, unique } of CASES) {
    it(`refuses @unique on ${kind}`, () => {
      refuses(`model D { id Int @id\n  ${unique} }`,
        new RegExp(`field '${name}': @unique cannot be enforced`))
    })
    it(`refuses @@unique over ${kind}`, () => {
      refuses(`model D { id Int @id\n  ${decl}\n  @@unique([${name}]) }`,
        new RegExp(`@@unique\\(\\[${name}\\]\\) cannot be built`))
    })
    it(`refuses @@index over ${kind}`, () => {
      refuses(`model D { id Int @id\n  ${decl}\n  @@index([${name}]) }`,
        new RegExp(`@@index\\(\\[${name}\\]\\) cannot be built`))
    })
  }

  it('refuses @unique on @from', () => {
    refuses(
      `model D { id Int @id\n  k K[]\n  n Int @from(K, count: true) @unique }\n` +
      `model K { id Int @id\n  dId Int?\n  d D? @relation(fields: [dId], references: [id]) }`,
      /field 'n': @unique cannot be enforced/)
  })

  it('accepts every one of them on @generated, which IS a column', () => {
    accepts(`model D { id Int @id\n  a String\n  g String @generated("a || 'x'") @unique }`)
    accepts(`model D { id Int @id\n  a String\n  g String @generated("a || 'x'")\n  @@unique([g]) }`)
    accepts(`model D { id Int @id\n  a String\n  g String @generated("a || 'x'")\n  @@index([g]) }`)
  })

  it('accepts an index over the column the value is computed FROM', () => {
    accepts(`model D { id Int @id\n  q Int\n  b Boolean @derived(q > 5)\n  @@index([q]) }`)
  })
})

describe('a default the column cannot hold', () => {
  // The column is an INTEGER of minor units, so the default is written into the
  // DDL as `12.99` and STRICT refuses the first row that takes it — at runtime,
  // naming no schema line.
  it('refuses a fractional @default on @scale, and says the minor-unit value', () => {
    refuses(`model D { id Int @id\n  p Int @scale(2) @default(12.99) }`, /@default\(12\.99\).*@default\(1299\)/s)
  })

  it('refuses a fractional @default on @money', () => {
    refuses(`model D { id Int @id\n  p Int @money(USD) @default(12.99) }`, /@default\(1299\)/)
  })

  it('states the value in the CURRENCY minor units, not in hundredths', () => {
    // The yen's minor unit is the yen and the dinar has three, so a suggestion
    // built from a fixed 100 is advice that is wrong by a hundred one way and a
    // thousand the other.
    refuses(`model D { id Int @id\n  p Int @money(JPY) @default(1.5) }`, /@default\(2\)/)
    refuses(`model D { id Int @id\n  p Int @money(KWD) @default(1.5) }`, /@default\(1500\)/)
    // A bare @money is the app's own currency and is not knowable here.
    refuses(`model D { id Int @id\n  p Int @money @default(12.99) }`, /@default\(1299\)/)
  })

  it('accepts the same default written in minor units', () => {
    accepts(`model D { id Int @id\n  p Int @scale(2) @default(1299) }`)
    accepts(`model D { id Int @id\n  p Int @money(USD) @default(1299) }`)
  })

  it('accepts a fractional default on a column that can hold one', () => {
    accepts(`model D { id Int @id\n  r Float @default(12.99) }`)
  })
})

describe('a relation across databases', () => {
  const two = (aDb: string, bDb: string) => `
database main  { path "a.db" }
database other { path "b.db" }
model A {
  id  Int  @id
  bId Int?
  b   B?   @relation(fields: [bId], references: [id])
  @@db(${aDb})
}
model B {
  id Int @id
  as A[]
  @@db(${bDb})
}
`
  it('refuses it — a foreign key names a table and a table lives in one file', () => {
    refuses(two('main', 'other'), /a relation cannot cross databases/)
  })

  it('accepts the same two models in one database', () => {
    accepts(two('main', 'main'))
  })

  it('says nothing about an @@external model, which litestone does not own', () => {
    accepts(`
database main  { path "a.db" }
database other { path "b.db" }
model A {
  id  Int  @id
  bId Int?
  b   B?   @relation(fields: [bId], references: [id])
  @@db(main)
}
model B {
  id Int @id
  as A[]
  @@db(other)
  @@external
}
`)
  })
})

describe('the corpus', () => {
  // 1,777 models nobody here wrote. A legality rule that over-refuses is worse
  // than the hole it closes, and this is the only body of input large enough to
  // say so.
  it('refuses none of it', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const dir = `${import.meta.dir}/fixtures/corpus`
    const files = [
      ...readdirSync(dir).filter(f => f.endsWith('.lite')).map(f => `${dir}/${f}`),
      `${import.meta.dir}/fixtures/scale/openmrp.lite`,
    ]
    const NEW_RULES = /cannot match|cannot be enforced — it is|cannot be built —|is not a value this column can hold|cannot cross databases/
    const hits: string[] = []
    for (const f of files) {
      const p = parse(readFileSync(f, 'utf8'))
      for (const e of p.errors ?? []) if (NEW_RULES.test(e)) hits.push(`${f.split('/').pop()}: ${e}`)
    }
    expect(hits).toEqual([])
  }, 60000)
})
