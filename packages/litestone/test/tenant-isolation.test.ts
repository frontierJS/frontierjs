/**
 * test/tenant-isolation.test.ts — `verifyTenantIsolation()`, the fifth executed
 * check (`FJS-513`).
 *
 * `verifyRowPolicies` grades a compiled WHERE against litestone's own JS
 * evaluator and reports a rule holding a `check()` as not-graded by name — so
 * the delegated half of declared tenancy has no grader, which is what
 * `FJS-382` cost. This one executes the crossing instead: seed a row for one
 * tenant, have another try to reach it.
 *
 * Every case here asserts a NEGATIVE result somewhere. A checker that finds
 * nothing is indistinguishable from a checker that ran nothing, so each fixture
 * that should be clean is paired with one that must not be.
 */

import { describe, test, it, expect } from 'bun:test'
import { createTestEnv } from '../src/testing.js'
import { parse } from '../src/core/parser.js'

const CLEAN = `
  tenancy { strategy row  column workspaceId  claim workspaceId }

  model Workspace {
    id    Int    @id @default(autoincrement())
    name  String
    boards Board[]
    @@tenant(none)
  }

  model Board {
    id          Int       @id @default(autoincrement())
    workspaceId Int
    workspace   Workspace @relation(fields: [workspaceId], references: [id])
    title       String
    widgets     Widget[]
  }

  model Widget {
    id      Int    @id @default(autoincrement())
    boardId Int
    board   Board  @relation(fields: [boardId], references: [id])
    label   String
  }
`

const leaks = (rows: any[]) => rows.filter(r => r.got === 'leaked')
const of    = (rows: any[], model: string) => rows.filter(r => r.model === model)

