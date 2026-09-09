// sql-audit-trail.test.ts — an audit trail that is an ordinary table.
//
// `@@log(x)` could only ever name a `driver logger` database: a directory of
// append-only jsonl, reachable by no join, no policy, no screen and no
// litestream replica. So an app that wanted a trail its own UI could show had
// to write a SECOND one by hand beside it — which is what basecamp does, and
// that duplication is the argument for this feature rather than a story about
// it (`IDEAS/logbook.md`).
//
// The rule that makes it safe: on a SQLite database `model` is REQUIRED. There
// is nothing to synthesize into — a table the app never declared cannot carry a
// gate, a policy, an index or a migration, and those are the entire reason to
// put the trail here instead.

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const tick = () => new Promise((r) => setImmediate(r))

const TRAIL = `
  id            Int      @id @default(autoincrement())
  operation     String
  model         String
  field         String?
  records       Json
  before        Json?
  after         Json?
  actorId       String?
  actorType     String?
  correlationId String?
  source        String?
  origin        String?
  ip            String?
  userAgent     String?
  tenant        String?
  meta          Json?
  createdAt     DateTime @default(now())
`

async function client(schema: string) {
  const db: any = await createClient({ schema, db: ':memory:' })
  await autoMigrate(db)
  return db
}

describe('a trail in SQLite', () => {

  test('writes a real row, and the JSON columns come back parsed', async () => {
    // The jsonl trail answers `records` and `before`/`after` as STRINGS, so
    // nothing in it joins to anything — a record rather than a dimension. A
    // column typed `Json` round-trips as the value.
    const db = await client(`
      database main { path ":memory:" model AuditRow }
      model AuditRow { ${TRAIL} }
      model Thing { id Int @id  name String  @@log(main) }
    `)
    await db.asSystem().thing.create({ data: { id: 1, name: 'one' } })
    await tick()

    const rows = await db.asSystem().auditRow.findMany({})
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('create')
    expect(rows[0].records).toEqual([1])
    expect(rows[0].after).toEqual({ id: 1, name: 'one' })
    db.$close()
  })

  test('it JOINS — which is the whole reason to put it here', async () => {
    // The one thing a directory of jsonl can never do. An audit screen shows
    // *who*, and a trail that holds an id and cannot reach the row it names
    // makes every reader do the lookup by hand.
    const db = await client(`
      database main { path ":memory:" model AuditRow }
      model User { id String @id  email String  entries AuditRow[] }
      model AuditRow {
        ${TRAIL}
        actor User? @relation(fields: [actorId], references: [id])
      }
      model Thing { id Int @id  name String  @@log(main) }
    `)
    await db.asSystem().user.create({ data: { id: 'u1', email: 'ada@example.test' } })
    await db.$setAuth({ id: 'u1' }).thing.create({ data: { id: 1, name: 'one' } })
    await tick()

    const [row] = await db.asSystem().auditRow.findMany({ include: { actor: true } })
    expect(row.actorId).toBe('u1')
    expect(row.actor?.email).toBe('ada@example.test')
    db.$close()
  })

  test('the trail can be append-only at the Data boundary', async () => {
    // `@@gate("5.8.9.9")` is `example`'s JournalEntry spelling: read at 5, the
    // application writes at 8, and 9 is LOCKED so nothing amends or removes.
    // The engine's own write must still land — it goes through a system
    // context, which grades 8 — and that is the pair worth pinning, because
    // writing 9 for create instead produces a trail that migrates, snapshots,
    // passes every check and refuses the first row the engine writes.
    const db = await client(`
      database main { path ":memory:" model AuditRow }
      model AuditRow { ${TRAIL}  @@gate("5.8.9.9") }
      model Thing { id Int @id  name String  @@log(main) }
    `)
    await db.asSystem().thing.create({ data: { id: 1, name: 'one' } })
    await tick()

    expect(await db.asSystem().auditRow.findMany({})).toHaveLength(1)

    // 9 is above asSystem()'s 8, so even the bypass cannot restate it.
    await expect(
      db.asSystem().auditRow.updateMany({ where: {}, data: { operation: 'nope' } })
    ).rejects.toThrow()
    db.$close()
  })

  test('a `driver logger` trail is untouched', async () => {
    // The negative control. This feature adds a second kind of target; it must
    // not quietly change the one every existing app is using.
    const db: any = await createClient({
      schema: `
        database main  { path ":memory:" }
        database audit { path "./audit/" driver logger }
        model Thing { id Int @id  name String  @@log(audit) }
      `,
      databases: ':memory:',
    })
    await autoMigrate(db)
    await db.asSystem().thing.create({ data: { id: 1, name: 'one' } })
    await tick()
    const rows = await db.asSystem().auditLogs.findMany({})
    expect(rows).toHaveLength(1)
    // Still the jsonl shape: strings, because there is no column type under it.
    expect(typeof rows[0].records).toBe('string')
    db.$close()
  })
})

