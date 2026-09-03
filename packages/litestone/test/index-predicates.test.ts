// Index predicates and the migrator (FJS-576, FJS-577).
//
// Litestone has emitted partial indexes for as long as `@@softDelete` has
// existed — every `@@index` on such a model is given `WHERE "deletedAt" IS
// NULL`. Two things then held that were each silent:
//
//   FJS-576  `introspect` kept `{name, cols, unique}` per index and dropped the
//            predicate, so a partial index and a full one over the same columns
//            compared equal. A predicate that changed migrated nothing.
//
//   FJS-577  the rebuild path called `generateIndexDDL(model, false, …)`, and
//            the `?? isSoftDelete(model)` beside the parameter is unreachable
//            when the argument is `false`. So any rebuild recreated a
//            soft-delete model's indexes as FULL ones. FJS-443's shape, in the
//            branch its fix did not reach.
//
// Together they compound: 577 degrades the index and 576 is why nothing
// notices, then or ever. Neither returns a wrong row — a predicate changes
// which index the planner may use and never which rows match — so the whole
// cost is a bigger index, a slower read, and `db push` and `migrate apply`
// building different databases.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { generateIndexDDL, generateDDL } from '../src/core/ddl.js'
import {
  introspect, indexPredicate, diffSchemas, buildPristine,
  generateMigrationSQL, splitStatements,
} from '../src/core/migrate.js'

const SOFT  = `model Note { id Int @id @default(autoincrement())  kind String  note String?  @@index([kind])  @@softDelete }`
const PLAIN = `model Note { id Int @id @default(autoincrement())  kind String  note String?  @@index([kind]) }`

const idxSql = (db: Database, name = 'idx_note_kind') =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE name=?`).get(name) as any)?.sql ?? null

function apply(db: Database, sql: string) {
  db.run('PRAGMA foreign_keys=OFF')
  for (const s of splitStatements(sql).filter(s => s && !s.startsWith('PRAGMA'))) db.prepare(s + ';').run()
}

function migrate(live: Database, schema: string) {
  const pr = parse(schema)
  apply(live, generateMigrationSQL(diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr), pr))
}

describe('indexPredicate', () => {
  it('reads the tail of a CREATE INDEX and normalises its whitespace', () => {
    expect(indexPredicate(`CREATE INDEX "i" ON "t" ("a") WHERE "d" IS NULL`)).toBe('"d" IS NULL')
    expect(indexPredicate(`CREATE INDEX "i" ON "t" ("a")\n  WHERE  "d"   IS NULL;`)).toBe('"d" IS NULL')
  })

  it('answers null for a full index', () => {
    expect(indexPredicate(`CREATE INDEX "i" ON "t" ("a", "b")`)).toBeNull()
  })

  it('is not confused by parentheses on either side of the WHERE', () => {
    // The column list cannot contain a `)` followed by WHERE, and a predicate
    // cannot be followed by a second one — so the first such `)` closes the list.
    expect(indexPredicate(`CREATE INDEX "i" ON "t" (lower("a")) WHERE ("x" IS NULL) OR ("y" = 1)`))
      .toBe('("x" IS NULL) OR ("y" = 1)')
  })
})

describe('introspect (FJS-576)', () => {
  it('carries the predicate, so a partial and a full index are not the same index', () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE "note" ("id" INTEGER PRIMARY KEY, "kind" TEXT, "deletedAt" TEXT)`)
    db.run(`CREATE INDEX "idx_note_kind"  ON "note" ("kind") WHERE "deletedAt" IS NULL`)
    db.run(`CREATE INDEX "idx_note_kind2" ON "note" ("kind")`)
    const idx = introspect(db).note.indexes
    expect(idx.find((i: any) => i.name === 'idx_note_kind').where).toBe('"deletedAt" IS NULL')
    expect(idx.find((i: any) => i.name === 'idx_note_kind2').where).toBeNull()
  })

  it('diffs a changed predicate as a drop and an add — it reported no change at all', () => {
    const pr       = parse(SOFT)
    const pristine = buildPristine(new Database(':memory:'), pr)
    const live     = new Database(':memory:')
    buildPristine(live, pr)
    live.run(`DROP INDEX "idx_note_kind"`)
    live.run(`CREATE INDEX "idx_note_kind" ON "note" ("kind")`)   // the ONLY difference

    const diff = diffSchemas(pristine, introspect(live), pr)
    expect(diff.hasChanges).toBe(true)
    const d = diff.tableDiffs.find((t: any) => t.name === 'note')
    expect(d.needsRebuild).toBe(false)                            // an index is not a table change
    expect(d.indexes.added.map((i: any) => i.where)).toEqual(['"deletedAt" IS NULL'])
    expect(d.indexes.dropped.map((i: any) => i.where)).toEqual([null])
  })

  it('repairs it — the generated migration drops the full index and creates the partial one', () => {
    const live = new Database(':memory:')
    buildPristine(live, parse(SOFT))
    live.run(`DROP INDEX "idx_note_kind"`)
    live.run(`CREATE INDEX "idx_note_kind" ON "note" ("kind")`)
    migrate(live, SOFT)
    expect(idxSql(live)).toMatch(/WHERE "deletedAt" IS NULL/)
  })

  it('a model that GAINS @@softDelete has its index reclaused, with its rows kept', () => {
    const live = new Database(':memory:')
    buildPristine(live, parse(PLAIN))
    live.run(`INSERT INTO "note" ("kind") VALUES ('k1')`)
    expect(idxSql(live)).not.toMatch(/WHERE/)
    migrate(live, SOFT)
    expect(idxSql(live)).toMatch(/WHERE "deletedAt" IS NULL/)
    expect((live.prepare(`SELECT count(*) c FROM "note"`).get() as any).c).toBe(1)
  })

  it('an unchanged schema still migrates nothing — the predicate must not churn every boot', () => {
    const live = new Database(':memory:')
    buildPristine(live, parse(SOFT))
    const pr = parse(SOFT)
    expect(diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr).hasChanges).toBe(false)
  })
})

describe('generateIndexDDL (FJS-577)', () => {
  const model = () => parse(SOFT).schema.models[0]

  it('asks the model when the caller states nothing — the fallback was dead code', () => {
    expect(generateIndexDDL(model()).join('\n')).toMatch(/WHERE "deletedAt" IS NULL/)
    expect(generateIndexDDL(model(), undefined).join('\n')).toMatch(/WHERE "deletedAt" IS NULL/)
  })

  it('still takes an explicit answer', () => {
    expect(generateIndexDDL(model(), false).join('\n')).not.toMatch(/WHERE/)
    expect(generateIndexDDL(parse(PLAIN).schema.models[0], true).join('\n')).toMatch(/WHERE "deletedAt" IS NULL/)
  })

  it('a table REBUILD keeps the predicate — it recreated the index as a full one', () => {
    const live = new Database(':memory:')
    buildPristine(live, parse(SOFT))
    live.run(`INSERT INTO "note" ("kind") VALUES ('k1')`)

    // dropping a column forces the 12-step rebuild, which recreates the indexes
    const AFTER = `model Note { id Int @id @default(autoincrement())  kind String  @@index([kind])  @@softDelete }`
    const pr    = parse(AFTER)
    const diff  = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    expect(diff.tableDiffs.find((t: any) => t.name === 'note').needsRebuild).toBe(true)
    apply(live, generateMigrationSQL(diff, pr))

    expect(idxSql(live)).toMatch(/WHERE "deletedAt" IS NULL/)
    expect((live.prepare(`SELECT count(*) c FROM "note"`).get() as any).c).toBe(1)
  })
})

