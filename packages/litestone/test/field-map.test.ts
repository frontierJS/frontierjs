// field-map.test.ts — `@map("column_name")` on a FIELD (FJS-761).
//
// The attribute parsed, was documented, was emitted by four of the importers,
// and was applied by nothing: `ddl.js` read the MODEL-level `@@map` and named
// every column after its field, so a schema carrying `fullName
// @map("full_name")` described a table it could not read. `litestone
// introspect` emits one per renamed column under its default camelCase
// reading, which made the adoption door produce a schema that could not read
// its own source.
//
// Two directions and they fail differently, which is why every row here is a
// PAIR against the same schema with the `@map`s taken off. A missed identifier
// on the WRITE side is `no such column` and stops — except in a WHERE, where
// SQLite reads an unknown `"ident"` as a STRING LITERAL, so the clause matches
// nothing and the answer is an empty list with no error at all. That silent
// shape is what `@@allow`, the include join and the soft-delete clause each
// were, and it is why the control matters: a mechanism that answered `[]` for
// both spellings would pass any test that only asked the mapped one.

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createClient } from '../src/core/client.js'
import { parse } from '../src/core/parser.js'
import { generateDDL, columnMapFor, fieldToColumnName, mapExprCols } from '../src/core/ddl.js'
import {
  introspect, diffSchemas, buildPristine, generateMigrationSQL, splitStatements,
} from '../src/core/migrate.js'

// One schema, written twice. `m` is the only difference, so any row that
// answers differently for the two is answering about `@map` and nothing else.
const SCHEMA = (m: boolean) => `
enum DocStatus { draft published }

model Author {
  id      Int    @id @default(autoincrement())
  penName String ${m ? '@map("pen_name")' : ''} @unique
  books   Book[]
}

model Book {
  id        Int       @id @default(autoincrement())
  title     String    ${m ? '@map("book_title")' : ''}
  pages     Int       ${m ? '@map("page_count")' : ''} @default(0)
  status    DocStatus ${m ? '@map("book_status")' : ''} @default(draft)
  ownerId   Int       ${m ? '@map("owner_id")' : ''}
  authorId  Int       ${m ? '@map("author_id")' : ''}
  author    Author    @relation(fields: [authorId], references: [id])
  deletedAt DateTime? ${m ? '@map("deleted_at")' : ''}
  rev       Int       ${m ? '@map("revision")' : ''} @version
  @@index([pages])
  @@softDelete
  @@check("pages >= 0", "a book has pages")
  @@transitions(status, draft -> published)
  @@allow('read', auth().id == ownerId)
  @@gate("0")
}`

async function world(mapped: boolean) {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA(mapped) })
  const sys = db.asSystem()
  const a = await sys.author.create({ data: { penName: 'Ada' } })
  await sys.book.createMany({ data: [
    { title: 'One', pages: 100, ownerId: 1, authorId: a.id },
    { title: 'Two', pages: 200, ownerId: 2, authorId: a.id },
  ] })
  return { db, sys, authorId: a.id }
}

/** The same question of both spellings. The mapped answer must equal the plain one. */
async function both(ask: (w: Awaited<ReturnType<typeof world>>) => unknown) {
  return { plain: await ask(await world(false)), mapped: await ask(await world(true)) }
}

const agree = async (ask: (w: Awaited<ReturnType<typeof world>>) => unknown) => {
  const { plain, mapped } = await both(ask)
  expect(mapped).toEqual(plain)
  return mapped
}

