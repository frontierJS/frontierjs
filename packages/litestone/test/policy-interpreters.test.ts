// One predicate, two interpreters, and a real oracle between them.
//
// `read`/`update`/`delete` compile the policy AST to a WHERE; `create` and the
// post-update check evaluate the same AST in JS. Nothing holds the two together
// but testing — the file's own comments log three prior drifts, and `FJS-195`
// is the canonical shape: a row that create allows and read then hides.
//
// So the grid is not "does each half handle this node type". It is: put the
// SAME predicate over the SAME rows and ask both. If the payload IS the row,
// the two must agree about it. A disagreement here is a defect in one of them
// and neither can be right by restating the other.
//
// A cell known to disagree is asserted STILL BROKEN with its id, the way
// `matrix.test.ts` does it: fixing it turns this red and says to promote the
// cell, so a fix cannot leave the grid stale.
import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

type Row = Record<string, unknown>

/** Which rows a principal may READ (SQL), and which they may CREATE (JS). */
async function verdicts(schema: string, rows: Row[], principal: unknown, opts: Record<string, unknown> = {}) {
  const db  = await createClient({ schema, db: ':memory:', ...opts })
  const sys = db.asSystem()
  for (const r of rows) await sys.doc.create({ data: r })

  const scoped   = db.$setAuth(principal)
  const readable = new Set((await scoped.doc.findMany()).map((x: any) => x.id))

  const creatable = new Set<string>()
  for (const r of rows) {
    try { await scoped.doc.create({ data: { ...r, id: `${r.id}-c` } }); creatable.add(r.id as string) }
    catch (e: any) { if (e.constructor.name !== 'AccessDeniedError') throw e }
  }
  db.$close()
  return { readable, creatable }
}

/** The two halves agree about every row. */
async function agree(schema: string, rows: Row[], principal: unknown, opts?: Record<string, unknown>) {
  const { readable, creatable } = await verdicts(schema, rows, principal, opts)
  const disagreed = rows.filter(r => readable.has(r.id as string) !== creatable.has(r.id as string))
  return disagreed.map(r => r.id)
}

const DOC = (expr: string, cols = '') => `
model Doc {
  id        String  @id
  ownerId   String?
  qty       Int?
  status    String?
  flag      Boolean?
  editorIds String[]
  openUntil DateTime?
  ${cols}
  @@allow('read',   ${expr})
  @@allow('create', ${expr})
}
`

const ROWS: Row[] = [
  { id: 'r1', ownerId: 'u1', qty: 9,    status: 'published', flag: true,  editorIds: ['u1'] },
  { id: 'r2', ownerId: 'u2', qty: 1,    status: 'draft',     flag: false, editorIds: [] },
  { id: 'r3', ownerId: null, qty: null, status: null,        flag: null,  editorIds: ['u2'] },
  { id: 'r4', ownerId: 'u1', qty: 5,    status: 'review',    flag: false, editorIds: [] },
  { id: 'r5', ownerId: 'u2', qty: 9,    status: 'published', flag: true,  editorIds: ['u1', 'u3'] },
]

const PRINCIPALS = [
  { label: 'member',   p: { id: 'u1', role: 'member', teamIds: ['u1', 'u2'] } },
  { label: 'admin',    p: { id: 'u9', role: 'admin',  teamIds: [] } },
  { label: 'noclaims', p: { id: 'u1' } },
]

// One row per expression FORM the policy language can produce. Adding a form to
// the parser means adding it here, or the two compilers can take it in
// different directions with nothing failing.
const FORMS = [
  // comparison — both operand orders, both column types, every operator
  `ownerId == auth().id`,
  `auth().id == ownerId`,
  `qty == 5`, `qty != 5`, `qty > 5`, `qty >= 5`, `qty < 5`, `qty <= 5`,
  `status == 'published'`,
  `status != 'draft'`,
  // presence — the language's own spelling of IS NULL, on both sides
  `ownerId == null`,
  `ownerId != null`,
  `auth() != null`,
  `auth() == null`,
  `auth().role == 'admin'`,
  // a Boolean column, which SQLite stores as 0/1
  `flag == true`,
  `flag != true`,
  // logic, including a NOT over a comparison that is UNKNOWN for some rows
  `qty > 5 && status == 'published'`,
  `qty > 5 || status == 'published'`,
  `!(qty > 5)`,
  `!(status == 'draft')`,
  `ownerId == auth().id || status == 'published'`,
  `(qty > 5 || qty < 2) && status == 'published'`,
  // ternary
  `auth().role == 'admin' ? true : ownerId == auth().id`,
  `qty > 5 ? status == 'published' : status == 'draft'`,
  // membership, all three shapes of the right operand
  `status in ['published', 'review']`,
  `qty in [1, 5, 9]`,
  `ownerId in auth().teamIds`,
  `auth().id in editorIds`,
]