// ─── @@index(where:) — a declared partial index ───────────────────────────────
//
// What a predicate may CONTAIN is not decided by a grammar. It is asked of the
// compiler: a predicate is reachable exactly when it compiles to SQL that binds
// nothing AND that a caller's own `where` can reproduce. SQLite proves a query
// implies a partial index at PREPARE time, so a bound `?` on either side can
// never be matched — and litestone binds every filter value except a null test.
//
// `auth()` and `now()` need no rule of their own; both bind. They get a sentence
// of their own because *this binds a value* is not what the author did wrong.

import { createClient } from '../src/index.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateDDL } from '../src/core/ddl.js'

const M = (attrs: string) => `
model Note {
  id         Int       @id @default(autoincrement())
  kind       String
  status     String
  ownerId    Int
  live       Boolean   @default(true)
  archivedAt DateTime?
${attrs}
}`

const indexLine = (src: string) => {
  const r = parse(src)
  if (!r.valid) throw new Error(r.errors[0])
  return generateDDL(r.schema).split('\n').find(l => l.includes('CREATE INDEX')) ?? ''
}
const refusal = (src: string) => {
  const r = parse(src)
  expect(r.valid).toBe(false)
  return r.errors[0]
}

describe('@@index(where:) — what it accepts', () => {
  it('takes a null test and compiles it to the same SQL a query does', () => {
    expect(parse(M('  @@index([kind], where: archivedAt == null)')).schema.models[0]
      .attributes.find((a: any) => a.kind === 'index').whereSql).toBe('"archivedAt" IS NULL')
    expect(indexLine(M('  @@index([kind], where: archivedAt != null)'))).toMatch(/WHERE "archivedAt" IS NOT NULL/)
  })

  it('takes them joined, both ways', () => {
    expect(indexLine(M('  @@index([kind], where: archivedAt == null && status != null)')))
      .toMatch(/WHERE \("archivedAt" IS NULL AND "status" IS NOT NULL\)/)
    expect(indexLine(M('  @@index([kind], where: archivedAt == null || status == null)')))
      .toMatch(/WHERE \("archivedAt" IS NULL OR "status" IS NULL\)/)
  })

  it('is optional — an ordinary @@index is untouched', () => {
    expect(indexLine(M('  @@index([kind])'))).not.toMatch(/WHERE/)
  })

  it('ANDs with the soft-delete clause rather than replacing it', () => {
    // The soft-delete clause is what makes the index reachable on such a model —
    // every read carries it — so honouring the declaration by dropping it would
    // silently un-optimise every query.
    expect(indexLine(M('  @@index([kind], where: archivedAt == null)\n  @@softDelete')))
      .toMatch(/WHERE \("deletedAt" IS NULL\) AND \("archivedAt" IS NULL\)/)
  })
})

describe('@@index(where:) — what it refuses, and why', () => {
  it('a value comparison, because a bound parameter can never be matched', () => {
    expect(refusal(M('  @@index([kind], where: status == "pending")'))).toMatch(/compares against a value/)
    expect(refusal(M('  @@index([kind], where: status == "pending")'))).toMatch(/binds every filter value/)
  })

  it('still refuses what only ONE compiler inlines — the rule, not the case', () => {
    // FJS-578 was a boolean: the policy compiler inlined `= 1` and the query
    // builder bound it, so such an index was reachable through $scope and never
    // through `where: { live: true }`. The query builder inlines it now, so the
    // case is gone and the rule is what is pinned — a predicate compiling to
    // SQL a caller's own filter cannot reproduce is refused.
    expect(refusal(M('  @@index([kind], where: status == "pending")')))
      .toMatch(/compares against a value/)
  })

  it('auth(), naming what an index is instead of what it bound', () => {
    expect(refusal(M('  @@index([kind], where: ownerId == auth().id)'))).toMatch(/different answer for every caller/)
  })

  it('now(), because SQLite refuses a non-deterministic index predicate', () => {
    expect(refusal(M('  @@index([kind], where: archivedAt < now())'))).toMatch(/SQLite refuses in an index predicate/)
  })

  it('a column this model does not have', () => {
    expect(refusal(M('  @@index([kind], where: nope == null)'))).toMatch(/'nope', which is not a column/)
  })

  it('an unknown argument name — a PARSE error, so there is no schema at all', () => {
    // The distinction is visible in the result: a parse error answers
    // `schema: null`, where a validate refusal above hands back the parsed
    // schema and marks it invalid.
    const r = parse(M('  @@index([kind], filter: archivedAt == null)'))
    expect(r.valid).toBe(false)
    expect(r.schema).toBeNull()
    expect(r.errors[0]).toMatch(/@@index: unknown argument 'filter' — expected 'where'/)
  })

  it('two @@index over the same columns — one derived name, predicate or not', () => {
    expect(refusal(M('  @@index([kind], where: archivedAt == null)\n  @@index([kind], where: status == null)')))
      .toMatch(/derive the same index name/)
  })
})

describe('@@index(where:) — the planner really uses it', () => {
  it('SEARCHes with the predicate stated and SCANs without it', async () => {
    const db: any = await createClient({
      db: ':memory:',
      schema: M('  @@index([kind], where: archivedAt == null)'),
    })
    for (let i = 0; i < 2000; i++)
      await db.note.create({ data: { kind: 'k' + (i % 13), status: 'open', ownerId: 1,
                                     archivedAt: i % 5 ? null : new Date('2020-01-01') } })
    const raw = db.asSystem()
    await raw.sql`ANALYZE`

    expect((await raw.sql`SELECT sql FROM sqlite_master WHERE name='idx_note_kind'`)[0].sql)
      .toMatch(/WHERE "archivedAt" IS NULL/)

    // the `?` on kind is what litestone really emits; the null test is literal
    const withIt = await raw.sql`EXPLAIN QUERY PLAN SELECT * FROM "note" WHERE "kind" = ${'k3'} AND "archivedAt" IS NULL`
    const without = await raw.sql`EXPLAIN QUERY PLAN SELECT * FROM "note" WHERE "kind" = ${'k3'}`
    expect(withIt.map((r: any) => r.detail).join(' ')).toMatch(/USING INDEX idx_note_kind/)
    expect(without.map((r: any) => r.detail).join(' ')).toMatch(/SCAN/)
  })

  it('survives a round trip through the migrator', () => {
    const src = M('  @@index([kind], where: archivedAt == null)')
    const live = new Database(':memory:')
    buildPristine(live, parse(src))
    expect(idxSql(live)).toMatch(/WHERE "archivedAt" IS NULL/)
    const pr = parse(src)
    expect(diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr).hasChanges).toBe(false)
  })

  it('a predicate that CHANGES is migrated', () => {
    const live = new Database(':memory:')
    buildPristine(live, parse(M('  @@index([kind], where: archivedAt == null)')))
    migrate(live, M('  @@index([kind], where: archivedAt != null)'))
    expect(idxSql(live)).toMatch(/WHERE "archivedAt" IS NOT NULL/)
  })
})

