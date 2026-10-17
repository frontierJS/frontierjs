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
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'

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

// A relation field has no column; SQLite reads the quoted name as a string
// literal, so the index builds over a constant (`FJS-1177`).
describe('a constraint or an index over a relation field', () => {
  const PARENT = `model P { id Int @id\n  cs C[] }\n`
  const child = (attr: string) =>
    `${PARENT}model C { id Int @id\n  pId Int\n  other P @relation(fields: [pId], references: [id])\n  ${attr} }`

  it('refuses @@index and names the foreign key', () => {
    refuses(child('@@index([other])'), /@@index\(\[other\]\) cannot be built — 'other' is a relation.*foreign key instead: pId/)
  })
  it('refuses @@unique and names the foreign key', () => {
    refuses(child('@@unique([other])'), /@@unique\(\[other\]\) cannot be built — 'other' is a relation.*foreign key instead: pId/)
  })
  it('accepts the same index over the foreign key', () => {
    accepts(child('@@index([pId])'))
    accepts(child('@@unique([pId])'))
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
    // A per-row currency is not knowable here, so it keeps the two-place reading.
    refuses(`model D { id Int @id\n  p Int @money(field: c) @default(12.99)\n  c String }`, /@default\(1299\)/)
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

  // @@external says litestone does not create the table, not which file it is
  // in, so the foreign key still names a table SQLite resolves nowhere (`FJS-1460`).
  it('refuses it when the target is @@external', () => {
    refuses(`
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
`, /a relation cannot cross databases/)
  })

  it('refuses it when the owning side is @@external', () => {
    refuses(`
database main  { path "a.db" }
database other { path "b.db" }
model A {
  id  Int  @id
  bId Int?
  b   B?   @relation(fields: [bId], references: [id])
  @@db(main)
  @@external
}
model B {
  id Int @id
  as A[]
  @@db(other)
}
`, /a relation cannot cross databases/)
  })

  it('accepts an @@external target in the same database', () => {
    accepts(`
database main  { path "a.db" }
model A {
  id  Int  @id
  bId Int?
  b   B?   @relation(fields: [bId], references: [id])
}
model B {
  id Int @id
  as A[]
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

// FJS-2330 — a model with no stored column is `CREATE TABLE "post" ()`, which
// SQLite refuses with `near ")": syntax error` naming nothing the author wrote.
describe('a model with no stored column', () => {
  it('refuses a model holding only a model attribute', () => {
    refuses(`model Post {\n  @@gate(1.3.4.6)\n}`, /Model 'Post'.*no stored (field|column)/)
  })
  it('refuses a model whose only fields are @computed', () => {
    refuses(`model Post {\n  title String @computed\n}`, /Model 'Post'.*no stored (field|column)/)
  })
  it('refuses a model whose only fields are relations', () => {
    refuses(`model Comment {\n  id Int @id\n}\nmodel Post {\n  comments Comment[]\n}`, /Model 'Post'.*no stored (field|column)/)
  })
  it('accepts the same model with one stored field', () => {
    accepts(`model Post {\n  id Int @id\n  title String @computed\n  @@gate(1.3.4.6)\n}`)
  })
  it('accepts a model whose only stored field arrives by @@trait', () => {
    accepts(`trait Stamped {\n  title String\n}\nmodel Post {\n  @@trait(Stamped)\n}`)
  })
  it('accepts an @@external model, which has no DDL', () => {
    accepts(`model Post {\n  @@external\n}`)
  })
})

// FJS-2707 — a `@generated` expression is SQL over the row's COLUMNS, and a
// field with none is a name SQLite reads as a string literal: beside
// `sub Int @from(Line, sum: amount)`, `twice Int @generated("{sub} * 2")`
// built, and read 0 for every row.
describe('a @generated expression naming a field with no column', () => {
  const LINE = `model Line {\n  id Int @id\n  orderId Int\n  order Order @relation(fields: [orderId], references: [id])\n  amount Int\n}`
  const CASES = [
    { kind: '@from',      decl: `sub Int @from(Line, sum: amount)` },
    { kind: '@computed',  decl: `sub Int @computed` },
    { kind: '@derived',   decl: `q Int\n  sub Boolean @derived(q > 5)` },
    { kind: '@transient', decl: `sub Int? @transient` },
  ] as const

  for (const { kind, decl } of CASES) {
    it(`refuses one naming a ${kind} field`, () => {
      refuses(`model Order {\n  id Int @id\n  lines Line[]\n  ${decl}\n  twice Int @generated("{sub} * 2")\n}\n${LINE}`,
        /field 'twice': @generated references 'sub', which is not a stored column/)
    })
  }
  it('refuses one naming a relation field', () => {
    refuses(`model Order {\n  id Int @id\n  lines Line[]\n  n Int @generated("{lines}")\n}\n${LINE}`,
      /field 'n': @generated references 'lines', which is not a stored column/)
  })
  it('accepts one naming a stored field, and one naming another @generated', () => {
    accepts(`model Order {\n  id Int @id\n  sub Int\n  twice Int @generated("{sub} * 2")\n  quad Int @generated("{twice} * 2")\n}`)
  })
})

// FJS-2757 — a backtick template is the string it produces, so it compiles to
// `concat_ws` text. On an Int column that is text in an INTEGER STRICT column,
// and `amount Int @generated(`{quantity} * {unitPrice}`)` migrated with no
// warning. The quote that means an expression is the double quote.
describe('a @generated template on a column that is not a String', () => {
  const body = (decl: string) => `model QuoteLine {\n  id Int @id\n  quantity Int\n  unitPrice Int\n  ${decl}\n}`
  for (const type of ['Int', 'Float', 'Boolean', 'Int?']) {
    it(`refuses one on ${type}`, () => {
      refuses(body('amount ' + type + ' @generated(`{quantity} * {unitPrice}`)'),
        /field 'amount': a @generated template produces text, and 'amount' is /)
    })
  }
  it('accepts the template on a String, and the SQL form on an Int', () => {
    accepts(body('label String @generated(`{quantity} {unitPrice}`)'))
    accepts(body('label String? @generated(`{quantity} {unitPrice}`)'))
    accepts(body('amount Int @generated("{quantity} * {unitPrice}")'))
  })
})

// FJS-2768 — `{a}` names a FIELD and the column may be called something else:
// `a Int @map("a_col")` beside `twice Int @generated("{a} * 2")` emitted
// `"a" * 2`, a string literal to SQLite, and read 0.
describe('a @generated expression naming a @map field', () => {
  const run = (src: string, insert: string, read: string) => {
    const p = parse(src)
    expect({ valid: p.valid, errors: p.errors }).toEqual({ valid: true, errors: [] })
    const db = new Database(':memory:')
    db.exec(generateDDL(p.schema, { foreignKeys: false }))
    db.exec(insert)
    return db.query(read).get() as Record<string, unknown>
  }
  it('reads the column, not a string literal', () => {
    const row = run(`model T {\n  id Int @id\n  a Int @map("a_col")\n  twice Int @generated("{a} * 2")\n}`,
      `INSERT INTO t (id, a_col) VALUES (1, 3)`, `SELECT twice, a_col FROM t`)
    expect(row).toEqual({ twice: 6, a_col: 3 })
  })
  it('reads two mapped columns through a stored generated column', () => {
    const row = run(`model T {\n  id Int @id\n  a Int @map("a_col")\n  b Int @map("b_col")\n  sum Int @generated("{a} + {b}", stored)\n}`,
      `INSERT INTO t (id, a_col, b_col) VALUES (1, 3, 4)`, `SELECT sum FROM t`)
    expect(row).toEqual({ sum: 7 })
  })
})

// FJS-2141 — a bound on a scaled column compares the STORED integer, so
// `@scale(4) @lte(100)` caps a percentage at 0.01%. A bound under one whole
// unit is the reading nobody intends; the refusal names the stored figure.
describe('a bound under one whole unit of a scaled column', () => {
  it('refuses @lte(100) at @scale(4) and writes the minor-unit figure', () => {
    refuses(`model D { id Int @id\n  r Int @scale(4) @lte(100) }`, /@lte\(100\).*100 minor units = 0\.01 at 4 places.*@lte\(1000000\) for 100/s)
  })

  it('refuses each of the four bounds, and @money', () => {
    for (const w of ['gte', 'lte', 'gt', 'lt'])
      refuses(`model D { id Int @id\n  r Int @scale(2) @${w}(50) }`, new RegExp(`@${w}\\(50\\).*50 minor units = 0\\.5 at 2 places`, 's'))
    refuses(`model D { id Int @id\n  p Int @money(USD) @lte(5) }`, /@lte\(5\).*5 minor units = 0\.05 at 2 places.*@lte\(500\) for 5/s)
  })

  it('accepts zero, a whole unit or more, and a column with no places', () => {
    accepts(`model D { id Int @id\n  r Int @scale(4) @gt(0) @lte(1000000) }`)
    accepts(`model D { id Int @id\n  p Int @money(USD) @gte(0) }`)
    accepts(`model D { id Int @id\n  y Int @money(JPY) @gte(1) @lte(100) }`)
    accepts(`model D { id Int @id\n  n Int @lte(100) }`)
  })
})

describe('the message at the boundary of a scaled column', () => {
  it('says the bound is in minor units', async () => {
    const { validateField } = await import('../src/core/validate.js')
    const errs = validateField('r', 20000001, [{ kind: 'scale', places: 4 }, { kind: 'lte', value: 1000000 }])
    expect(errs[0].message).toBe('must be at most 1000000 minor units')
    expect(validateField('n', 101, [{ kind: 'lte', value: 100 }])[0].message).toBe('must be at most 100')
  })
})
