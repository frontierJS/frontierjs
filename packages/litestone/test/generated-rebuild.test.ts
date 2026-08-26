// A GENERATED column through a rebuild, and through a diff.
//
// Two defects, one root: nothing in the migration path knew that a generated
// column is different from a stored one.
//
// `FJS-406` — a rebuild listed it in the copy. SQLite refuses
// (`cannot INSERT into generated column`), so the whole migration failed and
// rolled back. It is not only about ADDING one: a table that has carried a
// generated column for a year hits it the moment anything else about that
// table forces a rebuild, which is the commoner case by far.
//
// `FJS-407` — `introspect()` read `PRAGMA table_info`, which OMITS generated
// columns, so both sides of the diff were blind to them and a schema change
// touching one emitted nothing at all. `table_xinfo` lists them, and the
// expression comes off the table's own CREATE statement, which is the only
// place SQLite keeps it.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import {
  introspect, buildPristine, diffSchemas, generateMigrationSQL, splitStatements,
} from '../src/core/migrate.js'

const MODEL = `model Customer {
  id        Int     @id
  firstName String
  lastName  String
  fullName  String? @generated(\`{firstName} {lastName}\`, stored)
}`

/** No statement between the BEGIN and the COMMIT — the whole of "no changes". */
const inSync = (sql: string) =>
  sql.split('\n').every(l => !l.trim() || l.startsWith('--') || /^(PRAGMA|BEGIN|COMMIT)/.test(l))

/** Apply a generated migration the way the runner does — abort on first error. */
function migrate(live: Database, source: string) {
  const parsed   = parse(source)
  const pristine = buildPristine(new Database(':memory:'), parsed)
  const diff     = diffSchemas(pristine, introspect(live), parsed)
  const sql      = generateMigrationSQL(diff, parsed)

  for (const st of splitStatements(sql)) live.run(st)
  return sql
}

describe('a generated column through a rebuild', () => {
  it('is not copied — a rebuild for an unrelated reason still applies', () => {
    // `nickname` is dropped, which is what forces the rebuild. The generated
    // column is incidental, and it is what used to fail the whole thing.
    const live = new Database(':memory:')
    live.run(`CREATE TABLE "customer" (
      "id" INTEGER NOT NULL PRIMARY KEY, "firstName" TEXT NOT NULL, "lastName" TEXT NOT NULL,
      "nickname" TEXT,
      "fullName" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "lastName")) STORED
    ) STRICT`)
    live.run(`INSERT INTO "customer" ("id","firstName","lastName","nickname") VALUES (1,'Ada','Lovelace','Ada')`)

    const sql = migrate(live, MODEL)

    // The column must be absent from BOTH sides of the copy, not just the SELECT.
    expect(sql).toContain('INSERT INTO "customer__new" ("id", "firstName", "lastName")')
    expect(sql).not.toContain('"fullName" FROM')

    const row = live.query('SELECT * FROM customer').get() as Record<string, unknown>
    expect(row.firstName).toBe('Ada')
    // Recomputed by the new table from the columns that were copied — which is
    // why dropping it from the copy loses nothing.
    expect(row.fullName).toBe('Ada Lovelace')
  })

  it('carries its GENERATED clause into the rebuilt table', () => {
    const live = new Database(':memory:')
    live.run(`CREATE TABLE "customer" (
      "id" INTEGER NOT NULL PRIMARY KEY, "firstName" TEXT NOT NULL, "lastName" TEXT NOT NULL,
      "nickname" TEXT,
      "fullName" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "lastName")) STORED
    ) STRICT`)

    expect(migrate(live, MODEL)).toContain('GENERATED ALWAYS AS')

    // Still generated after the rebuild: a plain column would accept a write.
    expect(() => live.run(`INSERT INTO "customer" ("id","firstName","lastName","fullName") VALUES (2,'G','H','x')`))
      .toThrow(/generated column/)
  })
})