describe('@@index(where:) beside @@softDelete', () => {
  it('refuses the clause @@softDelete already gives, in FJS-480 words', () => {
    // Not a correctness fix: SQLite reaches the doubled index either way.
    // Refused because it is the line a converter writes — `deleted_at IS NULL`
    // is the commonest predicate there is, and here it is already implied.
    expect(refusal(M('  @@index([kind], where: archivedAt == null)\n  @@softDelete')
      .replace('archivedAt == null)', 'deletedAt == null)')
      .replace('  archivedAt DateTime?', '  archivedAt DateTime?\n  deletedAt  DateTime?')))
      .toMatch(/already gives every index on this model/)
  })

  it('still takes a predicate @@softDelete does not say', () => {
    expect(indexLine(M('  @@index([kind], where: archivedAt == null)\n  @@softDelete')))
      .toMatch(/WHERE \("deletedAt" IS NULL\) AND \("archivedAt" IS NULL\)/)
  })
})

// ─── FJS-578 — one meaning, one string ───────────────────────────────────────
//
// Two compilers turn a predicate into SQL: the policy compiler (@@scope,
// @@allow, the soft-delete clause) and the query builder a caller's own `where`
// goes through. They disagreed about a boolean — inlined `= 1` against bound
// `= ?` — which is invisible until something has to COMPARE the two strings.
// A partial index is that something: SQLite proves a query implies one at
// PREPARE time, and a `?` proves nothing.

