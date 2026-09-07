// `@map` and the paths that forgot it (FJS-761's other half).
//
// A schema names its columns twice: `fullName @map("full_name")` is `fullName`
// to every caller and `full_name` in the table, and the engine has to translate
// at every boundary between the two. `@map` was ignored entirely until
// `FJS-761`; the implementation reached `ddl.js` and most of the query builder
// and left FOUR raw `"deletedAt"` literals in the read fast paths.
//
// Nothing failed. SQLite resolves a double-quoted identifier it cannot bind as
// a STRING LITERAL rather than raising, so `WHERE "deletedAt" IS NULL` became
// `'deletedAt' IS NULL` — false for every row. Measured: every `findMany` and
// every `findUnique` by primary key on a mapped soft-delete model answered
// nothing, with a 200 and no error, while `count`, `findFirst` and `orderBy`
// answered correctly because those take the slow path where the clause IS
// mapped. A model half-visible to itself.
//
// ─── why this file is an oracle rather than a list ──────────────────────────
//
// One model is declared twice — once with every column mapped, once plain — and
// every operation is run against both and compared. A path that forgets the
// translation diverges; a path that never had it cannot be written down in
// advance, which is the whole difficulty: `@map` is not a feature with a call
// site, it is a fact every query has to carry. The two fast paths were found
// this way and the four literals were not all in the same function.
//
// The comparison is the negative control too. A fix that broke BOTH readings —
// dropping the clause, say — would agree, so the plain model is asserted to
// answer what a soft-delete model should: the row before the delete, nothing
// after it, the row again under `withDeleted`.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateLiteSchema } from '../src/tools/introspect.js'

// One body, two spellings. `id` is mapped too: `_fastFindUniqueSql` writes the
// primary key's FIELD name into its WHERE, so an unmapped id hides that half.
const body = (m: (n: string) => string) => `
model Owner {
  id     Int     @id @default(autoincrement()) ${m('id')}
  label  String  ${m('label')}
  things Thing[]
}
model Thing {
  id        Int       @id @default(autoincrement()) ${m('id')}
  title     String    ${m('title')}
  slug      String    @unique ${m('slug')}
  qty       Int       @default(0) ${m('qty')}
  ownerId   String?   ${m('ownerId')}
  ver       Int       @version ${m('ver')}
  upd       DateTime? @updatedAt ${m('upd')}
  ownerRef  Int?      ${m('ownerRef')}
  owner     Owner?    @relation(fields: [ownerRef], references: [id])
  deletedAt DateTime? ${m('deletedAt')}
  @@softDelete
  @@index([title])
}`

const mapped = (n: string) => `@map("${n.replace(/([A-Z])/g, (c) => '_' + c.toLowerCase())}_c")`
const plain  = () => ''

const client = async (m: (n: string) => string) =>
  (await createClient({ schema: `database main { path ":memory:" }\n` + body(m) })).asSystem()

type Table = any

// Instants differ between two runs and are not what is under test.
const norm = (v: unknown) =>
  JSON.stringify(v, (k, x) => (k === 'deletedAt' || k === 'upd') && x ? 'T' : x)

const OPS: Array<[string, (s: Table) => Promise<unknown>]> = [
  ['owner',         s => s.owner.create({ data: { label: 'o1' } })],
  ['create',        s => s.thing.create({ data: { title: 'a', slug: 's1', qty: 1, ownerId: 'u1', ownerRef: 1 } })],
  ['create 2',      s => s.thing.create({ data: { title: 'b', slug: 's2', qty: 2 } })],
  ['findMany',      s => s.thing.findMany({})],
  ['count',         s => s.thing.count()],
  ['findUnique pk', s => s.thing.findUnique({ where: { id: 1 } })],
  ['findUnique uq', s => s.thing.findUnique({ where: { slug: 's1' } })],
  ['findFirst',     s => s.thing.findFirst({ where: { qty: { gt: 1 } } })],
  ['orderBy',       s => s.thing.findMany({ orderBy: { title: 'desc' } })],
  ['select',        s => s.thing.findMany({ select: { title: true, qty: true } })],
  ['aggregate',     s => s.thing.aggregate({ _sum: { qty: true }, _count: true })],
  ['groupBy',       s => s.thing.groupBy({ by: ['ownerId'], _count: true })],
  ['update',        s => s.thing.update({ where: { id: 1 }, data: { qty: 7 } })],
  ['updateMany',    s => s.thing.updateMany({ where: { qty: { gte: 0 } }, data: { qty: 3 } })],
  ['upsert',        s => s.thing.upsert({ where: { slug: 's3' }, create: { title: 'c', slug: 's3' }, update: { qty: 9 } })],
  ['remove',        s => s.thing.remove({ where: { id: 2 } })],
  ['after remove',  s => s.thing.findMany({})],
  ['withDeleted',   s => s.thing.findMany({ withDeleted: true })],
  ['onlyDeleted',   s => s.thing.findMany({ onlyDeleted: true })],
  ['restore',       s => s.thing.restore({ where: { id: 2 } })],
  ['after restore', s => s.thing.findMany({})],
  ['include',       s => s.owner.findMany({ include: { things: true } })],
  ['include count', s => s.owner.findMany({ include: { things: { _count: true } } })],
  ['version bump',  s => s.thing.update({ where: { id: 1 }, data: { qty: 11 } })],
  ['unique clash',  s => s.thing.create({ data: { title: 'x', slug: 's1' } })],
  ['removeMany',    s => s.thing.removeMany({ where: { qty: { gte: 0 } } })],
  ['deleteMany',    s => s.thing.deleteMany({ where: { qty: { gte: 0 } }, withDeleted: true })],
  ['final',         s => s.thing.findMany({})],
]

