// test/auth-claims.test.ts
//
// What `auth().x` may name, and what an absent claim means (FJS-666, FJS-667,
// FJS-668).
//
// A row identifier is refused by name at startup. The auth side resolved
// against nothing, ever — so a misspelling parsed, built, and then enforced
// itself in OPPOSITE directions in the two interpreters, because an absent
// claim is `NULL` to the SQL compiler and `null` to the evaluator and the two
// read that oppositely. One typo is a lockout on read and an open door on
// create, and neither reads as a mistake from the side that refused.
//
// Every refusal here is PAIRED with the acceptance of a schema one character
// different, because a check that refuses the correct spelling too proves
// nothing about the typo (`FJS-351`). The 3VL rows are paired the other way —
// the claim present-and-false beside the claim absent — since a rule that
// denied everybody would satisfy any test that only asked about the absent one.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const AUTH_USER = `
model User {
  id        Int     @id @default(autoincrement())
  isStaff   Boolean @default(false)
  suspended Boolean @default(false)
  @@auth
}`

const build = (schema: string, opts: Record<string, unknown> = {}) =>
  createClient({ schema, db: ':memory:', ...opts })

const refusal = async (schema: string, opts: Record<string, unknown> = {}) =>
  build(schema, opts).then(() => null, (e: Error) => e.message)

// ─── the set is graded, in every place an expression can live ────────────────

describe('an unknown claim is refused by name', () => {
  const model = (body: string) => `${AUTH_USER}
model Note {
  id      Int    @id @default(autoincrement())
  ownerId Int
  secret  String @default("s")
${body}
}`

  test('@@allow — and the same schema spelled right builds', async () => {
    const err = await refusal(model(`  @@allow('read', auth().isStff == true)`))
    expect(err).toContain("'isStff' is not a claim the principal carries")
    expect(err).toContain('@@allow/@@deny')
    expect(await build(model(`  @@allow('read', auth().isStaff == true)`))).toBeTruthy()
  })

  test('@@deny', async () => {
    const err = await refusal(model(`  @@deny('update', auth().suspnded == true)`))
    expect(err).toContain("'suspnded' is not a claim the principal carries")
    expect(await build(model(`  @@deny('update', auth().suspended == true)`))).toBeTruthy()
  })

  test('@@scope', async () => {
    const err = await refusal(model(`  @@scope(mine, auth().isStff == true)`))
    expect(err).toContain("'isStff' is not a claim")
    expect(err).toContain('@@scope(mine, …)')
    expect(await build(model(`  @@scope(mine, auth().isStaff == true)`))).toBeTruthy()
  })

  // The field-level half was checked by NOTHING before — not for a claim and
  // not for a column (FJS-667). It is the same expression language compiled by
  // the same compiler, and a typo there strips the column from every row, which
  // reads as the policy working strictly.
  test('a field @allow', async () => {
    const withField = (expr: string) => `${AUTH_USER}
model Note {
  id      Int    @id @default(autoincrement())
  ownerId Int
  secret  String @allow('read', ${expr})
}`
    const err = await refusal(withField('auth().isStff == true'))
    expect(err).toContain("'isStff' is not a claim")
    expect(err).toContain('@allow(\'read\', …) on Note.secret')
    expect(await build(withField('auth().isStaff == true'))).toBeTruthy()
  })

  test("the refusal names the set and the way out", async () => {
    const err = await refusal(model(`  @@allow('read', auth().cartToken == ownerId)`))
    expect(err).toContain('Claims:')
    expect(err).toContain('isStaff (@@auth User)')
    expect(err).toContain("createClient({ claims: ['cartToken'] })")
  })
})

// FJS-667 on its own terms: the COLUMN half of the same missing walk. It fails
// closed rather than open — every row comes back with the column stripped — so
// the schema, the build and every assertion on the refused side agree with the
// mistake.
describe('a field @allow names a column that must exist', () => {
  const withField = (expr: string) => `${AUTH_USER}