describe('a boolean is written the same way by both compilers (FJS-578)', () => {
  const boolSchema = `model Note {
    id   Int     @id @default(autoincrement())
    kind String
    live Boolean @default(true)
    @@index([kind], where: live == true)
  }`

  it('a caller\'s filter inlines it, where it used to bind', async () => {
    const seen: any[] = []
    const db: any = await createClient({ db: ':memory:', schema: boolSchema, onQuery: (e: any) => seen.push(e) })
    await db.note.create({ data: { kind: 'k1' } })

    const sqlFor = async (fn: () => any) => {
      seen.length = 0; await fn()
      return seen.find(e => /SELECT \* FROM/i.test(e.sql ?? ''))?.sql ?? ''
    }
    expect(await sqlFor(() => db.note.findMany({ where: { live: true } }))).toMatch(/"live" = 1/)
    expect(await sqlFor(() => db.note.findMany({ where: { live: false } }))).toMatch(/"live" = 0/)
    expect(await sqlFor(() => db.note.findMany({ where: { live: { equals: true } } }))).toMatch(/"live" = 1/)
    expect(await sqlFor(() => db.note.findMany({ where: { live: { not: true } } }))).toMatch(/"live" != 1/)
    expect(await sqlFor(() => db.note.findMany({ where: { live: { in: [true, false] } } }))).toMatch(/IN \(1, 0\)/)
    // a non-boolean is untouched — it still binds
    expect(await sqlFor(() => db.note.findMany({ where: { kind: 'k1' } }))).toMatch(/"kind" = \?/)
  })

  it('so a boolean partial index is reachable from the caller\'s OWN query', async () => {
    // EXPLAIN the bytes the client actually sent. A hand-written lookalike
    // passes whatever the query builder does, which is no test of it at all.
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-partial-'))
    const file = join(dir, 'db.sqlite')
    try {
      const seen: any[] = []
      const db: any = await createClient({ db: file, schema: boolSchema, onQuery: (e: any) => seen.push(e) })
      for (let i = 0; i < 1500; i++) await db.note.create({ data: { kind: 'k' + (i % 13), live: i % 4 !== 0 } })
      await db.asSystem().sql`ANALYZE`

      seen.length = 0
      await db.note.findMany({ where: { kind: 'k3', live: true } })
      const q = seen.find(e => e.operation === 'findMany')
      expect(q.sql).toMatch(/"live" = 1/)

      const raw = new Database(file, { readonly: true })
      try {
        expect((raw.prepare(`SELECT sql FROM sqlite_master WHERE name='idx_note_kind'`).get() as any).sql)
          .toMatch(/WHERE "live" = 1/)
        const plan = raw.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params) as any[]
        expect(plan.map(r => r.detail).join(' ')).toMatch(/USING (COVERING )?INDEX idx_note_kind/)
      } finally { raw.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('and the rows are still the right rows', async () => {
    const db: any = await createClient({ db: ':memory:', schema: boolSchema })
    for (let i = 0; i < 40; i++) await db.note.create({ data: { kind: 'k', live: i % 4 !== 0 } })
    expect((await db.note.findMany({ where: { live: true } })).length).toBe(30)
    expect((await db.note.findMany({ where: { live: false } })).length).toBe(10)
    expect((await db.note.findMany({ where: { live: { not: true } } })).length).toBe(10)
    expect((await db.note.findMany({ where: { live: { in: [true, false] } } })).length).toBe(40)
  })
})

// ─── litestone introspect — the predicate crossing back (FJS-586, FJS-584) ────
//
// Reading a database INTO a schema is the other direction, and it discarded
// every index predicate. For a plain index that only widens the index; for a
// UNIQUE one it STRENGTHENS the constraint — `WHERE deleted_at IS NULL` is
// uniqueness among live rows, and `@unique` is uniqueness among all of them, so
// the generated schema refused writes the source database accepted. That
// asymmetry is the whole of this block.
//
// The product is a file somebody can use, so the headline assertion is that it
// PARSES. Three things here were found only by asking that: a `///` note at the
// end of a model body attaches to nothing, litestone names an index for its
// columns so two over one list cannot both be declared, and a composite unique
// over a nullable column needs `nullsDistinct: true` to be legal at all.

import { generateLiteSchema } from '../src/tools/introspect.js'
import { parseIndexColumns, parseIndexSorts, isIndexExpression, predicateToLite } from '../src/core/migrate.js'

const introspected = (ddl: string[]) => {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE note (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, email TEXT,
    live INTEGER, archivedAt TEXT, deletedAt TEXT)`)
  for (const d of ddl) db.run(d)
  try { return generateLiteSchema(db) } finally { db.close() }
}

describe('parseIndexColumns — one owner, and it can count brackets (FJS-584)', () => {
  it('keeps an expression whole instead of cutting it at the first bracket', () => {
    expect(parseIndexColumns('CREATE INDEX i ON t (lower(a))')).toEqual(['lower(a)'])
    expect(parseIndexColumns('CREATE INDEX i ON t (substr(a, 1, 2), b)')).toEqual(['substr(a, 1, 2)', 'b'])
  })

  it('reads an ordinary list, quoted or not', () => {
    expect(parseIndexColumns('CREATE INDEX i ON t (a, b)')).toEqual(['a', 'b'])
    expect(parseIndexColumns('CREATE INDEX i ON "t" ("a", "b")')).toEqual(['a', 'b'])
  })

  it('steps over a quoted table name that holds a bracket of its own', () => {
    expect(parseIndexColumns('CREATE UNIQUE INDEX i ON "my(tbl" ("a") WHERE x = 1')).toEqual(['a'])
  })

  it('says which members are not names', () => {
    expect(isIndexExpression('lower(a)')).toBe(true)
    expect(isIndexExpression('kind')).toBe(false)
  })
})

describe('litestone introspect — a partial UNIQUE is not @unique (FJS-586)', () => {
  it('refuses to strengthen the constraint, and says what it dropped', () => {
    const out = introspected([`CREATE UNIQUE INDEX u ON note (email) WHERE deletedAt IS NULL`])
    expect(out).not.toMatch(/email\s+String\?\s+@unique/)
    expect(out).toMatch(/FIXME: email is UNIQUE only where \(deletedAt IS NULL\)/)
  })

  it('but a TOTAL unique still becomes @unique — the predicate is the difference', () => {
    expect(introspected([`CREATE UNIQUE INDEX u ON note (email)`])).toMatch(/email\s+String\?\s+@unique/)
  })

  it('a composite unique over a nullable column carries nullsDistinct', () => {
    // Two NULLs never compare equal, so this is what SQLite is already doing —
    // and without the word litestone refuses the declaration outright.
    expect(introspected([`CREATE UNIQUE INDEX u ON note (kind, email)`]))
      .toMatch(/@@unique\(\[kind, email\], nullsDistinct: true\)/)
  })
})

describe('litestone introspect — a partial plain index comes back whole', () => {
  it('emits the predicate it can express', () => {
    expect(introspected([`CREATE INDEX i ON note (kind) WHERE archivedAt IS NULL`]))
      .toMatch(/@@index\(\[kind\], where: archivedAt == null\)/)
    expect(introspected([`CREATE INDEX i ON note (kind, email) WHERE live = 1`]))
      .toMatch(/@@index\(\[kind, email\], where: live == true\)/)
  })

  it('drops one it cannot, and says so — a plain index is only wider, never wrong', () => {
    const out = introspected([`CREATE INDEX i ON note (kind, email) WHERE length(kind) > 3`])
    expect(out).toMatch(/@@index\(\[kind, email\]\)/)
    expect(out).toMatch(/NOTE: index "i" was partial/)
  })

  it('leaves the soft-delete clause implicit, because declaring it is refused', () => {
    const out = introspected([`CREATE INDEX i ON note (kind, email) WHERE deletedAt IS NULL`])
    expect(out).toMatch(/@@index\(\[kind, email\]\)/)
    expect(out).not.toMatch(/where: deletedAt == null/)
  })

  it('hands over an index over an expression', () => {
    expect(introspected([`CREATE INDEX i ON note (lower(email))`]))
      .toMatch(/FIXME: index "i" is over the expression \(lower\(email\)\)/)
  })

  it('keeps ONE index per column list and hands over the rest', () => {
    const out = introspected([
      `CREATE INDEX a ON note (kind, email) WHERE live = 1`,
      `CREATE INDEX b ON note (kind, email) WHERE live = 0`,
    ])
    expect(out).toMatch(/@@index\(\[kind, email\], where: live == true\)/)
    expect(out).toMatch(/FIXME: index "b" is a second index over \[kind, email\]/)
  })
})

describe('litestone introspect — the generated schema parses', () => {
  it('round-trips every shape at once', () => {
    const out = introspected([
      `CREATE UNIQUE INDEX u1 ON note (email) WHERE deletedAt IS NULL`,
      `CREATE UNIQUE INDEX u2 ON note (kind, email)`,
      `CREATE INDEX i1 ON note (kind) WHERE archivedAt IS NULL`,
      `CREATE INDEX i2 ON note (kind, email) WHERE deletedAt IS NULL`,
      `CREATE INDEX i3 ON note (kind, email) WHERE live = 1`,
      `CREATE INDEX i4 ON note (kind, email) WHERE length(kind) > 3`,
      `CREATE INDEX i5 ON note (lower(email))`,
    ])
    const r = parse(out)
    expect(r.errors).toEqual([])
    expect(r.valid).toBe(true)
  })

  it('and a note is never a doc comment — one at the end of a model attaches to nothing', () => {
    const out = introspected([`CREATE INDEX i ON note (lower(email))`])
    expect(out).toMatch(/^\s*\/\/ FIXME:/m)
    expect(out).not.toMatch(/^\s*\/\/\/ FIXME: index/m)
    expect(parse(out).valid).toBe(true)
  })
})

describe('an index column may carry a direction (`FJS-591`)', () => {
  // Prisma's spelling, and ZenStack v2 and v3 declare `@@index` byte-identically
  // and mark it `@@@prisma` — inherited unchanged — so one spelling covers all
  // three and an imported schema carries it straight through.
  const ddl = (src: string) => generateDDL(parse(src).schema)
  const M = (sort: string) =>
    `model Ev {\n  id Int @id @default(autoincrement())\n  orgId Int\n  createdAt DateTime\n  @@index([orgId, createdAt${sort}])\n}\n`

  it('it parses, and the fields stay a plain list', () => {
    const attr: any = parse(M('(sort: Desc)')).schema.models[0].attributes.find((a: any) => a.kind === 'index')
    expect(attr.fields).toEqual(['orgId', 'createdAt'])
    expect(attr.sorts).toEqual([null, 'DESC'])
  })

  it('no direction anywhere leaves `sorts` null, so nothing downstream branches', () => {
    const attr: any = parse(M('')).schema.models[0].attributes.find((a: any) => a.kind === 'index')
    expect(attr.sorts).toBe(null)
  })

  it('the DDL carries it, and the index NAME does not change', () => {
    expect(ddl(M('(sort: Desc)'))).toContain('"idx_ev_orgId_createdAt" ON "ev" ("orgId", "createdAt" DESC)')
    expect(ddl(M(''))).toContain('"idx_ev_orgId_createdAt" ON "ev" ("orgId", "createdAt")')
  })

  it('lowercase is the client\'s own orderBy spelling and means the same thing', () => {
    expect(ddl(M('(sort: desc)'))).toContain('"createdAt" DESC')
  })

  it('anything else is refused by name', () => {
    expect(parse(M('(sort: Sideways)')).errors.join(' ')).toMatch(/sort must be Asc or Desc/)
    expect(parse(M('(order: Desc)')).errors.join(' ')).toMatch(/unknown column argument 'order'/)
  })

  it('the readers agree, and a quoted column with a direction is not an expression', () => {
    const sql = 'CREATE INDEX i ON "t" ("a", "b" DESC)'
    expect(parseIndexColumns(sql)).toEqual(['a', 'b'])
    expect(parseIndexSorts(sql)).toEqual([null, 'DESC'])
    // Without stripping the direction first, de-quoting leaves `b" DESC`, which
    // reads as an expression — the FJS-584 shape one modifier along.
    expect(isIndexExpression(parseIndexColumns(sql)[1]!)).toBe(false)
  })

  it('an expression index is untouched by the direction parse', () => {
    expect(parseIndexColumns('CREATE INDEX i ON t (lower(a), b DESC)')).toEqual(['lower(a)', 'b'])
    expect(parseIndexSorts('CREATE INDEX i ON t (lower(a), b DESC)')).toEqual([null, 'DESC'])
  })

  it('a changed direction MIGRATES — the name is the same, so nothing else would see it', () => {
    const live = new Database(':memory:')
    for (const stmt of ddl(M('')).split(';').map(x => x.trim()).filter(Boolean)) live.run(stmt + ';')

    const pr   = parse(M('(sort: Desc)'))
    const diff = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    const ev   = diff.tableDiffs.find((t: any) => t.name === 'ev')!

    expect(ev.indexes.dropped.map((i: any) => i.name)).toEqual(['idx_ev_orgId_createdAt'])
    expect(ev.indexes.added.map((i: any) => i.sorts)).toEqual([[null, 'DESC']])

    const sql = generateMigrationSQL(diff, pr)
    // The drop has to come first: same name, and CREATE INDEX IF NOT EXISTS
    // over a live one is a silent no-op.
    expect(sql.indexOf('DROP INDEX')).toBeLessThan(sql.indexOf('CREATE INDEX'))
    expect(sql).toContain('"orgId", "createdAt" DESC')
  })

  it('an unchanged schema still migrates nothing', () => {
    const live = new Database(':memory:')
    for (const stmt of ddl(M('(sort: Desc)')).split(';').map(x => x.trim()).filter(Boolean)) live.run(stmt + ';')
    const pr   = parse(M('(sort: Desc)'))
    const diff = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    const ev   = diff.tableDiffs.find((t: any) => t.name === 'ev')
    expect(ev?.indexes.added ?? []).toEqual([])
    expect(ev?.indexes.dropped ?? []).toEqual([])
  })
})