describe('one predicate, two interpreters', () => {
  for (const expr of FORMS) {
    it(`agrees about every row: ${expr}`, async () => {
      for (const { label, p } of PRINCIPALS) {
        const disagreed = await agree(DOC(expr), ROWS, p, { claims: ['teamIds'] })
        expect({ form: expr, principal: label, disagreed }).toEqual({ form: expr, principal: label, disagreed: [] })
      }
    }, 20000)
  }

  it('agrees about the clock', async () => {
    const rows = [
      { id: 'past',   openUntil: new Date(Date.now() - 86_400_000).toISOString() },
      { id: 'future', openUntil: new Date(Date.now() + 86_400_000).toISOString() },
      { id: 'none',   openUntil: null },
    ]
    expect(await agree(DOC(`openUntil > now()`), rows, { id: 'u1' })).toEqual([])
  })

  it('agrees through a check() delegation, in both directions', async () => {
    const schema = `
model Team {
  id      String  @id
  ownerId String?
  @@allow('read',   ownerId == auth().id)
  @@allow('create', ownerId == auth().id)
}
model Doc {
  id     String @id
  teamId String?
  team   Team?  @relation(fields: [teamId], references: [id])
  @@allow('read',   check(team))
  @@allow('create', check(team))
}
`
    const db  = await createClient({ schema, db: ':memory:' })
    const sys = db.asSystem()
    for (const t of [{ id: 't1', ownerId: 'u1' }, { id: 't2', ownerId: 'u2' }]) await sys.team.create({ data: t })
    const rows = [{ id: 'r1', teamId: 't1' }, { id: 'r2', teamId: 't2' }, { id: 'r3', teamId: null }]
    for (const r of rows) await sys.doc.create({ data: r })

    for (const who of ['u1', 'u2']) {
      const scoped   = db.$setAuth({ id: who })
      const readable = new Set((await scoped.doc.findMany()).map((x: any) => x.id))
      for (const r of rows) {
        let created = false
        try { await scoped.doc.create({ data: { ...r, id: `${r.id}-${who}` } }); created = true }
        catch (e: any) { if (e.constructor.name !== 'AccessDeniedError') throw e }
        expect({ who, row: r.id, read: readable.has(r.id), created })
          .toEqual({ who, row: r.id, read: readable.has(r.id), created: readable.has(r.id) })
      }
    }
    db.$close()
  })

  it('agrees with a @@deny standing beside the @@allow', async () => {
    const schema = `
model Doc {
  id      String @id
  status  String?
  ownerId String?
  @@allow('read',   ownerId == auth().id)
  @@allow('create', ownerId == auth().id)
  @@deny('read',    status == 'locked')
  @@deny('create',  status == 'locked')
}
`
    const rows = [
      { id: 'r1', ownerId: 'u1', status: 'open' },
      { id: 'r2', ownerId: 'u1', status: 'locked' },
      { id: 'r3', ownerId: 'u1', status: null },
    ]
    const { readable, creatable } = await verdicts(schema, rows, { id: 'u1' })
    // Named rather than merely equal: a deny that fires on UNKNOWN is the
    // FJS-668 rule, and asserting only that the two halves agree would pass if
    // both went the other way.
    expect([...readable].sort()).toEqual(['r1'])
    expect([...creatable].sort()).toEqual(['r1'])
  })
})

