// `@@id([a, b])` — a key that is a tuple (FJS-561).
//
// Composite primary keys ALREADY worked: two `@id` fields emit
// `PRIMARY KEY ("a", "b")`, and `findUnique`, `update`, `remove`, `restore`,
// `include` and the migrator have all handled that shape since they were
// written — litestone's own implicit m2m join table is one. What did not exist
// was the model-level spelling, and it is not merely sugar: it is the only place
// the key's column ORDER can be written down.
//
// The order is the point. A primary key builds an implicit index and an implicit
// index is prefix-matched, so `(orgId, userId)` answers `WHERE orgId = ?` and the
// swap does not. With `@id` on the fields the key order is the FIELD DECLARATION
// order, which is a different fact about the model — so `litestone introspect`
// read one key off a live table and wrote a schema that builds another, with
// nothing said. That is the sharpest thing here and it is asserted as a fixed
// point rather than as a string.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { createClient } from '../src/core/client.js'
import { generateLiteSchema } from '../src/tools/introspect.js'
import { introspect, buildPristine, diffSchemas } from '../src/core/migrate.js'

const errorsOf = (src: string) => parse(src).errors
const pkOf     = (src: string) => generateDDL(parse(src).schema).match(/PRIMARY KEY \([^)]*\)/)?.[0]
const M = (attr: string) => `model Membership {\n  orgId String\n  userId String\n  role String\n  ${attr}\n}`