describe('an index\'s column ORDER is part of what it is (`FJS-592`)', () => {
  // The same blindness as the direction one column along, and the sharper half:
  // a composite index is prefix-matched, so `[orgId, createdAt]` answers
  // `WHERE orgId = ?` and `[createdAt, orgId]` does not. `indexKey` compared the
  // columns as a SET, so swapping them was a real schema change that reported
  // as no change at all.
  const ddl = (src: string) => generateDDL(parse(src).schema)
  const M = (cols: string) =>
    `model Ev {\n  id Int @id @default(autoincrement())\n  orgId Int\n  createdAt DateTime\n  @@index([${cols}])\n}\n`

  const diffOf = (liveCols: string, wantCols: string) => {
    const live = new Database(':memory:')
    for (const stmt of ddl(M(liveCols)).split(';').map(x => x.trim()).filter(Boolean)) live.run(stmt + ';')
    const pr = parse(M(wantCols))
    const d  = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    return { ev: d.tableDiffs.find((t: any) => t.name === 'ev'), diff: d, pr }
  }

  it('reordering the columns MIGRATES', () => {
    const { ev, diff, pr } = diffOf('orgId, createdAt', 'createdAt, orgId')
    expect(ev!.indexes.dropped.map((i: any) => i.name)).toEqual(['idx_ev_orgId_createdAt'])
    expect(ev!.indexes.added.map((i: any) => i.cols)).toEqual([['createdAt', 'orgId']])

    // One DROP INDEX and one CREATE INDEX — not a table rebuild, which is what
    // makes the order worth being strict about.
    const sql = generateMigrationSQL(diff, pr)
    expect(sql).toContain('DROP INDEX')
    expect(sql).toContain('"createdAt", "orgId"')
    expect(sql).not.toContain('DROP TABLE')
  })

  it('and the same order still migrates nothing — the negative control', () => {
    const { ev } = diffOf('orgId, createdAt', 'orgId, createdAt')
    expect(ev?.indexes.added ?? []).toEqual([])
    expect(ev?.indexes.dropped ?? []).toEqual([])
  })

  it('a reordered `@@unique` migrates too — as a REBUILD, because it is a table constraint', () => {
    // The sibling of the above, and the expensive half. `@@unique` emits
    // `UNIQUE ("a", "b")` inside CREATE TABLE, so it never reaches `indexKey`
    // and the index diff cannot see it at all; the implicit index SQLite builds
    // for the constraint is prefix-matched like any other, so the two orders
    // serve different queries while admitting exactly the same rows. There is
    // no ALTER for a table constraint, so the only way to change one is to
    // rebuild — which is why this shipped after FJS-592 rather than with it
    // (`FJS-596`).
    const U = (cols: string) =>
      `model Ev {\n  id Int @id @default(autoincrement())\n  orgId Int\n  createdAt DateTime\n  @@unique([${cols}])\n}\n`
    expect(ddl(U('orgId, createdAt'))).toContain('UNIQUE ("orgId", "createdAt")')

    const live = new Database(':memory:')
    for (const stmt of ddl(U('orgId, createdAt')).split(';').map(x => x.trim()).filter(Boolean)) live.run(stmt + ';')
    const pr = parse(U('createdAt, orgId'))
    const d  = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    const ev = d.tableDiffs.find((t: any) => t.name === 'ev')!

    expect(ev.uniquesChanged).toBe(true)
    expect(ev.needsRebuild).toBe(true)
    expect(ev.uniques.added.map((u: any) => u.cols)).toEqual([['createdAt', 'orgId']])
    expect(ev.uniques.dropped.map((u: any) => u.cols)).toEqual([['orgId', 'createdAt']])

    // The index diff still sees nothing — which is the point. The constraint is
    // not an index to `sqlite_master`, so this had to be read somewhere else.
    expect(ev.indexes.added).toEqual([])
    expect(ev.indexes.dropped).toEqual([])

    const sql = generateMigrationSQL(d, pr)
    expect(sql).toContain('DROP TABLE "ev"')
    expect(sql).toContain('UNIQUE ("createdAt", "orgId")')
  })

  it('the same `@@unique` order still migrates nothing — the negative control', () => {
    const U = `model Ev {\n  id Int @id @default(autoincrement())\n  orgId Int\n  createdAt DateTime\n  @@unique([orgId, createdAt])\n}\n`
    const live = new Database(':memory:')
    for (const stmt of ddl(U).split(';').map(x => x.trim()).filter(Boolean)) live.run(stmt + ';')
    const pr = parse(U)
    const d  = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    expect(d.tableDiffs.find((t: any) => t.name === 'ev')).toBeUndefined()
  })
})

// ─── Uniqueness the TABLE declares (FJS-596) ─────────────────────────────────
//
// The reorder above is the performance half. This is the sharp one: a `@@unique`
// ADDED to an existing model migrated nothing, so the schema declared a
// constraint the live table did not enforce, `UniqueConflictError` never fired,
// and the duplicate landed. The mirror is as bad the other way — a `@@unique`
// REMOVED left the live table refusing writes the schema allows, in SQLite's
// own words about a table nobody named.
//
// Invisible for the same one reason in every case: an implicit index has NULL
// `sql` in `sqlite_master`, which is exactly what the index read filters on.

