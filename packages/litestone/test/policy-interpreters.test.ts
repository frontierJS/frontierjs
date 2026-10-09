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
  // membership, all three shapes of the right operand
  `status in ['published', 'review']`,
  `qty in [1, 5, 9]`,
  `ownerId in auth().teamIds`,
  `auth().id in editorIds`,
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
  note  String?   @allow('read', dueAt != null && dueAt < now() + 2d)
  @@scope(soon, dueAt > now() && dueAt < now() + 2d)
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
}
model Doc {
  id      String @id
  ownerId String?
  owner   Owner? @relation(fields: [ownerId], references: [id])
  @@allow('read',   EXPR)
  @@allow('create', EXPR)
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
  @@allow('read', owner.userId == auth().id)
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
  @@allow('read', EXPR)
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