model Note {
  id      Int    @id @default(autoincrement())
  ownerId Int
  secret  String @allow('read', ${expr})
}`

  test('a typo is refused where the same typo in @@allow already was', async () => {
    const err = await refusal(withField('ownerIdd == 1'))
    expect(err).toContain("'ownerIdd' is not a field on this model")
    expect(await build(withField('ownerId == 1'))).toBeTruthy()
  })

  test('the column typo used to strip the field from every row', async () => {
    // The measurement that makes the refusal worth having: with the walk absent
    // this built, and answered every row with `secret` gone.
    const db = await build(withField('ownerId == auth().id'))
    const sys = db.asSystem()
    await sys.note.create({ data: { ownerId: 1, secret: 'classified' } })
    await sys.note.create({ data: { ownerId: 2, secret: 'classified' } })
    const rows = await db.$setAuth({ id: 1 }).note.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: Record<string, unknown>) => r.secret ?? 'STRIPPED')).toEqual(['classified', 'STRIPPED'])
  })
})

// ─── what makes the set exist at all ─────────────────────────────────────────

describe('the four sources of a claim', () => {
  const note = (expr: string) => `
model Note {
  id      Int @id @default(autoincrement())
  ownerId Int
  @@allow('read', ${expr})
}`

  test('the framework fixes eight names, and this package reads all eight', async () => {
    // `id` and `capabilities` are the two the engine spells; the other six are
    // what `FrontierGateGetLevel` grades a caller by (src/plugins/gate.js), so
    // a standing is a claim even on an app whose User has no such column.
    for (const claim of ['id', 'capabilities', 'role', 'isAdmin', 'isOwner',
                         'isSystemAdmin', 'verifiedAt', 'activatedAt'])
      expect(await build(AUTH_USER + note(`auth().${claim} != null`))).toBeTruthy()
  })

  test('the @@auth model contributes its own columns', async () => {
    expect(await build(AUTH_USER + note('auth().isStaff == true'))).toBeTruthy()
    // …and a model that is not @@auth contributes nothing.
    const notAuth = AUTH_USER.replace('  @@auth\n', '') + `
model Other { id Int @id  quirk Boolean @default(false) }`
    expect(await refusal(notAuth + note('auth().quirk == true'), { claims: [] }))
      .toContain("'quirk' is not a claim")
  })

  test('the tenancy claim is known from the tenancy block', async () => {
    const tenant = `
tenancy { strategy row  column tenantId  claim tenantId }
model User { id Int @id  @@auth  @@tenant(none) }
model Note {
  id       Int @id @default(autoincrement())
  tenantId String
  ownerId  Int
  @@allow('read', auth().tenantId == tenantId)
}`
    expect(await build(tenant)).toBeTruthy()
  })

  // The one source that has to be stated: a value resolved PER REQUEST is on no
  // row and in no schema, so nothing can derive it.
  test('a declared claim is accepted, and the same claim undeclared is not', async () => {
    const schema = AUTH_USER + note('auth().cartToken == ownerId')
    expect(await build(schema, { claims: ['cartToken'] })).toBeTruthy()
    expect(await refusal(schema)).toContain("'cartToken' is not a claim")
  })
})

describe('the set only grades when there is one', () => {
  const bare = `
model User { id Int @id  isStaff Boolean @default(false) }
model Note {
  id      Int @id @default(autoincrement())
  ownerId Int
  @@allow('read', auth().isStaff == true)
}`

  test('no @@auth and no claims: the schema builds, ungraded', async () => {
    // Inventing a floor here would refuse `auth().isStaff` on every app in the
    // world. The degradation is announced instead — asserted in the row below.
    expect(await build(bare)).toBeTruthy()
  })

  test('claims: [] is a statement where absent is silence', async () => {
    // An empty array says the principal carries the framework's eight and
    // nothing else, so it grades — which is what makes `[]` distinguishable
    // from a caller who passed nothing at all.
    expect(await refusal(bare, { claims: [] })).toContain("'isStaff' is not a claim")
  })

  test('@@auth alone switches it on, with no claims passed', async () => {
    expect(await refusal(bare.replace('model User { id Int @id',
      'model User { id Int @id  @@auth') .replace('isStaff Boolean @default(false) }',
      'quirk Boolean @default(false) }')))
      .toContain("'isStaff' is not a claim")
  })
})

// ─── FJS-668: an absent claim means one thing, not two ───────────────────────
//
// The typo is refused at startup now, so what is left is the ORDINARY case: a
// correctly spelled, declared claim that this caller simply does not carry — an
// anonymous request, or a resolver that sets it on some requests and not
// others. `NULL = 1` is NULL and a WHERE that is NULL keeps no row, so the SQL
// half denies; `null === true` is false, so the JS half allowed.

describe('an absent claim reads the same in both interpreters', () => {
  const schema = `