describe('the parser says which mistake was made', () => {

  const refuse = (src: string) => {
    const r = parse(src)
    expect(r.valid).toBe(false)
    return r.errors.join('\n')
  }

  test('a SQLite target with no `model` key names the two ways out', () => {
    const msg = refuse(`
      database main { path ":memory:" }
      model Thing { id Int @id  @@log(main) }
    `)
    expect(msg).toMatch(/is not an audit trail/)
    expect(msg).toMatch(/model <Name>/)
    expect(msg).toMatch(/driver logger/)
  })

  test('`model` on a plain jsonl database is refused — that is storage, not a trail', () => {
    const msg = refuse(`
      database main  { path ":memory:" }
      database bulk  { path "./bulk/" driver jsonl model Row }
      model Row { id Int @id  operation String  model String  createdAt DateTime @default(now()) @@db(bulk) }
    `)
    expect(msg).toMatch(/model key is not valid for jsonl databases/)
  })

  test('a `model` naming a model in a DIFFERENT database is refused', () => {
    const msg = refuse(`
      database main  { path ":memory:" model AuditRow }
      database other { path ":memory:" }
      model AuditRow { id Int @id  operation String  model String  createdAt DateTime @default(now()) @@db(other) }
      model Thing { id Int @id  @@log(main) }
    `)
    expect(msg).toMatch(/must be assigned to this database/)
  })

  test('a trail model missing the required columns is refused by name', () => {
    const msg = refuse(`
      database main { path ":memory:" model AuditRow }
      model AuditRow { id Int @id  operation String }
      model Thing { id Int @id  @@log(main) }
    `)
    expect(msg).toMatch(/missing required field 'model'/)
    expect(msg).toMatch(/missing required field 'createdAt'/)
  })
})

// ─── every write path files an entry ──────────────────────────────────────────
//
// The completeness claim lived in `docs/audit-logging.md` and in nothing else
// (`FJS-1042`). `emitLogs` has eighteen hand-placed call sites against
// `fireEvent`'s three, so *does this verb log* is restated per verb the way
// `verbs-rules.test.ts`'s rules are — and announce got the enumeration this
// funnel never did, which is the wrong way round: an announcement that stops
// firing is a screen that does not move, and an entry that stops being filed is
// discovered by asking the trail a question it cannot answer.
//
// One case per named path, run against a real trail. Each asserts the OPERATION
// and the rows it names, because an entry filed under the wrong verb satisfies
// any test that only counts.

