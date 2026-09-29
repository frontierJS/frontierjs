// test/tenancy-delegation.test.ts
//
// `tenancy { strategy row }` scopes every model that CARRIES the tenant column.
// A model that holds only a foreign key to one that does is not cross-tenant
// data — it is the same tenant's data, one hop away — and it used to be left to
// a hand-written rule, because the obvious generated form could not be shipped:
// `check()` answered `true` conservatively in the JS evaluator, so the rule held
// for read, update and delete and permitted a cross-tenant CREATE in silence
// (FJS-282). Half-enforcement in the one feature whose whole job is enforcement.
//
// Two things make it work, and both are asserted here rather than assumed:
//
//   1. `check()` is a real lookup on create and post-update — the foreign key is
//      in the data, so the parent row can be read and graded.
//   2. tenancy generates one `@@deny(all, !check(rel))` per SCOPED PARENT, which
//      is why there is no choice to make: denies are AND'd, so two parents mean
//      both must be satisfied. Narrowing, which is the direction tenancy takes.
//
// Every assertion below is about the SAME caller: signed in, workspace 10.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient, parse } from '../src/index.js'

const SCHEMA = `
  tenancy { strategy row  column workspaceId  claim workspaceId }

  model App {
    id          Int    @id
    workspaceId Int
    name        String
    deploys     Deploy[]
  }

  model Deploy {
    id     Int  @id
    app    App  @relation(fields: [appId], references: [id])
    appId  Int
    sha    String
    lines  LogLine[]
  }

  // Two words on purpose: the table is 'log_line', and the correlation the
  // generated rule compiles to used to name the MODEL (FJS-333).
  model LogLine {
    id       Int    @id
    deploy   Deploy @relation(fields: [deployId], references: [id])
    deployId Int
    text     String
  }

  model Plan { id Int @id  name String }
`

let db: any, mine: any

beforeEach(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  await sys.app.createMany({ data: [
    { id: 1, workspaceId: 10, name: 'mine' },
    { id: 2, workspaceId: 20, name: 'theirs' },
  ] })
  await sys.deploy.createMany({ data: [{ id: 1, appId: 1, sha: 'aaa' }, { id: 2, appId: 2, sha: 'bbb' }] })
  await sys.logLine.createMany({ data: [{ id: 1, deployId: 1, text: 'l1' }, { id: 2, deployId: 2, text: 'l2' }] })
  mine = db.$setAuth({ id: 1, workspaceId: 10 })
})

const thrown = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)