describe('@map — the DDL names the column', () => {
  test('a mapped field becomes its column, an unmapped one stays its name', () => {
    const pr = parse(SCHEMA(true))
    const book = pr.schema.models.find((m: any) => m.name === 'Book')!
    expect(columnMapFor(book)).toEqual({
      title: 'book_title', pages: 'page_count', status: 'book_status',
      ownerId: 'owner_id', authorId: 'author_id', deletedAt: 'deleted_at', rev: 'revision',
    })
    // `id` maps to nothing and is absent, which is what lets an unmapped model
    // skip the translation entirely rather than walking an identity map.
    expect(columnMapFor(book).id).toBeUndefined()
    expect(fieldToColumnName(book.fields.find((f: any) => f.name === 'id'))).toBe('id')
  })

  test('the table, its index, its FK and its CHECK all name columns', () => {
    const ddl = generateDDL(parse(SCHEMA(true)).schema, { foreignKeys: true })
    expect(ddl).toContain('"book_title" TEXT NOT NULL')
    expect(ddl).toContain('FOREIGN KEY ("author_id") REFERENCES "author" ("id")')
    expect(ddl).toContain('"page_count"')          // the @@index
    expect(ddl).toContain('CHECK (page_count >= 0)')
    // The soft-delete clause every index on such a model carries.
    expect(ddl).toContain('WHERE "deleted_at" IS NULL')
    // The index NAME stays on the FIELD: it is this emitter's own identifier,
    // the migrator matches by shape rather than by it, and deriving it from the
    // column would rename every index the day a schema adds a @map.
    expect(ddl).toContain('"idx_book_pages"')
    // Nothing is left in field space.
    expect(ddl).not.toContain('"book_title" IS NULL')
    expect(ddl).not.toContain('CHECK (pages >= 0)')
  })

  test('an author-written expression is translated, and only its identifiers', () => {
    const cmap = { pages: 'page_count' }
    expect(mapExprCols("pages >= 0", cmap)).toBe('page_count >= 0')
    // A word inside a string literal is a VALUE. Rewriting there is how
    // `'pages'` would become a column reference.
    expect(mapExprCols("status = 'pages'", cmap)).toBe("status = 'pages'")
    // Bare where the name allows it, because SQLite reports an unnamed CHECK by
    // its own source text and one OPENING with a quoted identifier comes back
    // as that identifier alone — which is the message match below.
    expect(mapExprCols("pages >= 0", { pages: 'select' })).toBe('"select" >= 0')
  })
})

describe('@map — every verb answers what the plain schema answers', () => {
  test('create returns the FIELD, not the column', () => agree(async ({ sys }) => {
    const r = await sys.book.create({ data: { title: 'Three', pages: 3, ownerId: 1, authorId: 1 } })
    return { title: r.title, pages: r.pages, hasColumnKey: 'book_title' in r }
  }))

  test('where, orderBy and select', () => agree(async ({ sys }) => ({
    filtered: (await sys.book.findMany({ where: { pages: { gte: 150 } } })).map((b: any) => b.title),
    ordered:  (await sys.book.findMany({ orderBy: { pages: 'desc' } })).map((b: any) => b.title),
    selected: await sys.book.findMany({ select: { title: true }, orderBy: { title: 'asc' } }),
  })))

  test('count, exists, aggregate and groupBy', () => agree(async ({ sys }) => ({
    count: await sys.book.count(),
    exists: await sys.book.exists({ where: { title: 'One' } }),
    // `_max` is the row that fails silently: an unmapped identifier is read as a
    // string constant, so the aggregate answered the literal 'pages'.
    agg: await sys.book.aggregate({ _sum: { pages: true }, _max: { pages: true } }),
    grouped: await sys.book.groupBy({ by: ['authorId'], _count: true }),
  })))

  test('update, updateMany and an atomic operator', () => agree(async ({ sys }) => {
    const r = await sys.book.update({ where: { id: 1 }, data: { title: 'One!' } })
    const m = await sys.book.updateMany({ where: { authorId: 1 }, data: { pages: { increment: 5 } } })
    return { title: r.title, changed: m.count, pages: (await sys.book.findMany({ orderBy: { id: 'asc' } })).map((b: any) => b.pages) }
  }))

  test('a cursor page walks the mapped column', () => agree(async ({ sys }) => {
    const page = await sys.book.findManyCursor({ orderBy: { pages: 'asc' }, limit: 1 })
    const next = await sys.book.findManyCursor({ orderBy: { pages: 'asc' }, limit: 1, cursor: page.nextCursor })
    return { first: page.items.map((b: any) => b.title), second: next.items.map((b: any) => b.title), more: page.hasMore }
  }))

  test('@version bumps the mapped column and still conflicts', () => agree(async ({ sys }) => {
    const before = await sys.book.findFirst({ where: { id: 1 } })
    const after  = await sys.book.update({ where: { id: 1 }, data: { pages: 7 } })
    let conflict = 'NONE'
    try { await sys.book.update({ where: { id: 1 }, data: { rev: before.rev, pages: 8 } }) }
    catch (e: any) { conflict = e.constructor.name }
    return { before: before.rev, after: after.rev, conflict }
  }))

  test('@@softDelete hides the row, withDeleted finds it, restore brings it back', () => agree(async ({ sys }) => {
    await sys.book.remove({ where: { id: 1 } })
    const live = (await sys.book.findMany()).map((b: any) => b.title)
    const all  = (await sys.book.findMany({ withDeleted: true })).map((b: any) => b.title)
    await sys.book.restore({ where: { id: 1 } })
    return { live, all, back: (await sys.book.findMany()).map((b: any) => b.title) }
  }))

  test('@@transitions grades the mapped column', () => agree(async ({ sys }) => {
    const ok = await sys.book.update({ where: { id: 1 }, data: { status: 'published' } })
    let refused = 'ALLOWED'
    try { await sys.book.update({ where: { id: 1 }, data: { status: 'draft' } }) }
    catch (e: any) { refused = e.constructor.name }
    return { moved: ok.status, refused }
  }))
})