describe('a UNIQUE the table declares itself', () => {
  const ddl = (src: string) => generateDDL(parse(src).schema)
  const probe = (liveSrc: string, wantSrc: string) => {
    const live = new Database(':memory:')
    for (const stmt of ddl(liveSrc).split(';').map(x => x.trim()).filter(Boolean)) live.run(stmt + ';')
    const pr = parse(wantSrc)
    const d  = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    return { d, pr, ev: d.tableDiffs.find((t: any) => t.name === 'ev') as any }
  }
  const M = (body: string) =>
    `model Ev {\n  id Int @id @default(autoincrement())\n  orgId Int\n  email String${body}\n}\n`

  it('ADDING one rebuilds — the schema was declaring a constraint the table did not enforce', () => {
    const { ev, d, pr } = probe(M(''), M('\n  @@unique([orgId, email])'))
    expect(ev.needsRebuild).toBe(true)
    expect(ev.uniques.added.map((u: any) => u.cols)).toEqual([['orgId', 'email']])
    expect(generateMigrationSQL(d, pr)).toContain('UNIQUE ("orgId", "email")')
  })

  it('REMOVING one rebuilds — the table was refusing writes the schema allows', () => {
    const { ev, d, pr } = probe(M('\n  @@unique([orgId, email])'), M(''))
    expect(ev.needsRebuild).toBe(true)
    expect(ev.uniques.dropped.map((u: any) => u.cols)).toEqual([['orgId', 'email']])
    expect(generateMigrationSQL(d, pr)).not.toContain('UNIQUE (')
  })

  it('a column-level `@unique` is the same constraint, and is caught the same way', () => {
    const { ev } = probe(M(''), M(' @unique'))
    expect(ev.needsRebuild).toBe(true)
    expect(ev.uniques.added.map((u: any) => u.cols)).toEqual([['email']])
  })

  it('and moving between the two SPELLINGS migrates nothing — the negative control', () => {
    // `@unique` on a column and `@@unique([thatColumn])` build the same implicit
    // index, so a schema that swaps one for the other has changed nothing about
    // the database. Read off the pragma rather than the CREATE text, which is
    // what makes the two compare equal.
    const { d } = probe(M(' @unique'), M('\n  @@unique([email])'))
    expect(d.tableDiffs).toEqual([])
  })

  it('a composite PRIMARY KEY is the third spelling of it, and its column order counts too', () => {
    // Same pragma, same prefix-matching fact: `PRIMARY KEY (a, b)` builds an
    // implicit index that answers `WHERE a = ?` and the swap does not. Column
    // NAMES were already diffed; the order was not.
    const P = (a: string, b: string) => `model Ev {\n  ${a} String @id\n  ${b} String @id\n  x Int\n}\n`
    const live = new Database(':memory:')
    for (const stmt of ddl(P('orgId', 'userId')).split(';').map(x => x.trim()).filter(Boolean)) live.run(stmt + ';')
    const pr = parse(P('userId', 'orgId'))
    const d  = diffSchemas(buildPristine(new Database(':memory:'), pr), introspect(live), pr)
    const ev = d.tableDiffs.find((t: any) => t.name === 'ev') as any
    expect(ev.needsRebuild).toBe(true)
    expect(ev.uniques.added.map((u: any) => u.cols)).toEqual([['userId', 'orgId']])
  })

  it('an explicit CREATE UNIQUE INDEX is NOT read here — it belongs to the index diff', () => {
    // `origin: 'c'` is filtered out, or an index over the same columns would be
    // seen by both readers and each would report the other's as missing. It is
    // also what keeps an index the APP made out of this: those are `foreign` to
    // `diffIndexes`, which deliberately leaves them alone, and reading one here
    // would rebuild the table to remove a constraint litestone never declared.
    const live = new Database(':memory:')
    live.run(`CREATE TABLE "ev" ("id" INTEGER PRIMARY KEY, "orgId" INTEGER, "email" TEXT UNIQUE);`)
    live.run(`CREATE UNIQUE INDEX "u_ev" ON "ev" ("orgId", "email");`)

    // The constraint is read; the explicit index is not.
    expect(introspect(live).ev.uniques).toEqual([{ origin: 'u', cols: ['email'] }])
    expect(introspect(live).ev.indexes.map((i: any) => i.name)).toEqual(['u_ev'])
  })
})

// ─── The two conversion paths agree (FJS-590) ────────────────────────────────
//
// `litestone introspect` reads a live database; `litestone import` reads a dump.
// Both answer "what does this partial index become", and for a few hours they
// answered differently — introspect emitted the predicate and the importer,
// written before `@@index(where:)` existed, dropped it. One owner now:
// `predicateToLite` in core/migrate.js, read by three converters.

import { convert } from '../src/import/index.js'

const IMPORT_SQL = (idx: string[]) => `
CREATE TABLE notes (id integer PRIMARY KEY, kind text NOT NULL, email text,
                    live boolean, archived_at timestamp, deleted_at timestamp);
${idx.join('\n')}
`
const imported = (idx: string[]) => convert({ source: IMPORT_SQL(idx), format: 'sql', label: 'probe' })

describe('predicateToLite — the one owner', () => {
  const id = (x: string) => x

  it('translates a null test and both spellings of a boolean', () => {
    // SQLite writes 1/0 and Postgres writes true/false, and both reach here —
    // one from a live database, one from a dump.
    expect(predicateToLite('deletedAt IS NULL', id)).toBe('deletedAt == null')
    expect(predicateToLite('archived_at IS NOT NULL', id)).toBe('archived_at != null')
    expect(predicateToLite('live = 1', id)).toBe('live == true')
    expect(predicateToLite('live = true', id)).toBe('live == true')
    expect(predicateToLite('live = false', id)).toBe('live == false')
  })

  it('joins conjunctions, either connective', () => {
    expect(predicateToLite('(a IS NULL) AND (b IS NOT NULL)', id)).toBe('a == null && b != null')
    expect(predicateToLite('(a IS NULL) OR (b = 0)', id)).toBe('a == null || b == false')
    expect(predicateToLite('a IS NULL AND b = 1 AND c IS NOT NULL', id))
      .toBe('a == null && b == true && c != null')
  })

  it('refuses what it cannot mean exactly', () => {
    expect(predicateToLite('length(k) > 3', id)).toBeNull()
    expect(predicateToLite('status = 2', id)).toBeNull()
    // mixed AND/OR at one level is a precedence judgement, not a translation
    expect(predicateToLite('(a IS NULL) AND (b = 1) OR (c IS NULL)', id)).toBeNull()
    // a bare column is only a boolean if the column is one, which is a guess
    expect(predicateToLite('live', id)).toBeNull()
  })
})