describe('FJS-407 — the diff can see a generated column', () => {
  const live407 = (extra = '') => {
    const live = new Database(':memory:')
    live.run(`CREATE TABLE "customer" (
      "id" INTEGER NOT NULL PRIMARY KEY, "firstName" TEXT NOT NULL, "lastName" TEXT NOT NULL${extra}
    ) STRICT`)
    live.run(`INSERT INTO "customer" ("id","firstName","lastName") VALUES (1,'Ada','Lovelace')`)
    return live
  }

  it('adds a STORED one by rebuild — ADD COLUMN cannot', () => {
    const live = live407()
    const sql  = migrate(live, MODEL)

    // SQLite: `cannot add a STORED column`. The rebuild is the only path.
    expect(sql).not.toContain('ADD COLUMN')
    expect(sql).toContain('CREATE TABLE "customer__new"')

    const row = live.query('SELECT * FROM customer').get() as Record<string, unknown>
    expect(row.fullName).toBe('Ada Lovelace')
    expect(() => live.run(`INSERT INTO "customer" ("id","firstName","lastName","fullName") VALUES (2,'G','H','x')`))
      .toThrow(/generated column/)
  })

  it('adds a VIRTUAL one with ALTER, carrying its expression', () => {
    const live = live407()
    const sql  = migrate(live, MODEL.replace(', stored', ''))

    // A plain `ADD COLUMN "fullName" TEXT` is the shape that made this worth
    // testing: it applies cleanly and leaves a writable column of the same name.
    expect(sql).not.toContain('customer__new')
    expect(sql).toContain('ADD COLUMN "fullName" TEXT GENERATED ALWAYS AS')

    const row = live.query('SELECT * FROM customer').get() as Record<string, unknown>
    expect(row.fullName).toBe('Ada Lovelace')
    expect(() => live.run(`UPDATE "customer" SET "fullName" = 'x'`)).toThrow(/generated column/)
  })

  it('rebuilds when the expression changes', () => {
    const live = live407(`,\n      "fullName" TEXT GENERATED ALWAYS AS ("firstName") STORED`)
    const sql  = migrate(live, MODEL)

    expect(sql).toContain('CREATE TABLE "customer__new"')
    expect(live.query('SELECT * FROM customer').get()).toMatchObject({ fullName: 'Ada Lovelace' })
  })

  it('is in sync when nothing changed — no churn from reading the expression', () => {
    // The one that keeps this honest: a fix that always saw a difference would
    // rebuild the table on every migration and pass every other case here.
    const live = live407(`,\n      "fullName" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "lastName")) STORED`)
    expect(inSync(migrate(live, MODEL))).toBe(true)
  })

  it('sees storage change, both directions', () => {
    const virt  = MODEL.replace(', stored', '')
    const clause = (mode: string) =>
      `,\n      "fullName" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "lastName")) ${mode}`

    // No ALTER reaches storage in either direction, so each is a rebuild.
    expect(migrate(live407(clause('VIRTUAL')), MODEL)).toContain('customer__new')
    expect(migrate(live407(clause('STORED')),  virt)).toContain('customer__new')
    // …and neither direction fires when it already matches.
    expect(inSync(migrate(live407(clause('VIRTUAL')), virt))).toBe(true)
  })

  it('sees one dropped from the schema', () => {
    const live = live407(`,\n      "fullName" TEXT GENERATED ALWAYS AS ("firstName") STORED`)
    const sql  = migrate(live, MODEL.split('\n').filter(l => !l.includes('fullName')).join('\n'))

    expect(sql).toContain('customer__new')
    expect(live.prepare(`PRAGMA table_xinfo("customer")`).all().map((c: any) => c.name))
      .not.toContain('fullName')
  })

  it('reads the expression past a comma and a quote', () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE t (
      a TEXT, b TEXT,
      v TEXT GENERATED ALWAYS AS (concat_ws(', ', a, b)) VIRTUAL,
      s TEXT AS (upper(a)) STORED,
      UNIQUE (a, b)
    )`)
    const cols = introspect(db).t.columns as Array<{ name: string, generated: any }>
    const gen  = Object.fromEntries(cols.filter(c => c.generated).map(c => [c.name, c.generated]))

    expect(gen.v).toEqual({ mode: 'virtual', expr: "concat_ws(', ', a, b)" })
    // `GENERATED ALWAYS` is optional in SQLite; the column is the same column.
    expect(gen.s).toEqual({ mode: 'stored', expr: 'upper(a)' })
    expect(cols.filter(c => c.generated).length).toBe(2)
  })

  it('is a table_info blind spot, not a litestone one', () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE t (a TEXT, v TEXT GENERATED ALWAYS AS (a) VIRTUAL, s TEXT GENERATED ALWAYS AS (a) STORED)`)

    const info  = (db.prepare(`PRAGMA table_info("t")`).all()  as Array<{ name: string }>).map(c => c.name)
    const xinfo = (db.prepare(`PRAGMA table_xinfo("t")`).all() as Array<{ name: string, hidden: number }>)

    expect(info).toEqual(['a'])
    expect(xinfo.map(c => c.name)).toEqual(['a', 'v', 's'])
    // hidden: 2 = VIRTUAL generated, 3 = STORED generated. Both are read.
    expect(xinfo.filter(c => c.hidden >= 2).map(c => c.name)).toEqual(['v', 's'])
  })
})