describe('@map — the joins and the rules, which fail SILENTLY', () => {
  test('an include reads the target through the target\'s own map', () => agree(async ({ sys }) => {
    const a = await sys.author.findFirst({ where: { penName: 'Ada' }, include: { books: true } })
    const b = await sys.book.findFirst({ where: { title: 'One' }, include: { author: true } })
    return { books: a.books.map((x: any) => x.title).sort(), author: b.author?.penName }
  }))

  test('a relation filter compiles the target\'s columns', () => agree(async ({ sys }) =>
    (await sys.author.findMany({ where: { books: { some: { pages: { gt: 150 } } } } })).map((a: any) => a.penName)))

  test('an @@allow policy filters on the mapped column', () => agree(async ({ db }) =>
    (await db.$setAuth({ id: 2 }).book.findMany()).map((b: any) => b.ownerId)))

  test('a unique conflict names the FIELD', () => agree(async ({ sys }) => {
    try { await sys.author.create({ data: { penName: 'Ada' } }); return 'NO ERROR' }
    catch (e: any) { return e.fields }
  }))

  test('a @@check violation finds the message its author wrote', () => agree(async ({ sys }) => {
    try { await sys.book.create({ data: { title: 'Bad', pages: -1, ownerId: 1, authorId: 1 } }); return 'NO ERROR' }
    catch (e: any) { return e.message }
  }))
})

describe('@map — @@fts', () => {
  const FTS = (m: boolean) => `
model Doc {
  id    Int    @id @default(autoincrement())
  title String ${m ? '@map("doc_title")' : ''}
  body  String ${m ? '@map("doc_body")' : ''}
  @@fts([title, body])
}`
  test('the triggers reference the source table\'s columns', async () => {
    const answers: unknown[] = []
    for (const m of [false, true]) {
      const db: any = await createClient({ db: ':memory:', schema: FTS(m) })
      const sys = db.asSystem()
      await sys.doc.createMany({ data: [
        { title: 'Alpha one', body: 'about widgets' },
        { title: 'Beta two',  body: 'about gadgets' },
      ] })
      answers.push((await sys.doc.search('gadgets')).map((d: any) => d.title))
    }
    expect(answers[1]).toEqual(answers[0])
    expect(answers[1]).toEqual(['Beta two'])
  })
})

describe('@map — the migrator', () => {
  const MIG = (extra = '') => `
model Thing {
  id    Int     @id @default(autoincrement())
  label String  @map("thing_label")
  note  String? @map("thing_note")${extra}
  @@index([label])
  @@unique([label, note])
}`
  const built = (src: string) => {
    const pr  = parse(src)
    const raw = new Database(':memory:')
    for (const s of splitStatements(generateDDL(pr.schema, { foreignKeys: true })))
      if (s && !s.startsWith('PRAGMA')) raw.run(s)
    return { raw, pr }
  }
  const migration = (raw: Database, pr: any) =>
    splitStatements(generateMigrationSQL(diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(raw), pr), pr))
      .filter(s => s && !s.startsWith('PRAGMA') && s !== 'BEGIN' && s !== 'COMMIT')

  // The one that has to stay: a constraint compared by TEXT rebuilds on every
  // boot, and a mapped model is the case where the two sides are written by
  // different code paths.
  test('an unchanged mapped schema migrates nothing', () => {
    const { raw, pr } = built(MIG())
    expect(migration(raw, pr)).toEqual([])
  })

  test('a new mapped column is added under its COLUMN name', () => {
    const { raw } = built(MIG())
    const pr2 = parse(MIG('\n  extra Int? @map("extra_col")'))
    expect(migration(raw, pr2)).toEqual(['ALTER TABLE "thing" ADD COLUMN "extra_col" INTEGER'])
  })
})