describe('verifyTenantIsolation', () => {
  test('a correctly scoped schema leaks nothing, and says what it graded', async () => {
    const env  = await createTestEnv({ schema: CLEAN })
    const rows = await env.verifyTenantIsolation()

    expect(leaks(rows)).toEqual([])

    // The vacuity guard is the half that matters: a run where nobody can reach
    // anything would also report no leaks.
    expect(rows.filter(r => r.got === 'unreachable')).toEqual([])
    expect(of(rows, 'Workspace').map(r => r.got)).toEqual(['exempt'])

    // Coverage is the result. A model that isolates correctly is silent, so
    // without this a run that crossed nothing reads exactly like a clean one.
    expect(rows.filter(r => r.got === 'graded').map(r => r.model).sort()).toEqual(['Board', 'Widget'])
  })

  test('the DELEGATED model is graded, not skipped — the half verifyRowPolicies declines', async () => {
    const env = await createTestEnv({ schema: CLEAN })

    // Widget carries no workspaceId; it is scoped by `!check(board, 'read')`.
    const policy = await env.verifyRowPolicies()
    expect(policy.some(r => r.model === 'Widget' && /check\(\)/.test(r.message))).toBe(true)

    // The same model, actually crossed.
    const rows = await env.verifyTenantIsolation()
    expect(of(rows, 'Widget').filter(r => r.got === 'exempt' || r.got === 'unscoped')).toEqual([])
    expect(leaks(of(rows, 'Widget'))).toEqual([])
  })

  test('a model nothing scopes is a FINDING, not a silent pass', async () => {
    // `Note` carries no tenant column and its only relation is optional, so the
    // desugar writes nothing for it and reports nothing — every tenant reads
    // every row. The one shape that reaches production quietly.
    const env = await createTestEnv({ schema: `
      ${CLEAN}
      model Note {
        id   Int    @id @default(autoincrement())
        body String
      }
    ` })

    const rows = await env.verifyTenantIsolation()
    const note = of(rows, 'Note')
    expect(note).toHaveLength(1)
    expect(note[0].got).toBe('unscoped')
    expect(note[0].message).toMatch(/nothing scopes this model/)
  })

  test('a tenant column the app made writable is caught as a post-update move', async () => {
    // The generated `post-update` deny is what stops a caller pushing their own
    // row into somebody else's tenant. Removing it is the mutation, and the
    // check has to see it.
    const env = await createTestEnv({ schema: CLEAN })
    const rows = await env.verifyTenantIsolation({ ops: ['post-update'] })
    expect(leaks(rows)).toEqual([])

    // And the same schema with the rule gone must not come back clean.
    const holed = await createTestEnv({ schema: CLEAN
      .replace('tenancy { strategy row  column workspaceId  claim workspaceId }', '')
      .replace('@@tenant(none)', '') })
    const after = await holed.verifyTenantIsolation()
    expect(after).toHaveLength(1)
    expect(after[0].got).toBe('skipped')
    expect(after[0].message).toMatch(/declares no `tenancy \{ \}` block/)
  })

  test('strategy database is reported by name rather than graded', async () => {
    const env = await createTestEnv({ schema: `
      tenancy { strategy database  dir "./t"  registry "./r.db"  resolve subdomain }
      model Thing { id Int @id @default(autoincrement())  name String }
    ` })
    const rows = await env.verifyTenantIsolation()
    expect(rows).toHaveLength(1)
    expect(rows[0].got).toBe('skipped')
    expect(rows[0].message).toMatch(/isolates tenants by database file/)
  })

  test('a gate above 7 is uncheckable, not a pass', async () => {
    const env = await createTestEnv({ schema: CLEAN.replace(
      'model Board {', 'model Board {\n    @@gate("8.8.8.8")') })
    const rows = await env.verifyTenantIsolation()
    const board = of(rows, 'Board')
    expect(board.some(r => r.got === 'uncheckable')).toBe(true)
    expect(leaks(board)).toEqual([])
  })

  test('actors override the derived principals', async () => {
    const env  = await createTestEnv({ schema: CLEAN })
    const rows = await env.verifyTenantIsolation({
      actors: [{ id: 'a', workspaceId: 1 }, { id: 'b', workspaceId: 2 }],
      ops:    ['read'],
    })
    expect(leaks(rows)).toEqual([])
  })

  test('a delegated model scoped through an OPTIONAL relation reports the unparented row', async () => {
    // `check(rel)` answers true for a null foreign key — a row naming no parent
    // is not a row naming somebody else's (`FJS-382`). So an optional scoping
    // relation means a row can exist in no tenant, and every tenant reads it.
    // Ruled behavior, so it is named rather than called a leak — and it is not
    // silent, which is the whole point.
    const env = await createTestEnv({ schema: `
      ${CLEAN}
      model Card {
        id      Int    @id @default(autoincrement())
        title   String
        boardId Int?
        board   Board? @relation(fields: [boardId], references: [id])
      }
    ` })

    const rows = await env.verifyTenantIsolation()
    const card = of(rows, 'Card')

    // The PARENTED row is properly isolated — that is what the default seeding
    // now proves, and what an unparented-only seed could never have shown.
    expect(leaks(card)).toEqual([])

    const orphan = card.filter(r => r.got === 'unparented')
    expect(orphan).toHaveLength(1)
    expect(orphan[0].message).toMatch(/belongs to no tenant and every tenant reads it/)
    expect(orphan[0].message).toMatch(/Make the relation required/)
  })

  test('the leak path fires — a client with no denies is caught against a schema that has them', async () => {
    // The only way to prove a leak detector works is to hand it a leak, and a
    // correct desugar will not produce one. So the client is built from a
    // schema with the tenancy block REMOVED and graded against the schema that
    // has it — the same shape `against` serves in the other four checks, and
    // the same argument: expectations derived from the mutant disappear with
    // the rule, so they have to come from the original.
    const holed = CLEAN
      .replace('tenancy { strategy row  column workspaceId  claim workspaceId }', '')
      .replace('@@tenant(none)', '')

    const env      = await createTestEnv({ schema: holed })
    const withRule = await createTestEnv({ schema: CLEAN })

    const rows = await env.verifyTenantIsolation({ against: withRule.schema })
    const board = leaks(of(rows, 'Board'))

    expect(board.length).toBeGreaterThan(0)
    expect(board.some(r => r.op === 'read' && r.actor === 'B')).toBe(true)
    expect(board.find(r => r.op === 'read')!.message).toMatch(/belongs to tenant A and a caller in tenant B read it/)

    // And the delegated model leaks too, which is the half verifyRowPolicies
    // reports as not-graded rather than answering.
    expect(leaks(of(rows, 'Widget')).length).toBeGreaterThan(0)
  })
})