describe('a model scoped through its parent (FJS-282)', () => {
  test('reads are scoped one hop away', async () => {
    expect((await mine.deploy.findMany()).map((d: any) => d.sha)).toEqual(['aaa'])
  })

  test('and transitively, two hops away', async () => {
    expect((await mine.logLine.findMany()).map((l: any) => l.text)).toEqual(['l1'])
  })

  test('a create into your own parent is allowed', async () => {
    await mine.deploy.create({ data: { id: 3, appId: 1, sha: 'ccc' } })
    expect((await mine.deploy.findMany()).map((d: any) => d.sha)).toEqual(['aaa', 'ccc'])
  })

  // The half that was permitted in silence.
  test('a create into someone ELSE\'s parent is refused', async () => {
    const err = await thrown(mine.deploy.create({ data: { id: 4, appId: 2, sha: 'ddd' } }))
    expect(err.name).toBe('AccessDeniedError')
    expect(err.message).toContain('Outside your workspaceId')
    expect(await db.asSystem().deploy.count({ where: { id: 4 } })).toBe(0)
  })

  test('and so is one two hops away', async () => {
    const err = await thrown(mine.logLine.create({ data: { id: 5, deployId: 2, text: 'x' } }))
    expect(err.name).toBe('AccessDeniedError')
  })

  test('an anonymous caller creates nothing', async () => {
    expect((await thrown(db.deploy.create({ data: { id: 6, appId: 1, sha: 'eee' } }))).name)
      .toBe('AccessDeniedError')
  })

  test('a parent created in the SAME transaction is visible to its child', async () => {
    // The lookup routes through ctx.readDb, which serves the write connection
    // while a transaction is open. Without that, a parent and child created
    // together deny the child.
    await db.$transaction(async (tx: any) => {
      const t = tx.$setAuth({ id: 1, workspaceId: 10 })
      await t.app.create({ data: { id: 9, workspaceId: 10, name: 'fresh' } })
      await t.deploy.create({ data: { id: 9, appId: 9, sha: 'tx' } })
    })
    expect((await mine.deploy.findMany({ where: { id: 9 } })).length).toBe(1)
  })

  test('a model with no scoped parent is left alone, and said out loud', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const w = r.warnings.join(' ')
    expect(w).toContain('scoped through a parent')
    expect(w).toContain('Deploy (via app)')
    expect(w).toContain('LogLine (via deploy)')
    // Plan holds no column and no relation to one — reported, never inferred.
    expect(w).toContain('NOT scoped to a tenant — Plan')
  })

  test('the generated rule is a deny over all five operations', () => {
    const m = parse(SCHEMA).schema.models.find((m: any) => m.name === 'Deploy')
    const denies = m.attributes.filter((a: any) => a.kind === 'deny' && a.generated === 'tenancy')
    expect(denies).toHaveLength(1)
    // Five, not four: `post-update` grades the row the write produced, which is
    // what stops a child being re-pointed at a parent in another tenant.
    expect(denies[0].operations).toEqual(['read', 'update', 'delete', 'create', 'post-update'])
    // 'read' is STATED: the question is always "is that parent mine", never
    // "may I create that parent", which is what the default would ask.
    // And `tenancy` narrows it to the parent's generated denies, so the parent's
    // visibility rules do not become the child's tenancy (FJS-1319).
    expect(denies[0].expr).toEqual({ type: 'not', expr: { type: 'check', field: 'app', operation: 'read', tenancy: true } })
  })
})

