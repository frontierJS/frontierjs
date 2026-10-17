// `@collate` — a String column states the order it sorts and compares in (`FJS-D885`, `FJS-2500`).
//
// SQLite's default is BINARY, so `BNI` sorts before `Bing`, and a picker ordered
// by its label puts every capitalised word before every lowercase one. The word
// is written into the DDL, so ORDER BY, `=` and an index on the column agree.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { introspectToLite } from '../src/tools/introspect.js'
import {
  introspect, buildPristine, diffSchemas, generateMigrationSQL, splitStatements,
} from '../src/core/migrate.js'

const SCHEMA = `
model Source {
  id    Int    @id
  label String @collate(nocase)
  code  String
}`

const seed = async (db: any) => {
  for (const label of ['Bing', 'BNI', 'apple']) await db.source.create({ data: { label, code: label } })
}

describe('@collate(nocase)', () => {
  it('orders a String column as a person reads it', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    await seed(db)
    const rows = await db.source.findMany({ orderBy: [{ label: 'asc' }] })
    expect(rows.map((r: any) => r.label)).toEqual(['apple', 'Bing', 'BNI'])
  })

  it('leaves a column that does not state it in binary order', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    await seed(db)
    const rows = await db.source.findMany({ orderBy: [{ code: 'asc' }] })
    expect(rows.map((r: any) => r.code)).toEqual(['BNI', 'Bing', 'apple'])
  })

  it('is written into the column, so an index on it serves the same order', () => {
    const ddl = generateDDL(parse(SCHEMA.replace('code  String', 'code  String\n  @@index([label])')).schema)
    expect(ddl).toContain('"label" TEXT COLLATE NOCASE NOT NULL')
    expect(ddl).not.toContain('"code" TEXT COLLATE')
  })

  it('takes the three SQLite ships, and refuses a fourth by name', () => {
    for (const name of ['binary', 'nocase', 'rtrim'])
      expect(parse(`model A { id Int @id\n  t String @collate(${name}) }`).errors).toEqual([])
    const refused = parse('model A { id Int @id\n  t String @collate(unicode) }')
    expect(refused.errors.join('\n')).toMatch(/binary, nocase, rtrim/)
  })

  it('is refused off a String column', () => {
    const parsed = parse('model A { id Int @id\n  n Int @collate(nocase) }')
    expect(parsed.errors.join('\n')).toMatch(/requires a stored String column/)
  })

  it('is a migration: adding it to a populated column rebuilds the table', () => {
    const live = new Database(':memory:')
    live.run(`CREATE TABLE "source" ("id" INTEGER NOT NULL PRIMARY KEY, "label" TEXT NOT NULL, "code" TEXT NOT NULL) STRICT`)
    live.run(`INSERT INTO "source" VALUES (1,'Bing','a'),(2,'BNI','b'),(3,'apple','c')`)

    const parsed   = parse(SCHEMA)
    const pristine = buildPristine(new Database(':memory:'), parsed)
    const diff     = diffSchemas(pristine, introspect(live), parsed)
    const sql      = generateMigrationSQL(diff, parsed)
    for (const st of splitStatements(sql)) live.run(st)

    const labels = live.query(`SELECT "label" FROM "source" ORDER BY "label"`).all().map((r: any) => r.label)
    expect(labels).toEqual(['apple', 'Bing', 'BNI'])

    // …and a second pass finds nothing left to do.
    const again = diffSchemas(buildPristine(new Database(':memory:'), parsed), introspect(live), parsed)
    expect(again.tables?.modified ?? again.modified ?? []).toEqual([])
  })

  it('is read back from an adopted database, and one on a column that is not a String is left off', () => {
    const live = new Database(':memory:')
    live.run(`CREATE TABLE "source" ("id" INTEGER NOT NULL PRIMARY KEY, "label" TEXT COLLATE NOCASE NOT NULL, "code" TEXT COLLATE RTRIM NOT NULL, "n" INTEGER COLLATE NOCASE NOT NULL) STRICT`)
    const out = introspectToLite(live) as any
    const lite = typeof out === 'string' ? out : out.lite ?? out.text
    expect(lite).toMatch(/label\s+String\s+@collate\(nocase\)/)
    expect(lite).toMatch(/code\s+String\s+@collate\(rtrim\)/)
    expect(lite).toMatch(/\n  n\s+Int\n/)
    expect(out.gaps.map((g: any) => `${g.kind}:${g.field}`)).toContain('collation:n')
    expect(parse(lite).errors).toEqual([])
  })
})
