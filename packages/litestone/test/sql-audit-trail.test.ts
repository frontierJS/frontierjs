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
// is nothing to synthesise into — a table the app never declared cannot carry a
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