describe('litestone import — the predicate survives', () => {
  it('emits one it can hold, and says so in the gap record', () => {
    const r = imported([`CREATE INDEX i ON notes (kind) WHERE archived_at IS NULL;`])
    expect(r.lite).toMatch(/@@index\(\[kind\], where: archivedAt == null\)/)
    expect(r.gaps.find((g: any) => g.kind === 'partial-index').emitted).toMatch(/emitted whole/)
  })

  it('drops one it cannot, and a plain index is only wider', () => {
    const r = imported([`CREATE INDEX i ON notes (kind) WHERE length(kind) > 3;`])
    expect(r.lite).toMatch(/@@index\(\[kind\]\)/)
    expect(r.gaps.find((g: any) => g.kind === 'partial-index').emitted).toMatch(/without the predicate/)
  })

  // FJS-603 turned this one round: a partial unique is CARRIED now, because
  // `@@unique(where:)` exists to hold it.
  it('carries a partial UNIQUE, which it used to drop whole', () => {
    const r = imported([`CREATE UNIQUE INDEX u ON notes (kind) WHERE deleted_at IS NULL;`])
    expect(r.lite).toMatch(/@@unique\(\[kind\], where: deletedAt == null\)/)
    expect(r.gaps.find((g: any) => g.kind === 'partial-index').emitted).toMatch(/carried whole/)
  })

  // …and the value form, which is the grammar the two attributes do not share:
  // a partial INDEX over a bound value is refused at parse, so this reading is
  // asked for on the unique path alone.
  it('carries a value comparison on a unique and never on an index', () => {
    const u = imported([`CREATE UNIQUE INDEX u ON notes (kind) WHERE status = 'active';`])
    expect(u.lite).toMatch(/@@unique\(\[kind\], where: status == "active"\)/)
    const i = imported([`CREATE INDEX i ON notes (kind) WHERE status = 'active';`])
    expect(i.lite).toMatch(/@@index\(\[kind\]\)/)
    expect(i.gaps.find((g: any) => g.kind === 'partial-index').emitted).toMatch(/without the predicate/)
  })

  // The one it still drops, and the reason is the round trip: a nullable member
  // needs `nullsDistinct: true`, a predicate excludes it, and emitting both is
  // a schema this parser refuses (FJS-594).
  it('drops a partial unique whose tuple has a nullable member, rather than writing one that will not parse', () => {
    const r = imported([`CREATE UNIQUE INDEX u ON notes (email, kind) WHERE deleted_at IS NULL;`])
    expect(r.lite).not.toMatch(/@@unique/)
    expect(r.gaps.find((g: any) => g.kind === 'partial-index').emitted).toMatch(/nullsDistinct, which a predicate excludes/)
  })

  it('and what it emits parses', () => {
    const r = imported([
      `CREATE INDEX i1 ON notes (kind) WHERE archived_at IS NULL;`,
      `CREATE INDEX i2 ON notes (email) WHERE live = true;`,
      `CREATE INDEX i3 ON notes (archived_at) WHERE (archived_at IS NULL) AND (live = true);`,
      `CREATE INDEX i4 ON notes (live) WHERE length(kind) > 3;`,
      `CREATE UNIQUE INDEX u1 ON notes (email, kind) WHERE deleted_at IS NULL;`,
    ])
    const p = parse(r.lite)
    expect(p.errors).toEqual([])
    expect(p.valid).toBe(true)
  })

  it('answers the same thing introspect does for the same index', () => {
    // The actual FJS-590 assertion: one question, one answer, two readers.
    for (const [sqlite, pg] of [
      [`CREATE INDEX i ON note (kind) WHERE archivedAt IS NULL`,
       `CREATE INDEX i ON notes (kind) WHERE archived_at IS NULL;`],
      [`CREATE INDEX i ON note (kind, email) WHERE live = 1`,
       `CREATE INDEX i ON notes (kind, email) WHERE live = true;`],
      [`CREATE INDEX i ON note (kind) WHERE length(kind) > 3`,
       `CREATE INDEX i ON notes (kind) WHERE length(kind) > 3;`],
    ]) {
      const a = (introspected([sqlite]).match(/@@index\(.*\)/) ?? [''])[0]
      const b = (imported([pg]).lite.match(/@@index\(.*\)/) ?? [''])[0]
      expect(b).toBe(a)
    }
  })
})

// ─── @@unique(where:) — conditional uniqueness (FJS-603) ─────────────────────
//
// `@@unique([planId], where: effectiveTo == null)` — at most one OPEN row per
// parent, which is the constraint effective dating is built on and which three
// models in `example` declared the exact opposite of, because `nullsDistinct:
// true` was the only argument the attribute took.
//
// One word, two node kinds. A plain `@@unique` rides inside CREATE TABLE; a
// predicate cannot, so this is a standalone CREATE UNIQUE INDEX. Most of the
// assertions below are about that split being real rather than cosmetic.
//
// The load-bearing one is `the soft-delete clause is NOT ANDed in`. On an
// @@index the AND is an optimisation; on a UNIQUE index the predicate IS the
// constraint, and ANDing it is FJS-204's rejected derivation arriving through
// the back door — the deleted row stops holding its @unique slot.

describe('@@unique(where:) — what it parses to', () => {
  const one = (src: string) => parse(`model W {
    id Int @id @default(autoincrement())
    employeeId Int
    rate Int
    status String @default("active")
    effectiveTo DateTime?
    ${src}
  }`)

  it('a predicate makes it a DIFFERENT node kind from a plain @@unique', () => {
    const a = one('@@unique([employeeId])').schema.models[0].attributes.find((x: any) => x.kind === 'uniqueIndex')
    const b = one('@@unique([employeeId], where: effectiveTo == null)').schema.models[0]
      .attributes.find((x: any) => x.kind === 'partialUnique')
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    // Which is what keeps the table emitter correct without being edited.
    expect(b.whereSql).toBe('"effectiveTo" IS NULL')
  })

  it('emits a standalone CREATE UNIQUE INDEX and nothing inside the table', () => {
    const ddl = generateDDL(one('@@unique([employeeId], where: effectiveTo == null)').schema)
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_w_employeeId" ON "w" ("employeeId") WHERE "effectiveTo" IS NULL;')
    expect(ddl).not.toContain('UNIQUE ("employeeId")')
  })

  // The record this was built from claimed the value comparison could simply be
  // allowed, on the grounds that enforcement never goes through the planner.
  // Half right: SQLite refuses a BOUND PARAMETER in a partial index predicate
  // whether or not it is unique, and litestone binds every value it compiles.
  // Measured — `parameters prohibited in partial index WHERE clauses`, at
  // migration time, naming a table the author is no longer looking at.
  it('inlines the literals a value comparison compiles to, because SQLite refuses a parameter', () => {
    const r = one('@@unique([employeeId], where: status == "active")')
    expect(r.errors).toEqual([])
    const a = r.schema.models[0].attributes.find((x: any) => x.kind === 'partialUnique')
    expect(a.whereSql).toBe(`"status" = 'active'`)
    expect(a.whereSql).not.toContain('?')
    // …and the DDL SQLite is handed actually builds.
    const db = new Database(':memory:')
    apply(db, generateDDL(r.schema))
    expect(idxSql(db, 'idx_w_employeeId')).toContain(`WHERE "status" = 'active'`)
  })

  it('accepts a comparison @@index(where:) refuses, and for the reason the two differ', () => {
    // On @@index this is refused: the planner cannot prove a query implies it.
    // A unique index is enforced on INSERT and never consults the planner.
    expect(one('@@index([employeeId], where: status == "active")').errors.length).toBe(1)
    expect(one('@@unique([employeeId], where: status == "active")').errors).toEqual([])
  })

  it('refuses `where` and `nullsDistinct` together', () => {
    const r = one('@@unique([employeeId], where: effectiveTo == null, nullsDistinct: true)')
    expect(r.valid).toBe(false)
  })

  it('refuses now() by name, because SQLite ACCEPTS a clock there', () => {
    const r = one('@@unique([employeeId], where: effectiveTo > now())')
    expect(r.errors.join(' ')).toContain('now()')
    expect(r.errors.join(' ')).toContain('never moved')
  })

  it('refuses auth(), a column of another model, and a subquery', () => {
    expect(one('@@unique([employeeId], where: rate == auth().rate)').errors.length).toBe(1)
    expect(one('@@unique([employeeId], where: nope == null)').errors.join(' ')).toContain('not a column')
  })

  it('collides with an @@index over the same columns, and says which two', () => {
    const r = one('@@index([employeeId])\n    @@unique([employeeId], where: effectiveTo == null)')
    expect(r.errors.join(' ')).toContain('idx_<table>_employeeId')
    expect(r.errors.join(' ')).toContain('@@index([employeeId]) and @@unique([employeeId])')
  })

  it('the nullable-member refusal now offers the predicate as the third answer', () => {
    const r = parse(`model W {
      id Int @id
      planId Int
      effectiveTo DateTime?
      @@unique([planId, effectiveTo])
    }`)
    const msg = r.errors.join(' ')
    expect(msg).toContain('nullsDistinct: true')
    // …and the column list is CHANGED in the suggestion, which is the whole of
    // what separates the two answers: the nullable column moves into the
    // predicate rather than staying in the tuple.
    expect(msg).toContain('@@unique([planId], where: effectiveTo == null)')
  })
})

