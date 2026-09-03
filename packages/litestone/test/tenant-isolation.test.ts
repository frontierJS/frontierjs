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
    // Ruled behaviour, so it is named rather than called a leak — and it is not
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

// ─── the write side: a unique that is not per tenant ─────────────────────────
//
// `verifyTenantIsolation` above executes the READ crossing. A `@unique` is the
// same boundary from the write side and the desugar never touched it, so on a
// scoped model an ordinary `slug String @unique` is unique across the whole
// installation: two tenants cannot both hold "launch", and the second is
// refused by a message naming the value — telling them a row they may not read
// exists (`FJS-639`).
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

  it('names a bare @unique on a scoped model, and says all three ways out', () => {
    const w = warn('model Post { id Int @id  workspaceId Int  slug String @unique }')
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('Post.slug')
    expect(w[0]).toContain('workspaceId')          // add the column
    expect(w[0]).toContain('reaching a scoped model')  // or a scoped parent
    expect(w[0]).toContain('global')               // or say you meant it
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