model User { id Int @id  suspended Boolean @default(false)  @@auth }
model Note {
  id      Int    @id @default(autoincrement())
  ownerId Int
  body    String
  @@allow('read', true) @@allow('create', true) @@allow('update', true)
  @@deny('create', auth().suspended == true)
  @@deny('update', auth().suspended == true)
}`

  const both = async (principal: Record<string, unknown>) => {
    const db  = await build(schema)
    await db.asSystem().note.create({ data: { ownerId: 1, body: 'seed' } })
    const c   = db.$setAuth(principal)
    const sql = await c.note.update({ where: { id: 1 }, data: { body: 'z' } })
      .then((r: unknown) => (r ? 'allow' : 'deny'), () => 'deny')
    const js  = await c.note.create({ data: { ownerId: 1, body: 'z' } })
      .then(() => 'allow', () => 'deny')
    return { sql, js }
  }

  test('present and false: both allow', async () => {
    expect(await both({ id: 1, suspended: false })).toEqual({ sql: 'allow', js: 'allow' })
  })

  test('present and true: both deny', async () => {
    expect(await both({ id: 1, suspended: true })).toEqual({ sql: 'deny', js: 'deny' })
  })

  // The row this file exists for. It used to be `{ sql: 'deny', js: 'allow' }`.
  test('ABSENT: both deny, because AND NOT (NULL) keeps no row', async () => {
    expect(await both({ id: 1 })).toEqual({ sql: 'deny', js: 'deny' })
  })
})

describe('null propagates the way SQLite propagates it', () => {
  // An ALLOW and a DENY read UNKNOWN oppositely and that is not a special case
  // — it is `(allows) AND NOT (denies)` being NULL, which keeps no row either
  // way. Stated as two rows because a fix that denied on both would look
  // identical from the deny side alone.
  const allowOn = (expr: string) => `
model User { id Int @id  suspended Boolean @default(false)  @@auth }
model Note {
  id      Int @id @default(autoincrement())
  ownerId Int
  @@allow('create', ${expr})
}`

  const creates = async (schema: string, principal: Record<string, unknown>) => {
    const db = await build(schema)
    return db.$setAuth(principal).note.create({ data: { ownerId: 1 } })
      .then(() => 'allow', () => 'deny')
  }

  test('an allow whose predicate is UNKNOWN admits nobody', async () => {
    expect(await creates(allowOn('auth().suspended == false'), { id: 1 })).toBe('deny')
    expect(await creates(allowOn('auth().suspended == false'), { id: 1, suspended: false })).toBe('allow')
  })

  test('NOT of UNKNOWN is UNKNOWN, not TRUE', async () => {
    // The single most misleading shape: `!` over an absent claim looks like it
    // should let everybody in, and in SQL it lets nobody in.
    expect(await creates(allowOn('!(auth().suspended == true)'), { id: 1 })).toBe('deny')
    expect(await creates(allowOn('!(auth().suspended == true)'), { id: 1, suspended: false })).toBe('allow')
  })

  test('UNKNOWN || TRUE is TRUE, and UNKNOWN && TRUE is UNKNOWN', async () => {
    expect(await creates(allowOn('auth().suspended == false || ownerId == 1'), { id: 1 })).toBe('allow')
    expect(await creates(allowOn('auth().suspended == false && ownerId == 1'), { id: 1 })).toBe('deny')
  })

  test('NULL IN (list) is UNKNOWN, never false', async () => {
    expect(await creates(allowOn("auth().role in ['staff', 'admin']"), { id: 1 })).toBe('deny')
    expect(await creates(allowOn("auth().role in ['staff', 'admin']"), { id: 1, role: 'staff' })).toBe('allow')
  })

  // `auth().x == null` is a PRESENCE test and keeps its own branch — it is the
  // one comparison SQL spells differently too (`IS NULL`), and without it there
  // would be no way to write "the caller carries no such claim".
  test('a presence test still answers a boolean', async () => {
    expect(await creates(allowOn('auth().suspended == null'), { id: 1 })).toBe('allow')
    expect(await creates(allowOn('auth().suspended == null'), { id: 1, suspended: false })).toBe('deny')
  })
})