describe('a mapped column answers what an unmapped one does', () => {
  it('every operation, in sequence, against both spellings', async () => {
    const A = await client(mapped)
    const B = await client(plain)

    const run = async (s: Table, fn: (s: Table) => Promise<unknown>) => {
      try { return norm(await fn(s)) }
      catch (err) { return 'THREW: ' + (err as Error).message.split('\n')[0] }
    }

    const divergent: string[] = []
    for (const [label, fn] of OPS) {
      const a = await run(A, fn)
      const b = await run(B, fn)
      if (a !== b) divergent.push(`${label}\n  mapped: ${a}\n  plain : ${b}`)
    }
    expect(divergent).toEqual([])
  })

  // The control that keeps the comparison honest: two readings that are both
  // wrong agree. These pin what the PLAIN model answers, so a change that
  // silenced soft delete on both sides fails here rather than passing above.
  it('and the plain model really does hide a deleted row', async () => {
    const s = await client(plain)
    await s.thing.create({ data: { title: 'a', slug: 's1' } })
    expect((await s.thing.findMany({})).length).toBe(1)
    // `remove` is the soft one — `delete` is the purge hatch and bypasses the
    // filter by design, which is its stated contract.
    await s.thing.remove({ where: { slug: 's1' } })
    expect(await s.thing.findMany({})).toEqual([])
    expect((await s.thing.findMany({ withDeleted: true })).length).toBe(1)
    await s.thing.restore({ where: { slug: 's1' } })
    expect((await s.thing.findMany({})).length).toBe(1)
  })

  // The mapped side of the same claim, stated directly rather than by
  // comparison — the row that says the DDL and the query agree about the name.
  it('the table holds the mapped names and the caller never sees them', async () => {
    const s = await client(mapped)
    const cols = (await s.sql`SELECT name FROM pragma_table_info('thing')`).map((r: any) => r.name)
    expect(cols).toContain('title_c')
    expect(cols).toContain('deleted_at_c')
    expect(cols).not.toContain('title')
    const row = await s.thing.create({ data: { title: 'a', slug: 's1' } })
    expect(row.title).toBe('a')
    expect((row as Record<string, unknown>).title_c).toBeUndefined()
  })
})

describe('@@softDelete needs the column it names', () => {
  const build = async (fields: string) => {
    try {
      await createClient({ schema:
        `database main { path ":memory:" }\nmodel Thing { id Int @id @default(autoincrement())  title String  ${fields}  @@softDelete }` })
      return null
    } catch (err) { return (err as Error).message }
  }

  // Without it the model is half-visible to itself and says nothing: SQLite
  // reads the unknown identifier as a string literal, so every read is filtered
  // by `'deletedAt' IS NULL` and answers nothing.
  it('a model with no deletedAt is refused, naming the field to add', async () => {
    const msg = await build('')
    expect(msg).toContain('@@softDelete needs')
    expect(msg).toContain('deletedAt DateTime?')
  })

  // A required column is stamped at create, so every row is born deleted and
  // invisible to every read — measured, not reasoned: `create` answers a row
  // carrying a `deletedAt` and `findMany` then answers nothing.
  it('a deletedAt that cannot hold NULL is refused', async () => {
    expect(await build('deletedAt DateTime @default(now())')).toContain('to be optional')
  })

  // And the type is NOT checked, which is the adoption door: litestone writes
  // every instant as ISO-8601 TEXT, `deletedAt String?` behaves identically —
  // measured, including the stamp and the restore — and `introspect` emits
  // exactly that, because a real database's TEXT column cannot say whether it
  // holds a date. A type rule here would refuse the schema litestone itself
  // generates from the database it is being adopted onto.
  it('but the type is not, because introspect reads one out of TEXT', async () => {
    expect(await build('deletedAt String?')).toBeNull()
  })

  // The controls. A check that refused every soft-delete model would satisfy
  // all three rows above.
  it('and the declarations that work are accepted', async () => {
    expect(await build('deletedAt DateTime?')).toBeNull()
    expect(await build('deletedAt DateTime? @map("deleted_at")')).toBeNull()
  })
})

// `introspect` infers `@@softDelete` from the column, so it has to infer it from
// the same fact the parser checks — otherwise the adoption door emits a schema
// litestone will not load. It inferred on the NAME alone, and the repo's own
// 188-model fixture carried the result: `DeletedRecord.deletedAt` is
// `DateTime @default(now())`, the instant a deletion was recorded, and marking
// that model soft-deleting made every row born deleted.
describe('introspect infers @@softDelete from a column that can hold NULL', () => {
  const readBack = (ddl: string) => {
    const db = new Database(':memory:')
    db.run(ddl)
    try { return generateLiteSchema(db) } finally { db.close() }
  }

  it('a nullable deleted_at is a soft-delete marker', () => {
    const out = readBack(`CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT, deletedAt TEXT)`)
    expect(out).toContain('@@softDelete')
    expect(parse(out).valid).toBe(true)
  })

  it('a NOT NULL one is a data column and is left alone', () => {
    const out = readBack(`CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT, deletedAt TEXT NOT NULL)`)
    expect(out).not.toContain('@@softDelete')
    expect(parse(out).valid).toBe(true)
  })
})