describe('@@id declares the key, in its own column order', () => {
  it('emits the tuple as the table\'s PRIMARY KEY', () => {
    expect(errorsOf(M('@@id([orgId, userId])'))).toEqual([])
    expect(pkOf(M('@@id([orgId, userId])'))).toBe('PRIMARY KEY ("orgId", "userId")')
  })

  it('and the ORDER is the one written, not the one the fields are declared in', () => {
    // The whole of what this spelling adds. Both models declare orgId first.
    expect(pkOf(M('@@id([userId, orgId])'))).toBe('PRIMARY KEY ("userId", "orgId")')
  })

  it('desugars to `@id` on each field, so nothing downstream learned a new shape', async () => {
    const db = await createClient({ schema: M('@@id([userId, orgId])'), db: ':memory:' })
    await db.membership.create({ data: { orgId: 'o1', userId: 'u1', role: 'admin' } })

    expect(await db.membership.findUnique({ where: { orgId: 'o1', userId: 'u1' } }))
      .toMatchObject({ orgId: 'o1', userId: 'u1', role: 'admin' })
    expect(await db.membership.update({ where: { orgId: 'o1', userId: 'u1' }, data: { role: 'viewer' } }))
      .toMatchObject({ role: 'viewer' })

    // The constraint is real, and names both columns together — in the KEY's
    // order, which this model declares reversed.
    await expect(db.membership.create({ data: { orgId: 'o1', userId: 'u1', role: 'x' } }))
      .rejects.toThrow(/userId "u1" \+ orgId "o1" is already taken — those values must be unique together/)
  })

  it('the key survives a soft delete, a relation and an include', async () => {
    const SRC = `
model Org { id String @id
  memberships Membership[] }
model Membership {
  orgId String
  userId String
  role String
  org Org @relation(fields: [orgId], references: [id])
  deletedAt DateTime?
  @@id([orgId, userId])
  @@softDelete
}`
    const db = await createClient({ schema: SRC, db: ':memory:' })
    await db.org.create({ data: { id: 'o1' } })
    await db.membership.create({ data: { orgId: 'o1', userId: 'u1', role: 'admin' } })
    await db.membership.remove({ where: { orgId: 'o1', userId: 'u1' } })
    expect(await db.membership.count()).toBe(0)
    expect((await db.membership.restore({ where: { orgId: 'o1', userId: 'u1' } })).length).toBe(1)
    expect((await db.org.findUnique({ where: { id: 'o1' }, include: { memberships: true } })).memberships)
      .toHaveLength(1)
  })

  // The shape a composite key mostly exists FOR — a keyed row with children — and
  // the one that would be worth little if the key could only be declared and not
  // pointed at. A multi-column `references:` resolves to a real multi-column
  // FOREIGN KEY, so the database refuses a dangling half of the pair.
  it('and another model can point AT it, on both columns', async () => {
    const SRC = `
model Membership {
  orgId  String
  userId String
  role   String
  notes  MembershipNote[]
  @@id([orgId, userId])
}
model MembershipNote {
  id     Int @id @default(autoincrement())
  orgId  String
  userId String
  body   String
  member Membership @relation(fields: [orgId, userId], references: [orgId, userId])
}`
    expect(generateDDL(parse(SRC).schema))
      .toContain('FOREIGN KEY ("orgId", "userId") REFERENCES "membership" ("orgId", "userId")')

    const db = await createClient({ schema: SRC, db: ':memory:' })
    await db.membership.create({ data: { orgId: 'o1', userId: 'u1', role: 'admin' } })
    await db.membershipNote.create({ data: { orgId: 'o1', userId: 'u1', body: 'hello' } })

    expect((await db.membership.findUnique({
      where: { orgId: 'o1', userId: 'u1' }, include: { notes: true } })).notes).toHaveLength(1)
    expect((await db.membershipNote.findFirst({ include: { member: true } })).member)
      .toMatchObject({ role: 'admin' })

    // Half a key is not a key: the FK correlates on both columns.
    await expect(db.membershipNote.create({ data: { orgId: 'o1', userId: 'nobody', body: 'x' } }))
      .rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})

describe('what @@id refuses, and why each would not identify a row', () => {
  it('a field-level @id beside it — two answers to one question', () => {
    expect(errorsOf(`model M { a String @id  b String  @@id([a, b]) }`)[0])
      .toMatch(/both say what identifies a row/)
  })

  it('a second @@id — a row has one identity', () => {
    expect(errorsOf(`model M { a String  b String  @@id([a])  @@id([b]) }`)[0])
      .toMatch(/@@id declared 2 times/)
  })

  it('a nullable member — SQLite permits one and it identifies nothing', () => {
    // The `@@unique` rule (FJS-D130) one constraint kind along, and sharper:
    // there is no `nullsDistinct` reading of a primary key.
    expect(errorsOf(`model M { a String  b String?  @@id([a, b]) }`)[0])
      .toMatch(/cannot be nullable/)
  })

  it('a relation — a primary key is over columns', () => {
    expect(errorsOf(`model Org { id String @id  ms M[] }
model M { orgId String  org Org @relation(fields: [orgId], references: [id])  x String  @@id([org, x]) }`)[0])
      .toMatch(/names the relation 'org' — name the foreign key field instead/)
  })

  it('an array — the key would be over a JSON serialisation', () => {
    expect(errorsOf(`model M { a String  tags String[]  @@id([a, tags]) }`)[0])
      .toMatch(/names the array 'tags'/)
  })

  it('a virtual column — there is nothing stored to key by', () => {
    expect(errorsOf(`model M { a String  c String @computed  @@id([a, c]) }`)[0])
      .toMatch(/which is @computed/)
  })

  it('the same field twice', () => {
    expect(errorsOf(`model M { a String  @@id([a, a]) }`)[0]).toMatch(/names 'a' twice/)
  })

  // An unknown name is already reported by the generic model-attribute check, so
  // this asserts it is said ONCE rather than by both.
  it('an unknown field, exactly once', () => {
    const e = errorsOf(`model M { a String  @@id([a, nope]) }`)
    expect(e.filter(x => x.includes('nope'))).toHaveLength(1)
  })

  it('an enum member is a column and is allowed', () => {
    expect(errorsOf(`enum K { x y }\nmodel M { a String  k K  @@id([a, k]) }`)).toEqual([])
  })

  it('and a trait may not carry one — the guard the parser already had', () => {
    // `TRAIT_FORBIDDEN_MODEL_ATTRS` has named 'id' since traits were written and
    // could never fire, because no schema could reach a `@@id` the parser
    // refused. Making the word real is what makes the guard live.
    expect(errorsOf(`trait Keyed {\n  a String\n  b String\n  @@id([a, b])\n}\nmodel M {\n  x String @id\n  @@trait(Keyed)\n}`)[0])
      .toMatch(/@@id is not allowed in a trait/)
  })
})

describe('the key\'s order survives a round trip through the database', () => {
  // The defect that makes @@id worth a grammar rather than a convention. Before
  // it, `@id` per column was the only spelling introspect had, so it wrote the
  // key in COLUMN order — a different key, silently, and one the migrator would
  // then rebuild the table to install.
  const live = () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE "membership" ("orgId" TEXT NOT NULL, "userId" TEXT NOT NULL,
            "role" TEXT NOT NULL, PRIMARY KEY ("userId","orgId")) STRICT;`)
    return db
  }

  it('introspect writes the key it read, not the columns it saw', () => {
    const lite = generateLiteSchema(live())
    expect(lite).toContain('@@id([userId, orgId])')
    expect(lite).not.toMatch(/orgId\s+String\s+@id/)
    expect(pkOf(lite)).toBe('PRIMARY KEY ("userId", "orgId")')
  })

  it('and reading a database built from that output gives the same text', () => {
    const lite = generateLiteSchema(live())
    const again = new Database(':memory:')
    for (const st of generateDDL(parse(lite).schema).split(';').map(x => x.trim()).filter(Boolean))
      again.run(st + ';')
    expect(generateLiteSchema(again)).toBe(lite)
  })

  it('so the schema it wrote migrates nothing against the database it came from', () => {
    // The negative control for the pair above: a fixed point that still asks the
    // migrator for a rebuild is not one.
    const db = live()
    const pr = parse(generateLiteSchema(db))
    const d  = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(db), pr)
    expect(d.tableDiffs).toEqual([])
  })
})

// ─── FJS-694 · a tuple key is not a unique column ─────────────────────────
//
// `expandCompositeId` stamps `@id` on every member, so every downstream read of
// *which column identifies a row* answered with one of them — and one member of
// a tuple identifies nothing. Three separate faults came out of that, and the
// worst is silent.

describe('a member of a tuple key does not identify a row (FJS-694)', () => {

  const SCHEMA = `model Membership {
  userId Int
  teamId Int
  role   String @default("member")
  @@id([userId, teamId])
}
`

  const client = () => createClient({ resolveFrom: '/tmp', db: ':memory:', schema: SCHEMA })

  it('the default ordering is the KEY, not a column called id', async () => {
    // `normaliseOrderBy` defaults to the literal `id`, which it must — it is a
    // pure function with no model in scope. A composite-keyed model has no such
    // column, so every derived list over one answered
    // `400 Unknown orderBy field 'id'` and was unreachable.
    const db: any = await client()
    expect(db.membership.orderTotal(undefined)).toEqual([{ userId: 'asc' }, { teamId: 'asc' }])
  })

  it('the tiebreaker appends the WHOLE key, not its first column', async () => {
    const db: any = await client()
    expect(db.membership.orderTotal({ role: 'asc' }))
      .toEqual([{ role: 'asc' }, { userId: 'asc' }, { teamId: 'asc' }])
  })

  it('ordering by one key column is still completed — this is the silent one', async () => {
    // It used to be treated as already total, because that column carries `@id`.
    const db: any = await client()
    expect(db.membership.orderTotal({ userId: 'asc' }))
      .toEqual([{ userId: 'asc' }, { teamId: 'asc' }])
  })

  it('a cursor walk over one key column serves every row', async () => {
    // The assertion the three above exist for. Three rows sharing a userId,
    // paged two at a time: the cursor said `userId > 1`, every remaining row
    // shares that userId, and page two came back EMPTY. One row was lost with
    // no error and no gap — the class the tiebreaker exists to prevent.
    const db: any = await client()
    for (const teamId of [1, 2, 3]) await db.membership.create({ data: { userId: 1, teamId } })

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const p = await db.membership.findManyCursor({ limit: 2, orderBy: { userId: 'asc' }, cursor })
      seen.push(...p.items.map((r: any) => `${r.userId}/${r.teamId}`))
      if (!p.hasMore) break
      cursor = p.nextCursor
    }
    expect(seen).toEqual(['1/1', '1/2', '1/3'])
  })

  it('a single-column key is still a unique column — the control', async () => {
    // The fix must not stop `@id` on one field from being what it is, or every
    // ordinary model pays for the tuple case.
    const db: any = await createClient({
      resolveFrom: '/tmp', db: ':memory:',
      schema: 'model Post {\n  id Int @id @default(autoincrement())\n  title String\n}\n',
    })
    expect((db as any).post.orderTotal({ title: 'asc' }))
      .toEqual([{ title: 'asc' }, { id: 'asc' }])
    // Already total: nothing appended.
    expect((db as any).post.orderTotal({ id: 'desc' })).toEqual([{ id: 'desc' }])
  })

  it('a @unique column still breaks the tie on a tuple-keyed model', async () => {
    // A column that IS unique on its own needs no key appended after it.
    const db: any = await createClient({
      resolveFrom: '/tmp', db: ':memory:',
      schema: `model Membership {
  userId Int
  teamId Int
  slug   String @unique
  @@id([userId, teamId])
}
`,
    })
    expect(db.membership.orderTotal({ slug: 'asc' })).toEqual([{ slug: 'asc' }])
  })
})
