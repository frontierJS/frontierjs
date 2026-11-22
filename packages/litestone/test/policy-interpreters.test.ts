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
  @@allow(read,   ${expr})
  @@allow(create, ${expr})
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
  // `auth().level` is graded rather than read, so it needs a principal the
  // shipped resolver grades above the others.
  { label: 'standing', p: { id: 'u2', isAdmin: true, teamIds: [] } },
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
  // arithmetic (`FJS-D1107`): precedence, a null operand, SQLite's round()
  `qty * 2 > 9`,
  `qty + 1 == 6`,
  `qty - 2 * 2 < 2`,
  `qty -1 >= 4`,
  `round(qty * 0.5) == 3`,
  `round(qty * 0.5) == 5`,
  `qty * 2 == null`,
  `qty * 2 != null`,
  `(qty > 5 ? qty * 2 : qty + 100) >= 18`,
  // membership, all three shapes of the right operand
  `status in ['published', 'review']`,
  `qty in [1, 5, 9]`,
  `ownerId in auth().teamIds`,
  `auth().id in editorIds`,
  // a list claim's presence binds its nullness, never the list (`FJS-4200`)
  `auth().teamIds == null`,
  `auth().teamIds != null`,
  `auth().teamIds == null || ownerId in auth().teamIds`,
  // the gate's grade, which no principal carries (`FJS-D296`)
  `auth().level >= 5`,
  `ownerId == auth().id || auth().level >= 5`,
  `auth().level == null`,
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

  // FJS-2135: `now() + <duration>` in a row policy. The offset moves the bound
  // instant in SQL and the evaluated one in JS, and both must land on the same
  // rows or a row create allows is one read then hides.
  it('agrees about the clock moved by a duration', async () => {
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
    const rows = [
      { id: 'overdue', openUntil: at(-30) },
      { id: 'soon',    openUntil: at(24) },
      { id: 'later',   openUntil: at(24 * 4) },
      { id: 'month',   openUntil: at(24 * 40) },
      { id: 'year',    openUntil: at(24 * 400) },
      { id: 'none',    openUntil: null },
    ]
    const readable = async (expr: string) =>
      (await verdicts(DOC(expr), rows, { id: 'u1' })).readable
    for (const expr of [
      `openUntil > now() && openUntil < now() + 2d`,
      `openUntil < now() - 1d`,
      `openUntil < now() + 1mo`,
      `openUntil < now() + 1yr`,
      `openUntil >= now() + 90min`,
    ]) {
      expect({ expr, disagreed: await agree(DOC(expr), rows, { id: 'u1' }) }).toEqual({ expr, disagreed: [] })
    }
    expect([...await readable(`openUntil > now() && openUntil < now() + 2d`)]).toEqual(['soon'])
    expect([...await readable(`openUntil < now() - 1d`)]).toEqual(['overdue'])
    expect([...await readable(`openUntil < now() + 1mo`)].sort()).toEqual(['later', 'overdue', 'soon'])
  })

  it('a duration offset works in @@scope and in a field @allow', async () => {
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
    const db: any = await createClient({ db: ':memory:', schema: `
model Task {
  id    Int       @id
  dueAt DateTime?
  note  String?   @allow(read, dueAt != null && dueAt < now() + 2d)
  @@scope(soon, dueAt > now() && dueAt < now() + 2d)
  @@gate(0)
}` })
    const sys = db.asSystem()
    await sys.task.create({ data: { id: 1, dueAt: at(24),     note: 'a' } })
    await sys.task.create({ data: { id: 2, dueAt: at(24 * 4), note: 'b' } })

    expect((await sys.task.findMany({ where: { $scope: 'soon' } })).map((r: any) => r.id)).toEqual([1])
    const seen = await db.$setAuth({ id: 'u1' }).task.findMany({ orderBy: { id: 'asc' } })
    expect(seen.map((r: any) => [r.id, r.note ?? null])).toEqual([[1, 'a'], [2, null]])
    db.$close()
  })

  it('agrees through a check() delegation, in both directions', async () => {
    const schema = `
model Team {
  id      String  @id
  ownerId String?
  @@allow(read,   ownerId == auth().id)
  @@allow(create, ownerId == auth().id)
}
model Doc {
  id     String @id
  teamId String?
  team   Team?  @relation(fields: [teamId], references: [id])
  @@allow(read,   check(team))
  @@allow(create, check(team))
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

  // `FJS-D221` — one hop, and the same obligation `check()` has one block up.
  // The two compilers reach a related row by different routes: a correlated
  // scalar subquery in the WHERE, and a synchronous SELECT off the payload's
  // foreign key. Nothing but this holds them together, and the SHAPES are where
  // they can part company — a null parent, a null column on a real parent, a
  // membership test whose list lives on the parent, and a mapped column.
  it('agrees across one relation hop, in every operand shape', async () => {
    const schema = `
model Owner {
  id        String   @id
  userId    String?
  ref       String   @map("reference")
  editorIds String[]
  @@gate(0)
}
model Doc {
  id      String @id
  ownerId String?
  owner   Owner? @relation(fields: [ownerId], references: [id])
  @@allow(read,   EXPR)
  @@allow(create, EXPR)
}
`
    const OWNERS = [
      { id: 'o1', userId: 'u1',  ref: 'A',      editorIds: [] },
      { id: 'o2', userId: 'u2',  ref: 'PUBLIC', editorIds: ['u1'] },
      { id: 'o3', userId: null,  ref: 'B',      editorIds: [] },
    ]
    // r4 names NO parent, which is the row the two halves are likeliest to
    // answer differently about: `check()` allows an absent foreign key on
    // purpose, and a path must not — a missing parent is a missing VALUE.
    const ROWS = [
      { id: 'r1', ownerId: 'o1' },
      { id: 'r2', ownerId: 'o2' },
      { id: 'r3', ownerId: 'o3' },
      { id: 'r4', ownerId: null },
    ]

    for (const expr of [
      `owner.userId == auth().id`,
      `auth().id == owner.userId`,
      `owner.userId == null`,
      `owner.userId != null`,
      `owner.ref == 'PUBLIC'`,
      `auth().id in owner.editorIds`,
      `owner.userId == auth().id || owner.ref == 'PUBLIC'`,
      `owner.userId != null ? owner.userId == auth().id : true`,
      // the relation itself: SQL reads the foreign key, and so must JS
      `owner == null`,
      `owner != null`,
    ]) {
      const db  = await createClient({ schema: schema.replaceAll('EXPR', expr), db: ':memory:' })
      const sys = db.asSystem()
      for (const o of OWNERS) await sys.owner.create({ data: o })
      for (const r of ROWS)   await sys.doc.create({ data: r })

      for (const who of ['u1', 'u2']) {
        const scoped   = db.$setAuth({ id: who })
        const readable = new Set((await scoped.doc.findMany()).map((x: any) => x.id))
        for (const r of ROWS) {
          let created = false
          try { await scoped.doc.create({ data: { ...r, id: `${r.id}-${who}` } }); created = true }
          catch (e: any) { if (e.constructor.name !== 'AccessDeniedError') throw e }
          expect({ expr, who, row: r.id, created })
            .toEqual({ expr, who, row: r.id, created: readable.has(r.id) })
        }
      }
      db.$close()
    }
  }, 30000)

  // The pair for the block above. Agreement is cheap for a rule that admits
  // nobody or everybody, so the grid has to be shown to SEPARATE rows — and
  // separate them by the PARENT's column, since a rule keyed on the child's own
  // `ownerId` would pass every assertion above with the hop compiled away.
  it('one hop actually decides — the parent column is what admits the row', async () => {
    const schema = `
model Owner { id String @id  userId String? }
model Doc {
  id      String @id
  ownerId String?
  owner   Owner? @relation(fields: [ownerId], references: [id])
  @@allow(read, owner.userId == auth().id)
}
`
    const db  = await createClient({ schema, db: ':memory:' })
    const sys = db.asSystem()
    await sys.owner.create({ data: { id: 'o1', userId: 'u1' } })
    await sys.owner.create({ data: { id: 'o2', userId: 'u2' } })
    await sys.doc.create({ data: { id: 'mine',    ownerId: 'o1' } })
    await sys.doc.create({ data: { id: 'theirs',  ownerId: 'o2' } })
    await sys.doc.create({ data: { id: 'orphan',  ownerId: null } })

    const read = async (who: string | null) =>
      (await db.$setAuth(who ? { id: who } : null).doc.findMany()).map((x: any) => x.id).sort()

    expect(await read('u1')).toEqual(['mine'])
    expect(await read('u2')).toEqual(['theirs'])
    // An absent parent is an absent VALUE, so the comparison is UNKNOWN and an
    // @@allow keeps no row — the same answer the SQL half gives for free,
    // because a scalar subquery over no row IS NULL.
    expect(await read(null)).toEqual([])
    db.$close()
  })

  // `FJS-D566` — any row of a to-many. The oracle is `$readAs`, not create:
  // a row being created has no children, so create answers false for every
  // rule and would agree with any SQL half that also said false. `$readAs`
  // runs the SAME JS evaluator over a STORED row, and it is what grades a
  // broadcast — so this is also the proof a live socket is graded against the
  // membership row rather than a snapshot of it.
  it('agrees across a to-many test, in every shape the node sits in', async () => {
    const schema = `
model Team {
  id      String       @id
  private Boolean      @default(false)
  members TeamMember[]
  @@allow(read, EXPR)
}
model TeamMember {
  id        String    @id
  teamId    String
  team      Team      @relation(fields: [teamId], references: [id])
  userId    String
  status    String    @default("active")
  deletedAt DateTime?
  @@softDelete
}
`
    for (const expr of [
      `members.some(userId == auth().id)`,
      `members.some(userId == auth().id && status == 'active')`,
      `members.some(userId == auth().id || status == 'revoked')`,
      `!members.some(userId == auth().id)`,
      `private == false || members.some(userId == auth().id)`,
      `members.some(userId in auth().teamIds)`,
      `members.some(status != 'active')`,
      `members.some(userId == auth().id) && members.some(status == 'active')`,
    ]) {
      const db: any = await createClient({ schema: schema.replaceAll('EXPR', expr), db: ':memory:', claims: ['teamIds'] })
      const sys = db.asSystem()
      for (const t of [{ id: 'ENG' }, { id: 'SEC', private: true }, { id: 'DES', private: true }, { id: 'EMPTY', private: true }])
        await sys.team.create({ data: t })
      for (const m of [
        { id: 'm1', teamId: 'SEC', userId: 'u1' },
        { id: 'm2', teamId: 'DES', userId: 'u2' },
        { id: 'm3', teamId: 'DES', userId: 'u1', status: 'revoked' },
        { id: 'm4', teamId: 'ENG', userId: 'u2' },
        { id: 'm5', teamId: 'EMPTY', userId: 'u1' },
      ]) await sys.teamMember.create({ data: m })
      // A removed membership is not one of the relation's rows, in either half.
      await sys.teamMember.remove({ where: { id: 'm5' } })

      const all = await sys.team.findMany()
      for (const p of [{ id: 'u1', teamIds: ['u2'] }, { id: 'u2', teamIds: [] }, { id: 'u9', teamIds: ['u1'] }, null]) {
        const sql = new Set((await db.$setAuth(p).team.findMany()).map((x: any) => x.id))
        for (const row of all) {
          const js = (await db.$readAs('team', row, p)) != null
          expect({ expr, who: p?.id ?? null, row: row.id, js })
            .toEqual({ expr, who: p?.id ?? null, row: row.id, js: sql.has(row.id) })
        }
      }
      db.$close()
    }
  }, 30000)

  // `FJS-D2239` — inside `rel.some(…)` a bare name is the child's, and
  // `this.col` is the row the rule is declared on: four-eyes, *no approver is
  // the author*. The table and the column are both mapped, so a correlation
  // that named the model or the field rather than what SQLite stores is a
  // string constant and matches nothing.
  it('agrees across a to-many test that names the parent row with this.col', async () => {
    const schema = `
model Repository {
  id       String   @id
  authorId String?  @map("author_id")
  accesses Access[]
  @@map("repos")
  @@allow(read, EXPR)
}
model Access {
  id           String     @id
  repositoryId String
  repository   Repository @relation(fields: [repositoryId], references: [id])
  userId       String
}
`
    const cases: [string, Record<string, string[]>][] = [
      [`accesses.some(userId == this.authorId)`,                         { u1: ['A', 'C'], u2: ['A', 'C'], none: ['A', 'C'] }],
      [`!accesses.some(userId == this.authorId)`,                        { u1: ['B', 'D', 'E'], u2: ['B', 'D', 'E'], none: ['B', 'D', 'E'] }],
      [`accesses.some(userId == auth().id && userId != this.authorId)`,  { u1: ['B', 'C'], u2: [], none: [] }],
      [`accesses.some(this.authorId == userId && userId == auth().id)`,  { u1: ['A'], u2: ['C'], none: [] }],
      [`accesses.some(this.authorId == null)`,                           { u1: ['E'], u2: ['E'], none: ['E'] }],
    ]
    for (const [expr, want] of cases) {
      const db: any = await createClient({ schema: schema.replaceAll('EXPR', expr), db: ':memory:' })
      // A write to the parent's column changes who may read it, so it is in the reach.
      if (expr === cases[0][0])
        expect(db.$readColumns('repository')).toEqual({ Access: ['repositoryId', 'userId'], Repository: ['authorId', 'id'] })
      const sys = db.asSystem()
      for (const r of [
        { id: 'A', authorId: 'u1' }, { id: 'B', authorId: 'u2' }, { id: 'C', authorId: 'u2' },
        { id: 'D', authorId: 'u3' }, { id: 'E', authorId: null },
      ]) await sys.repository.create({ data: r })
      for (const [id, repositoryId, userId] of [
        ['a1', 'A', 'u1'], ['b1', 'B', 'u1'], ['c1', 'C', 'u1'], ['c2', 'C', 'u2'], ['e1', 'E', 'u1'],
      ]) await sys.access.create({ data: { id, repositoryId, userId } })

      const all = await sys.repository.findMany()
      for (const who of ['u1', 'u2', 'none']) {
        const p   = who === 'none' ? null : { id: who }
        const sql = (await db.$setAuth(p).repository.findMany()).map((x: any) => x.id).sort()
        const js  = []
        for (const row of all) if ((await db.$readAs('repository', row, p)) != null) js.push(row.id)
        expect({ expr, who, sql, js: js.sort() }).toEqual({ expr, who, sql: want[who], js: want[who] })
      }
      db.$close()
    }
  }, 30000)

  // `FJS-D2291` — `every` and `none` beside `some`. The empty set is vacuously
  // true for both; a child whose condition is NULL fails `every` (the test is
  // `IS NOT TRUE`) and is not a hit for `none`. A soft-deleted child is not one
  // of the relation's rows, so the red check on P5 does not count. The chained
  // form runs a different compiler (`chainedSomeSql`), so Merge asks it too.
  it('agrees across every(…) and none(…), and pins the empty set and NULL', async () => {
    const schema = `
model PullRequest {
  id      String  @id
  headSha String
  checks  Check[]
  merges  Merge[]
  @@allow(read, EXPR)
}
model Check {
  id            String      @id
  pullRequestId String
  pullRequest   PullRequest @relation(fields: [pullRequestId], references: [id])
  sha           String
  state         String?
  deletedAt     DateTime?
  @@softDelete
}
model Merge {
  id            String      @id
  pullRequestId String
  pullRequest   PullRequest @relation(fields: [pullRequestId], references: [id])
  @@allow(read, CHAINED)
}
`
    const cases: [string, string[]][] = [
      [`checks.every(state == 'green')`,                         ['P1', 'P3', 'P5', 'P6']],
      [`checks.every(state == 'green' && sha == this.headSha)`,  ['P1', 'P3', 'P5']],
      [`!checks.every(state == 'green')`,                        ['P2', 'P4']],
      [`checks.none(state == 'red')`,                            ['P1', 'P3', 'P4', 'P5', 'P6']],
      [`!checks.none(state == 'red')`,                           ['P2']],
      [`checks.none(sha != this.headSha)`,                       ['P1', 'P2', 'P3', 'P4', 'P5']],
    ]
    for (const [expr, want] of cases) {
      const chained = expr.replace('checks.', 'pullRequest.checks.').replaceAll('this.headSha', 'this.pullRequest.headSha')
      const usable  = !chained.includes('this.pullRequest')
      const db: any = await createClient({ db: ':memory:', schema: schema
        .replaceAll('EXPR', expr).replaceAll('CHAINED', usable ? chained : 'true') })
      const sys = db.asSystem()
      for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'])
        await sys.pullRequest.create({ data: { id, headSha: id === 'P6' ? 'h2' : 'h1' } })
      for (const [id, pullRequestId, state] of [
        ['c1', 'P1', 'green'], ['c2', 'P1', 'green'], ['c3', 'P2', 'green'], ['c4', 'P2', 'red'],
        ['c5', 'P4', 'green'], ['c6', 'P4', null],    ['c7', 'P5', 'green'], ['c8', 'P5', 'red'],
        ['c9', 'P6', 'green'],
      ]) await sys.check.create({ data: { id, pullRequestId, state, sha: 'h1' } })
      await sys.check.remove({ where: { id: 'c8' } })
      for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'])
        await sys.merge.create({ data: { id: `m${id}`, pullRequestId: id } })

      const sql = (await db.pullRequest.findMany()).map((x: any) => x.id).sort()
      const js  = []
      for (const row of await sys.pullRequest.findMany()) if ((await db.$readAs('pullRequest', row, null)) != null) js.push(row.id)
      expect({ expr, sql, js: js.sort() }).toEqual({ expr, sql: want, js: want })

      if (usable) {
        const msql = (await db.merge.findMany()).map((x: any) => x.pullRequestId).sort()
        const mjs  = []
        for (const row of await sys.merge.findMany()) if ((await db.$readAs('merge', row, null)) != null) mjs.push(row.pullRequestId)
        expect({ chained, msql, mjs: mjs.sort() }).toEqual({ chained, msql: want, mjs: want })
      }
      db.$close()
    }
  }, 30000)

  it('prints every(…) and none(…) back as written', async () => {
    const { policyExprToString } = await import('../src/core/policy.js') as any
    const { parse } = await import('../src/core/parser.js') as any
    for (const src of [`checks.every(state == 'green')`, `checks.none(state == 'red')`, `p.checks.every(state == 'green')`]) {
      const { schema } = parse(`model P { id Int @id; p P? @relation(fields: [pId], references: [id]); pId Int?; checks C[]; ` +
        `@@allow(read, ${src}) } model C { id Int @id; pId Int; p P @relation(fields: [pId], references: [id]); state String? }`)
      expect(policyExprToString(schema.models[0].attributes.find((x: any) => x.kind === 'allow').expr)).toBe(src)
    }
  })

  it('refuses this.col where it cannot mean the declaring row', async () => {
    const at = (expr: string, cols = '') => createClient({ db: ':memory:', schema: `
model Repository {
  id       String   @id
  authorId String?
  secret   String?  @encrypted
  ${cols}
  accesses Access[]
  @@allow(read, ${expr})
}
model Access {
  id           String     @id
  repositoryId String
  repository   Repository @relation(fields: [repositoryId], references: [id])
  userId       String
}
`, encryptionKey: 'k'.repeat(64) })
    // Outside a some(…) the row is the one being tested, and the bare name says it.
    await expect(at(`this.authorId == auth().id`)).rejects.toThrow(/write 'authorId'/)
    await expect(at(`accesses.some(userId == this.nope)`)).rejects.toThrow(/'nope' is not a field on Repository/)
    await expect(at(`accesses.some(userId == this.accesses)`)).rejects.toThrow(/no column/)
    await expect(at(`accesses.some(userId == this.secret)`)).rejects.toThrow(/@encrypted/)
    await expect(at(`accesses.some(userId == this.authorId.id)`)).rejects.toThrow(/one hop/)
  })

  // `FJS-D1027` — two to-one hops. The SQL half joins the hops in one scalar
  // subquery and the JS half binds the row's first foreign key into the same
  // text; a null anywhere along the chain is where they can part company.
  it('agrees across a two-hop path, with a null at every link', async () => {
    const schema = `
model Customer { id String @id  userId String? @map("user_id")  orders Order[]  @@gate(0) }
model Order {
  id         String    @id
  customerId String?
  customer   Customer? @relation(fields: [customerId], references: [id])
  lines      Line[]
  @@gate(0)
}
model Line {
  id      String @id
  orderId String?
  order   Order? @relation(fields: [orderId], references: [id])
  @@allow(read, EXPR)
}
`
    const cases: [string, Record<string, string[]>][] = [
      [`order.customer.userId == auth().id`,                 { u1: ['l1'], u2: ['l2'], none: [] }],
      // A broken link anywhere is an absent value, so `== null` holds for it.
      [`order.customer.userId == null`,                      { u1: ['l3', 'l4', 'l5'], u2: ['l3', 'l4', 'l5'], none: ['l3', 'l4', 'l5'] }],
      [`order.customer.userId != null`,                      { u1: ['l1', 'l2'], u2: ['l1', 'l2'], none: ['l1', 'l2'] }],
      [`order.customer.userId == auth().id || order == null`, { u1: ['l1', 'l5'], u2: ['l2', 'l5'], none: ['l5'] }],
    ]
    for (const [expr, want] of cases) {
      const db: any = await createClient({ schema: schema.replaceAll('EXPR', expr), db: ':memory:' })
      const sys = db.asSystem()
      for (const c of [{ id: 'c1', userId: 'u1' }, { id: 'c2', userId: 'u2' }, { id: 'c3', userId: null }])
        await sys.customer.create({ data: c })
      for (const o of [{ id: 'o1', customerId: 'c1' }, { id: 'o2', customerId: 'c2' }, { id: 'o3', customerId: 'c3' }, { id: 'o4', customerId: null }])
        await sys.order.create({ data: o })
      for (const l of [{ id: 'l1', orderId: 'o1' }, { id: 'l2', orderId: 'o2' }, { id: 'l3', orderId: 'o3' }, { id: 'l4', orderId: 'o4' }, { id: 'l5', orderId: null }])
        await sys.line.create({ data: l })

      const all = await sys.line.findMany()
      for (const who of ['u1', 'u2', 'none']) {
        const p   = who === 'none' ? null : { id: who }
        const sql = (await db.$setAuth(p).line.findMany()).map((x: any) => x.id).sort()
        const js  = []
        for (const row of all) if ((await db.$readAs('line', row, p)) != null) js.push(row.id)
        expect({ expr, who, sql, js: js.sort() }).toEqual({ expr, who, sql: want[who], js: want[who] })
      }
      db.$close()
    }
  }, 30000)

  // A chained `.some(…)` compiles two ways: collapsed onto the child's own key
  // where the to-many hangs off the key the last hop points at, and joined
  // otherwise. `customer.orders` comes back to the table the rule is declared
  // on, so an unaliased hop would compare the order with itself.
  it('agrees across a chained to-many test, collapsed and joined', async () => {
    const schema = `
model Org { id String @id  members Member[]  customers Customer[]  @@gate(0) }
model Member {
  id        String    @id
  orgId     String
  org       Org       @relation(fields: [orgId], references: [id])
  userId    String
  role      String
  deletedAt DateTime?
  @@softDelete
}
model Customer {
  id     String  @id
  orgId  String?
  org    Org?    @relation(fields: [orgId], references: [id])
  orders Order[]
  @@gate(0)
}
model Order {
  id         String    @id
  customerId String?
  customer   Customer? @relation(fields: [customerId], references: [id])
  authorId   String?   @map("author_id")
  @@map("orders")
  @@allow(read, EXPR)
}
`
    const cases: [string, Record<string, string[]>][] = [
      [`customer.org.members.some(userId == auth().id)`,                     { u1: ['o1', 'o5'], u2: ['o1', 'o2', 'o5'], none: [] }],
      [`customer.org.members.some(userId == auth().id && role == 'finance')`, { u1: ['o1', 'o5'], u2: ['o2'], none: [] }],
      // No org at the end of the chain is no member, so the negation admits it.
      [`!customer.org.members.some(userId == auth().id)`,                    { u1: ['o2', 'o3', 'o4'], u2: ['o3', 'o4'], none: ['o1', 'o2', 'o3', 'o4', 'o5'] }],
      [`customer.org.members.some(userId == this.authorId)`,                 { u1: ['o1', 'o2', 'o5'], u2: ['o1', 'o2', 'o5'], none: ['o1', 'o2', 'o5'] }],
      [`customer.orders.some(authorId == auth().id)`,                        { u1: ['o1', 'o3', 'o5'], u2: ['o1', 'o2', 'o5'], none: [] }],
    ]
    for (const [expr, want] of cases) {
      const db: any = await createClient({ schema: schema.replaceAll('EXPR', expr), db: ':memory:' })
      const sys = db.asSystem()
      for (const g of [{ id: 'g1' }, { id: 'g2' }]) await sys.org.create({ data: g })
      for (const m of [
        { id: 'm1', orgId: 'g1', userId: 'u1', role: 'finance' },
        { id: 'm2', orgId: 'g1', userId: 'u2', role: 'support' },
        { id: 'm3', orgId: 'g2', userId: 'u2', role: 'finance' },
        { id: 'm4', orgId: 'g2', userId: 'u1', role: 'admin' },
      ]) await sys.member.create({ data: m })
      // A removed membership grants nothing, in either half.
      await sys.member.remove({ where: { id: 'm4' } })
      for (const c of [{ id: 'c1', orgId: 'g1' }, { id: 'c2', orgId: 'g2' }, { id: 'c3', orgId: null }])
        await sys.customer.create({ data: c })
      for (const o of [
        { id: 'o1', customerId: 'c1', authorId: 'u1' }, { id: 'o2', customerId: 'c2', authorId: 'u2' },
        { id: 'o3', customerId: 'c3', authorId: 'u1' }, { id: 'o4', customerId: null, authorId: 'u2' },
        { id: 'o5', customerId: 'c1', authorId: 'u2' },
      ]) await sys.order.create({ data: o })

      const all = await sys.order.findMany()
      for (const who of ['u1', 'u2', 'none']) {
        const p   = who === 'none' ? null : { id: who }
        const sql = (await db.$setAuth(p).order.findMany()).map((x: any) => x.id).sort()
        const js  = []
        for (const row of all) if ((await db.$readAs('order', row, p)) != null) js.push(row.id)
        expect({ expr, who, sql, js: js.sort() }).toEqual({ expr, who, sql: want[who], js: want[who] })
      }
      db.$close()
    }
  }, 30000)

  it('agrees with a @@deny standing beside the @@allow', async () => {
    const schema = `
model Doc {
  id      String @id
  status  String?
  ownerId String?
  @@allow(read,   ownerId == auth().id)
  @@allow(create, ownerId == auth().id)
  @@deny(read,    status == 'locked')
  @@deny(create,  status == 'locked')
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
  @@allow(read,   ${expr})
  @@allow(create, ${expr})
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
  @@allow(read,   qty > 5)
  @@allow(create, qty > 5)
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
  @@allow(read,   n > 0)
  @@allow(create, n > 0)
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
  dbl Int? @generated("qty * 2")
  @@allow(create, qty > 0)
  @@deny(create,  dbl > 10)
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
  @@allow(read,   tag == 'x')
  @@allow(create, tag == 'x')
}
`
    const db = await createClient({ schema, db: ':memory:' })
    const made = await db.$setAuth({ id: 'u1' }).doc.create({ data: { id: 'a', tag: 'x' }, system: ['tag'] })
    expect(made.tag).toBe('x')
    db.$close()
  })
})

// FJS-2197: a TEXT column read as a predicate is its numeric prefix to SQLite,
// so '0' is false there; JS truthiness called it true and create allowed a row
// that read then hid.
describe('a String column used as a predicate', () => {
  const rows: Row[] = ['0', '1', '', 'abc', '0.0', ' 2', '1abc', 'false'].map((flag, i) => ({ id: `t${i}`, flag }))
  const schema = (expr: string) => `
model Doc {
  id   String @id
  flag String?
  @@allow(read,   ${expr})
  @@allow(create, ${expr})
}
`
  for (const expr of [`flag`, `!flag`, `flag ? true : false`, `flag && true`]) {
    it(`agrees about every row: ${expr}`, async () => {
      expect({ expr, disagreed: await agree(schema(expr), rows, { id: 'u1' }) }).toEqual({ expr, disagreed: [] })
    })
  }
})

// FJS-2215 — a belongsTo field names the RELATION and the value is on the
// foreign key. `owner == auth()` always read the key; `owner == auth().id` read
// a column called `owner` in both halves and matched nothing.
describe('a belongsTo field read through a claim', () => {
  const SCHEMA = `
model User { id Int @id
  @@auth
  @@gate(0) }
model Doc {
  id      Int  @id
  ownerId Int
  owner   User @relation(fields: [ownerId], references: [id])
  @@allow(read,   owner == auth().id)
  @@allow(create, owner == auth().id)
}
`
  it('read and create admit the caller\'s own row and refuse another\'s', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    const sys = db.asSystem() as any
    await sys.user.create({ data: { id: 1 } })
    await sys.user.create({ data: { id: 2 } })
    await sys.doc.create({ data: { id: 1, ownerId: 1 } })
    await sys.doc.create({ data: { id: 2, ownerId: 2 } })
    const u1 = db.$setAuth({ id: 1 }) as any
    expect((await u1.doc.findMany()).map((r: any) => r.id)).toEqual([1])
    await u1.doc.create({ data: { id: 3, ownerId: 1 } })
    await expect(u1.doc.create({ data: { id: 4, ownerId: 2 } })).rejects.toThrow()
    db.$close()
  })
})

// FJS-1724 — the generated tenant deny compiled to `NOT (? IS NULL OR col != ?)`,
// which no index serves, so a scoped read scanned every tenant's rows. The pass
// form `? IS NOT NULL AND col = ?` has the same truth table and a SEARCH.
describe('the tenant deny on a row-tenancy model', () => {
  const SCHEMA = `
tenancy { strategy row  column workspaceId  claim workspaceId }
model Doc {
  id          String @id
  workspaceId String
  title       String?
  @@index([workspaceId])
}
`
  it('plans a SEARCH on the tenant index, and the rows are the same', async () => {
    const { Database } = await import('bun:sqlite')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-tenant-scan-'))
    const file = join(dir, 'db.sqlite')
    try {
      const seen: any[] = []
      const db: any = await createClient({ schema: SCHEMA, db: file, onQuery: (e: any) => seen.push(e) })
      const sys = db.asSystem()
      for (let i = 0; i < 300; i++) await sys.doc.create({ data: { id: `d${i}`, workspaceId: i % 30 === 0 ? 'W1' : `W${2 + (i % 20)}` } })

      seen.length = 0
      const w1 = await db.$setAuth({ id: 'u', workspaceId: 'W1' }).doc.findMany()
      expect(w1.length).toBe(10)
      expect(w1.every((r: any) => r.workspaceId === 'W1')).toBe(true)
      const q = seen.find(e => e.operation === 'findMany')

      const raw = new Database(file, { readonly: true })
      try {
        const plan = (raw.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params) as any[]).map(r => r.detail).join(' | ')
        expect(plan).toMatch(/SEARCH doc USING INDEX idx_doc_workspaceId/)
      } finally { raw.close() }

      // No principal carries no tenant: the deny still refuses every row.
      expect(await db.$setAuth({ id: 'u' }).doc.findMany()).toEqual([])
      db.$close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a scalar where a claim is read as a LIST', () => {
  // FJS-3038: `$setAuth({ teachingCourseIds: course.id })` is a mistake the SQL
  // half silently forgave by wrapping the scalar, while the JS half read a
  // string as a JSON document and a number as a one-item list.
  for (const [label, claim] of [['a string', 'u1'], ['a number', 7]] as const) {
    it(`reads ${label} in a list claim as an empty list, in both halves`, async () => {
      const { readable, creatable } = await verdicts(
        DOC(`ownerId in auth().teamIds`, ''),
        [{ id: 'r1', ownerId: 'u1' }, { id: 'r2', ownerId: '7' }],
        { id: 'u9', teamIds: claim },
        { claims: ['teamIds'] })
      expect([...readable]).toEqual([])
      expect([...creatable]).toEqual([])
    })
  }

  it('still admits a row the array claim names', async () => {
    const { readable, creatable } = await verdicts(
      DOC(`ownerId in auth().teamIds`),
      [{ id: 'r1', ownerId: 'u1' }, { id: 'r2', ownerId: 'u2' }],
      { id: 'u9', teamIds: ['u1'] },
      { claims: ['teamIds'] })
    expect([...readable]).toEqual(['r1'])
    expect([...creatable]).toEqual(['r1'])
  })
})

// ─── @@require: a rule about the data, graded under asSystem() (FJS-1878) ────
//
// `@@deny` is the caller tier and `asSystem()` drops it, so a carrier send, an
// automation and a job all wrote past a consent the schema stated. `@@require`
// takes the same predicate and holds for every writer.
describe('@@require is graded under asSystem()', () => {
  const SCHEMA = `
model Conversation {
  id         Int       @id @default(autoincrement())
  optedOutAt DateTime?
  messages   Message[]
}
model Message {
  id             Int          @id @default(autoincrement())
  direction      String
  conversationId Int
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  @@require(create, direction == 'inbound' || conversation.optedOutAt == null, 'They texted STOP.')
}`

  const build = async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const sys = db.asSystem()
    const open = await sys.conversation.create({ data: {} })
    const stopped = await sys.conversation.create({ data: { optedOutAt: new Date().toISOString() } })
    return { db, sys, open, stopped }
  }

  it('refuses an outbound row for an opted-out conversation, system or not', async () => {
    const { db, sys, stopped } = await build()
    const data = { direction: 'outbound', conversationId: stopped.id }
    await expect(sys.message.create({ data })).rejects.toThrow('They texted STOP.')
    await expect(db.$setAuth({ id: 1 }).message.create({ data })).rejects.toThrow('They texted STOP.')
    db.$close()
  })

  it('admits an inbound row for the same conversation and an outbound row for an open one', async () => {
    const { db, sys, open, stopped } = await build()
    await sys.message.create({ data: { direction: 'inbound', conversationId: stopped.id } })
    await sys.message.create({ data: { direction: 'outbound', conversationId: open.id } })
    expect(await sys.message.count()).toBe(2)
    db.$close()
  })

  it('refuses a rule on an operation it cannot grade, by name', async () => {
    const bad = SCHEMA.replace('(create,', '(read,')
    await expect(createClient({ schema: bad, db: ':memory:' })).rejects.toThrow(/cannot grade read/)
  })
})

// ─── @@require on update and delete: the STORED row (FJS-3284, FJS-D1261) ────
//
// The same rule on the other half of the write: the predicate is graded on the
// row as stored, through the WHERE the write already carries, so `asSystem()`
// cannot edit or remove a row the schema says is frozen.
describe('@@require(update | delete) is graded against the stored row, under asSystem()', () => {
  const SCHEMA = `
model Doc {
  id      Int    @id @default(autoincrement())
  status  String @default('open')
  builtIn Boolean @default(false)
  @@require(update, status != 'archived')
  @@require(delete, builtIn == false)
}`

  const build = async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const sys = db.asSystem()
    const open     = await sys.doc.create({ data: {} })
    const archived = await sys.doc.create({ data: { status: 'archived' } })
    const builtIn  = await sys.doc.create({ data: { builtIn: true } })
    return { db, sys, open, archived, builtIn }
  }

  it('refuses an update of an archived row, system or not, and admits an open one', async () => {
    const { db, sys, open, archived } = await build()
    // The WHERE excludes the row, as an update policy does: nothing is reached.
    // The system caller is told so (FJS-D2218); a scoped one sees a miss.
    await expect(sys.doc.update({ where: { id: archived.id }, data: { status: 'open' } })).rejects.toThrow(/refused by @@require\(update\)/)
    expect(await db.$setAuth({ id: 1 }).doc.update({ where: { id: archived.id }, data: { status: 'open' } })).toBeNull()
    expect((await sys.doc.findUnique({ where: { id: archived.id } })).status).toBe('archived')
    await sys.doc.update({ where: { id: open.id }, data: { status: 'archived' } })
    expect((await sys.doc.findUnique({ where: { id: open.id } })).status).toBe('archived')
    db.$close()
  })

  it('narrows a bulk update to the rows it admits', async () => {
    const { db, sys } = await build()
    const { count } = await sys.doc.updateMany({ where: {}, data: { status: 'touched' } })
    expect(count).toBe(2)
    expect(await sys.doc.count({ where: { status: 'archived' } })).toBe(1)
    db.$close()
  })

  it('refuses a delete of a built-in row, system or not, and admits another', async () => {
    const { db, sys, open, builtIn } = await build()
    await expect(sys.doc.delete({ where: { id: builtIn.id } })).rejects.toThrow(/refused by @@require\(delete\)/)
    expect(await sys.doc.count({ where: { id: builtIn.id } })).toBe(1)
    await sys.doc.delete({ where: { id: open.id } })
    expect(await sys.doc.count({ where: { id: open.id } })).toBe(0)
    // A bulk delete narrows to the rows it may remove.
    expect(await sys.doc.deleteMany({ where: {} })).toEqual({ count: 1 })
    expect(await sys.doc.count()).toBe(1)
    db.$close()
  })
})

// FJS-D2240: a numeric @from aggregate is read through the subquery it already
// compiles to, in both halves; the count is every child row that exists,
// whoever asks.
describe('a policy reading a @from aggregate', () => {
  const SCHEMA = (rules: string, review = '') => `
model Pull {
  id        Int      @id
  title     String?
  reviews   Review[]
  approvals Int      @from(Review, count: true, where: approved == true)
  score     Int      @from(Review, sum: weight)
  anyReview Boolean  @from(Review, exists: true)
  ${rules}
}
model Review {
  id       Int     @id
  pullId   Int
  pull     Pull    @relation(fields: [pullId], references: [id])
  approved Boolean @default(false)
  weight   Int     @default(1)
  authorId Int?
  ${review}
}`

  const build = async (rules: string, review = '') => {
    const db  = await createClient({ schema: SCHEMA(rules, review), db: ':memory:' })
    const sys = db.asSystem()
    for (const id of [1, 2, 3]) await sys.pull.create({ data: { id } })
    // Pull 1: two approvals. Pull 2: one approval, one not. Pull 3: none.
    for (const [id, pullId, approved, authorId] of [[1, 1, true, 7], [2, 1, true, 8], [3, 2, true, 7], [4, 2, false, 8]] as const)
      await sys.review.create({ data: { id, pullId, approved, authorId } })
    return { db, sys }
  }

  it('@@require(postUpdate) grades the count after the write (the JS half)', async () => {
    const { db, sys } = await build(`@@require(postUpdate, approvals >= 2, 'Two approvals merge.')`)
    await sys.pull.update({ where: { id: 1 }, data: { title: 'merged' } })
    await expect(sys.pull.update({ where: { id: 2 }, data: { title: 'merged' } })).rejects.toThrow(/Two approvals merge/)
    expect((await sys.pull.findUnique({ where: { id: 2 } })).title).toBeNull()
    db.$close()
  })

  it('@@require(update) grades the stored row (the SQL half), one and many', async () => {
    const { db, sys } = await build(`@@require(update, approvals >= 2)`)
    await sys.pull.update({ where: { id: 1 }, data: { title: 'merged' } })
    await expect(sys.pull.update({ where: { id: 2 }, data: { title: 'merged' } })).rejects.toThrow(/refused by @@require\(update\)/)
    expect(await sys.pull.updateMany({ where: {}, data: { title: 'x' } })).toEqual({ count: 1 })
    db.$close()
  })

  // Pull 1: approvals 2, score 2, a review. Pull 2: 1, 2, a review. Pull 3: 0, 0, none.
  it.each([
    ['score > 1',                   [1, 2]],
    ['anyReview',                   [1, 2]],
    ['!anyReview',                  [3]],
    ['approvals * 2 > score',       [1]],
    ['approvals == 1 || score == 0', [2, 3]],
    ['approvals in [0, 2]',         [1, 3]],
    ['score == null',               []],
  ])('both halves admit the same rows: %s', async (expr, expected) => {
    const admitted = async (op: string) => {
      const { db, sys } = await build(`@@require(${op}, ${expr})`)
      const ids = []
      for (const id of [1, 2, 3]) {
        try { await sys.pull.update({ where: { id }, data: { title: 'probe' } }); ids.push(id) }
        catch (e: any) { if (e.constructor.name !== 'AccessDeniedError') throw e }
      }
      db.$close()
      return ids
    }
    expect(await admitted('update')).toEqual(expected)
    expect(await admitted('postUpdate')).toEqual(expected)
  })

  it('a read policy counts every child row, not the ones the caller may read', async () => {
    const { db } = await build(`@@allow(read, approvals >= 2)`, `@@allow(read, authorId == auth().id)`)
    const ids = (await db.$setAuth({ id: 7 }).pull.findMany()).map((p: any) => p.id)
    expect(ids).toEqual([1])
    db.$close()
  })

  it('still refuses an @from that picks a row', async () => {
    await expect(build(`latest Review? @from(Review, last: true)\n  @@require(update, latest != null)`))
      .rejects.toThrow(/'latest' is @from\(…, first\/last\)/)
  })
})

// `FJS-D2239`: `this.col` in an @from where: names the row the @from is
// declared on. Pull 1's head is 'a', Pull 2's 'b' and Pull 3 has none, so a
// review on another commit, and every review of Pull 3, is not counted.
describe('an @from where: naming the declaring row as this.col', () => {
  const SCHEMA = (rules = '', review = '') => `
model Pull {
  id          Int      @id
  title       String?
  headSha     String?  @map("head_sha")
  reviews     Review[]
  approvals   Int      @from(Review, count: true, where: commitSha == this.headSha && approved == true)
  firstOnHead Review?  @from(Review, first: true, where: commitSha == this.headSha)
  ${rules}
}
model Review {
  id        Int     @id
  pullId    Int
  pull      Pull    @relation(fields: [pullId], references: [id])
  commitSha String? @map("commit_sha")
  approved  Boolean @default(false)
  authorId  Int?
  ${review}
}`

  const build = async (rules = '', review = '') => {
    const db  = await createClient({ schema: SCHEMA(rules, review), db: ':memory:' })
    const sys = db.asSystem()
    for (const [id, headSha] of [[1, 'a'], [2, 'b'], [3, null]] as const) await sys.pull.create({ data: { id, headSha } })
    for (const [id, pullId, commitSha, approved, authorId] of [
      [1, 1, 'a', true, 7], [2, 1, 'old', true, 8], [3, 1, 'a', true, 8],
      [4, 2, 'b', true, 7], [5, 2, 'a', true, 7], [6, 3, 'a', true, 7],
    ] as const) await sys.review.create({ data: { id, pullId, commitSha, approved, authorId } })
    return { db, sys }
  }
  const counts = (rows: any[]) => rows.map(p => [p.id, p.approvals])

  it('a read counts the children on the parent row\'s own column', async () => {
    const { db, sys } = await build()
    expect(counts(await sys.pull.findMany({ orderBy: { id: 'asc' } }))).toEqual([[1, 2], [2, 1], [3, 0]])
    expect((await sys.pull.findMany({ where: { approvals: { gte: 2 } } })).map((p: any) => p.id)).toEqual([1])
    expect((await sys.pull.findUnique({ where: { id: 2 } })).firstOnHead.id).toBe(4)
    db.$close()
  })

  it('a recount under the child\'s read policy still reads the parent\'s column', async () => {
    const { db } = await build(`@@allow(read, true)`, `@@allow(read, authorId == auth().id)`)
    const as = (id: number) => db.$setAuth({ id }).pull.findMany({ orderBy: { id: 'asc' } })
    expect(counts(await as(7))).toEqual([[1, 1], [2, 1], [3, 0]])
    expect(counts(await as(8))).toEqual([[1, 1], [2, 0], [3, 0]])
    expect((await as(8)).map((p: any) => p.firstOnHead?.id ?? null)).toEqual([3, null, null])
    db.$close()
  })

  it('both halves of a policy read the parent\'s column, and postUpdate the written one', async () => {
    for (const op of ['update', 'postUpdate']) {
      const { db, sys } = await build(`@@require(${op}, approvals >= 2)`)
      const ids = []
      for (const id of [1, 2, 3]) {
        try { await sys.pull.update({ where: { id }, data: { title: 'probe' } }); ids.push(id) }
        catch (e: any) { if (e.constructor.name !== 'AccessDeniedError') throw e }
      }
      expect([op, ids]).toEqual([op, [1]])
      db.$close()
    }
    const { db, sys } = await build(`@@require(postUpdate, approvals >= 2)`)
    // Two approvals on 'a' before the write and none on 'new' after it.
    await expect(sys.pull.update({ where: { id: 1 }, data: { headSha: 'new' } })).rejects.toThrow(/post-update policy/)
    expect((await sys.pull.findUnique({ where: { id: 1 } })).headSha).toBe('a')
    db.$close()
  })

  it('refused by name: a missing column, a relation, an @from, an encoded column', async () => {
    const errorsOf = async (where: string, extra = '') => {
      try { await createClient({ db: ':memory:', schema: SCHEMA(extra).replace(
        'where: commitSha == this.headSha && approved == true', where) }); return '' }
      catch (e: any) { return e.message }
    }
    expect(await errorsOf('where: commitSha == this.nope')).toContain(`'nope' is not a field on Pull`)
    expect(await errorsOf('where: commitSha == this.reviews')).toContain(`'this.reviews' is a to-many relation on Pull`)
    expect(await errorsOf('where: approved == this.approvals')).toContain(`'this.approvals' is @from on Pull`)
    expect(await errorsOf('where: commitSha == this.token', 'token String? @encrypted')).toContain(`'this.token' is @encrypted on Pull`)
  })
})