describe("SQLite's affinity, which JS `===` does not have", () => {
  // `FJS-713`. SQLite applies the COLUMN's affinity to the other operand and
  // then orders by storage class; `===` does neither. Measured across column
  // type × operator × operand, 54 of 594 cells disagreed — in both directions,
  // on every operator — so the live case is not one type pairing but the whole
  // comparison surface. The named one is the framework's own: a
  // `SessionContext` carries `userId` as TEXT, so every junction principal
  // meets an `Int` key this way.
  //
  // Asserted by VALUE and not merely by agreement: two halves that both went
  // the other way would satisfy an agreement test and refuse every owner.

  it('reads an Int column against a string claim, both halves', async () => {
    const { readable, creatable } = await verdicts(
      DOC('ownerNum == auth().id', 'ownerNum Int?'),
      [{ id: 'r1', ownerNum: 5 }, { id: 'r2', ownerNum: 6 }],
      { id: '5' })
    expect([...readable]).toEqual(['r1'])
    expect([...creatable]).toEqual(['r1'])
  })

  it('reads a String column against a numeric claim, both halves', async () => {
    const { readable, creatable } = await verdicts(
      DOC('ownerId == auth().id'),
      [{ id: 'r1', ownerId: '5' }, { id: 'r2', ownerId: '6' }],
      { id: 5 })
    expect([...readable]).toEqual(['r1'])
    expect([...creatable]).toEqual(['r1'])
  })

  it('reads a Boolean column against the integer SQLite stores it as', async () => {
    const { readable, creatable } = await verdicts(
      DOC('flag == auth().id'),
      [{ id: 'r1', flag: true }, { id: 'r2', flag: false }],
      { id: 1 })
    expect([...readable]).toEqual(['r1'])
    expect([...creatable]).toEqual(['r1'])
  })

  it('orders across storage classes, where a number is below any text', async () => {
    // `qty < 'abc'` is TRUE in SQLite for every integer: numeric affinity
    // cannot convert `'abc'`, so it stays TEXT and INTEGER sorts first. JS
    // answers false through NaN, which is the opposite and not UNKNOWN.
    const { readable, creatable } = await verdicts(
      DOC(`qty < 'abc'`),
      [{ id: 'r1', qty: 5 }, { id: 'r2', qty: 999 }],
      { id: 'u1' })
    expect([...readable].sort()).toEqual(['r1', 'r2'])
    expect([...creatable].sort()).toEqual(['r1', 'r2'])
  })

  it('applies the same affinity to every element of an `in` list', async () => {
    const { readable, creatable } = await verdicts(
      DOC(`qty in ['5', '6']`),
      [{ id: 'r1', qty: 5 }, { id: 'r2', qty: 9 }],
      { id: 'u1' })
    expect([...readable]).toEqual(['r1'])
    expect([...creatable]).toEqual(['r1'])
  })

  it('leaves a genuine type mismatch unequal, which is the negative control', async () => {
    // Affinity converts a well-formed number and nothing else. Without this
    // row, a fix that coerced with `==` would pass every case above and make
    // every policy over a text column match far too much.
    const { readable, creatable } = await verdicts(
      DOC('ownerId == auth().id'),
      [{ id: 'r1', ownerId: 'abc' }],
      { id: 0 })
    expect([...readable]).toEqual([])
    expect([...creatable]).toEqual([])
  })
})

describe('a create policy over a column the payload cannot carry', () => {
  // The create half is evaluated against the PAYLOAD, so a column SQLite
  // computes from the row reads `undefined` there and the allow never holds —
  // while the read half, which is SQL, answers it perfectly. Refused at build,
  // where the fix is a schema edit.
  const cases = [
    ['derived',   `big Boolean? @derived(qty > 5)`,   `big == true`],
    ['generated', `dbl Int? @generated("qty * 2")`,   `dbl > 10`],
  ] as const

  for (const [kind, col, expr] of cases) {
    it(`refuses a @${kind} column by name`, async () => {
      const schema = `
model Doc {
  id  String @id
  qty Int?
  ${col}
  @@allow('read',   ${expr})
  @@allow('create', ${expr})
}
`
      await expect(createClient({ schema, db: ':memory:' })).rejects.toThrow(new RegExp(`@${kind}`))
    })

    it(`accepts the same predicate over the column it is computed FROM — @${kind}`, async () => {
      // The pair. A refusal that cannot be shown to come from the rule it names
      // proves nothing (`FJS-351`), and this is the identical model with the
      // predicate written the way the message says to write it.
      const schema = `
model Doc {
  id  String @id
  qty Int?
  ${col}
  @@allow('read',   qty > 5)
  @@allow('create', qty > 5)
}
`
      const db = await createClient({ schema, db: ':memory:' })
      const made = await db.$setAuth({ id: 'u1' }).doc.create({ data: { id: 'a', qty: 9 } })
      expect(made.id).toBe('a')
      db.$close()
    })
  }

  it('refuses a @from column too, and says which kind it is', async () => {
    const schema = `
model Doc {
  id   String @id
  kids Kid[]
  n    Int?   @from(Kid, count: true)
  @@allow('read',   n > 0)
  @@allow('create', n > 0)
}
model Kid {
  id    String @id
  docId String?
  doc   Doc?   @relation(fields: [docId], references: [id])
}
`
    await expect(createClient({ schema, db: ':memory:' })).rejects.toThrow(/@from/)
  })

  it('says the opposite thing about a @@deny, which fails the other way', async () => {
    const schema = `
model Doc {
  id  String @id
  qty Int?
  big Boolean? @derived(qty > 5)
  @@allow('create', qty > 0)
  @@deny('create',  big == true)
}
`
    await expect(createClient({ schema, db: ':memory:' })).rejects.toThrow(/can never fire, so it refuses nothing/)
  })

  it('leaves a @system column alone — the application can supply one', async () => {
    // The facet is *does SQLite compute this*, not *is it read-only to the
    // caller*: a `@system` column reaches the payload through `system: ['col']`,
    // so a create policy naming one is answerable and must not be refused.
    const schema = `
model Doc {
  id  String @id
  tag String? @system
  @@allow('read',   tag == 'x')
  @@allow('create', tag == 'x')
}
`
    const db = await createClient({ schema, db: ':memory:' })
    const made = await db.$setAuth({ id: 'u1' }).doc.create({ data: { id: 'a', tag: 'x' }, system: ['tag'] })
    expect(made.tag).toBe('x')
    db.$close()
  })
})