describe('two scoped parents mean both, and via narrows to one', () => {
  const TWO = `
    tenancy { strategy row  column workspaceId  claim workspaceId }
    model Left  { id Int @id  workspaceId Int  kids Kid[] }
    model Right { id Int @id  workspaceId Int  kids Kid[] }
    model Kid {
      id      Int   @id
      left    Left  @relation(fields: [leftId],  references: [id])
      leftId  Int
      right   Right @relation(fields: [rightId], references: [id])
      rightId Int
    }
  `

  test('one deny per scoped parent — denies are AND\'d, so both must pass', () => {
    const kid = parse(TWO).schema.models.find((m: any) => m.name === 'Kid')
    const denies = kid.attributes.filter((a: any) => a.kind === 'deny' && a.generated === 'tenancy')
    expect(denies.map((d: any) => d.expr.expr.field).sort()).toEqual(['left', 'right'])
  })

  test('both are enforced on create', async () => {
    const d: any = await createClient({ db: ':memory:', schema: TWO })
    const sys = d.asSystem()
    await sys.left.createMany({ data: [{ id: 1, workspaceId: 10 }, { id: 2, workspaceId: 20 }] })
    await sys.right.createMany({ data: [{ id: 1, workspaceId: 10 }, { id: 2, workspaceId: 20 }] })
    const me = d.$setAuth({ id: 1, workspaceId: 10 })

    await me.kid.create({ data: { id: 1, leftId: 1, rightId: 1 } })
    // One foot in each tenant is refused, whichever foot it is.
    expect((await thrown(me.kid.create({ data: { id: 2, leftId: 1, rightId: 2 } }))).name).toBe('AccessDeniedError')
    expect((await thrown(me.kid.create({ data: { id: 3, leftId: 2, rightId: 1 } }))).name).toBe('AccessDeniedError')
    d.$close()
  })

  test('@@tenant(via:) narrows to the one relation named', () => {
    const kid = parse(TWO.replace('model Kid {', 'model Kid {\n      @@tenant(via: left)'))
      .schema.models.find((m: any) => m.name === 'Kid')
    const denies = kid.attributes.filter((a: any) => a.kind === 'deny' && a.generated === 'tenancy')
    expect(denies.map((d: any) => d.expr.expr.field)).toEqual(['left'])
  })

  test('via naming something that is not a to-one relation is refused', () => {
    const r = parse(TWO.replace('model Kid {', 'model Kid {\n      @@tenant(via: nope)'))
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/names no to-one relation/)
  })

  test('via naming a parent that is not itself scoped is refused', () => {
    const r = parse(`
      tenancy { strategy row  column workspaceId  claim workspaceId }
      model Loose { id Int @id  kids Kid[]  @@tenant(none) }
      model Kid { id Int @id  loose Loose @relation(fields: [looseId], references: [id])  looseId Int
        @@tenant(via: loose) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/is not scoped to a tenant itself/)
  })
})

describe('check() outside a WHERE is a real lookup (FJS-282)', () => {
  // Nothing to do with tenancy — the same seam, written by hand.
  const HAND = `
    model Org {
      id      Int @id
      ownerId Int
      orders  Order[]
      @@allow('all', ownerId == auth().id)
    }
    model Order {
      id    Int @id
      org   Org @relation(fields: [orgId], references: [id])
      orgId Int
      @@deny('all', !check(org))
    }
  `

  test('a create is graded against the parent that exists', async () => {
    const d: any = await createClient({ db: ':memory:', schema: HAND })
    await d.asSystem().org.createMany({ data: [{ id: 1, ownerId: 100 }, { id: 2, ownerId: 200 }] })
    const alice = d.$setAuth({ id: 100 })

    await alice.order.create({ data: { id: 1, orgId: 1 } })
    expect((await thrown(alice.order.create({ data: { id: 2, orgId: 2 } }))).name).toBe('AccessDeniedError')
    d.$close()
  })

  test('an absent foreign key allows — there is no parent to be outside of', async () => {
    const d: any = await createClient({ db: ':memory:', schema: `
      model Org   { id Int @id  ownerId Int  orders Order[]  @@allow('all', ownerId == auth().id) }
      model Order { id Int @id  org Org? @relation(fields: [orgId], references: [id])  orgId Int?
                    @@deny('all', !check(org)) }
    ` })
    await d.asSystem().org.create({ data: { id: 1, ownerId: 100 } })
    await d.$setAuth({ id: 100 }).order.create({ data: { id: 1 } })
    expect(await d.asSystem().order.count()).toBe(1)
    d.$close()
  })

  // FJS-333. `model LineItem` is table `line_item`, and the correlation the
  // EXISTS compiles to named the MODEL — `no such column: LineItem.orderId`.
  // Every single-word model hid it, because SQLite matches identifiers
  // case-insensitively and `Order` is `order`.
  test('a model whose table name is snake_cased still correlates', async () => {
    const d: any = await createClient({ db: ':memory:', schema: `
      model Org      { id Int @id  ownerId Int  items LineItem[]  @@allow('all', ownerId == auth().id) }
      model LineItem { id Int @id  org Org @relation(fields: [orgId], references: [id])  orgId Int
                       @@deny('all', !check(org)) }
    ` })
    await d.asSystem().org.createMany({ data: [{ id: 1, ownerId: 100 }, { id: 2, ownerId: 200 }] })
    await d.asSystem().lineItem.createMany({ data: [{ id: 1, orgId: 1 }, { id: 2, orgId: 2 }] })
    expect((await d.$setAuth({ id: 100 }).lineItem.findMany()).map((r: any) => r.id)).toEqual([1])
    d.$close()
  })
})

// ─── An OPTIONAL parent ──────────────────────────────────────────────────────
//
// The delegated rule is `!check(rel)`, and `check()` had two implementations
// that disagreed about a null foreign key. `evalCheck` — the JS half, which
// runs on create — returns true, because a row naming no parent is not a row
// naming somebody else's. `compileSql` emitted a bare EXISTS, which is false
// for a null column, so the same row was invisible to every scoped READ.
//
// Basecamp's dashboard widgets are the shape: one required parent (the board)
// and two optional ones (a server, an app). A counter widget names neither, so
// it could be created and then never seen again. Four checks in its drive said
// so and nothing in the suites did — `verifyRowPolicies` reports a `check()`
// policy as not-graded by name, so the net that grades every other rule cannot
// see this one.

describe('a delegated child whose parent is optional', () => {
  const SCHEMA = `
    tenancy { strategy row  column workspaceId  claim workspaceId }
    model Board  { id Int @id @default(autoincrement())  workspaceId Int  widgets Widget[] }
    model Srv    { id Int @id @default(autoincrement())  workspaceId Int  widgets Widget[] }
    model Widget {
      id      Int    @id @default(autoincrement())
      boardId Int    board Board @relation(fields: [boardId], references: [id])
      srvId   Int?   srv   Srv?  @relation(fields: [srvId], references: [id])
      label   String
    }
  `

  test('is visible when the optional parent is absent', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const sys = db.asSystem()
    await sys.board.create({ data: { workspaceId: 1 } })
    await sys.srv.create({ data: { workspaceId: 1 } })

    const caller = db.$setAuth({ id: 'u1', workspaceId: 1 })
    await caller.widget.create({ data: { boardId: 1, label: 'no server' } })
    await caller.widget.create({ data: { boardId: 1, srvId: 1, label: 'with server' } })

    const rows = await caller.widget.findMany({})
    expect(rows.map((r: any) => r.label).sort()).toEqual(['no server', 'with server'])
  })

  test('and the guard opens no hole in either direction', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const sys = db.asSystem()
    await sys.board.create({ data: { workspaceId: 1 } })   // mine
    await sys.board.create({ data: { workspaceId: 2 } })   // theirs
    await sys.srv.create({ data: { workspaceId: 2 } })     // theirs
    await sys.widget.create({ data: { boardId: 2, label: 'on their board' } })
    await sys.widget.create({ data: { boardId: 1, srvId: 1, label: 'on their server' } })

    const caller = db.$setAuth({ id: 'u1', workspaceId: 1 })
    expect(await caller.widget.findMany({})).toEqual([])
  })
})

// A row whose EVERY scoping parent is null belongs to no tenant, and is
// `asSystem()`'s alone — the answer a null claim column gives (FJS-D141). Each
// per-parent deny lets its null through, which is right for the widget above
// and made this row every tenant's, the anonymous caller's included.
describe('a delegated row that names no parent at all (FJS-D481)', () => {
  const SCHEMA = `
    tenancy { strategy row  column workspaceId  claim workspaceId }
    model Doc   { id Int @id @default(autoincrement())  workspaceId Int  notes Note[] }
    model Note  {
      id      Int    @id @default(autoincrement())
      docId   Int?   doc Doc? @relation(fields: [docId], references: [id])
      label   String
      replies Reply[]
    }
    model Reply { id Int @id @default(autoincrement())  noteId Int  note Note @relation(fields: [noteId], references: [id])  body String }
  `

  const seeded = async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const sys = db.asSystem()
    await sys.doc.create({ data: { workspaceId: 1 } })
    await sys.note.create({ data: { docId: 1, label: 'a-note' } })
    await sys.note.create({ data: { label: 'orphan-note' } })
    await sys.reply.create({ data: { noteId: 2, body: 'on the orphan' } })
    return db
  }

  test('is read by asSystem() and by no tenant, and a grandchild follows it', async () => {
    const db = await seeded()
    const a  = db.$setAuth({ id: 'u1', workspaceId: 1 })
    expect((await a.note.findMany({})).map((r: any) => r.label)).toEqual(['a-note'])
    expect(await db.$setAuth({ id: 'u2', workspaceId: 2 }).note.findMany({})).toEqual([])
    expect(await db.$setAuth(null).note.findMany({})).toEqual([])
    expect(await a.reply.findMany({})).toEqual([])
    expect((await db.asSystem().note.findMany({})).map((r: any) => r.label).sort()).toEqual(['a-note', 'orphan-note'])
    db.$close()
  })

  test('a tenant can neither create one nor detach a row into one', async () => {
    const db = await seeded()
    const a  = db.$setAuth({ id: 'u1', workspaceId: 1 })
    await expect(a.note.create({ data: { label: 'unfiled' } })).rejects.toThrow('Outside your workspaceId')
    await expect(a.note.update({ where: { id: 1 }, data: { docId: null } })).rejects.toThrow('Outside your workspaceId')
    expect((await a.note.create({ data: { docId: 1, label: 'filed' } })).label).toBe('filed')
    db.$close()
  })
})

// The generated deny asks whether the parent is in YOUR TENANT, not whether you
// may READ it. Delegating to the parent's whole read rule made every visibility
// rule the parent has a tenancy rule of the child, reported as one: a private
// team only its members can read refused its own workspace's admin adding the
// first member, as `Outside your workspaceId` (FJS-1319).
describe('a parent the caller may not read is still in their tenant (FJS-1319)', () => {
  const PRIVATE = `
    tenancy { strategy row  column workspaceId  claim workspaceId }

    model Team {
      id          Int     @id
      workspaceId Int
      private     Boolean @default(false)
      members     TeamMember[]
      @@allow('all', private == false || id in auth().teamIds)
    }

    model TeamMember {
      id     Int  @id
      team   Team @relation(fields: [teamId], references: [id])
      teamId Int
      userId Int
      notes  Note[]
    }

    model Note {
      id           Int        @id
      teamMember   TeamMember @relation(fields: [teamMemberId], references: [id])
      teamMemberId Int
      text         String
    }
  `

  let pdb: any, admin: any
  beforeEach(async () => {
    pdb = await createClient({ db: ':memory:', schema: PRIVATE })
    const sys = pdb.asSystem()
    await sys.team.createMany({ data: [
      { id: 1, workspaceId: 10, private: true },
      { id: 2, workspaceId: 20, private: false },
    ] })
    await sys.teamMember.create({ data: { id: 1, teamId: 1, userId: 7 } })
    await sys.note.create({ data: { id: 1, teamMemberId: 1, text: 'n1' } })
    admin = pdb.$setAuth({ id: 1, workspaceId: 10, teamIds: [] })
  })

  test('a create naming a private team in your workspace is not refused as tenancy', async () => {
    await admin.teamMember.create({ data: { id: 2, teamId: 1, userId: 1 } })
    expect(await pdb.asSystem().teamMember.count({ where: { teamId: 1 } })).toBe(2)
  })

  test('and neither is one two hops down', async () => {
    await admin.note.create({ data: { id: 2, teamMemberId: 1, text: 'n2' } })
    expect(await pdb.asSystem().note.count()).toBe(2)
  })

  test('visibility is the child\'s own policy: with none, its tenant reads it', async () => {
    expect((await admin.teamMember.findMany()).map((m: any) => m.id)).toEqual([1])
    expect((await admin.note.findMany()).map((n: any) => n.text)).toEqual(['n1'])
  })

  test('a team in ANOTHER workspace is still refused as tenancy, public or not', async () => {
    const err = await thrown(admin.teamMember.create({ data: { id: 3, teamId: 2, userId: 1 } }))
    expect(err.name).toBe('AccessDeniedError')
    expect(err.message).toContain('Outside your workspaceId')
    const other = pdb.$setAuth({ id: 2, workspaceId: 20, teamIds: [] })
    expect(await other.teamMember.findMany()).toEqual([])
    expect(await other.note.findMany()).toEqual([])
  })
})

// FJS-519 kept a system client's tenancy denies while a tenant is in scope, and
// read that off the deny's `claim` — which only the column denies carried, so a
// system client scoped workspace 10's apps and read every workspace's deploys.
describe('a system client with a tenant in scope is scoped one hop away too (FJS-1370)', () => {
  const scopedSys = () => db.$setAuth({ workspaceId: 10 }).asSystem()

  test('reads are scoped through the parent', async () => {
    expect((await scopedSys().app.findMany()).map((a: any) => a.id)).toEqual([1])
    expect((await scopedSys().deploy.findMany()).map((d: any) => d.id)).toEqual([1])
    expect((await scopedSys().logLine.findMany()).map((l: any) => l.id)).toEqual([1])
  })

  test('a create into another tenant\'s parent is refused', async () => {
    const err = await thrown(scopedSys().deploy.create({ data: { id: 4, appId: 2, sha: 'ddd' } }))
    expect(err?.name).toBe('AccessDeniedError')
    expect(await db.asSystem().deploy.count({ where: { id: 4 } })).toBe(0)
  })

  test('a system client with no tenant in scope still reads every tenant', async () => {
    expect((await db.asSystem().deploy.findMany()).map((d: any) => d.id)).toEqual([1, 2])
    expect((await db.asSystem().logLine.findMany()).map((l: any) => l.id)).toEqual([1, 2])
  })
})