// ─── the write side: a unique is scoped per tenant ───────────────────────────
//
// `verifyTenantIsolation` above executes the READ crossing. A `@unique` is the
// same boundary from the write side, and the desugar never touched it: on a
// scoped model an ordinary `slug String @unique` was unique across the whole
// installation, so two tenants could not both hold "launch" and the second was
// refused by a message naming the value — telling them a row they may not read
// exists (`FJS-639`).
//
// It is SCOPED now rather than reported (`FJS-1159`): the tenant column is
// stated once, in the block, and a schema FRAGMENT can never name it, so the
// desugar prepends it the way it already prepends a deny. `@unique(global)` is
// the opt-out and existed before this.
//
// **What still warns is what cannot be derived** — a model scoped through a
// PARENT carries no tenant column of its own, and which parent to scope by is
// not decidable here, since a model may have two.
//
// Every case here is a PAIR with a correct schema that must stay silent. A rule
// that fires on a correct app is a rule people switch off, and the naive form
// of this one — *the constraint must name the tenant column* — reports ten of
// basecamp's twenty-three, every one of them right.
describe('a unique that is not per tenant', () => {
  const T = 'tenancy { strategy row  column workspaceId  claim workspaceId }\n' +
            'model Workspace { id Int @id  name String  @@tenant(none) }\n'
  const warn = (src: string) => {
    const r = parse(T + src)
    expect(r.valid).toBe(true)
    return (r.warnings ?? []).filter(w => w.includes('unique constraint'))
  }

  it('scopes a bare @unique on a scoped model, and says so', () => {
    const w = warn('model Post { id Int @id  workspaceId Int  slug String @unique }')
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('are scoped per tenant')
    expect(w[0]).toContain('Post.slug')
    expect(w[0]).toContain('workspaceId')   // the column it was scoped by
    expect(w[0]).toContain('global')        // …and how to keep it installation-wide
  })

  it('…and the DECLARATION is what moved, so every reader sees one constraint', () => {
    // The field-level attribute is LIFTED rather than annotated: a column
    // cannot carry a two-column UNIQUE, and a reader that kept asking the field
    // would emit the old index beside the new one.
    const r    = parse(T + 'model Post { id Int @id  workspaceId Int  slug String @unique }')
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    expect(post.fields.find((f: any) => f.name === 'slug')!
      .attributes.some((a: any) => a.kind === 'unique')).toBe(false)
    expect(post.attributes.filter((a: any) => a.kind === 'uniqueIndex').map((a: any) => a.fields))
      .toEqual([['workspaceId', 'slug']])
  })

  // The one shape that is still reported, and the reason is that nothing here
  // can choose: a Volume is scoped through Server, carries no column of its
  // own, and a model may have two scoped parents.
  it('reports a model scoped through a PARENT, whose constraint reaches neither', () => {
    const w = warn(`model Server { id Int @id  workspaceId Int  volumes Volume[] }
model Volume { id Int @id  serverId Int  name String @unique
  server Server @relation(fields: [serverId], references: [id]) }`)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('scoped through a PARENT')
    expect(w[0]).toContain('Volume.name')
  })

  it('is silent when the tuple carries the tenant column', () => {
    expect(warn('model Post { id Int @id  workspaceId Int  slug String\n' +
                '  @@unique([workspaceId, slug]) }')).toHaveLength(0)
  })

  // The half a non-transitive rule gets wrong: a Volume is per-tenant because a
  // Server is, and the constraint names no tenant column at all.
  it('is silent when the tuple reaches a scoped parent', () => {
    expect(warn(`model Server { id Int @id  workspaceId Int  volumes Volume[] }
model Volume { id Int @id  serverId Int  name String
  server Server @relation(fields: [serverId], references: [id])
  @@unique([serverId, name]) }`)).toHaveLength(0)
  })

  // …and transitively, which is what the scoping fixpoint buys: App is scoped
  // through Environment through Project, and none of the three names a column
  // on the constraint.
  it('is silent through a GRANDPARENT', () => {
    expect(warn(`model Project     { id Int @id  workspaceId Int  envs Environment[] }
model Environment { id Int @id  projectId Int  apps App[]
  project Project @relation(fields: [projectId], references: [id]) }
model App         { id Int @id  environmentId Int  slug String
  env Environment @relation(fields: [environmentId], references: [id])
  @@unique([environmentId, slug]) }`)).toHaveLength(0)
  })

  it('is silenced by saying it was meant — both spellings', () => {
    expect(warn('model Invitation { id Int @id  workspaceId Int  token String @unique(global) }')).toHaveLength(0)
    expect(warn('model Site { id Int @id  workspaceId Int  host String\n' +
                '  @@unique([host], global: true) }')).toHaveLength(0)
  })

  it('says nothing about a model that spans tenants on purpose', () => {
    expect(warn('model Plan { id Int @id  code String @unique  @@tenant(none) }')).toHaveLength(0)
  })

  // A modifier that parsed as nothing would be a schema saying less than its
  // author wrote — the failure `@unique(global)` exists to prevent.
  it('refuses a mis-spelled modifier by name', () => {
    const r = parse(T + 'model P { id Int @id  workspaceId Int  s String @unique(globl) }')
    expect(r.valid).toBe(false)
    expect(r.errors.join()).toMatch(/unknown argument 'globl'.*only one is 'global'/)
  })
})