describe('every write path files an entry (FJS-1042)', () => {

  const SCHEMA = `
    database main { path ":memory:" model AuditRow }
    model AuditRow { ${TRAIL} }
    model Thing {
      id      Int     @id
      name    String
      state   String  @default("draft")
      deletedAt DateTime?
      @@softDelete
      @@log(main)
    }
    model Quiet { id Int @id  name String }
  `

  // The trail as the assertions read it: operation, the ids it named, and
  // whether it carried snapshots. Field-level entries would double every row,
  // so the model-level ones are what an enumeration over VERBS is about.
  async function trail(db: any) {
    await tick()
    const rows = await db.asSystem().auditRow.findMany({ orderBy: { id: 'asc' } })
    return rows.filter((r: any) => r.field === null)
      .map((r: any) => ({ op: r.operation, records: r.records, before: r.before, after: r.after }))
  }

  async function fresh() {
    const db = await client(SCHEMA)
    return db
  }

  test('create · createMany', async () => {
    const db = await fresh()
    await db.asSystem().thing.create({ data: { id: 1, name: 'one' } })
    expect(await trail(db)).toEqual([{ op: 'create', records: [1], before: null, after: { id: 1, name: 'one', state: 'draft', deletedAt: null } }])

    const db2 = await fresh()
    await db2.asSystem().thing.createMany({ data: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] })
    const t2 = await trail(db2)
    expect(t2).toHaveLength(1)
    expect(t2[0].op).toBe('create')
    expect(t2[0].records).toEqual([1, 2])
    // Documented: a bulk write names its rows and never their contents.
    expect(t2[0].before).toBeNull()
    expect(t2[0].after).toBeNull()
    db.$close(); db2.$close()
  })

  test('update · updateMany', async () => {
    const db = await fresh()
    await db.asSystem().thing.createMany({ data: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] })
    await db.asSystem().thing.update({ where: { id: 1 }, data: { state: 'live' } })
    const one = (await trail(db)).at(-1)
    expect(one.op).toBe('update')
    expect(one.records).toEqual([1])
    // The single-row half is the one that carries snapshots, and the pair with
    // the bulk row above is what makes the asymmetry an assertion rather than
    // an accident.
    expect(one.before.state).toBe('draft')
    expect(one.after.state).toBe('live')

    await db.asSystem().thing.updateMany({ where: {}, data: { state: 'archived' } })
    const many = (await trail(db)).at(-1)
    expect(many.op).toBe('update')
    expect(many.records).toEqual([1, 2])
    expect(many.before).toBeNull()
    db.$close()
  })

  test('upsert files under what it DID — create, then update', async () => {
    // Single `upsert` reaches the trail transitively: it delegates to create
    // and to update. That is the one path in the eleven with no `emitLogs` of
    // its own, so it is the one an enumeration is most likely to lose.
    const db = await fresh()
    await db.asSystem().thing.upsert({ where: { id: 1 }, create: { id: 1, name: 'one' }, update: { name: 'one' } })
    expect((await trail(db)).at(-1).op).toBe('create')
    await db.asSystem().thing.upsert({ where: { id: 1 }, create: { id: 1, name: 'one' }, update: { name: 'moved' } })
    expect((await trail(db)).at(-1).op).toBe('update')
    db.$close()
  })

  test('upsertMany splits its batch, because it did both', async () => {
    const db = await fresh()
    await db.asSystem().thing.create({ data: { id: 1, name: 'one' } })
    await db.asSystem().thing.upsertMany({
      data: [{ id: 1, name: 'moved' }, { id: 2, name: 'two' }],
      conflictTarget: ['id'],
      update: ['name'],
    })
    const ops = (await trail(db)).map((r: any) => r.op)
    expect(ops.filter((o: string) => o === 'create')).toHaveLength(2)
    expect(ops.filter((o: string) => o === 'update')).toHaveLength(1)
    db.$close()
  })

  test('remove · removeMany · restore — a soft delete files, and coming back files as update', async () => {
    const db = await fresh()
    await db.asSystem().thing.createMany({ data: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] })

    await db.asSystem().thing.remove({ where: { id: 1 } })
    const rm = (await trail(db)).at(-1)
    expect(rm.op).toBe('delete')
    expect(rm.records).toEqual([1])

    // Documented: a restored row CHANGED STATE, it was not created. Filing it
    // as `create` would make the trail claim the row did not exist before.
    await db.asSystem().thing.restore({ where: { id: 1 } })
    expect((await trail(db)).at(-1).op).toBe('update')

    await db.asSystem().thing.removeMany({ where: {} })
    const rmm = (await trail(db)).at(-1)
    expect(rmm.op).toBe('delete')
    expect(rmm.records).toEqual([1, 2])
    db.$close()
  })

  test('delete · deleteMany — the hard path files too', async () => {
    // A hard delete is the write with the most to answer for and the least
    // left to read: after it there is no row, so an entry that was never filed
    // cannot be reconstructed from anything.
    const db = await fresh()
    await db.asSystem().thing.createMany({ data: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] })

    await db.asSystem().thing.delete({ where: { id: 1 } })
    const d = (await trail(db)).at(-1)
    expect(d.op).toBe('delete')
    expect(d.records).toEqual([1])
    expect(d.before.name).toBe('one')

    await db.asSystem().thing.deleteMany({ where: {} })
    const dm = (await trail(db)).at(-1)
    expect(dm.op).toBe('delete')
    expect(dm.records).toEqual([2])
    db.$close()
  })

  test('a model that declares no trail files nothing', async () => {
    // The control. Every row above passes against an engine that logged every
    // write of every model, which is a different defect wearing this test's
    // green.
    const db = await fresh()
    await db.asSystem().quiet.create({ data: { id: 1, name: 'one' } })
    await db.asSystem().quiet.update({ where: { id: 1 }, data: { name: 'two' } })
    await db.asSystem().quiet.delete({ where: { id: 1 } })
    expect(await trail(db)).toEqual([])
    db.$close()
  })
})