describe('@@unique(where:) — against a real database', () => {
  const SRC = (extra = '') => `model PayWindow {
    id Int @id @default(autoincrement())
    employeeId Int
    rate Int
    effectiveTo DateTime?
    ${extra}
    @@unique([employeeId], where: effectiveTo == null)
  }`

  it('accepts every row OUTSIDE the predicate and refuses the second one inside it', async () => {
    const db: any = await createClient({ schema: SRC(), db: ':memory:' })
    const mk = (e: number, to: string | null) => db.payWindow.create({ data: { employeeId: e, rate: 1, effectiveTo: to } })

    // Three CLOSED windows for one employee — the rows a plain @@unique would
    // have refused, and the reason a predicate is what this shape needs.
    await mk(1, '2020-01-01T00:00:00.000Z')
    await mk(1, '2021-01-01T00:00:00.000Z')
    await mk(1, '2022-01-01T00:00:00.000Z')
    expect(await db.payWindow.count({ where: { employeeId: 1 } })).toBe(3)

    await mk(1, null)                                   // one open window: fine
    await expect(mk(1, null)).rejects.toThrow(/already taken/i)   // a second: not
    await mk(2, null)                                   // another employee: fine
    expect(await db.payWindow.count({ where: { effectiveTo: null } })).toBe(2)
    db.$close()
  })

  // The line this feature turns on. Asserted against the emitted TEXT, because
  // nothing else can see it: the constraint behaves identically either way
  // until a row is soft-deleted, and then it behaves like FJS-204 reversed.
  it('does NOT get @@softDelete\'s clause ANDed in, where @@index does', () => {
    const ddl = generateDDL(parse(SRC('deletedAt DateTime?\n    @@softDelete')).schema)
    const line = ddl.split('\n').find(l => l.includes('CREATE UNIQUE INDEX')) ?? ''
    expect(line).toContain('WHERE "effectiveTo" IS NULL')
    expect(line).not.toContain('deletedAt')

    // The control, one attribute along: an @@index on the same model DOES.
    const both = generateDDL(parse(`model N {
      id Int @id
      kind String
      deletedAt DateTime?
      @@index([kind], where: kind != null)
      @@softDelete
    }`).schema)
    expect(both.split('\n').find(l => l.includes('CREATE INDEX'))).toContain('deletedAt')
  })
})

describe('@@unique(where:) — the migrator', () => {
  const SRC = (pred: string) => `model PayWindow {
    id Int @id @default(autoincrement())
    employeeId Int
    rate Int
    effectiveTo DateTime?
    @@unique([employeeId], where: ${pred})
  }`

  const liveFrom = (pred: string) => {
    const db = new Database(':memory:')
    apply(db, generateDDL(parse(SRC(pred)).schema))
    return { db, live: introspect(db) }
  }
  const planAgainst = (live: any, pred: string) => {
    const pr = parse(SRC(pred))
    return diffSchemas(buildPristine(new Database(':memory:'), pr), live, pr)
  }

  it('an unchanged predicate migrates nothing', () => {
    const { live } = liveFrom('effectiveTo == null')
    expect(planAgainst(live, 'effectiveTo == null').tableDiffs).toEqual([])
  })

  // The cost is the reason the node kinds are split: a table constraint can
  // only change by rebuilding the table, and this changes by swapping an index.
  it('an edited predicate is one DROP and one CREATE, never a rebuild', () => {
    const { live } = liveFrom('effectiveTo == null')
    const d: any = planAgainst(live, 'effectiveTo != null')
    expect(d.tableDiffs.length).toBe(1)
    expect(d.tableDiffs[0].needsRebuild).toBe(false)
    expect(d.tableDiffs[0].indexes.added.length).toBe(1)
    expect(d.tableDiffs[0].indexes.dropped.length).toBe(1)
    expect(d.tableDiffs[0].indexes.added[0].unique).toBe(true)
    expect(d.tableDiffs[0].indexes.added[0].where).toContain('IS NOT NULL')
  })

  it('is read back as an index and never as a table constraint', () => {
    const { db } = liveFrom('effectiveTo == null')
    const rows = db.prepare(`PRAGMA index_list("pay_window")`).all() as any[]
    const ours = rows.find(r => r.name === 'idx_pay_window_employeeId')
    // origin 'c' — an explicit CREATE INDEX, which is what puts it in the index
    // diff rather than in `tableUniques`, with no edit to either.
    expect(ours).toMatchObject({ unique: 1, origin: 'c', partial: 1 })
  })
})

import { deriveReleaseSurface, classifyPivot } from '../src/release.js'

describe('@@unique(where:) — the deploy gate (release.js)', () => {
  const SRC = (attr: string) => `model W {
    id Int @id
    employeeId Int
    effectiveTo DateTime?
    ${attr}
  }`
  const grade = (before: string, after: string) => {
    const b = deriveReleaseSurface(parse(SRC(before)).schema)
    const a = deriveReleaseSurface(parse(SRC(after)).schema)
    return classifyPivot(b, a)
  }

  // The correctness hole this had to close: keyed on the column list alone, a
  // narrowed or widened predicate graded as no change at all.
  it('gaining a predicate is an EXPAND — the constraint now covers fewer rows', () => {
    const r = grade('@@unique([employeeId])', '@@unique([employeeId], where: effectiveTo == null)')
    expect(r.verdict).toBe('expand')
    expect(JSON.stringify(r.findings)).toContain('gained a predicate')
  })

  it('losing one is a CONTRACT — N-1 writes rows the new constraint refuses', () => {
    const r = grade('@@unique([employeeId], where: effectiveTo == null)', '@@unique([employeeId])')
    expect(r.verdict).toBe('contract')
  })

  // Deliberately not decided: whether one predicate implies the other is
  // implication between two SQL expressions, and answering it with a text
  // comparison would be a deploy verdict made by a regex.
  it('a predicate moving between two non-empty ones is UNKNOWN, not a guess', () => {
    const r = grade('@@unique([employeeId], where: effectiveTo == null)',
                    '@@unique([employeeId], where: effectiveTo != null)')
    expect(r.verdict).toBe('unknown')           // its own word, and it ranks with contract
    expect(JSON.stringify(r.findings)).toContain('implication between two SQL expressions')
  })

  it('adding one where there was none is still a contract, like any new @@unique', () => {
    expect(grade('', '@@unique([employeeId], where: effectiveTo == null)').verdict).toBe('contract')
  })
})

describe('@@unique(where:) — what it deliberately does NOT satisfy', () => {
  // A one-to-one needs the far side to hold at most one row PER PARENT, always.
  // A constraint that holds over only some rows does not say that, and the node
  // kind is what makes the check correct without being taught anything.
  it('does not make a relation one-to-one', () => {
    const r = parse(`
      model A { id Int @id  b B? }
      model B { id Int @id  aId Int  a A @relation(fields: [aId], references: [id])  live Boolean
        @@unique([aId], where: live == true) }
    `)
    expect(r.errors.join(' ')).toContain('is not unique')
  })
})