/**
 * A fragment's bare tenant column, declared ahead of the app's own models.
 *
 * `Note` is what an imported `.lite` looks like after a host extends it: the
 * tenant column is a plain scalar, because a fragment cannot name the host's
 * column and so can never declare the relation (`FJS-D310`). Declaring it FIRST
 * is the whole fixture — the carrier that decides the tenant values is the
 * schema's, not the model's, and a synthetic value satisfies no foreign key.
 */
const FRAGMENT_FIRST = `
  tenancy { strategy row  column workspaceId  claim workspaceId }

  model Note {
    id          Int    @id @default(autoincrement())
    workspaceId Int
    body        String
  }

  model Workspace {
    id    Int    @id @default(autoincrement())
    name  String
    boards Board[]
    @@tenant(none)
  }

  model Board {
    id          Int       @id @default(autoincrement())
    workspaceId Int
    workspace   Workspace @relation(fields: [workspaceId], references: [id])
    title       String
  }
`

describe('the tenant values satisfy the schema, not the first model declared', () => {
  test('a bare carrier declared first does not blind every model with a real key', async () => {
    const env  = await createTestEnv({ schema: FRAGMENT_FIRST })
    const rows = await env.verifyTenantIsolation()

    // The defect answered `error` here — *no row could be seeded for tenant A*
    // — for every model whose column is a foreign key, which is honest and
    // reads exactly like a model that isolates correctly.
    const errors = rows.filter(r => r.got === 'error')
    expect(errors.map(r => r.message)).toEqual([])

    // And the model that DID seed is not evidence on its own: the pairing is
    // that the keyed model was crossed too.
    expect(of(rows, 'Board').some(r => r.got === 'graded')).toBe(true)
    expect(of(rows, 'Note').some(r => r.got === 'graded')).toBe(true)
    expect(leaks(rows)).toEqual([])
  })

  test('a schema whose carriers are ALL bare still grades, on the synthetic value', async () => {
    // The control for the fix: preferring a keyed carrier must not remove the
    // fallback, or a schema whose tenant column references nothing stops being
    // gradable at all.
    const env = await createTestEnv({ schema: `
      tenancy { strategy row  column tenantId  claim tenantId }

      model Note {
        id       Int    @id @default(autoincrement())
        tenantId String
        body     String
      }
    ` })
    const rows = await env.verifyTenantIsolation()

    expect(rows.filter(r => r.got === 'error').map(r => r.message)).toEqual([])
    expect(of(rows, 'Note').some(r => r.got === 'graded')).toBe(true)
    expect(leaks(rows)).toEqual([])
  })
})

/**
 * A model whose write rule is ownership, under declared row tenancy.
 *
 * `ownerId @default(auth().id)` names the row's owner, and seeding runs on the
 * system client where that default has no caller to read. The row then belongs
 * to nobody, the acting tenant cannot update it, and the check reports
 * `unreachable` — true, and it means the model is graded by nothing.
 */
const OWNED = `
  tenancy { strategy row  column workspaceId  claim workspaceId }

  model Workspace {
    id    Int    @id @default(autoincrement())
    docs  Doc[]
    name  String
    @@tenant(none)
  }

  model Doc {
    id          Int       @id @default(autoincrement())
    workspaceId Int
    workspace   Workspace @relation(fields: [workspaceId], references: [id])
    ownerId     String    @default(auth().id)
    title       String
    @@allow('read',   true)
    @@allow('update', ownerId == auth().id)
    @@allow('delete', ownerId == auth().id)
  }
`

describe('an owner-scoped model is seeded as the tenant acting on it', () => {
  test('the acting tenant owns its own row, so a refusal means tenancy', async () => {
    const env  = await createTestEnv({ schema: OWNED })
    const rows = await env.verifyTenantIsolation()

    // The defect: `Doc … was seeded for tenant A and tenant A cannot update it`.
    expect(rows.filter(r => r.got === 'unreachable').map(r => r.message)).toEqual([])
    expect(of(rows, 'Doc').some(r => r.got === 'graded')).toBe(true)
    expect(leaks(rows)).toEqual([])
  })
})

describe('the two policy checkers seed into the tenant their reader holds', () => {
  // Both build a reader carrying a tenant claim and then seed through a plain
  // factory, which generates a fresh value for that same column on every row —
  // so the tenant rule filtered every row before the rule under test was
  // reached, and each check named the wrong rule as ungraded.
  const PROTECTED = `
    tenancy { strategy row  column workspaceId  claim workspaceId }

    model Workspace {
      id     String @id
      notes  Note[]
      name   String
      @@tenant(none)
    }

    model Note {
      id          Int       @id @default(autoincrement())
      workspaceId String
      workspace   Workspace @relation(fields: [workspaceId], references: [id])
      ownerId     String    @default(auth().id)
      body        String
      @@allow('read',   ownerId == auth().id)
      @@allow('update', ownerId == auth().id)
    }

    // Scoped through its PARENT, which is the shape that bites: a delegated
    // tenant rule is a check() through the relation, and the candidate values a
    // checker builds off a predicate cannot satisfy one -- only seeding the
    // whole chain into the reader's tenant can.
    model Comment {
      id        Int      @id @default(autoincrement())
      noteId    Int
      note      Note     @relation(fields: [noteId], references: [id])
      body      String
      apiToken  String?  @guarded
    }
  `

  test('a protected column on a scoped model is actually reached', async () => {
    const env = await createTestEnv({ schema: PROTECTED })
    // The defect reported `the seeded row was not visible to a SYSADMIN(7)
    // reader`, which reads as a row-policy problem and was tenancy.
    expect((await env.verifyFieldProtection()).map((m: any) => m.message)).toEqual([])
  })

  test('a policy on a scoped model gets rows on both sides', async () => {
    const env    = await createTestEnv({ schema: PROTECTED })
    const graded = await env.verifyRowPolicies()
    // The defect reported *all N seeded rows fall on the same side of the
    // policy (all excluded)* — naming a policy that had never been consulted.
    expect(graded.filter((m: any) => /fall on the same side/.test(m.message)).map((m: any) => m.message)).toEqual([])
  })
})
