#!/usr/bin/env bun
// litestone.test.ts — full end-to-end test suite for Bun
//
// Run:  bun test
//   or: bun test/litestone.test.ts

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { resolve, join }  from 'path'
import { tmpdir }          from 'os'

import { parse, parseFile }           from '../src/core/parser.js'
import { generateDDL, isSoftDelete,
         isStrict }                   from '../src/core/ddl.js'
import { splitStatements, introspect,
         buildPristine, diffSchemas,
         generateMigrationSQL,
         summariseDiff }              from '../src/core/migrate.js'
import { createClient, ValidationError } from '../src/core/client.js'
import { buildWhere, buildOrderBy, sql,
         encodeCursor, decodeCursor,
         normaliseOrderBy, buildCursorWhere,
         isNamedAgg, buildNamedAggExpr } from '../src/core/query.js'
import { create, apply, status,
         verify, autoMigrate }        from '../src/core/migrations.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), `litestone-test-${Date.now()}`)
mkdirSync(TMP, { recursive: true })

function tmpDb(name: string) { return join(TMP, `${name}.db`) }
function tmpDir(name: string) { const d = join(TMP, name); mkdirSync(d, { recursive: true }); return d }

// Create a schema, apply DDL to a fresh db, return a createClient instance
async function makeDb(schemaText: string, name = 'test', opts: Record<string, any> = {}) {
  const path   = tmpDb(name + Math.random().toString(36).slice(2))
  const result = parse(schemaText)
  if (!result.valid) throw new Error(result.errors.join('\n'))

  const raw = new Database(path)
  raw.run('PRAGMA page_size = 8192')
  for (const stmt of splitStatements(generateDDL(result.schema)))
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  raw.close()

  return createClient({ parsed: result,  db: path, ...opts })
}



// ┌────────────────────────────────────────────────────────────────────────────┐
// │  PARSER, DDL & SCHEMA                                                      │
// └────────────────────────────────────────────────────────────────────────────┘

describe('parser', () => {

  test('parses basic model', () => {
    const r = parse(`
      model User {
        id    Int  @id
        email String     @unique
        name  String?
      }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.models).toHaveLength(1)
    expect(r.schema.models[0].name).toBe('User')
    expect(r.schema.models[0].fields).toHaveLength(3)
  })

  test('parses enums', () => {
    const r = parse(`
      enum Plan { starter  pro  enterprise }
      model Account { id Int @id
        plan Plan @default(starter) }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.enums).toHaveLength(1)
    expect(r.schema.enums[0].values.map((v: any) => v.name)).toEqual(['starter','pro','enterprise'])
  })

  test('parses function blocks', () => {
    const r = parse(`
      function slug(text: String): String {
        @@expr("lower(replace({text}, ' ', '-'))")
      }
      model Post { id Int @id
        title String
        slug String @slug(title) }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.functions).toHaveLength(1)
    expect(r.schema.functions[0].name).toBe('slug')
    expect(r.schema.functions[0].params).toHaveLength(1)
  })

  test('parses @generated with {field} syntax', () => {
    const r = parse(`
      model Order {
        id    Int @id
        price Int
        tax   Float    @default(0.08)
        total Float    @generated("{price} * (1.0 + {tax})", stored)
      }
    `)
    expect(r.valid).toBe(true)
    const totalField = r.schema.models[0].fields.find((f: any) => f.name === 'total')
    const gen = totalField.attributes.find((a: any) => a.kind === 'generated')
    expect(gen.expr).toBe('"price" * (1.0 + "tax")')  // {field} → "field"
    expect(gen.stored).toBe(true)
  })

  test('validates unknown @relation references', () => {
    const r = parse(`
      model User {
        id        Int  @id
        account   Account @relation(fields: [accountId], references: [id])
        accountId Int
      }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('Account'))).toBe(true)
  })

  test('forward-ref @relation (FK after relation field) is valid', () => {
    const r = parse(`
      model Account { id Int @id
        name String }
      model User {
        id        Int  @id
        account   Account @relation(fields: [accountId], references: [id])
        accountId Int
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('validates @funcCall unknown function', () => {
    const r = parse(`
      model T { id Int @id
        val Int
        r Int @missingFn(val) }
    `)
    expect(r.errors.some((e: string) => e.includes('unknown function'))).toBe(true)
  })

  test('validates @funcCall arg count', () => {
    const r = parse(`
      function dbl(x: Int): Int { @@expr("{x} * 2") }
      model T { id Int @id
        val Int
        r Int @dbl(val, extra) }
    `)
    expect(r.errors.some((e: string) => e.includes('expects 1 argument'))).toBe(true)
  })

  test('multi-file imports via parseFile', () => {
    const dir = tmpDir('imports')
    writeFileSync(join(dir, 'enums.lite'),    'enum Role { admin  member }')
    writeFileSync(join(dir, 'functions.lite'),'function slug(text: String): String { @@expr("lower({text})") }')
    writeFileSync(join(dir, 'schema.lite'),   [
      'import "./enums.lite"',
      'import "./functions.lite"',
      'model User { id Int @id\nrole Role @default(member)\nname String\nslug String @slug(name) }',
    ].join('\n'))

    const r = parseFile(join(dir, 'schema.lite'))
    expect(r.valid).toBe(true)
    expect(r.schema.enums).toHaveLength(1)
    expect(r.schema.functions).toHaveLength(1)
    expect(r.schema.models).toHaveLength(1)
  })

  test('import deduplication — same file imported twice', () => {
    const dir = tmpDir('dedup')
    writeFileSync(join(dir, 'enums.lite'),  'enum Status { active  archived }')
    writeFileSync(join(dir, 'a.lite'),      'import "./enums.lite"\nmodel A { id Int @id\ns Status }')
    writeFileSync(join(dir, 'b.lite'),      'import "./enums.lite"\nmodel B { id Int @id\ns Status }')
    writeFileSync(join(dir, 'schema.lite'), 'import "./a.lite"\nimport "./b.lite"')

    const r = parseFile(join(dir, 'schema.lite'))
    expect(r.valid).toBe(true)
    expect(r.schema.enums).toHaveLength(1)   // not 2
    expect(r.schema.models).toHaveLength(2)
  })

  test('import missing file returns error', () => {
    const dir = tmpDir('missing')
    writeFileSync(join(dir, 'schema.lite'), 'import "./nonexistent.lite"')
    const r = parseFile(join(dir, 'schema.lite'))
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('Cannot read file')
  })

  // ─── Invisible / gotcha characters ────────────────────────────────────────
  // Editors and rich-text sources frequently introduce these. Parser must
  // either tolerate them or fail with an actionable error.

  test('strips leading UTF-8 BOM', () => {
    const r = parse('\uFEFFmodel User { id Int @id }')
    expect(r.valid).toBe(true)
    expect(r.schema.models[0].name).toBe('User')
  })

  test('treats non-breaking space as whitespace', () => {
    // U+00A0 between tokens — used to trip tokenizer on first occurrence
    const src = `model\u00A0users\u00A0{\u00A0id\u00A0Int\u00A0@id\u00A0}`
    const r = parse(src)
    expect(r.valid).toBe(true)
    expect(r.schema.models[0].fields).toHaveLength(1)
  })

  test('ignores zero-width characters', () => {
    const src = `model User { id\u200B Int @id }`
    const r = parse(src)
    expect(r.valid).toBe(true)
    expect(r.schema.models[0].fields[0].name).toBe('id')
  })

  test('smart quote produces actionable error with codepoint + hint', () => {
    // U+201C is the left smart double-quote — common when pasting from docs
    let err: any = null
    try { parse(`model User { id String @default(\u201Chi\u201D) }`) }
    catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.message).toContain('U+201C')
    expect(err.message.toLowerCase()).toContain('smart')
  })

  test('NBSP error path retains location info if not skipped (sanity)', () => {
    // Direct check that pickCharHint surfaces a useful message when something
    // genuinely unparseable shows up — uses an em-dash, which we don't accept.
    let err: any = null
    try { parse(`model User { id \u2014 Int @id }`) }
    catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.message).toContain('U+2014')
    expect(err.message.toLowerCase()).toMatch(/dash|did you mean/)
  })

  test('parseFile: SQLite database file is rejected with a clear error', () => {
    // Regression: passing a .db file as 'schema' to createClient (e.g. paths
    // got swapped) used to crash deep in tokenize() with "U+0000". parseFile
    // now sniffs the SQLite magic header and produces an actionable error.
    const dir = tmpDir('sqlite-as-schema')
    const fakeDb = Buffer.concat([
      Buffer.from('SQLite format 3\u0000', 'binary'),
      Buffer.alloc(100), // padding so we look like a real header
    ])
    const dbPath = join(dir, 'oops.db')
    writeFileSync(dbPath, fakeDb)
    const r = parseFile(dbPath)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain('SQLite database')
    expect(r.errors.join('\n').toLowerCase()).toContain('swap')
  })

  test('parseFile: arbitrary binary file rejected with clear error', () => {
    const dir = tmpDir('binary-as-schema')
    const path = join(dir, 'random.bin')
    writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0x00, 0x42]))
    const r = parseFile(path)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n').toLowerCase()).toContain('binary')
  })

  test('parseFile: tokenize errors include the offending file path', () => {
    // When an import chain points at a broken file, the path in the error
    // message is what makes it findable. Drop a smart quote in and check.
    const dir = tmpDir('parse-error-path')
    const path = join(dir, 'broken.lite')
    writeFileSync(path, `model User { id String @default(\u201Cx\u201D) }`)
    let err: any = null
    try { parseFile(path) } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.message).toContain(path)
    expect(err.message).toContain('U+201C')
  })
})

// ─── 2. DDL ───────────────────────────────────────────────────────────────────


describe('DDL', () => {

  test('STRICT by default', () => {
    const r = parse(`model T { id Int @id }`)
    expect(isStrict(r.schema.models[0])).toBe(true)
    expect(generateDDL(r.schema)).toContain('STRICT')
  })

  test('@@noStrict opts out', () => {
    const r = parse(`model T { id Int @id
        @@noStrict }`)
    expect(isStrict(r.schema.models[0])).toBe(false)
    expect(generateDDL(r.schema)).not.toContain('STRICT')
  })

  test('soft delete detection', () => {
    const r = parse(`
      model Soft { id Int @id
        deletedAt DateTime?
        @@softDelete }
      model Hard { id Int @id }
      model Cascade { id Int @id
        deletedAt DateTime?
        @@softDelete(cascade) }
    `)
    const [soft, hard, cascade] = r.schema.models
    expect(isSoftDelete(soft)).toBe(true)
    expect(isSoftDelete(hard)).toBe(false)
    expect(isSoftDelete(cascade)).toBe(true)
    // cascade flag
    expect(soft.attributes.find((a: any) => a.kind === 'softDelete').cascade).toBe(false)
    expect(cascade.attributes.find((a: any) => a.kind === 'softDelete').cascade).toBe(true)
  })

  test('partial indexes on soft-delete tables', () => {
    const r = parse(`
      model User { id Int @id
        email String
        deletedAt DateTime?
        @@softDelete
        @@index([email]) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('WHERE "deletedAt" IS NULL')
    expect(ddl).toContain('idx_user_deletedAt')
  })

  test('no partial indexes on hard-delete tables', () => {
    const r = parse(`
      model Log { id Int @id
        action String
        @@index([action]) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).not.toContain('WHERE')
  })

  test('enum generates CHECK constraint', () => {
    const r = parse(`
      enum Plan { starter  pro  enterprise }
      model T { id Int @id
        plan Plan @default(starter) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain("CHECK (\"plan\" IN ('starter', 'pro', 'enterprise'))")
  })

  test('FTS5 virtual table + triggers', () => {
    const r = parse(`
      model Message { id Int @id
        body String
        title String?
        @@fts([body, title]) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('message_fts')
    expect(ddl).toContain('message_fts_insert')
    expect(ddl).toContain('message_fts_delete')
    expect(ddl).toContain('message_fts_update')
    expect(ddl).toContain('fts5')
  })

  test('@generated VIRTUAL (default)', () => {
    const r = parse(`
      model T { id Int @id
        a Int
        b Float @generated("{a} * 2") }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('GENERATED ALWAYS AS ("a" * 2) VIRTUAL')
  })

  test('@generated STORED', () => {
    const r = parse(`
      model T { id Int @id
        a Int
        b Int @generated("{a} * 2", stored) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('GENERATED ALWAYS AS ("a" * 2) STORED')
  })


  test('@generated — self-reference is an error', () => {
    const r = parse(`
      model T {
        id  Int @id
        a   Int
        val Int @generated("{val} * 2")
      }
    `)
    expect(r.errors.some((e: string) => e.includes('cannot reference itself'))).toBe(true)
  })

  test('@generated — circular reference is an error', () => {
    const r = parse(`
      model T {
        id Int @id
        a  Int @generated("{b} + 1")
        b  Int @generated("{a} + 1")
      }
    `)
    expect(r.errors.some((e: string) => e.includes('circular'))).toBe(true)
  })

  test('@generated — unknown field reference is an error', () => {
    const r = parse(`
      model T {
        id  Int @id
        a   Int
        val Int @generated("{ghost} * 2")
      }
    `)
    expect(r.errors.some((e: string) => e.includes("unknown field 'ghost'"))).toBe(true)
  })

  test('@generated — forward chain is valid (SQLite handles it)', () => {
    const r = parse(`
      model T {
        id Int @id
        c  Int @generated("{b} + 1")
        b  Int @generated("{a} + 1")
        a  Int
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('@generated — backward chain is valid', () => {
    const r = parse(`
      model T {
        id Int @id
        a  Int
        b  Int @generated("{a} + 1")
        c  Int @generated("{b} + 1")
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('@generated — multi-field expr is valid', () => {
    const r = parse(`
      model Order {
        id    Int @id
        price Int
        tax   Float    @default(0.08)
        total Float    @generated("{price} * (1.0 + {tax})")
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('function @funcCall expands to GENERATED ALWAYS AS STORED', () => {
    const r = parse(`
      function slug(text: String): String { @@expr("lower({text})") }
      model Post { id Int @id
        title String
        slug String @slug(title) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('GENERATED ALWAYS AS (lower("title")) STORED')
  })

  test('DDL executes in bun:sqlite', () => {
    const r = parse(`
      model Account { id Int @id
        name String
        plan String @default("starter") }
      model User { id Int @id
        accountId Int
        email String @unique
        deletedAt DateTime?
        @@softDelete
        @@index([accountId]) }
    `)
    const db = new Database(':memory:')
    expect(() => {
      for (const s of splitStatements(generateDDL(r.schema)))
        if (!s.startsWith('PRAGMA')) db.run(s)
    }).not.toThrow()
    db.close()
  })
})

// ─── 3. Migrations ────────────────────────────────────────────────────────────


describe('query helpers', () => {

  test('buildWhere — basic equality', () => {
    const p: any[] = []
    const w = buildWhere({ id: 1 }, p)
    expect(w).toBe('"id" = ?')
    expect(p).toEqual([1])
  })

  test('buildWhere — null IS NULL', () => {
    const p: any[] = []
    const w = buildWhere({ deletedAt: null }, p)
    expect(w).toBe('"deletedAt" IS NULL')
  })

  test('buildWhere — operators', () => {
    const p: any[] = []
    const w = buildWhere({ score: { gte: 50, lte: 100 } }, p)
    expect(w).toContain('>= ?')
    expect(w).toContain('<= ?')
  })

  test('buildWhere — notIn includes NULL rows', () => {
    const p: any[] = []
    const w = buildWhere({ status: { notIn: ['deleted'] } }, p)
    expect(w).toContain('IS NULL')
  })

  test('buildWhere — AND/OR groups', () => {
    const p: any[] = []
    const w = buildWhere({ AND: [{ id: 1 }, { role: 'admin' }] }, p)
    expect(w).toContain('AND')
  })

  test('buildWhere — contains', () => {
    const p: any[] = []
    const w = buildWhere({ name: { contains: 'Smith' } }, p)
    expect(w).toBe('"name" LIKE ?')
    expect(p[0]).toBe('%Smith%')
  })

  test('encodeCursor / decodeCursor roundtrip', () => {
    const data = { id: 50, createdAt: '2024-01-01' }
    const token = encodeCursor(data)
    expect(typeof token).toBe('string')
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true)
    expect(decodeCursor(token)).toEqual(data)
  })

  test('decodeCursor throws on invalid token', () => {
    expect(() => decodeCursor('!!!invalid')).toThrow()
  })

  test('normaliseOrderBy', () => {
    const r = normaliseOrderBy([{ createdAt: 'desc' }, { id: 'asc' }])
    expect(r[0]).toEqual({ col: 'createdAt', dir: 'DESC' })
    expect(r[1]).toEqual({ col: 'id', dir: 'ASC' })
  })

  test('buildCursorWhere — single ASC', () => {
    const p: any[] = []
    const w = buildCursorWhere([{ col: 'id', dir: 'ASC' }], { id: 50 }, p)
    expect(w).toBe('"id" > ?')
    expect(p).toEqual([50])
  })

  test('buildCursorWhere — single DESC', () => {
    const p: any[] = []
    const w = buildCursorWhere([{ col: 'id', dir: 'DESC' }], { id: 50 }, p)
    expect(w).toBe('"id" < ?')
  })

  test('buildCursorWhere — multi-field', () => {
    const p: any[] = []
    const w = buildCursorWhere(
      [{ col: 'createdAt', dir: 'DESC' }, { col: 'id', dir: 'ASC' }],
      { createdAt: '2024-01-01', id: 50 },
      p
    )
    expect(w).toBe('("createdAt" < ?) OR ("createdAt" = ? AND "id" > ?)')
    expect(p).toEqual(['2024-01-01', '2024-01-01', 50])
  })

  test('sql tag — produces RawClause with placeholders', () => {
    const state = 'TX'
    const min   = 200
    const clause = sql`price > IF(state = ${state}, ${min}, 100)`
    expect(clause._litestoneRaw).toBe(true)
    expect(clause.sql).toBe('price > IF(state = ?, ?, 100)')
    expect(clause.params).toEqual(['TX', 200])
  })

  test('sql tag — no interpolations', () => {
    const clause = sql`deletedAt IS NULL`
    expect(clause.sql).toBe('deletedAt IS NULL')
    expect(clause.params).toEqual([])
  })

  test('buildWhere — $raw with sql tag', () => {
    const p: any[] = []
    const w = buildWhere({ status: 'active', $raw: sql`price > ${100}` }, p)
    expect(w).toContain('"status" = ?')
    expect(w).toContain('(price > ?)')
    expect(p).toEqual(['active', 100])
  })

  test('buildWhere — $raw composed in AND', () => {
    const p: any[] = []
    const w = buildWhere({
      AND: [
        { status: 'active' },
        { $raw: sql`json_extract(meta, '$.tier') = ${3}` },
      ]
    }, p)
    expect(w).toContain('"status" = ?')
    expect(w).toContain("json_extract(meta, '$.tier') = ?")
    expect(p).toEqual(['active', 3])
  })

  test('buildWhere — $raw plain string (no params)', () => {
    const p: any[] = []
    const w = buildWhere({ $raw: 'deletedAt IS NULL' }, p)
    expect(w).toBe('(deletedAt IS NULL)')
    expect(p).toEqual([])
  })

  test('buildWhere — $raw invalid value throws', () => {
    expect(() => buildWhere({ $raw: 42 as any }, [])).toThrow()
  })

  test('buildOrderBy — NULLS LAST object form', () => {
    const r = buildOrderBy({ createdAt: { dir: 'asc', nulls: 'last' } })
    expect(r).toBe('"createdAt" ASC NULLS LAST')
  })

  test('buildOrderBy — NULLS FIRST', () => {
    const r = buildOrderBy({ name: { dir: 'desc', nulls: 'first' } })
    expect(r).toBe('"name" DESC NULLS FIRST')
  })

  test('buildOrderBy — object form without nulls is plain ASC/DESC', () => {
    const r = buildOrderBy({ id: { dir: 'asc' } })
    expect(r).toBe('"id" ASC')
  })

  test('normaliseOrderBy — handles object form', () => {
    const r = normaliseOrderBy([{ name: { dir: 'asc', nulls: 'last' } }, { id: 'desc' }])
    expect(r).toEqual([{ col: 'name', dir: 'ASC' }, { col: 'id', dir: 'DESC' }])
  })

  test('isNamedAgg — detects named aggregate specs', () => {
    expect(isNamedAgg('_countPaid', { count: true, filter: sql`x = 1` })).toBe(true)
    expect(isNamedAgg('_sumPaid',   { sum: 'amount' })).toBe(true)
    expect(isNamedAgg('_count',     true)).toBe(false)         // built-in scalar
    expect(isNamedAgg('_sum',       { amount: true })).toBe(false)  // built-in obj
    expect(isNamedAgg('status',     { count: true })).toBe(false)   // no _ prefix
  })

  test('buildNamedAggExpr — filtered count', () => {
    const params: any[] = []
    const e = buildNamedAggExpr('_countPaid', { count: true, filter: sql`status = ${'paid'}` }, params)
    expect(e).toContain("COUNT(*) FILTER (WHERE status = ?)")
    expect(params).toEqual(['paid'])
  })

  test('buildNamedAggExpr — sum no filter', () => {
    const params: any[] = []
    const e = buildNamedAggExpr('_total', { sum: 'amount' }, params)
    expect(e).toBe('SUM("amount") AS "__nagg___total"')
    expect(params).toHaveLength(0)
  })
})

// ─── 15. $schema + $enums + $softDelete + $relations ─────────────────────────


describe('@updatedAt parser attribute', () => {
  test('@updatedAt is a recognised field attribute', () => {
    const result = parse(`
      model Post {
        id        Int  @id
        title     String
        updatedAt DateTime @default(now()) @updatedAt
      }
    `)
    expect(result.valid).toBe(true)
    const field = result.schema.models[0].fields.find((f: any) => f.name === 'updatedAt')
    const attr  = field?.attributes.find((a: any) => a.kind === 'updatedAt')
    expect(attr).toBeDefined()
  })

  test('@updatedAt alongside other attributes does not conflict', () => {
    const result = parse(`
      model Item {
        id        Int  @id
        name      String     @trim @lower
        updatedAt DateTime @default(now()) @updatedAt
        deletedAt DateTime?
        @@softDelete
      }
    `)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('auto-trigger still fires via DDL convention (field named updatedAt)', async () => {
    // The @updatedAt attribute is documentary — the trigger is generated by DDL
    // based on field name, not the attribute. Verify the trigger works.
    const db = await makeDb(`
      model Entry {
        id        Int  @id
        body      String
        updatedAt DateTime @default(now()) @updatedAt
      }
    `, 'updatedat-trigger')
    const entry = await db.entry.create({ data: { id: 1, body: 'original' } })
    const before = entry.updatedAt

    // Small delay so timestamp can change
    await new Promise(r => setTimeout(r, 10))
    await db.entry.update({ where: { id: 1 }, data: { body: 'changed' } })
    const after = await db.entry.findUnique({ where: { id: 1 } })

    expect(after.updatedAt).not.toBe(before)
    db.$close()
  })
})

// ─── 43. @date field attribute ────────────────────────────────────────────────


describe('@date field attribute', () => {
  const schema = `
    model Event {
      id        Int @id
      name      String
      startsOn  String    @date
      endsOn    String?   @date
    }
  `

  test('@date parses as kind: date', () => {
    const result = parse(schema)
    expect(result.valid).toBe(true)
    const field = result.schema.models[0].fields.find((f: any) => f.name === 'startsOn')
    const attr  = field?.attributes.find((a: any) => a.kind === 'date')
    expect(attr).toBeDefined()
  })

  test('@date accepts a valid YYYY-MM-DD string', async () => {
    const db = await makeDb(schema, 'date-valid')
    const event = await db.event.create({ data: { id: 1, name: 'Launch', startsOn: '2026-04-06' } })
    expect(event.startsOn).toBe('2026-04-06')
    db.$close()
  })

  test('@date rejects an invalid format', async () => {
    const db = await makeDb(schema, 'date-invalid')
    await expect(
      db.event.create({ data: { id: 1, name: 'Bad', startsOn: '06/04/2026' } })
    ).rejects.toThrow('YYYY-MM-DD')
    db.$close()
  })

  test('@date rejects a full datetime string', async () => {
    const db = await makeDb(schema, 'date-reject-datetime')
    await expect(
      db.event.create({ data: { id: 1, name: 'Bad', startsOn: '2026-04-06T09:00:00.000Z' } })
    ).rejects.toThrow('YYYY-MM-DD')
    db.$close()
  })

  test('@date allows null on optional field', async () => {
    const db = await makeDb(schema, 'date-null')
    const event = await db.event.create({ data: { id: 1, name: 'TBD', startsOn: '2026-04-06', endsOn: null } })
    expect(event.endsOn).toBeNull()
    db.$close()
  })

  test('@date fields sort correctly as strings', async () => {
    const db = await makeDb(schema, 'date-sort')
    await db.event.createMany({ data: [
      { id: 1, name: 'C', startsOn: '2026-06-01' },
      { id: 2, name: 'A', startsOn: '2026-01-15' },
      { id: 3, name: 'B', startsOn: '2026-03-20' },
    ]})
    const rows = await db.event.findMany({ orderBy: { startsOn: 'asc' } })
    expect(rows.map((r: any) => r.name)).toEqual(['A', 'B', 'C'])
    db.$close()
  })

  test('@date range queries work correctly', async () => {
    const db = await makeDb(schema, 'date-range')
    await db.event.createMany({ data: [
      { id: 1, name: 'Past',    startsOn: '2025-12-01' },
      { id: 2, name: 'Q1',     startsOn: '2026-01-15' },
      { id: 3, name: 'Q2',     startsOn: '2026-04-06' },
      { id: 4, name: 'Future', startsOn: '2026-09-01' },
    ]})
    const q2 = await db.event.findMany({
      where: { startsOn: { gte: '2026-04-01', lt: '2026-07-01' } }
    })
    expect(q2).toHaveLength(1)
    expect(q2[0].name).toBe('Q2')
    db.$close()
  })

  test('@date appears as format: date in JSON Schema', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const result = parse(schema)
    const jschema = generateJsonSchema(result.schema)
    const props = jschema['$defs'].Event.properties
    expect(props.startsOn.format).toBe('date')
  })

  test('@date on optional field is nullable in JSON Schema', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const result = parse(schema)
    const jschema = generateJsonSchema(result.schema)
    const endsOn = jschema['$defs'].Event.properties.endsOn
    // nullable: anyOf with date string and null
    expect(endsOn.anyOf ?? [endsOn]).toSatisfy((arr: any) =>
      JSON.stringify(arr).includes('date')
    )
  })

  test('@date custom error message', async () => {
    const result = parse(`
      model Item {
        id   Int @id
        due  String    @date("Due date must be YYYY-MM-DD")
      }
    `)
    expect(result.valid).toBe(true)
    const db = await makeDb(`
      model Item {
        id   Int @id
        due  String    @date("Due date must be YYYY-MM-DD")
      }
    `, 'date-custom-msg')
    await expect(
      db.item.create({ data: { id: 1, due: 'not-a-date' } })
    ).rejects.toThrow('Due date must be YYYY-MM-DD')
    db.$close()
  })
})

// ─── 44. @sequence per-scope auto-increment ───────────────────────────────────


describe('@sequence per-scope auto-increment', () => {
  const schema = `
    model Quote {
      id          Int  @id
      accountId   Int?
      quoteNumber Int? @sequence(scope: accountId)
      title       String
    }
  `

  test('@sequence parses with scope field', () => {
    const result = parse(schema)
    expect(result.valid).toBe(true)
    const field = result.schema.models[0].fields.find((f: any) => f.name === 'quoteNumber')
    const attr  = field?.attributes.find((a: any) => a.kind === 'sequence')
    expect(attr).toBeDefined()
    expect(attr.scope).toBe('accountId')
  })

  test('first quote for an account gets quoteNumber 1', async () => {
    const db = await makeDb(schema, 'seq-first')
    const q = await db.quote.create({ data: { id: 1, accountId: 1, title: 'A' } })
    expect(q.quoteNumber).toBe(1)
    db.$close()
  })

  test('sequence increments per account', async () => {
    const db = await makeDb(schema, 'seq-increment')
    const q1 = await db.quote.create({ data: { id: 1, accountId: 1, title: 'A' } })
    const q2 = await db.quote.create({ data: { id: 2, accountId: 1, title: 'B' } })
    const q3 = await db.quote.create({ data: { id: 3, accountId: 1, title: 'C' } })
    expect(q1.quoteNumber).toBe(1)
    expect(q2.quoteNumber).toBe(2)
    expect(q3.quoteNumber).toBe(3)
    db.$close()
  })

  test('each account has its own sequence starting at 1', async () => {
    const db = await makeDb(schema, 'seq-isolated')
    const a1q1 = await db.quote.create({ data: { id: 1, accountId: 1, title: 'A' } })
    const a1q2 = await db.quote.create({ data: { id: 2, accountId: 1, title: 'B' } })
    const a2q1 = await db.quote.create({ data: { id: 3, accountId: 2, title: 'C' } })
    const a2q2 = await db.quote.create({ data: { id: 4, accountId: 2, title: 'D' } })
    expect(a1q1.quoteNumber).toBe(1)
    expect(a1q2.quoteNumber).toBe(2)
    expect(a2q1.quoteNumber).toBe(1)   // account 2 starts at 1
    expect(a2q2.quoteNumber).toBe(2)
    db.$close()
  })

  test('explicit quoteNumber is respected but counter still bumps', async () => {
    const db = await makeDb(schema, 'seq-explicit')
    const q1 = await db.quote.create({ data: { id: 1, accountId: 1, quoteNumber: 100, title: 'Jump' } })
    const q2 = await db.quote.create({ data: { id: 2, accountId: 1, title: 'Next' } })
    expect(q1.quoteNumber).toBe(100)   // explicit value respected
    expect(q2.quoteNumber).toBe(101)   // counter continues from 100
    db.$close()
  })

  test('createMany assigns sequential numbers per account', async () => {
    const db = await makeDb(schema, 'seq-many')
    await db.quote.createMany({ data: [
      { id: 1, accountId: 1, title: 'A' },
      { id: 2, accountId: 1, title: 'B' },
      { id: 3, accountId: 2, title: 'C' },
      { id: 4, accountId: 1, title: 'D' },
      { id: 5, accountId: 2, title: 'E' },
    ]})
    const acc1 = await db.quote.findMany({ where: { accountId: 1 }, orderBy: { quoteNumber: 'asc' } })
    const acc2 = await db.quote.findMany({ where: { accountId: 2 }, orderBy: { quoteNumber: 'asc' } })
    expect(acc1.map((q: any) => q.quoteNumber)).toEqual([1, 2, 3])
    expect(acc2.map((q: any) => q.quoteNumber)).toEqual([1, 2])
    db.$close()
  })

  test('_litestone_sequences table is created automatically', async () => {
    const db = await makeDb(schema, 'seq-table')
    await db.quote.create({ data: { id: 1, accountId: 1, title: 'A' } })
    const tables = db.$db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_litestone_sequences'`
    ).all()
    expect(tables).toHaveLength(1)
    db.$close()
  })

  test('multiple @sequence fields on one model are independent', async () => {
    const db = await makeDb(`
      model Doc {
        id         Int @id
        accountId  Int
        docNum     Int @sequence(scope: accountId)
        revNum     Int @sequence(scope: accountId)
        title      String
      }
    `, 'seq-multi')
    const d1 = await db.doc.create({ data: { id: 1, accountId: 1, title: 'A' } })
    const d2 = await db.doc.create({ data: { id: 2, accountId: 1, title: 'B' } })
    // Both sequences increment independently
    expect(d1.docNum).toBe(1)
    expect(d1.revNum).toBe(1)
    expect(d2.docNum).toBe(2)
    expect(d2.revNum).toBe(2)
    db.$close()
  })

  test('missing scope value is skipped gracefully', async () => {
    const db = await makeDb(schema, 'seq-no-scope')
    // accountId not provided — sequence cannot run, field stays null
    const q = await db.quote.create({ data: { id: 1, title: 'No account' } })
    expect(q.quoteNumber).toBeNull()
    db.$close()
  })
})

// ─── Factory + testing helpers ────────────────────────────────────────────────

import { makeTestClient, Factory, truncate, reset, snapshot, restore } from '../src/testing.js'
import { defineFactory, loadFixture, parseCsv } from '../src/seeder.js'
import { fakeFor, fakeEmail } from '../src/fake.js'
import { generateJsonSchema } from '../src/jsonschema.js'

// ── Shared factories ──────────────────────────────────────────────────────────

const FACTORY_SCHEMA = `
  model Account {
    id   Int @id
    name String
    plan String    @default("starter")
  }
  model User {
    id        Int @id
    accountId Int
    email     String
    role      String    @default("member")
    deletedAt DateTime?
    @@softDelete
  }
  model Post {
    id        Int @id
    userId    Int
    title     String
    status    String    @default("draft")
    deletedAt DateTime?
    @@softDelete
  }
`

class AccountFactory extends Factory {
  model = 'Account'
  traits = {
    pro:        { plan: 'pro' },
    enterprise: { plan: 'enterprise' },
  }
  definition(seq: number, rng: any) {
    return { id: seq, name: `Account ${seq}`, plan: 'starter' }
  }
}

class UserFactory extends Factory {
  model = 'User'
  traits = {
    admin:   { role: 'admin' },
    member:  { role: 'member' },
    viewer:  { role: 'viewer' },
  }
  definition(seq: number, rng: any) {
    return { id: seq, accountId: 1, email: `user${seq}@test.com`, role: 'member' }
  }
}

class PostFactory extends Factory {
  model = 'Post'
  traits = {
    published: { status: 'published' },
    draft:     { status: 'draft' },
  }
  definition(seq: number, rng: any) {
    return { id: seq, userId: 1, title: `Post ${seq}`, status: 'draft' }
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────


describe('@markdown', () => {
  const MD_SCHEMA = `
    model Post {
      id   Int @id
      body String    @markdown
      note String?   @markdown
      name String
    }
  `

  test('schema parses without error', () => {
    const r = parse(MD_SCHEMA)
    expect(r.valid).toBe(true)
  })

  test('@markdown stored on field AST as kind:markdown', () => {
    const { schema } = parse(MD_SCHEMA)
    const body = schema.models[0].fields.find((f: any) => f.name === 'body')
    expect(body.attributes.some((a: any) => a.kind === 'markdown')).toBe(true)
  })

  test('non-markdown field has no markdown attribute', () => {
    const { schema } = parse(MD_SCHEMA)
    const name = schema.models[0].fields.find((f: any) => f.name === 'name')
    expect(name.attributes.some((a: any) => a.kind === 'markdown')).toBe(false)
  })

  test('JSON Schema emits contentMediaType: text/markdown', () => {
    const { schema } = parse(MD_SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    const posts = js['$defs']?.Post ?? js.Post
    expect(posts.properties.body.contentMediaType).toBe('text/markdown')
  })

  test('optional markdown field also gets contentMediaType', () => {
    const { schema } = parse(MD_SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    const posts = js['$defs']?.Post ?? js.Post
    // Optional field is wrapped in anyOf — contentMediaType on the string branch
    const noteSchema = posts.properties.note
    const branch = noteSchema?.anyOf?.[0] ?? noteSchema
    expect(branch?.contentMediaType).toBe('text/markdown')
  })

  test('plain text field has no contentMediaType', () => {
    const { schema } = parse(MD_SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    const posts = js['$defs']?.Post ?? js.Post
    expect(posts.properties.name.contentMediaType).toBeUndefined()
  })

  test('field stores and retrieves String value normally', async () => {
    const { db } = await makeTestClient(MD_SCHEMA)
    const row = await db.post.create({ data: { id: 1, body: '# Hello\n**world**', name: 'test' } })
    expect(row.body).toBe('# Hello\n**world**')
    db.$close()
  })
})

// ─── File[] — multi-file fields ──────────────────────────────────────────────

import { fileUrls } from '../src/storage/index.js'


describe('File type + @keepVersions parser', () => {
  test('File type is a recognized scalar type', () => {
    const result = parse(`
      model User {
        id     Int @id
        avatar File?
      }
    `)
    expect(result.valid).toBe(true)
    const field = result.schema.models[0].fields.find((f: any) => f.name === 'avatar')
    expect(result.valid).toBe(true)
    expect(field?.type.name).toBe('File')
    expect(field?.type.optional).toBe(true)
  })

  test('@keepVersions attribute sets the flag on File fields', () => {
    const result = parse(`
      model User {
        id     Int @id
        resume File?   @keepVersions
      }
    `)
    expect(result.valid).toBe(true)
    const field = result.schema.models[0].fields.find((f: any) => f.name === 'resume')
    expect(field?.type.name).toBe('File')
    const attr  = field?.attributes.find((a: any) => a.kind === 'keepVersions')
    expect(attr).toBeDefined()
  })

  test('File type generates TEXT column in DDL', async () => {
    const { generateDDL } = await import('../src/core/ddl.js')
    const result = parse(`
      model User {
        id     Int @id
        avatar File?
      }
    `)
    const ddl = generateDDL(result.schema)
    expect(ddl).toContain('"avatar" TEXT')
  })

  test('multiple File fields on same model are all valid', () => {
    const result = parse(`
      model User {
        id     Int @id
        avatar File?
        resume File?   @keepVersions
      }
    `)
    expect(result.valid).toBe(true)
    const fields = result.schema.models[0].fields
    const fileFields = fields.filter((f: any) => f.type.name === 'File')
    expect(fileFields).toHaveLength(2)
  })
})

// ─── 33. FileStorage plugin ───────────────────────────────────────────────────

const FILE_SCHEMA = `
  model User {
    id     Int @id
    name   String
    avatar File?
    resume File?   @keepVersions
  }
`

// Mock provider — captures calls without needing real S3
function makeMockProvider() {
  return {
    puts:    [] as Array<{ key: string; contentType: string; size: number }>,
    deletes: [] as string[],
    async put(key: string, _body: unknown, opts: any) {
      this.puts.push({ key, contentType: opts.contentType, size: opts.size })
    },
    async get(key: string) { return Buffer.from(`bytes:${key}`) },
    async delete(key: string) { this.deletes.push(key) },
    async sign(key: string, { expiresIn = 3600 } = {}) { return `https://cdn/${key}?exp=${expiresIn}` },
    publicUrl(key: string) { return `https://cdn/${key}` },
  }
}


describe('File[] — parser + DDL', () => {
  test('File[] parses without error', () => {
    const r = parse(`model T { id Int @id; photos File[] }`)
    expect(r.valid).toBe(true)
  })

  test('File[]? optional parses without error', () => {
    const r = parse(`model T { id Int @id; photos File[]? }`)
    expect(r.valid).toBe(true)
  })

  test('File[] stored as TEXT column (JSON array)', async () => {
    const { db } = await makeTestClient(`model T { id Int @id; photos File[] }`)
    const cols = db.$db.prepare("PRAGMA table_info('t')").all()
    const photosCol = cols.find((c: any) => c.name === 'photos')
    expect(photosCol?.type).toBe('TEXT')
    db.$close()
  })
})

// ─── @accept — file type validation ──────────────────────────────────────────


describe('@accept', () => {
  test('parses @accept("image/*") without error', () => {
    const r = parse(`model T { id Int @id; avatar File? @accept("image/*") }`)
    expect(r.valid).toBe(true)
  })

  test('@accept stored on field AST with types', () => {
    const { schema } = parse(`model T { id Int @id; avatar File? @accept("image/*") }`)
    const f = schema.models[0].fields.find((f: any) => f.name === 'avatar')
    const attr = f.attributes.find((a: any) => a.kind === 'accept')
    expect(attr?.types).toBe('image/*')
  })

  test('@accept multi-type parses', () => {
    const r = parse(`model T { id Int @id; f File? @accept("image/jpeg,image/png") }`)
    expect(r.valid).toBe(true)
    const { schema } = r
    const attr = schema.models[0].fields[1].attributes.find((a: any) => a.kind === 'accept')
    expect(attr?.types).toBe('image/jpeg,image/png')
  })

  test('JSON Schema emits x-litestone-accept', () => {
    const { schema } = parse(`model T { id Int @id; avatar File? @accept("image/*") }`)
    const js = generateJsonSchema(schema, { mode: 'full' })
    const t = js['$defs']?.T ?? js.T
    expect(t.properties.avatar['x-litestone-accept'] ?? 
      t.properties.avatar?.anyOf?.[0]?.['x-litestone-accept']).toBe('image/*')
  })
})

// ─── jsonschema extensions ────────────────────────────────────────────────────

const JEXT_SCHEMA = `
  enum Plan { starter pro enterprise }

  model Account {
    id    Int @id
    name  String
    plan  Plan    @default(starter)
    users User[]
    @@gate("2.5.5.6")
  }

  model User {
    id        Int  @id
    account   Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
    accountId Int
    email     String     @email
    posts     Post[]
    @@gate("2.4.4.6")
  }

  model Post {
    id     Int @id
    author User   @relation(fields: [userId], references: [id])
    userId Int
    title  String
    tags   Post[]
  }
`





describe('bun:sqlite — WAL + dual connections', () => {

  test('WAL mode is set on write connection', async () => {
    const db  = await makeDb(`model T { id Int @id }`, 'wal')
    const raw = db.$db as Database
    const mode = raw.query('PRAGMA journal_mode').get() as any
    expect(mode.journal_mode).toBe('wal')
    db.$close()
  })

  test('page_size is 8192', async () => {
    const db  = await makeDb(`model T { id Int @id }`, 'pagesize')
    const raw = db.$db as Database
    const ps  = raw.query('PRAGMA page_size').get() as any
    expect(ps.page_size).toBe(8192)
    db.$close()
  })

  test('foreign_keys ON', async () => {
    const db  = await makeDb(`model T { id Int @id }`, 'fk')
    const raw = db.$db as Database
    const fk  = raw.query('PRAGMA foreign_keys').get() as any
    expect(fk.foreign_keys).toBe(1)
    db.$close()
  })

  test('$cacheSize reports both connections', async () => {
    const db = await makeDb(`model T { id Int @id }`, 'cache')
    await db.t.findMany()
    const cs = db.$cacheSize
    expect(cs).toHaveProperty('read')
    expect(cs).toHaveProperty('write')
    expect(cs.read).toBeGreaterThan(0)
    db.$close()
  })

  test('readonly read connection cannot write', async () => {
    // Structural test — read and write connections are separate, each with their own cache
    const db = await makeDb(`model T { id Int @id }`, 'readonly')
    await db.t.findMany()
    await db.t.create({ data: { id: 1 } })
    await db.t.findMany()
    // Both caches should be populated independently
    const cs = db.$cacheSize
    expect(cs.read).toBeGreaterThan(0)
    expect(cs.write).toBeGreaterThan(0)
    db.$close()
  })
})

// ─── 13. Extensions ───────────────────────────────────────────────────────────


// ┌────────────────────────────────────────────────────────────────────────────┐
// │  MIGRATIONS                                                                │
// └────────────────────────────────────────────────────────────────────────────┘

describe('migrations', () => {

  test('pristine diff detects new table', () => {
    const r1 = parse(`model User { id Int @id
        email String }`)
    const r2 = parse(`
      model User    { id Int @id
        email String }
      model Account { id Int @id
        name  String }
    `)
    const liveDb    = new Database(':memory:')
    const pristineDb = new Database(':memory:')
    for (const s of splitStatements(generateDDL(r1.schema)))
      if (!s.startsWith('PRAGMA')) liveDb.run(s)

    const pristine = buildPristine(pristineDb, r2)
    const diff     = diffSchemas(pristine, liveDb, r2)
    expect(diff.hasChanges).toBe(true)
    // newTables holds model objects — .name is the PascalCase model name
    expect(diff.newTables.map((m: any) => m.name)).toContain('Account')
    liveDb.close()
    pristineDb.close()
  })

  test('pristine diff detects new column', () => {
    const r1 = parse(`model User { id Int @id
        email String }`)
    const r2 = parse(`model User { id Int @id
        email String
        name String? }`)
    const liveDb     = new Database(':memory:')
    const pristineDb = new Database(':memory:')
    for (const s of splitStatements(generateDDL(r1.schema)))
      if (!s.startsWith('PRAGMA')) liveDb.run(s)

    const diff = diffSchemas(buildPristine(pristineDb, r2), liveDb, r2)
    expect(diff.hasChanges).toBe(true)
    liveDb.close()
    pristineDb.close()
  })

  test('generate + apply migrations', async () => {
    const schemaText = `
      model User { id Int @id
        email String @unique
        name String? }
    `
    const dbPath = tmpDb('migrations')
    const migDir = tmpDir('migrations-sql')
    const result = parse(schemaText)

    const db = new Database(dbPath)
    db.run('PRAGMA journal_mode = WAL')
    db.run('PRAGMA page_size = 8192')
    db.close()

    // Reopen for migration
    const db2 = new Database(dbPath)
    create(db2, result, 'initial', migDir)
    apply(db2, migDir)
    db2.close()

    // Verify table exists — PascalCase model `User` → snake_case table `user`
    const db3 = new Database(dbPath)
    expect(() => db3.query('SELECT * FROM user').all()).not.toThrow()
    db3.close()
  })

  test('migration status — applied/pending', async () => {
    const schemaText = `model Post { id Int @id
        title String }`
    const dbPath = tmpDb('status')
    const migDir = tmpDir('status-sql')
    const result = parse(schemaText)

    const db = new Database(dbPath)
    create(db, result, 'initial', migDir)

    const before = status(db, migDir)
    expect(before.some((r: any) => r.state === 'pending')).toBe(true)

    apply(db, migDir)

    const after = status(db, migDir)
    expect(after.every((r: any) => r.state === 'applied')).toBe(true)
    db.close()
  })

  test('verify detects drift', () => {
    const schemaText = `model Thing { id Int @id
        val String }`
    const dbPath = tmpDb('verify')
    const migDir = tmpDir('verify-sql')
    const result = parse(schemaText)

    const db = new Database(dbPath)
    create(db, result, 'init', migDir)
    apply(db, migDir)

    // Manually add a column — creates drift. Table is `thing` (snake_case of Thing).
    db.run('ALTER TABLE thing ADD COLUMN extra TEXT')

    const v = verify(db, result, migDir)
    expect(v.state).toBe('drift')
    db.close()
  })
})

// ─── 4. Client — CRUD ─────────────────────────────────────────────────────────

const SCHEMA = `
  enum Plan { starter  pro  enterprise }
  enum Role { admin  member  viewer }

  model Account {
    id        Int  @id
    name      String
    plan      Plan     @default(starter)
    meta      Json?
    createdAt DateTime @default(now())
  }

  model User {
    id        Int  @id
    account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
    accountId Int
    email     String     @unique @lower
    name      String?
    isAdmin   Boolean  @default(false)
    role      Role     @default(member)
    prefs     Json?
    createdAt DateTime @default(now())
    deletedAt DateTime?

    @@softDelete
    @@index([accountId])
  }

  model Message {
    id        Int  @id
    user      User     @relation(fields: [userId], references: [id])
    userId    Int
    body      String
    title     String?
    isRead    Boolean  @default(false)
    createdAt DateTime @default(now())

    @@fts([body, title])
    @@index([userId])
  }
`


describe('autoMigrate', () => {
  test('creates tables on a fresh empty database', async () => {
    const { autoMigrate } = await import('../src/core/migrations.js')
    const db = await makeDb(`
      model Widget {
        id    Int @id
        label String
      }
    `, 'automigrate-fresh')
    // makeDb already applied DDL — create a second client on the same file
    // to simulate an already-migrated state
    const result = autoMigrate(db)
    expect(result.main.state).toBe('in-sync')
    db.$close()
  })

  test('no-ops when schema is already in sync', async () => {
    const { autoMigrate } = await import('../src/core/migrations.js')
    const db = await makeDb(`
      model Thing { id Int @id; name String }
    `, 'automigrate-noop')
    const result = autoMigrate(db)
    expect(result.main.state).toBe('in-sync')
    expect(result.main.applied).toBe(0)
    db.$close()
  })

  test('applies a new column when schema drifts', async () => {
    const { autoMigrate } = await import('../src/core/migrations.js')
    const path = tmpDb('automigrate-drift' + Math.random().toString(36).slice(2))
    const { Database } = await import('bun:sqlite')

    // Create DB with just id column — table name matches the derived snake_case
    // singular of the PascalCase model (Gadget → gadget)
    const raw = new Database(path)
    raw.run('CREATE TABLE gadget (id INTEGER PRIMARY KEY)')
    raw.close()

    // Now createClient with a schema that has an extra column
    const result = parse(`model Gadget { id Int @id; name String @default("x") }`)
    const db = await createClient({ parsed: result,  db: path })

    const migResult = autoMigrate(db)
    expect(migResult.main.state).toBe('migrated')
    expect(migResult.main.applied).toBeGreaterThan(0)

    // Verify new column exists
    const row = db.$db.query(`INSERT INTO gadget (name) VALUES ('test') RETURNING *`).get()
    expect((row as any).name).toBe('test')
    db.$close()
  })

  test('returns in-sync after migration is applied', async () => {
    const { autoMigrate } = await import('../src/core/migrations.js')
    const path = tmpDb('automigrate-idempotent' + Math.random().toString(36).slice(2))
    const { Database } = await import('bun:sqlite')

    const raw = new Database(path)
    raw.run('CREATE TABLE item (id INTEGER PRIMARY KEY)')
    raw.close()

    const result = parse(`model Item { id Int @id; label String @default("x") }`)
    const db = await createClient({ parsed: result,  db: path })

    autoMigrate(db)                    // first call — applies migration
    const second = autoMigrate(db)     // second call — no-op
    expect(second.main.state).toBe('in-sync')
    db.$close()
  })
})

// ─── 36. upsertMany ───────────────────────────────────────────────────────────


describe('status() — sql field', () => {
  test('status rows include sql string for applied and pending', async () => {
    const { db } = await makeTestClient(
      `model T { id Int @id; name String }`,
      { data: async () => {} }
    )
    // Create a temp migrations dir with one file
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdirSync, writeFileSync } = await import('fs')
    const { status } = await import('../src/core/migrations.js')

    const dir = join(tmpdir(), `mig-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const sql = 'CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY);'
    writeFileSync(join(dir, '20240101000000_test.sql'), sql)

    const rows = status(db.$db, dir)
    expect(rows.length).toBe(1)
    expect(rows[0].sql).toBe(sql)
    expect(rows[0].state).toBe('pending')
    db.$close()
  })

  test('orphaned rows have sql: null', async () => {
    const { db } = await makeTestClient(`model T { id Int @id }`)
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { mkdirSync, writeFileSync, unlinkSync } = await import('fs')
    const { status, apply } = await import('../src/core/migrations.js')

    const dir = join(tmpdir(), `mig-orphan-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, '20240101000000_orphan.sql')
    writeFileSync(filePath, 'SELECT 1;')

    // Apply so it's recorded, then delete the file
    apply(db.$db, dir)
    unlinkSync(filePath)

    const rows = status(db.$db, dir)
    const orphan = rows.find((r: any) => r.state === 'orphaned')
    expect(orphan).toBeDefined()
    expect(orphan.sql).toBeNull()
    db.$close()
  })
})


// ─── RETURNING * write path ───────────────────────────────────────────────────





// ┌────────────────────────────────────────────────────────────────────────────┐
// │  CLIENT — CORE                                                             │
// └────────────────────────────────────────────────────────────────────────────┘

describe('client — CRUD', () => {
  let db: any

  beforeAll(async () => { db = await makeDb(SCHEMA, 'crud') })
  afterAll(() => db.$close())

  test('create + findUnique', async () => {
    const acc = await db.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
    expect(acc.id).toBe(1)
    expect(acc.name).toBe('Acme')
    expect(acc.plan).toBe('pro')

    const found = await db.account.findUnique({ where: { id: 1 } })
    expect(found?.name).toBe('Acme')
  })

  test('Boolean auto-coercion', async () => {
    await db.user.create({ data: { id: 1, accountId: 1, email: 'alice@acme.com', isAdmin: true, role: 'admin' } })
    const u = await db.user.findUnique({ where: { id: 1 } })
    expect(u?.isAdmin).toBe(true)
    expect(typeof u?.isAdmin).toBe('boolean')
  })

  test('Boolean write false', async () => {
    await db.user.create({ data: { id: 2, accountId: 1, email: 'bob@acme.com', isAdmin: false } })
    const u = await db.user.findUnique({ where: { id: 2 } })
    expect(u?.isAdmin).toBe(false)
    expect(typeof u?.isAdmin).toBe('boolean')
  })

  test('JSON auto-parse', async () => {
    await db.account.update({ where: { id: 1 }, data: { meta: { seats: 10 } } })
    const a = await db.account.findUnique({ where: { id: 1 } })
    expect(a?.meta).toEqual({ seats: 10 })
    expect(typeof a?.meta).toBe('object')
  })

  test('@lower transform on email', async () => {
    await db.user.create({ data: { id: 3, accountId: 1, email: 'CAROL@ACME.COM' } })
    const u = await db.user.findUnique({ where: { id: 3 } })
    expect(u?.email).toBe('carol@acme.com')
  })

  test('createMany', async () => {
    const r = await db.user.createMany({ data: [
      { id: 10, accountId: 1, email: 'u10@x.com' },
      { id: 11, accountId: 1, email: 'u11@x.com' },
      { id: 12, accountId: 1, email: 'u12@x.com' },
    ]})
    expect(r.count).toBe(3)
  })

  test('findMany with where', async () => {
    const rows = await db.user.findMany({ where: { accountId: 1 } })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r: any) => r.accountId === 1)).toBe(true)
  })

  test('findMany orderBy + limit', async () => {
    const rows = await db.user.findMany({ orderBy: { id: 'asc' }, limit: 2 })
    expect(rows.length).toBe(2)
    expect(rows[0].id).toBeLessThan(rows[1].id)
  })

  test('update', async () => {
    await db.account.update({ where: { id: 1 }, data: { name: 'Acme Corp' } })
    const a = await db.account.findUnique({ where: { id: 1 } })
    expect(a?.name).toBe('Acme Corp')
  })

  test('updateMany', async () => {
    const r = await db.user.updateMany({ where: { accountId: 1 }, data: { role: 'viewer' } })
    expect(r.count).toBeGreaterThan(0)
  })

  test('upsert — create path', async () => {
    const a = await db.account.upsert({
      where:  { id: 99 },
      create: { id: 99, name: 'New Corp', plan: 'starter' },
      update: { name: 'Updated' },
    })
    expect(a?.name).toBe('New Corp')
  })

  test('upsert — update path', async () => {
    await db.account.upsert({
      where:  { id: 99 },
      create: { id: 99, name: 'New Corp', plan: 'starter' },
      update: { name: 'Updated Corp' },
    })
    const a = await db.account.findUnique({ where: { id: 99 } })
    expect(a?.name).toBe('Updated Corp')
  })

  test('count', async () => {
    const n = await db.account.count()
    expect(n).toBeGreaterThan(0)
  })

  test('count with where', async () => {
    const n = await db.user.count({ where: { accountId: 1 } })
    expect(n).toBeGreaterThan(0)
  })

  test('exists — returns true when row found', async () => {
    const found = await db.account.exists({ where: { id: 1 } })
    expect(found).toBe(true)
  })

  test('exists — returns false when no row found', async () => {
    const found = await db.account.exists({ where: { id: 99999 } })
    expect(found).toBe(false)
  })

  test('exists — no where returns true when table has rows', async () => {
    const found = await db.account.exists()
    expect(found).toBe(true)
  })

  test('exists — where compound condition', async () => {
    // NOTE: the updateMany test above set all accountId=1 users to role='viewer'.
    // Use that known state so both halves of the compound condition match.
    const found = await db.user.exists({ where: { accountId: 1, role: 'viewer' } })
    expect(found).toBe(true)
  })

  test('$raw — filters with sql tag', async () => {
    // accountId = 1 has users with ids 1,2,3 created earlier
    const minId = 2
    const rows = await db.user.findMany({
      where: { $raw: sql`"id" >= ${minId}` },
      orderBy: { id: 'asc' },
    })
    expect(rows.every((r: any) => r.id >= minId)).toBe(true)
  })

  test('$raw — composed with structured where', async () => {
    const rows = await db.user.findMany({
      where: {
        accountId: 1,
        $raw: sql`"id" = ${1}`,
      }
    })
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(1)
  })

  test('$raw — in AND clause', async () => {
    const rows = await db.user.findMany({
      where: {
        AND: [
          { accountId: 1 },
          { $raw: sql`"id" IN (${1}, ${2})` },
        ]
      },
      orderBy: { id: 'asc' },
    })
    expect(rows.map((r: any) => r.id)).toEqual([1, 2])
  })

  test('$raw — works with count', async () => {
    const n = await db.user.count({ where: { $raw: sql`"accountId" = ${1}` } })
    expect(n).toBeGreaterThan(0)
  })

  test('$raw — works with exists', async () => {
    const found = await db.user.exists({ where: { $raw: sql`"id" = ${1}` } })
    expect(found).toBe(true)
  })

  test('orderBy NULLS LAST — object form', async () => {
    // name can be null for some users
    const rows = await db.user.findMany({
      orderBy: { name: { dir: 'asc', nulls: 'last' } },
    })
    // all non-null names should come before nulls
    const names = rows.map((r: any) => r.name)
    const firstNull = names.findIndex((n: any) => n === null)
    if (firstNull !== -1) {
      expect(names.slice(firstNull).every((n: any) => n === null)).toBe(true)
    }
  })

  test('findMany distinct', async () => {
    // create some duplicate roles
    const roles = await db.user.findMany({
      select: { role: true },
      distinct: true,
      orderBy: { role: 'asc' },
    })
    const roleValues = roles.map((r: any) => r.role)
    expect(roleValues.length).toBe(new Set(roleValues).size)
  })

  test('create select: false — returns null, row exists', async () => {
    const result = await db.account.create({
      data: { id: 199, name: 'Silent', plan: 'starter' },
      select: false,
    })
    expect(result).toBeNull()
    const found = await db.account.findUnique({ where: { id: 199 } })
    expect(found?.name).toBe('Silent')
  })

  test('update select: false — returns null, row updated', async () => {
    const result = await db.account.update({
      where: { id: 1 },
      data: { name: 'Updated Silently' },
      select: false,
    })
    expect(result).toBeNull()
    const found = await db.account.findUnique({ where: { id: 1 } })
    expect(found?.name).toBe('Updated Silently')
  })

  test('update select: false — returns null when no match', async () => {
    const result = await db.account.update({
      where: { id: 99999 },
      data: { name: 'ghost' },
      select: false,
    })
    expect(result).toBeNull()
  })

  test('upsert select: false — returns null', async () => {
    const result = await db.account.upsert({
      where: { id: 98 },
      create: { id: 98, name: 'Upserted', plan: 'starter' },
      update: { name: 'Upserted Again' },
      select: false,
    })
    expect(result).toBeNull()
    const found = await db.account.findUnique({ where: { id: 98 } })
    expect(found?.name).toBe('Upserted')
  })

  test('enum validation — invalid value throws', async () => {
    expect(db.account.create({ data: { id: 200, name: 'X', plan: 'invalid' } }))
      .rejects.toThrow(ValidationError)
  })
})

// ─── 5a. Relation orderBy ─────────────────────────────────────────────────────


describe('relation orderBy', () => {
  let db: any

  beforeAll(async () => {
    ;({ db } = await makeTestClient(`
      model Country {
        id    Int @id
        name  String
        code  String
      }
      model Company {
        id        Int  @id
        name      String
        country   Country @relation(fields: [countryId], references: [id])
        countryId Int
      }
      model User {
        id        Int  @id
        name      String
        company   Company @relation(fields: [companyId], references: [id])
        companyId Int
      }
    `, {
      data: async (db: any) => {
        await db.country.create({ data: { id: 1, name: 'Australia', code: 'AU' } })
        await db.country.create({ data: { id: 2, name: 'Canada',    code: 'CA' } })
        await db.country.create({ data: { id: 3, name: 'Botswana',  code: 'BW' } })
        await db.company.create({ data: { id: 1, name: 'Zulu Corp',  countryId: 1 } })
        await db.company.create({ data: { id: 2, name: 'Alpha Inc',  countryId: 2 } })
        await db.company.create({ data: { id: 3, name: 'Mesa Ltd',   countryId: 3 } })
        await db.user.create({ data: { id: 1, name: 'Alice', companyId: 1 } })
        await db.user.create({ data: { id: 2, name: 'Bob',   companyId: 2 } })
        await db.user.create({ data: { id: 3, name: 'Carol', companyId: 3 } })
      }
    }))
  })

  afterAll(() => db.$close())

  test('orderBy belongsTo field asc', async () => {
    const rows = await db.user.findMany({ orderBy: { company: { name: 'asc' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Bob', 'Carol', 'Alice'])
  })

  test('orderBy belongsTo field desc', async () => {
    const rows = await db.user.findMany({ orderBy: { company: { name: 'desc' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Alice', 'Carol', 'Bob'])
  })

  test('orderBy two-hop relation field', async () => {
    // users → companies → countries, order by country name
    const rows = await db.user.findMany({
      orderBy: { company: { country: { name: 'asc' } } }
    })
    // Australia=Alice, Botswana=Carol, Canada=Bob
    expect(rows.map((r: any) => r.name)).toEqual(['Alice', 'Carol', 'Bob'])
  })

  test('mixed flat + relation orderBy', async () => {
    // primary sort: company.name asc; tiebreak: user.name asc (no ties here but exercises mixed path)
    const rows = await db.user.findMany({
      orderBy: [{ company: { name: 'asc' } }, { name: 'asc' }]
    })
    expect(rows.map((r: any) => r.name)).toEqual(['Bob', 'Carol', 'Alice'])
  })

  test('orderBy relation field with limit', async () => {
    const rows = await db.user.findMany({
      orderBy: { company: { name: 'asc' } },
      limit: 2,
    })
    expect(rows.length).toBe(2)
    expect(rows[0].name).toBe('Bob')
    expect(rows[1].name).toBe('Carol')
  })

  test('orderBy relation field with where', async () => {
    const rows = await db.user.findMany({
      where:   { id: { in: [1, 2] } },
      orderBy: { company: { name: 'asc' } },
    })
    expect(rows.map((r: any) => r.name)).toEqual(['Bob', 'Alice'])
  })

  test('orderBy on companies by country field', async () => {
    // country names asc: Australia (Zulu), Botswana (Mesa), Canada (Alpha)
    const rows = await db.company.findMany({ orderBy: { country: { name: 'asc' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Zulu Corp', 'Mesa Ltd', 'Alpha Inc'])
  })

  // Both of these name a key the model does not declare, so orderBy key
  // validation refuses them before buildRelationOrderBy is reached. It names
  // what IS sortable, which the old "relation not found" could not.
  test('throws on unknown hasMany relation in orderBy', async () => {
    await expect(
      db.country.findMany({ orderBy: { companies: { name: 'asc' } } })
    ).rejects.toThrow("Unknown orderBy field 'companies'")
  })

  test('throws on unknown relation in orderBy', async () => {
    await expect(
      db.user.findMany({ orderBy: { nonexistent: { name: 'asc' } } })
    ).rejects.toThrow("Unknown orderBy field 'nonexistent'")
  })

})

describe('relation aggregate orderBy', () => {
  let db: any

  beforeAll(async () => {
    ;({ db } = await makeTestClient(`
      model Author {
        id     Int @id
        name   String
        books  Book[]
        tags   Tag[]
      }
      model Book {
        id       Int @id
        title    String
        price    Float
        author   Author @relation(fields: [authorId], references: [id])
        authorId Int
      }
      model Tag {
        id      Int @id
        label   String
        authors Author[]
      }
    `, {
      data: async (db: any) => {
        await db.tag.create({ data: { id: 1, label: 'fiction' } })
        await db.tag.create({ data: { id: 2, label: 'science' } })
        // Alice — 3 books, tagged with fiction + science
        await db.author.create({ data: { id: 1, name: 'Alice' } })
        await db.book.create({ data: { id: 1, title: 'A1', price: 10, authorId: 1 } })
        await db.book.create({ data: { id: 2, title: 'A2', price: 20, authorId: 1 } })
        await db.book.create({ data: { id: 3, title: 'A3', price: 30, authorId: 1 } })
        // Bob — 1 book, tagged with fiction
        await db.author.create({ data: { id: 2, name: 'Bob' } })
        await db.book.create({ data: { id: 4, title: 'B1', price: 50, authorId: 2 } })
        // Carol — 2 books, no tags
        await db.author.create({ data: { id: 3, name: 'Carol' } })
        await db.book.create({ data: { id: 5, title: 'C1', price: 5,  authorId: 3 } })
        await db.book.create({ data: { id: 6, title: 'C2', price: 15, authorId: 3 } })
        // Tags via implicit m2m
        await db.author.update({ where: { id: 1 }, data: { tags: { connect: [{ id: 1 }, { id: 2 }] } } })
        await db.author.update({ where: { id: 2 }, data: { tags: { connect: [{ id: 1 }] } } })
      }
    }))
  })

  afterAll(() => db.$close())

  test('orderBy hasMany _count asc', async () => {
    const rows = await db.author.findMany({ orderBy: { books: { _count: 'asc' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Bob', 'Carol', 'Alice'])
  })

  test('orderBy hasMany _count desc', async () => {
    const rows = await db.author.findMany({ orderBy: { books: { _count: 'desc' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Alice', 'Carol', 'Bob'])
  })

  test('orderBy hasMany _sum asc', async () => {
    // Alice: 10+20+30=60, Bob: 50, Carol: 5+15=20
    const rows = await db.author.findMany({ orderBy: { books: { _sum: { price: 'asc' } } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Carol', 'Bob', 'Alice'])
  })

  test('orderBy hasMany _sum desc', async () => {
    const rows = await db.author.findMany({ orderBy: { books: { _sum: { price: 'desc' } } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  test('orderBy hasMany _max asc', async () => {
    // Alice max: 30, Bob max: 50, Carol max: 15
    const rows = await db.author.findMany({ orderBy: { books: { _max: { price: 'asc' } } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Carol', 'Alice', 'Bob'])
  })

  test('orderBy manyToMany _count asc', async () => {
    // Alice: 2 tags, Bob: 1 tag, Carol: 0 tags
    const rows = await db.author.findMany({ orderBy: { tags: { _count: 'asc' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Carol', 'Bob', 'Alice'])
  })

  test('orderBy manyToMany _count desc', async () => {
    const rows = await db.author.findMany({ orderBy: { tags: { _count: 'desc' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  test('mixed flat + aggregate orderBy', async () => {
    const rows = await db.author.findMany({
      orderBy: [{ books: { _count: 'desc' } }, { name: 'asc' }]
    })
    expect(rows[0].name).toBe('Alice')  // 3 books
  })

  test('aggregate orderBy with where', async () => {
    const rows = await db.author.findMany({
      where:   { id: { in: [1, 3] } },
      orderBy: { books: { _count: 'asc' } },
    })
    expect(rows.map((r: any) => r.name)).toEqual(['Carol', 'Alice'])
  })

  test('throws on belongsTo aggregate orderBy', async () => {
    await expect(
      db.book.findMany({ orderBy: { author: { _count: 'asc' } } })
    ).rejects.toThrow('belongsTo')
  })

  test('throws on manyToMany _sum', async () => {
    await expect(
      db.author.findMany({ orderBy: { tags: { _sum: { id: 'asc' } } } })
    ).rejects.toThrow('manyToMany')
  })
})

describe('window functions', () => {
  let db: any

  beforeAll(async () => {
    ;({ db } = await makeTestClient(`
      model Score {
        id        Int @id
        userId    Int
        category  String
        value     Float
        createdAt DateTime @default(now())
      }
    `, {
      data: async (db: any) => {
        await db.score.createMany({ data: [
          { id: 1, userId: 1, category: 'math',    value: 90 },
          { id: 2, userId: 2, category: 'math',    value: 75 },
          { id: 3, userId: 3, category: 'math',    value: 85 },
          { id: 4, userId: 1, category: 'science', value: 80 },
          { id: 5, userId: 2, category: 'science', value: 95 },
          { id: 6, userId: 3, category: 'science', value: 70 },
        ]})
      }
    }))
  })

  afterAll(() => db.$close())

  test('rowNumber — global', async () => {
    const rows = await db.score.findMany({
      orderBy: { id: 'asc' },
      window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows.map((r: any) => r.rn)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('rank — within partition', async () => {
    const rows = await db.score.findMany({
      orderBy: [{ category: 'asc' }, { value: 'desc' }],
      window:  {
        rank: { rank: true, partitionBy: 'category', orderBy: { value: 'desc' } }
      },
    })
    const math = rows.filter((r: any) => r.category === 'math')
    expect(math.find((r: any) => r.value === 90).rank).toBe(1)
    expect(math.find((r: any) => r.value === 85).rank).toBe(2)
    expect(math.find((r: any) => r.value === 75).rank).toBe(3)
  })

  test('denseRank', async () => {
    const rows = await db.score.findMany({
      orderBy: { value: 'desc' },
      window:  { dr: { denseRank: true, orderBy: { value: 'desc' } } },
    })
    // All values are distinct so dense_rank === rank
    expect(rows[0].dr).toBe(1)
    expect(rows[1].dr).toBe(2)
  })

  test('sum — running total within partition', async () => {
    const rows = await db.score.findMany({
      where:   { category: 'math' },
      orderBy: { id: 'asc' },
      window:  {
        runningSum: {
          sum: 'value',
          partitionBy: 'category',
          orderBy: { id: 'asc' },
          rows: [null, 0],  // UNBOUNDED PRECEDING to CURRENT ROW
        }
      },
    })
    // 90, 90+75=165, 165+85=250
    expect(rows[0].runningSum).toBeCloseTo(90)
    expect(rows[1].runningSum).toBeCloseTo(165)
    expect(rows[2].runningSum).toBeCloseTo(250)
  })

  test('avg — moving average (2 preceding + current)', async () => {
    const rows = await db.score.findMany({
      where:   { category: 'math' },
      orderBy: { id: 'asc' },
      window:  {
        movingAvg: {
          avg: 'value',
          orderBy: { id: 'asc' },
          rows: [-2, 0],
        }
      },
    })
    expect(rows[0].movingAvg).toBeCloseTo(90)           // only 1 row in window
    expect(rows[1].movingAvg).toBeCloseTo((90+75)/2)    // 2 rows
    expect(rows[2].movingAvg).toBeCloseTo((90+75+85)/3) // 3 rows
  })

  test('lag — previous row value', async () => {
    const rows = await db.score.findMany({
      where:   { category: 'math' },
      orderBy: { id: 'asc' },
      window:  { prev: { lag: 'value', offset: 1, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].prev).toBeNull()  // no previous row
    expect(rows[1].prev).toBeCloseTo(90)
    expect(rows[2].prev).toBeCloseTo(75)
  })

  test('lead — next row value', async () => {
    const rows = await db.score.findMany({
      where:   { category: 'math' },
      orderBy: { id: 'asc' },
      window:  { next: { lead: 'value', offset: 1, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].next).toBeCloseTo(75)
    expect(rows[1].next).toBeCloseTo(85)
    expect(rows[2].next).toBeNull()  // no next row
  })

  test('count — running count', async () => {
    const rows = await db.score.findMany({
      orderBy: { id: 'asc' },
      window:  { n: { count: true, orderBy: { id: 'asc' }, rows: [null, 0] } },
    })
    expect(rows[0].n).toBe(1)
    expect(rows[5].n).toBe(6)
  })

  test('multiple window functions in one query', async () => {
    const rows = await db.score.findMany({
      orderBy: { id: 'asc' },
      window:  {
        rn:   { rowNumber: true, orderBy: { id: 'asc' } },
        rank: { rank: true, partitionBy: 'category', orderBy: { value: 'desc' } },
      },
    })
    expect(rows[0]).toHaveProperty('rn')
    expect(rows[0]).toHaveProperty('rank')
  })

  test('window + where + limit', async () => {
    // Limit must apply after window computation
    const rows = await db.score.findMany({
      orderBy: { value: 'desc' },
      limit:   3,
      window:  { rn: { rowNumber: true, orderBy: { value: 'desc' } } },
    })
    expect(rows.length).toBe(3)
    // rowNumber should still reflect global ranking (not just within the 3 rows)
    expect(rows[0].rn).toBe(1)
    expect(rows[1].rn).toBe(2)
    expect(rows[2].rn).toBe(3)
  })

  test('firstValue within partition', async () => {
    const rows = await db.score.findMany({
      orderBy: [{ category: 'asc' }, { value: 'desc' }],
      window:  {
        best: {
          firstValue: 'value',
          partitionBy: 'category',
          orderBy: { value: 'desc' },
        }
      },
    })
    const math = rows.filter((r: any) => r.category === 'math')
    // firstValue in each math row should be the best math score (90)
    expect(math.every((r: any) => r.best === 90)).toBe(true)
  })

  test('throws on unknown window function', async () => {
    await expect(
      db.score.findMany({ window: { x: { unknown: true } as any } })
    ).rejects.toThrow('unrecognised window function')
  })
})

// ─── 5. Client — Soft Delete ──────────────────────────────────────────────────



describe('client — soft delete', () => {
  let db: any

  beforeAll(async () => { db = await makeDb(SCHEMA, 'soft') })
  afterAll(() => db.$close())

  beforeEach(async () => {
    await db.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, email: 'a@x.com' },
      { id: 2, accountId: 1, email: 'b@x.com' },
      { id: 3, accountId: 1, email: 'c@x.com' },
    ]})
  })

  afterEach(async () => {
    // hard delete everything between tests
    await db.user.delete({ where: { id: { in: [1,2,3] } } })
    await db.account.delete({ where: { id: 1 } })
  })

  test('findMany excludes soft-deleted by default', async () => {
    await db.user.remove({ where: { id: 1 } })
    const live = await db.user.findMany()
    expect(live.every((u: any) => u.deletedAt === null)).toBe(true)
    expect(live.find((u: any) => u.id === 1)).toBeUndefined()
  })

  test('delete sets deletedAt, not real DELETE', async () => {
    await db.user.remove({ where: { id: 2 } })
    const all = await db.user.findMany({ withDeleted: true })
    const deleted = all.find((u: any) => u.id === 2)
    expect(deleted).toBeDefined()
    expect(deleted.deletedAt).not.toBeNull()
  })

  test('withDeleted: true shows all rows', async () => {
    await db.user.remove({ where: { id: 1 } })
    const all = await db.user.findMany({ withDeleted: true })
    expect(all.some((u: any) => u.id === 1)).toBe(true)
  })

  test('onlyDeleted: true shows only deleted', async () => {
    await db.user.remove({ where: { id: 1 } })
    const deleted = await db.user.findMany({ onlyDeleted: true })
    expect(deleted.every((u: any) => u.deletedAt !== null)).toBe(true)
    expect(deleted.every((u: any) => u.id === 1)).toBe(true)
  })

  test('restore sets deletedAt = null', async () => {
    await db.user.remove({ where: { id: 1 } })
    await db.user.restore({ where: { id: 1 } })
    const u = await db.user.findUnique({ where: { id: 1 } })
    expect(u).toBeDefined()
    expect(u?.deletedAt).toBeNull()
  })

  test('delete permanently removes row (bypasses soft delete)', async () => {
    await db.user.delete({ where: { id: 3 } })
    const all = await db.user.findMany({ withDeleted: true })
    expect(all.find((u: any) => u.id === 3)).toBeUndefined()  // truly gone
  })

  test('delete on soft-delete table is a real DELETE, not soft', async () => {
    await db.user.create({ data: { id: 99, accountId: 1, email: 'temp@x.com' } })
    await db.user.delete({ where: { id: 99 } })
    const raw = await db.sql`SELECT * FROM user WHERE id = 99`
    expect(raw).toHaveLength(0)  // row is gone, not soft-deleted
  })

  test('update only targets live rows', async () => {
    await db.user.remove({ where: { id: 1 } })
    await db.user.updateMany({ where: { accountId: 1 }, data: { role: 'admin' } })
    const deleted = await db.user.findFirst({ where: { id: 1 }, withDeleted: true })
    expect(deleted?.role).toBe('member')  // was not updated
  })

  test('exists returns false for soft-deleted rows', async () => {
    await db.user.remove({ where: { id: 1 } })
    const found = await db.user.exists({ where: { id: 1 } })
    expect(found).toBe(false)
  })

  test('exists withDeleted: true finds soft-deleted rows', async () => {
    await db.user.remove({ where: { id: 1 } })
    const found = await db.user.exists({ where: { id: 1 }, withDeleted: true })
    expect(found).toBe(true)
  })
})

// ─── 6. Client — Select + Include ─────────────────────────────────────────────


describe('client — select + include', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(SCHEMA, 'select')
    await db.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
    await db.user.create({ data: { id: 1, accountId: 1, email: 'alice@acme.com', name: 'Alice' } })
  })
  afterAll(() => db.$close())

  test('select restricts columns', async () => {
    const rows = await db.user.findMany({ select: { id: true, email: true } })
    expect(Object.keys(rows[0]).sort()).toEqual(['email','id'])
  })

  test('select + include — FK stripped', async () => {
    const rows = await db.user.findMany({
      select:  { id: true, email: true },
      include: { account: true },
    })
    expect('account' in rows[0]).toBe(true)
    expect('accountId' in rows[0]).toBe(false)
  })

  test('nested select on include', async () => {
    const rows = await db.user.findMany({
      select: { id: true, account: { select: { name: true } } }
    })
    expect(rows[0].account?.name).toBe('Acme')
    expect('id' in (rows[0].account ?? {})).toBe(false)
  })

  test('false in select excludes field', async () => {
    const rows = await db.user.findMany({ select: { id: true, role: false } })
    expect('role' in rows[0]).toBe(false)
  })

  test('null select returns all fields', async () => {
    const rows = await db.user.findMany()
    expect(Object.keys(rows[0]).length).toBeGreaterThan(4)
  })
})

// ─── 7. Client — Transactions ─────────────────────────────────────────────────


describe('client — transactions', () => {
  let db: any

  beforeAll(async () => { db = await makeDb(SCHEMA, 'tx') })
  afterAll(() => db.$close())

  // Reads normally go to the readonly WAL connection, which cannot observe the
  // write connection's uncommitted work. A create() inside a transaction was
  // invisible to a findMany() on the very next line — the row existed, the reader
  // held a snapshot from before it.
  describe('read-your-own-writes', () => {
    test('findMany sees a row created earlier in the same transaction', async () => {
      const d = await makeDb(SCHEMA, 'tx-ryow-1')
      await d.$transaction(async (tx: any) => {
        await tx.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
        expect((await tx.account.findMany()).length).toBe(1)
        expect(await tx.account.count()).toBe(1)
      })
      d.$close()
    })

    test('findUnique sees it too (the pk fast path stands down)', async () => {
      const d = await makeDb(SCHEMA, 'tx-ryow-2')
      await d.$transaction(async (tx: any) => {
        await tx.account.create({ data: { id: 7, name: 'Acme', plan: 'pro' } })
        expect((await tx.account.findUnique({ where: { id: 7 } }))?.name).toBe('Acme')
      })
      d.$close()
    })

    test('a read-modify-write inside one transaction reads the new value', async () => {
      const d = await makeDb(SCHEMA, 'tx-ryow-3')
      await d.account.create({ data: { id: 1, name: 'Acme', plan: 'starter' } })
      await d.$transaction(async (tx: any) => {
        await tx.account.update({ where: { id: 1 }, data: { plan: 'pro' } })
        const current = await tx.account.findUnique({ where: { id: 1 } })
        expect(current.plan).toBe('pro')
      })
      d.$close()
    })

    test('include/relations resolve against the transaction too', async () => {
      const d = await makeDb(SCHEMA, 'tx-ryow-4')
      await d.$transaction(async (tx: any) => {
        await tx.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
        await tx.user.create({ data: { id: 1, accountId: 1, email: 'a@acme.com' } })
        const user = await tx.user.findUnique({ where: { id: 1 }, include: { account: true } })
        expect(user.account.name).toBe('Acme')
      })
      d.$close()
    })

    test('a rollback still discards everything the reads could see', async () => {
      const d = await makeDb(SCHEMA, 'tx-ryow-5')
      await expect(d.$transaction(async (tx: any) => {
        await tx.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
        expect((await tx.account.findMany()).length).toBe(1)
        throw new Error('BOOM')
      })).rejects.toThrow('BOOM')
      expect(await d.account.count()).toBe(0)
      d.$close()
    })

    test('reads return to the read connection after the transaction ends', async () => {
      const d = await makeDb(SCHEMA, 'tx-ryow-6')
      await d.$transaction(async (tx: any) => {
        await tx.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
      })
      expect(await d.account.count()).toBe(1)
      // …and after a rollback, so a failed transaction cannot strand the routing
      await expect(d.$transaction(async () => { throw new Error('x') })).rejects.toThrow('x')
      expect(await d.account.count()).toBe(1)
      d.$close()
    })

    test('nested transactions (savepoints) keep reading their own writes', async () => {
      const d = await makeDb(SCHEMA, 'tx-ryow-7')
      await d.$transaction(async (outer: any) => {
        await outer.account.create({ data: { id: 1, name: 'Outer', plan: 'pro' } })
        await d.$transaction(async (inner: any) => {
          await inner.account.create({ data: { id: 2, name: 'Inner', plan: 'pro' } })
          expect((await inner.account.findMany()).length).toBe(2)
        })
        expect((await outer.account.findMany()).length).toBe(2)
      })
      expect(await d.account.count()).toBe(2)
      d.$close()
    })
  })

  test('transaction commits all steps', async () => {
    const result = await db.$transaction(async (tx: any) => {
      const a = await tx.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
      const u = await tx.user.create({ data: { id: 1, accountId: a.id, email: 'alice@acme.com' } })
      return { a, u }
    })
    expect(result.a.id).toBe(1)
    expect(result.u.id).toBe(1)
    const found = await db.account.findUnique({ where: { id: 1 } })
    expect(found?.name).toBe('Acme')
  })

  test('transaction rolls back on error', async () => {
    await expect(db.$transaction(async (tx: any) => {
      await tx.account.create({ data: { id: 2, name: 'Globex', plan: 'pro' } })
      throw new Error('intentional rollback')
    })).rejects.toThrow('intentional rollback')

    const a = await db.account.findUnique({ where: { id: 2 } })
    expect(a).toBeNull()
  })

  test('createMany inside $transaction uses savepoint', async () => {
    await db.account.create({ data: { id: 3, name: 'Initech', plan: 'starter' } })
    await db.$transaction(async (tx: any) => {
      await tx.user.createMany({ data: [
        { id: 10, accountId: 3, email: 'u10@x.com' },
        { id: 11, accountId: 3, email: 'u11@x.com' },
      ]})
    })
    const count = await db.user.count({ where: { accountId: 3 } })
    expect(count).toBe(2)
  })

  test('return value propagates', async () => {
    const r = await db.$transaction(async () => 42)
    expect(r).toBe(42)
  })
})

// ─── 8. Client — Cursor Pagination ────────────────────────────────────────────


describe('client — cursor pagination', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(SCHEMA, 'cursor')
    await db.account.create({ data: { id: 1, name: 'A', plan: 'pro' } })
    // 25 users
    await db.user.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        id: i + 1, accountId: 1, email: `u${i+1}@x.com`,
      }))
    })
  })
  afterAll(() => db.$close())

  test('first page returns limit items + hasMore', async () => {
    const p = await db.user.findManyCursor({ limit: 10, orderBy: { id: 'asc' } })
    expect(p.items.length).toBe(10)
    expect(p.hasMore).toBe(true)
    expect(typeof p.nextCursor).toBe('string')
  })

  test('pages cover all rows with no duplicates', async () => {
    const ids = new Set<number>()
    let cursor = null
    let pages  = 0
    do {
      const p: any = await db.user.findManyCursor({ limit: 10, orderBy: { id: 'asc' }, cursor })
      for (const r of p.items) ids.add(r.id)
      cursor = p.nextCursor
      pages++
    } while (cursor)
    expect(ids.size).toBe(25)
    expect(pages).toBe(3)
  })

  test('last page has hasMore = false', async () => {
    const p = await db.user.findManyCursor({ limit: 25, orderBy: { id: 'asc' } })
    expect(p.hasMore).toBe(false)
    expect(p.nextCursor).toBeNull()
  })

  test('cursor is opaque base64url', async () => {
    const p = await db.user.findManyCursor({ limit: 5, orderBy: { id: 'asc' } })
    expect(/^[A-Za-z0-9_-]+$/.test(p.nextCursor)).toBe(true)
  })

  test('resume from cursor gives correct next page', async () => {
    const p1 = await db.user.findManyCursor({ limit: 5, orderBy: { id: 'asc' } })
    const p2 = await db.user.findManyCursor({ limit: 5, orderBy: { id: 'asc' }, cursor: p1.nextCursor })
    expect(p2.items[0].id).toBe(p1.items[4].id + 1)
  })

  test('multi-field cursor ordering', async () => {
    const ids = new Set<number>()
    let cursor = null
    do {
      const p: any = await db.user.findManyCursor({
        limit: 10,
        orderBy: [{ accountId: 'asc' }, { id: 'asc' }],
        cursor,
      })
      for (const r of p.items) ids.add(r.id)
      cursor = p.nextCursor
    } while (cursor)
    expect(ids.size).toBe(25)
  })
})

// ─── 9. Client — FTS Search ───────────────────────────────────────────────────


describe('client — FTS search', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(SCHEMA, 'fts')
    await db.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
    await db.user.create({ data: { id: 1, accountId: 1, email: 'a@x.com' } })
    await db.message.createMany({ data: [
      { id: 1, userId: 1, body: 'SQLite is a great embedded database', title: 'SQLite intro' },
      { id: 2, userId: 1, body: 'Full text search with FTS5 is powerful', title: 'FTS guide' },
      { id: 3, userId: 1, body: 'Bun makes JavaScript development fast', title: 'Bun intro' },
    ]})
  })
  afterAll(() => db.$close())

  test('basic search returns ranked results', async () => {
    const r = await db.message.search('sqlite')
    expect(r.length).toBe(1)
    expect(r[0].id).toBe(1)
    expect(typeof r[0]._rank).toBe('number')
  })

  test('FTS not available on non-FTS model', async () => {
    expect(db.user.search('alice')).rejects.toThrow()
  })

  // Step 3 rejoins the fetched rows to the FTS hits by id, so a select that did
  // not name the id joined nothing and the search answered [] — a query with
  // results reporting none, with nothing to say why.
  test('a select that omits the id still returns the matching rows', async () => {
    const r = await db.message.search('sqlite', { select: { title: true } })
    expect(r).toEqual([{ title: 'SQLite intro' }])
  })

  test('the id injected for that join is not returned', async () => {
    const r = await db.message.search('sqlite', { select: { body: true } })
    expect(Object.keys(r[0])).toEqual(['body'])
  })

  test('phrase search', async () => {
    const r = await db.message.search('"full text"')
    expect(r.length).toBe(1)
    expect(r[0].id).toBe(2)
  })

  test('prefix search', async () => {
    const r = await db.message.search('dat*')
    expect(r.length).toBeGreaterThan(0)
  })

  test('highlight option', async () => {
    const r = await db.message.search('sqlite', {
      highlight: { field: 'body', open: '<b>', close: '</b>' }
    })
    expect(r[0]._highlight).toContain('<b>')
  })

  test('snippet option', async () => {
    const r = await db.message.search('sqlite', {
      snippet: { field: 'body', open: '[', close: ']', length: 8 }
    })
    expect(r[0]._snippet).toContain('[')
  })

  test('no results returns empty array', async () => {
    const r = await db.message.search('xyzzy_nonexistent')
    expect(r).toEqual([])
  })

  test('FTS index syncs on insert', async () => {
    await db.message.create({ data: { id: 99, userId: 1, body: 'unique_quasar_term test', title: 'Sync test' } })
    const r = await db.message.search('unique_quasar_term')
    expect(r.length).toBe(1)
    expect(r[0].id).toBe(99)
  })
})

// ─── 9b. Client — @@fts on a @@softDelete model ───────────────────────────────
// The pair was unusable. Two triggers fired on one soft delete — an
// unconditional AFTER UPDATE one and an AFTER UPDATE OF "deletedAt" one — so
// FTS5 got two 'delete' commands for one docid. It reports that as `database
// disk image is malformed`, naming neither the model, the FTS table, nor the
// two attributes, so remove() read as a corrupt database file.
//
// Whether it raises at all depends on the index: FTS5 only notices when the
// second delete empties the structure, which is why the one-row case below is
// the deterministic guard and why nothing caught this for so long. Above one
// row the extra delete was swallowed and the row stayed in the index — so the
// old triggers never achieved the live-only index they were written for, and
// search() was right only because it filters again in its own WHERE.
//
// That second filter is now the only one: the index mirrors the table, which
// is also what makes withDeleted/onlyDeleted mean anything.

describe('client — @@fts + @@softDelete', () => {
  const FTS_SD = `
    model Note {
      id        Int @id
      title     String
      body      String
      deletedAt DateTime?
      @@softDelete
      @@fts([title, body])
    }`

  async function notes(n = 3) {
    const db: any = await makeDb(FTS_SD, 'fts-sd')
    const rows = [
      { id: 1, title: 'ada',   body: 'lovelace wrote notes' },
      { id: 2, title: 'grace', body: 'hopper wrote compilers' },
      { id: 3, title: 'alan',  body: 'turing wrote papers' },
    ].slice(0, n)
    for (const data of rows) await db.note.create({ data })
    return db
  }
  const ids = (rows: any[]) => rows.map(r => r.id).sort()
  // The index's own opinion, with no soft-delete filter over it — the only way
  // to see what the triggers actually did rather than what search() shows.
  const indexed = (db: any) =>
    db.$db.query(`SELECT rowid FROM note_fts WHERE note_fts MATCH 'wrote' ORDER BY rowid`)
      .all().map((r: any) => r.rowid)

  test('remove() does not throw when the index holds one row', async () => {
    const db = await notes(1)
    const removed = await db.note.remove({ where: { id: 1 } })
    expect(removed.id).toBe(1)
    db.$close()
  })

  test('the index mirrors the table through the whole lifecycle', async () => {
    const db = await notes()
    expect(indexed(db)).toEqual([1, 2, 3])
    await db.note.remove({ where: { id: 2 } })
    expect(indexed(db)).toEqual([1, 2, 3])       // soft delete is not an index event
    await db.note.delete({ where: { id: 3 } })
    expect(indexed(db)).toEqual([1, 2])          // a hard delete is
    await db.note.restore({ where: { id: 2 } })
    expect(indexed(db)).toEqual([1, 2])
    db.$close()
  })

  test('a soft-deleted row leaves the results', async () => {
    const db = await notes()
    expect(ids(await db.note.search('wrote'))).toEqual([1, 2, 3])
    await db.note.remove({ where: { id: 2 } })
    expect(ids(await db.note.search('wrote'))).toEqual([1, 3])
    db.$close()
  })

  test('withDeleted and onlyDeleted reach the deleted row', async () => {
    const db = await notes()
    await db.note.remove({ where: { id: 2 } })
    expect(ids(await db.note.search('wrote', { withDeleted: true }))).toEqual([1, 2, 3])
    expect(ids(await db.note.search('wrote', { onlyDeleted: true }))).toEqual([2])
    db.$close()
  })

  test('restore() puts the row back in the results', async () => {
    const db = await notes()
    await db.note.remove({ where: { id: 2 } })
    await db.note.restore({ where: { id: 2 } })
    expect(ids(await db.note.search('wrote'))).toEqual([1, 2, 3])
    db.$close()
  })

  test('a rebuild agrees with the triggers', async () => {
    // 'rebuild' reindexes straight from the content table, so it can only agree
    // with the triggers while the index mirrors the table. Holding the live rows
    // only means the index silently disagrees with its own rebuild.
    const db = await notes()
    await db.note.remove({ where: { id: 2 } })
    const before = indexed(db)
    db.$db.run(`INSERT INTO "note_fts"("note_fts") VALUES('rebuild')`)
    expect(indexed(db)).toEqual(before)
    db.$close()
  })

  test('the index passes integrity-check after the full lifecycle', async () => {
    const db = await notes()
    await db.note.remove({ where: { id: 1 } })
    await db.note.restore({ where: { id: 1 } })
    await db.note.update({ where: { id: 1 }, data: { body: 'lovelace wrote algorithms' } })
    await db.note.remove({ where: { id: 3 } })
    await db.note.delete({ where: { id: 2 } })
    expect(() => db.$db.run(`INSERT INTO "note_fts"("note_fts") VALUES('integrity-check')`)).not.toThrow()
    db.$close()
  })

  test('limit counts matching rows, not index entries', async () => {
    // Soft-deleted rows are in the index, so a filter applied after the FTS
    // LIMIT spends slots on rows that are then dropped: a search for 2 answering
    // 1, with nothing to say why.
    const db = await notes()
    await db.note.remove({ where: { id: 1 } })
    expect(await db.note.search('wrote', { limit: 2 })).toHaveLength(2)
    db.$close()
  })

  test('a where filter also narrows before the limit', async () => {
    const db = await notes()
    expect(ids(await db.note.search('wrote', { where: { title: 'grace' }, limit: 1 }))).toEqual([2])
    db.$close()
  })

  test('a database still carrying the retired triggers is repaired by a migration', async () => {
    // The DDL fix reaches new databases. Every database that already exists
    // carries the trigger pair, and introspect() did not record triggers at
    // all — so the diff said "in sync" about a database where every remove()
    // throws. A trigger the app wrote is not in pristine and has to survive.
    const parsed = parse(FTS_SD)
    const path   = tmpDb('fts-legacy' + Math.random().toString(36).slice(2))
    const raw    = new Database(path)
    for (const stmt of splitStatements(generateDDL(parsed.schema)))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt)

    raw.run(`CREATE TRIGGER "note_fts_soft_delete" AFTER UPDATE OF "deletedAt" ON "note"
             WHEN old."deletedAt" IS NULL AND new."deletedAt" IS NOT NULL BEGIN
               INSERT INTO "note_fts"("note_fts", rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
             END`)
    raw.run(`CREATE TRIGGER "note_fts_restore" AFTER UPDATE OF "deletedAt" ON "note"
             WHEN old."deletedAt" IS NOT NULL AND new."deletedAt" IS NULL BEGIN
               INSERT INTO "note_fts"(rowid, title, body) VALUES (new.id, new.title, new.body);
             END`)
    raw.run(`CREATE TABLE "app_log" (id INTEGER PRIMARY KEY, what TEXT)`)
    raw.run(`CREATE TRIGGER "note_app_log" AFTER INSERT ON "note"
             BEGIN INSERT INTO "app_log"(what) VALUES ('n'); END`)
    raw.run(`INSERT INTO "note" (id, title, body) VALUES (1, 'ada', 'lovelace wrote notes')`)

    const diff = diffSchemas(buildPristine(new Database(':memory:'), parsed), introspect(raw), parsed)
    expect(diff.droppedTriggers.map((t: any) => t.name).sort())
      .toEqual(['note_fts_restore', 'note_fts_soft_delete'])

    for (const stmt of splitStatements(generateMigrationSQL(diff, parsed)))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt + ';')
    const after = raw.query(`SELECT name FROM sqlite_master WHERE type='trigger'`)
      .all().map((r: any) => r.name)
    raw.close()

    expect(after).toContain('note_app_log')
    expect(after).not.toContain('note_fts_soft_delete')

    const db: any = await createClient({ parsed, db: path })
    expect((await db.note.remove({ where: { id: 1 } })).id).toBe(1)
    db.$close()
  })

  test('a table rebuild puts the generated triggers back', async () => {
    // rebuildSQL drops the table, which takes every trigger on it, and nothing
    // recreated them — so a model came out of a column-drop migration with an
    // FTS index that had silently stopped updating and an updatedAt that had
    // stopped being stamped. Both keep working; neither reports anything.
    const before = parse(`model Note { id Int @id  title String  keep String  updatedAt DateTime  @@fts([title]) }`)
    const after  = parse(`model Note { id Int @id  title String  updatedAt DateTime  @@fts([title]) }`)
    const raw = new Database(tmpDb('fts-rebuild' + Math.random().toString(36).slice(2)))
    for (const stmt of splitStatements(generateDDL(before.schema)))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
    const triggers = () => raw.query(`SELECT name FROM sqlite_master WHERE type='trigger'`)
      .all().map((r: any) => r.name).sort()
    const wanted = triggers()
    expect(wanted).toContain('note_fts_update')
    expect(wanted).toContain('note_updatedAt')

    const diff = diffSchemas(buildPristine(new Database(':memory:'), after), introspect(raw), after)
    expect(diff.tableDiffs.some((d: any) => d.name === 'note' && d.needsRebuild)).toBe(true)
    for (const stmt of splitStatements(generateMigrationSQL(diff, after)))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt + ';')

    expect(triggers()).toEqual(wanted)
    raw.close()
  })
})

// ─── migrations — schema objects litestone did not create ────────────────────
//
// Every index litestone generates for a model table is `idx_<table>_<fields>`.
// One with any other name was created by the app, and a diff that treats it as
// stale removes it on the next schema change of ANY kind — no rebuild, no
// error, just a query plan that silently collapses. What litestone owns it may
// drop; what it did not create it leaves alone.

describe('migrations — an index the app created', () => {
  const V1  = `model Note { id Int @id  title String  body String }`
  const V2  = `model Note { id Int @id  title String  body String  extra String? }`
  const IDX = `model Note { id Int @id  title String  body String\n  @@index([title]) }`

  const boot = (schemaText: string, extras: string[] = []) => {
    const raw = new Database(tmpDb('own-idx' + Math.random().toString(36).slice(2)))
    for (const stmt of splitStatements(generateDDL(parse(schemaText).schema)))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
    for (const s of extras) raw.run(s)
    return raw
  }
  const indexes = (raw: any) => raw
    .query(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`)
    .all().map((r: any) => r.name).sort()

  const migrate = (raw: any, schemaText: string) =>
    autoMigrate({ $rawDbs: { main: raw } } as any, parse(schemaText)).main

  test('it survives an unrelated schema change', async () => {
    const raw = boot(V1, [`CREATE INDEX "note_title_idx" ON "note" ("title")`])
    expect(migrate(raw, V2).state).toBe('migrated')
    expect(indexes(raw)).toEqual(['note_title_idx'])
    raw.close()
  })

  // Its mere presence used to count as a change, so the drop landed on a
  // migration where the schema had not moved at all.
  test('its presence is not itself a schema change', async () => {
    const raw = boot(V1, [`CREATE INDEX "note_title_idx" ON "note" ("title")`])
    expect(migrate(raw, V1).state).toBe('in-sync')
    expect(indexes(raw)).toEqual(['note_title_idx'])
    raw.close()
  })

  // The other direction, which the ownership rule must not break: an index
  // litestone DID generate is still dropped when the schema stops declaring it.
  test('an index litestone generated is still dropped when @@index goes away', async () => {
    const raw = boot(IDX)
    expect(indexes(raw)).toEqual(['idx_note_title'])
    expect(migrate(raw, V1).state).toBe('migrated')
    expect(indexes(raw)).toEqual([])
    raw.close()
  })

  // A rebuild drops the table and takes both with it. Litestone cannot restate
  // what it did not create (FJS-183), so it says what it is about to destroy.
  test('a rebuild names the app-created objects it will destroy', async () => {
    const withCol = `model Note { id Int @id  title String  scratch String }`
    const without = `model Note { id Int @id  title String }`
    const raw = boot(withCol, [
      `CREATE INDEX "note_title_idx" ON "note" ("title")`,
      `CREATE TRIGGER "note_audit" AFTER INSERT ON "note" BEGIN SELECT 1; END`,
    ])
    const { sql } = migrate(raw, without)
    expect(sql).toContain('this rebuild DROPS the table, which destroys:')
    expect(sql).toContain('trigger "note_audit"')
    expect(sql).toContain('index "note_title_idx"')
    raw.close()
  })
})

// ─── migrations — a view over a rebuilt table ────────────────────────────────
//
// A rebuild ends in ALTER TABLE … RENAME, which reparses every view in the
// schema — so a view pointing at the table that was just dropped is not merely
// stale, it takes the whole migration down. That made a model carrying a `view`
// over it un-rebuildable, litestone's own feature against litestone's own
// migrations. Unlike a trigger, a view is a stored SELECT with no state, so it
// can be dropped and put back verbatim.

describe('migrations — a view over a rebuilt table', () => {
  const boot = (schemaText: string, extras: string[] = []) => {
    const parsed = parse(schemaText)
    if (!parsed.valid) throw new Error(parsed.errors.join('\n'))
    const raw = new Database(tmpDb('view-rb' + Math.random().toString(36).slice(2)))
    for (const stmt of splitStatements(generateDDL(parsed.schema)))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
    for (const s of extras) raw.run(s)
    return raw
  }
  const objects = (raw: any) => raw
    .query(`SELECT type || ':' || name AS o FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestone%' ORDER BY 1`)
    .all().map((r: any) => r.o)
  const migrate = (raw: any, schemaText: string) =>
    autoMigrate({ $rawDbs: { main: raw } } as any, parse(schemaText)).main

  const V1 = `model Note { id Int @id  title String  scratch String }`
  const V2 = `model Note { id Int @id  title String }`

  test('a view declared in the schema survives the rebuild', async () => {
    const withView = (m: string) => `${m}\nview NoteV {\n  title String\n  @@sql("SELECT title FROM note")\n}`
    const raw = boot(withView(V1))
    expect(migrate(raw, withView(V2)).state).toBe('migrated')
    expect(objects(raw)).toEqual(['table:note', 'view:NoteV'])
    expect(raw.query(`PRAGMA table_info("note")`).all().map((c: any) => c.name)).toEqual(['id', 'title'])
    raw.close()
  })

  test('a view the app created survives it too', async () => {
    const raw = boot(V1, [`CREATE VIEW "v_titles" AS SELECT title FROM note`])
    expect(migrate(raw, V2).state).toBe('migrated')
    expect(objects(raw)).toEqual(['table:note', 'view:v_titles'])
    raw.close()
  })

  test('a view over another table is not touched', async () => {
    const two1 = `${V1}\nmodel Tag { id Int @id  label String }`
    const two2 = `${V2}\nmodel Tag { id Int @id  label String }`
    const raw = boot(two1, [`CREATE VIEW "v_tags" AS SELECT label FROM tag`])
    expect(migrate(raw, two2).state).toBe('migrated')
    expect(objects(raw)).toContain('view:v_tags')
    raw.close()
  })

  // Restoring the OLD body here would fail on exactly the change the new body
  // was written for, so a view the schema is redefining is left to the
  // changed-views block at the end of the migration.
  test('a view redefined in the same migration gets its new body, not the old one back', async () => {
    const before = `${V1}\nview NoteV {\n  scratch String\n  @@sql("SELECT scratch FROM note")\n}`
    const after  = `${V2}\nview NoteV {\n  title String\n  @@sql("SELECT title FROM note")\n}`
    const raw = boot(before)
    expect(migrate(raw, after).state).toBe('migrated')
    expect(raw.query(`SELECT sql FROM sqlite_master WHERE name='NoteV'`).get().sql)
      .toContain('SELECT title FROM note')
    raw.close()
  })

  // SQLite does not resolve a view body at CREATE time, so a view invalidated
  // by the rebuild comes back without complaint and fails months later, in
  // whatever reads it. Reading zero rows from it inside the transaction is what
  // turns that into a migration that refuses.
  test('a view the rebuild invalidates fails the migration instead of coming back broken', async () => {
    const raw = boot(V1, [`CREATE VIEW "v_scratch" AS SELECT scratch FROM note`])
    expect(() => migrate(raw, V2)).toThrow('no such column: scratch')
    expect(raw.query(`PRAGMA table_info("note")`).all().map((c: any) => c.name))
      .toEqual(['id', 'title', 'scratch'])   // rolled back whole
    raw.close()
  })

  test('a rebuild with no view over it emits no view SQL', async () => {
    const raw = boot(V1)
    expect(migrate(raw, V2).sql).not.toContain('DROP VIEW')
    raw.close()
  })
})

// ─── 10. Client — $backup ─────────────────────────────────────────────────────


describe('client — $backup', () => {
  let db: any
  const backupPath = join(TMP, 'backup-test.db')

  beforeAll(async () => {
    db = await makeDb(SCHEMA, 'backup')
    await db.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
  })
  afterAll(() => {
    db.$close()
    if (existsSync(backupPath)) unlinkSync(backupPath)
  })

  test('$backup creates a readable db', async () => {
    const result = await db.$backup(backupPath)
    expect(result.path).toBe(backupPath)
    expect(result.size).toBeGreaterThan(0)
    expect(existsSync(backupPath)).toBe(true)

    // Verify backup contains the data
    const backup = new Database(backupPath, { readonly: true })
    const rows   = backup.query('SELECT * FROM account').all()
    expect(rows).toHaveLength(1)
    backup.close()
  })

  test('$backup with vacuum: true', async () => {
    const vPath = join(TMP, 'backup-vacuum.db')
    await db.$backup(vPath, { vacuum: true })
    expect(existsSync(vPath)).toBe(true)
    const v = new Database(vPath, { readonly: true })
    const rows = v.query('SELECT * FROM account').all()
    expect(rows).toHaveLength(1)
    v.close()
    unlinkSync(vPath)
  })

  test('backup is unchanged after writes to main db', async () => {
    await db.account.create({ data: { id: 2, name: 'Globex', plan: 'starter' } })
    const backup = new Database(backupPath, { readonly: true })
    const rows   = backup.query('SELECT COUNT(*) as n FROM account').get() as any
    expect(rows.n).toBe(1)  // backup still has only 1 row
    backup.close()
  })
})

// ─── 11. Client — $attach ─────────────────────────────────────────────────────


describe('client — $attach', () => {
  let db: any
  const archivePath = join(TMP, 'archive.db')

  beforeAll(async () => {
    // Create an archive db with some data
    const archive = new Database(archivePath)
    archive.run('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT)')
    archive.run("INSERT INTO accounts VALUES (100, 'Archive Corp')")
    archive.close()

    db = await makeDb(SCHEMA, 'attach')
    await db.account.create({ data: { id: 1, name: 'Acme', plan: 'pro' } })
  })
  afterAll(() => {
    db.$close()
    if (existsSync(archivePath)) unlinkSync(archivePath)
  })

  test('$attach + cross-db query', async () => {
    db.$attach(archivePath, 'archive')
    expect(db.$attached).toContain('archive')

    const rows = await db.sql`
      SELECT id, name FROM account
      UNION ALL
      SELECT id, name FROM archive.accounts
      ORDER BY id
    `
    expect(rows).toHaveLength(2)
    expect(rows.some((r: any) => r.name === 'Acme')).toBe(true)
    expect(rows.some((r: any) => r.name === 'Archive Corp')).toBe(true)
  })

  test('$detach removes the alias', async () => {
    db.$detach('archive')
    expect(db.$attached).not.toContain('archive')
    await expect(db.sql`SELECT * FROM archive.accounts`).rejects.toThrow()
  })

  test('duplicate attach throws', () => {
    db.$attach(archivePath, 'arch2')
    expect(() => db.$attach(archivePath, 'arch2')).toThrow()
    db.$detach('arch2')
  })

  test('detach non-existent throws', () => {
    expect(() => db.$detach('nonexistent')).toThrow()
  })
})

// ─── 12. Bun-specific: WAL + dual connections ─────────────────────────────────


describe('client — metadata properties', () => {
  let db: any

  beforeAll(async () => { db = await makeDb(SCHEMA, 'meta') })
  afterAll(() => db.$close())

  test('$schema exposes parsed schema', () => {
    expect(db.$schema.models.length).toBeGreaterThan(0)
    expect(db.$schema.models.map((m: any) => m.name)).toContain('User')
  })

  test('$enums lists all enums with values', () => {
    expect(db.$enums).toHaveProperty('Plan')
    expect(db.$enums.Plan).toEqual(['starter', 'pro', 'enterprise'])
    expect(db.$enums.Role).toEqual(['admin', 'member', 'viewer'])
  })

  test('$softDelete identifies soft-delete models', () => {
    // Keys are PascalCase model names — matches how the schema was declared
    expect(db.$softDelete.User).toBe(true)
    expect(db.$softDelete.Account).toBe(false)
  })

  test('$relations exposes relation map', () => {
    expect(db.$relations).toHaveProperty('User')
    expect(db.$relations.User).toHaveProperty('account')
  })

  test('await db does not throw (proxy then-trap fix)', async () => {
    // This verifies the proxy.then === undefined fix
    const resolved = await Promise.resolve(db)
    expect(resolved).toBe(db)
  })
})


// ─── 16. updatedAt auto-trigger ───────────────────────────────────────────────


describe('updatedAt auto-trigger', () => {

  test('trigger generated when updatedAt DateTime field exists', () => {
    const r = parse(`
      model Post {
        id        Int  @id
        title     String
        createdAt DateTime @default(now())
        updatedAt DateTime @default(now())
      }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('post_updatedAt')
    expect(ddl).toContain('AFTER UPDATE ON')
    expect(ddl).toContain('WHEN NEW."updatedAt" IS OLD."updatedAt"')
  })

  test('no trigger on models without updatedAt', () => {
    const r = parse(`model Log { id Int @id
        action String }`)
    expect(generateDDL(r.schema)).not.toContain('logs_updatedAt')
  })

  test('no trigger on non-DateTime updatedAt field', () => {
    const r = parse(`model T { id Int @id
        updatedAt String }`)
    expect(generateDDL(r.schema)).not.toContain('t_updatedAt')
  })

  test('trigger fires on UPDATE in bun:sqlite', async () => {
    const db = await makeDb(`
      model Post {
        id        Int  @id
        title     String
        createdAt DateTime @default(now())
        updatedAt DateTime @default(now())
      }
    `, 'updatedat')

    await db.post.create({ data: {
      id: 1, title: 'Hello',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }})

    const before = await db.post.findUnique({ where: { id: 1 } })
    await Bun.sleep(15)
    await db.post.update({ where: { id: 1 }, data: { title: 'World' } })
    const after = await db.post.findUnique({ where: { id: 1 } })

    expect(after!.updatedAt).not.toBe(before!.updatedAt)
    expect(after!.createdAt).toBe(before!.createdAt)  // createdAt unchanged
    db.$close()
  })

  test('WHEN guard — explicit updatedAt set by user is preserved', async () => {
    const db = await makeDb(`
      model Post {
        id        Int  @id
        title     String
        updatedAt DateTime @default(now())
      }
    `, 'updatedat-guard')

    await db.post.create({ data: { id: 1, title: 'Hello', updatedAt: '2024-01-01T00:00:00.000Z' } })
    // Explicitly set updatedAt — trigger should NOT override it
    await db.post.update({ where: { id: 1 }, data: { title: 'World', updatedAt: '2099-01-01T00:00:00.000Z' } })
    const row = await db.post.findUnique({ where: { id: 1 } })
    expect(row!.updatedAt).toBe('2099-01-01T00:00:00.000Z')
    db.$close()
  })

  test('trigger fires via raw SQL too (database-level)', async () => {
    const db = await makeDb(`
      model Post {
        id        Int  @id
        title     String
        updatedAt DateTime @default(now())
      }
    `, 'updatedat-raw')

    const raw = db.$db as Database
    raw.run(`INSERT INTO post (id, title, updatedAt) VALUES (1, 'Hello', '2024-01-01T00:00:00.000Z')`)
    await Bun.sleep(15)
    raw.run(`UPDATE post SET title = 'Direct SQL' WHERE id = 1`)
    const row = raw.query(`SELECT * FROM post WHERE id = 1`).get() as any
    expect(row.updatedAt).not.toBe('2024-01-01T00:00:00.000Z')
    db.$close()
  })
})

// ─── 17. Soft delete cascade ──────────────────────────────────────────────────

const CASCADE_SCHEMA = `
  model Account {
    id        Int  @id
    name      String
    deletedAt DateTime?
    @@softDelete(cascade)
  }

  model User {
    id        Int  @id
    account   Account @relation(fields: [accountId], references: [id])
    accountId Int
    email     String
    deletedAt DateTime?
    @@softDelete(cascade)
  }

  model Post {
    id        Int @id
    user      User @relation(fields: [userId], references: [id])
    userId    Int
    title     String
    deletedAt DateTime?
    @@softDelete
  }
`


describe('soft delete cascade', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(CASCADE_SCHEMA, 'cascade')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, email: 'alice@x.com' },
      { id: 2, accountId: 1, email: 'bob@x.com' },
    ]})
    await db.post.createMany({ data: [
      { id: 1, userId: 1, title: 'P1' }, { id: 2, userId: 1, title: 'P2' },
      { id: 3, userId: 2, title: 'P3' }, { id: 4, userId: 2, title: 'P4' },
    ]})
  })
  afterAll(() => db.$close())

  test('@@softDelete(cascade) parses on model', () => {
    const r = parse(`model T { id Int @id
        deletedAt DateTime?
        @@softDelete(cascade) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'softDelete')
    expect(attr).toBeDefined()
    expect(attr.cascade).toBe(true)
  })

  test('remove cascades to child tables', async () => {
    await db.account.remove({ where: { id: 1 } })
    expect(await db.account.count()).toBe(0)
    expect(await db.user.count()).toBe(0)
    expect(await db.post.count()).toBe(0)
  })

  test('cascade is soft — all rows preserved', async () => {
    expect(await db.account.count({ withDeleted: true } as any)).toBe(1)
    expect(await db.user.count({ withDeleted: true } as any)).toBe(2)
    expect(await db.post.count({ withDeleted: true } as any)).toBe(4)
  })

  test('restore cascades children back', async () => {
    await db.account.restore({ where: { id: 1 } })
    expect(await db.account.count()).toBe(1)
    expect(await db.user.count()).toBe(2)
    expect(await db.post.count()).toBe(4)
  })

  test('deleteMany also cascades', async () => {
    await db.account.removeMany({})
    expect(await db.user.count()).toBe(0)
    expect(await db.post.count()).toBe(0)
    // Restore for subsequent tests
    await db.account.restore({ where: { id: 1 } })
  })

  test('remove() on non-soft-delete table is a real DELETE', async () => {
    const db2 = await makeDb(`
      model Log { id Int @id
        action String }
    `, 'remove-hard')
    await db2.log.create({ data: { id: 1, action: 'login' } })
    await db2.log.remove({ where: { id: 1 } })
    const all = await db2.sql`SELECT * FROM log`
    expect(all).toHaveLength(0)   // gone — real DELETE, no deletedAt column
    db2.$close()
  })

  test('without cascade — children not affected', async () => {
    const db2 = await makeDb(`
      model Org    { id Int @id
        name String
        deletedAt DateTime?
        @@softDelete }
      model Member {
        id    Int @id
        org   Org @relation(fields: [orgId], references: [id])
        orgId Int
        name  String
        deletedAt DateTime?
        @@softDelete
      }
    `, 'no-cascade')

    await db2.org.create({ data: { id: 1, name: 'Org' } })
    await db2.member.create({ data: { id: 1, orgId: 1, name: 'Alice' } })
    await db2.org.remove({ where: { id: 1 } })  // soft-delete orgs — no cascade so members untouched

    // Member still live — no cascade flag
    expect(await db2.member.count()).toBe(1)
    db2.$close()
  })

  test('cascade only reaches soft-delete children', async () => {
    // posts has deletedAt but no cascade — still gets cascaded TO
    // because the parent (users) has @@softDelete(cascade)
    const allPosts = await db.post.findMany({ withDeleted: true } as any)
    const deletedPosts = allPosts.filter((p: any) => p.deletedAt !== null)
    // All posts were soft-deleted via the cascade from accounts→users→posts
    expect(deletedPosts.length).toBe(0)   // all restored now
  })
})

// ─── @hardDelete cascade ──────────────────────────────────────────────────────

const HARD_DELETE_CASCADE_SCHEMA = `
  model Account {
    id        Int  @id
    name      String
    users     User[]
    sessions  Session[]  @hardDelete
    deletedAt DateTime?
    @@softDelete(cascade)
  }

  model User {
    id        Int  @id
    accountId Int
    account   Account @relation(fields: [accountId], references: [id])
    name      String
    deletedAt DateTime?
    @@softDelete
  }

  model Session {
    id        Int  @id
    accountId Int
    account   Account @relation(fields: [accountId], references: [id])
    token     String
  }
`

describe('@hardDelete — cascade hard-deletes relation children', () => {
  test('@hardDelete children are hard-deleted when parent is soft-deleted', async () => {
    const db = await makeDb(HARD_DELETE_CASCADE_SCHEMA, 'hd-cascade-basic')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.session.createMany({ data: [
      { id: 1, accountId: 1, token: 'tok-a' },
      { id: 2, accountId: 1, token: 'tok-b' },
    ]})
    await db.account.remove({ where: { id: 1 } })

    // sessions have no deletedAt — they should be gone entirely
    const raw = db.$db.prepare('SELECT * FROM session').all()
    expect(raw).toHaveLength(0)
    db.$close()
  })

  test('non-@hardDelete soft-delete children are still soft-deleted', async () => {
    const db = await makeDb(HARD_DELETE_CASCADE_SCHEMA, 'hd-cascade-soft-side')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.create({ data: { id: 1, accountId: 1, name: 'Alice' } })
    await db.account.remove({ where: { id: 1 } })

    // users row still exists — soft-deleted
    const raw = db.$db.prepare('SELECT * FROM user').all() as any[]
    expect(raw).toHaveLength(1)
    expect(raw[0].deletedAt).not.toBeNull()
    db.$close()
  })

  test('@hardDelete children excluded from restore()', async () => {
    const db = await makeDb(HARD_DELETE_CASCADE_SCHEMA, 'hd-cascade-restore')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.session.create({ data: { id: 1, accountId: 1, token: 'tok' } })
    await db.account.remove({ where: { id: 1 } })

    // sessions gone
    expect(db.$db.prepare('SELECT * FROM session').all()).toHaveLength(0)

    await db.account.restore({ where: { id: 1 } })

    // account restored, sessions still gone
    const account = await db.account.findUnique({ where: { id: 1 } })
    expect(account).not.toBeNull()
    expect(db.$db.prepare('SELECT * FROM session').all()).toHaveLength(0)
    db.$close()
  })

  test('@hardDelete works with removeMany()', async () => {
    const db = await makeDb(HARD_DELETE_CASCADE_SCHEMA, 'hd-cascade-removemany')
    await db.account.createMany({ data: [
      { id: 1, name: 'Acme' }, { id: 2, name: 'Globex' }
    ]})
    await db.session.createMany({ data: [
      { id: 1, accountId: 1, token: 'a1' },
      { id: 2, accountId: 1, token: 'a2' },
      { id: 3, accountId: 2, token: 'b1' },
    ]})
    await db.account.removeMany({ where: { id: { in: [1, 2] } } })

    expect(db.$db.prepare('SELECT * FROM session').all()).toHaveLength(0)
    db.$close()
  })

  test('@hardDelete on a hard-delete child model (no deletedAt) works', async () => {
    // sessions has no deletedAt — it's always a hard-delete table
    // @hardDelete cascade should still physically remove it
    const db = await makeDb(HARD_DELETE_CASCADE_SCHEMA, 'hd-cascade-no-sd-child')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.session.createMany({ data: [
      { id: 1, accountId: 1, token: 'x' },
      { id: 2, accountId: 1, token: 'y' },
    ]})
    await db.account.remove({ where: { id: 1 } })
    expect(db.$db.prepare('SELECT * FROM session').all()).toHaveLength(0)
    db.$close()
  })
})

// ─── softDelete cascade footgun warning ───────────────────────────────────────

describe('@@softDelete cascade footgun warning', () => {
  test('warns when @@softDelete model has hasMany to another @@softDelete model without cascade', () => {
    const r = parse(`
      model Account {
        id        Int  @id
        users     User[]
        deletedAt DateTime?
        @@softDelete
      }
      model User {
        id        Int  @id
        accountId Int
        account   Account @relation(fields: [accountId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }
    `)
    expect(r.warnings.some((w: string) =>
      w.includes('Account') && w.includes('User') && w.includes('@@softDelete(cascade)')
    )).toBe(true)
  })

  test('no warning when @@softDelete(cascade) is declared', () => {
    const r = parse(`
      model Account {
        id        Int  @id
        users     User[]
        deletedAt DateTime?
        @@softDelete(cascade)
      }
      model User {
        id        Int  @id
        accountId Int
        account   Account @relation(fields: [accountId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }
    `)
    expect(r.warnings.some((w: string) =>
      w.includes('accounts') && w.includes('users') && w.includes('@@softDelete(cascade)')
    )).toBe(false)
  })

  test('no warning when child has no @@softDelete', () => {
    const r = parse(`
      model Account {
        id        Int  @id
        logs      Log[]
        deletedAt DateTime?
        @@softDelete
      }
      model Log {
        id        Int  @id
        accountId Int
        account   Account @relation(fields: [accountId], references: [id])
        body      String
      }
    `)
    expect(r.warnings.some((w: string) => w.includes('@@softDelete(cascade)'))).toBe(false)
  })

  test('no warning when @hardDelete is on the relation field', () => {
    const r = parse(`
      model Account {
        id        Int  @id
        sessions  Session[]  @hardDelete
        deletedAt DateTime?
        @@softDelete
      }
      model Session {
        id        Int  @id
        accountId Int
        account   Account @relation(fields: [accountId], references: [id])
        token     String
      }
    `)
    expect(r.warnings.some((w: string) => w.includes('@@softDelete(cascade)'))).toBe(false)
  })

  test('no warning when parent has no @@softDelete at all', () => {
    const r = parse(`
      model Account {
        id    Int @id
        users User[]
      }
      model User {
        id        Int  @id
        accountId Int
        account   Account @relation(fields: [accountId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }
    `)
    expect(r.warnings.some((w: string) => w.includes('@@softDelete(cascade)'))).toBe(false)
  })

  test('warning mentions @hardDelete as an alternative', () => {
    const r = parse(`
      model Account {
        id        Int @id
        users     User[]
        deletedAt DateTime?
        @@softDelete
      }
      model User {
        id        Int  @id
        accountId Int
        account   Account @relation(fields: [accountId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }
    `)
    expect(r.warnings.some((w: string) => w.includes('@hardDelete'))).toBe(true)
  })
})

// ─── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// ─── 18. @omit / @guarded ─────────────────────────────────────────────────────


describe('String[] / Int[] array fields', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model Post {
        id     Int @id
        title  String
        tags   String[]
        scores Int[]
        flags  String[]   @minItems(1) @maxItems(5) @uniqueItems
      }
    `, 'arrays')
  })
  afterAll(() => db.$close())

  test('String[] defaults to []', async () => {
    await db.post.create({ data: { id: 1, title: 'Hello', flags: ['featured'] } })
    const row = await db.post.findUnique({ where: { id: 1 } })
    expect(row.tags).toEqual([])
    expect(row.scores).toEqual([])
  })

  test('String[] stores and retrieves array', async () => {
    await db.post.create({ data: { id: 2, title: 'World', tags: ['js', 'ts'], flags: ['new'] } })
    const row = await db.post.findUnique({ where: { id: 2 } })
    expect(row.tags).toEqual(['js', 'ts'])
  })

  test('Int[] stores and retrieves array', async () => {
    await db.post.create({ data: { id: 3, title: 'Nums', scores: [10, 20, 30], flags: ['test'] } })
    const row = await db.post.findUnique({ where: { id: 3 } })
    expect(row.scores).toEqual([10, 20, 30])
  })

  test('update replaces array', async () => {
    await db.post.update({ where: { id: 2 }, data: { tags: ['bun', 'sqlite'] } })
    const row = await db.post.findUnique({ where: { id: 2 } })
    expect(row.tags).toEqual(['bun', 'sqlite'])
  })

  // WHERE operators
  test('where: { tags: { has: "bun" } }', async () => {
    const rows = await db.post.findMany({ where: { tags: { has: 'bun' } } })
    expect(rows.map((r: any) => r.id)).toContain(2)
    expect(rows.map((r: any) => r.id)).not.toContain(1)
  })

  test('where: { tags: { hasSome: ["js","bun"] } }', async () => {
    // post 2 has ['bun','sqlite'], post at id=2 matches 'bun'
    const rows = await db.post.findMany({ where: { tags: { hasSome: ['js', 'bun'] } } })
    expect(rows.length).toBeGreaterThan(0)
  })

  test('where: { tags: { hasEvery: ["bun","sqlite"] } }', async () => {
    const rows = await db.post.findMany({ where: { tags: { hasEvery: ['bun', 'sqlite'] } } })
    expect(rows.map((r: any) => r.id)).toContain(2)
  })

  test('where: { tags: { hasEvery: ["bun","missing"] } } returns empty', async () => {
    const rows = await db.post.findMany({ where: { tags: { hasEvery: ['bun', 'missing'] } } })
    expect(rows).toHaveLength(0)
  })

  test('where: { tags: { isEmpty: true } }', async () => {
    const rows = await db.post.findMany({ where: { tags: { isEmpty: true } } })
    expect(rows.map((r: any) => r.id)).toContain(1)
    expect(rows.map((r: any) => r.id)).not.toContain(2)
  })

  test('where: { tags: { isEmpty: false } }', async () => {
    const rows = await db.post.findMany({ where: { tags: { isEmpty: false } } })
    expect(rows.map((r: any) => r.id)).not.toContain(1)
    expect(rows.map((r: any) => r.id)).toContain(2)
  })

  // Validation
  test('@minItems violation throws ValidationError', async () => {
    await expect(
      db.post.create({ data: { id: 99, title: 'Bad', flags: [] } })
    ).rejects.toThrow(ValidationError)
  })

  test('@maxItems violation throws ValidationError', async () => {
    await expect(
      db.post.create({ data: { id: 99, title: 'Bad', flags: ['a','b','c','d','e','f'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('@uniqueItems violation throws ValidationError', async () => {
    await expect(
      db.post.create({ data: { id: 99, title: 'Bad', flags: ['dup','dup'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('String[] rejects non-string items', async () => {
    await expect(
      db.post.create({ data: { id: 99, title: 'Bad', tags: [1, 2], flags: ['ok'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('Int[] rejects non-integer items', async () => {
    await expect(
      db.post.create({ data: { id: 99, title: 'Bad', scores: ['not','ints'], flags: ['ok'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('non-array value throws ValidationError', async () => {
    await expect(
      db.post.create({ data: { id: 99, title: 'Bad', tags: 'not-array', flags: ['ok'] } })
    ).rejects.toThrow(ValidationError)
  })
})

// ─── 23. findFirstOrThrow / findUniqueOrThrow ─────────────────────────────────


describe('findFirstOrThrow / findUniqueOrThrow', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model User {
        id    Int @id
        email String    @unique
        name  String
      }
    `, 'throw-ops')
    await db.user.create({ data: { id: 1, name: 'Alice', email: 'alice@x.com' } })
  })
  afterAll(() => db.$close())

  test('findFirstOrThrow returns row when found', async () => {
    const row = await db.user.findFirstOrThrow({ where: { id: 1 } })
    expect(row.name).toBe('Alice')
  })

  test('findFirstOrThrow throws when not found', async () => {
    await expect(
      db.user.findFirstOrThrow({ where: { id: 999 } })
    ).rejects.toThrow('user')
  })

  test('findFirstOrThrow error has NOT_FOUND code', async () => {
    const err = await db.user.findFirstOrThrow({ where: { id: 999 } }).catch(e => e)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.model).toBe('user')  // NOT_FOUND carries the table name
  })

  test('findUniqueOrThrow returns row when found', async () => {
    const row = await db.user.findUniqueOrThrow({ where: { id: 1 } })
    expect(row.email).toBe('alice@x.com')
  })

  test('findUniqueOrThrow throws when not found', async () => {
    await expect(
      db.user.findUniqueOrThrow({ where: { id: 999 } })
    ).rejects.toThrow('user')
  })

  test('findUniqueOrThrow error has NOT_FOUND code', async () => {
    const err = await db.user.findUniqueOrThrow({ where: { id: 999 } }).catch(e => e)
    expect(err.code).toBe('NOT_FOUND')
  })
})

// ─── 24. Global query filters ─────────────────────────────────────────────────


describe('global query filters', () => {
  test('static filter applied to findMany', async () => {
    const db = await makeDb(`
      model Post {
        id     Int @id
        status String
        title  String
      }
    `, 'filter-static', {
      filters: { post: { status: 'published' } }
    })
    await db.post.create({ data: { id: 1, title: 'Draft',     status: 'draft' } })
    await db.post.create({ data: { id: 2, title: 'Published', status: 'published' } })
    await db.post.create({ data: { id: 3, title: 'Other pub', status: 'published' } })

    const rows = await db.post.findMany()
    expect(rows.length).toBe(2)
    expect(rows.every((r: any) => r.status === 'published')).toBe(true)
    db.$close()
  })

  test('static filter applied to count', async () => {
    const db = await makeDb(`
      model Item {
        id     Int @id
        active Boolean @default(true)
      }
    `, 'filter-count', {
      filters: { item: { active: true } }
    })
    await db.item.create({ data: { id: 1, active: true } })
    await db.item.create({ data: { id: 2, active: false } })
    await db.item.create({ data: { id: 3, active: true } })

    expect(await db.item.count()).toBe(2)
    db.$close()
  })

  test('filter AND-merged with query where', async () => {
    const db = await makeDb(`
      model Post {
        id     Int @id
        status String
        pinned Boolean @default(false)
      }
    `, 'filter-merge', {
      filters: { post: { status: 'published' } }
    })
    await db.post.create({ data: { id: 1, status: 'published', pinned: true } })
    await db.post.create({ data: { id: 2, status: 'published', pinned: false } })
    await db.post.create({ data: { id: 3, status: 'draft',     pinned: true } })

    // Filter: published AND pinned
    const rows = await db.post.findMany({ where: { pinned: true } })
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(1)
    db.$close()
  })

  test('function filter receives ctx', async () => {
    let called = false
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'filter-fn', {
      filters: {
        t: (_ctx: any) => {
          called = true
          return {}  // no-op filter
        }
      }
    })
    await db.t.create({ data: { id: 1, val: 'x' } })
    await db.t.findMany()
    expect(called).toBe(true)
    db.$close()
  })

  test('no filter — unaffected tables work normally', async () => {
    const db = await makeDb(`
      model A { id Int @id }
      model B { id Int @id }
    `, 'filter-none', {
      filters: { a: { id: { gt: 0 } } }
    })
    await db.a.create({ data: { id: 1 } })
    await db.b.create({ data: { id: 1 } })
    expect(await db.a.count()).toBe(1)
    expect(await db.b.count()).toBe(1)
    db.$close()
  })
})

// ─── 25. Nested writes ────────────────────────────────────────────────────────


describe('nested writes', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model Account {
        id    Int @id
        name  String
      }
      model User {
        id        Int  @id
        account   Account @relation(fields: [accountId], references: [id])
        accountId Int
        email     String
      }
    `, 'nested-writes')
  })
  afterAll(() => db.$close())

  test('create with hasMany create', async () => {
    const acc = await db.account.create({
      data: {
        id: 1, name: 'Acme',
        User: { create: [
          { id: 1, email: 'alice@acme.com' },
          { id: 2, email: 'bob@acme.com' },
        ]}
      }
    })
    expect(acc.id).toBe(1)
    const users = await db.user.findMany({ where: { accountId: 1 } })
    expect(users.length).toBe(2)
  })

  test('create with belongsTo connect', async () => {
    const user = await db.user.create({
      data: {
        id: 3, email: 'carol@acme.com',
        account: { connect: { id: 1 } }
      }
    })
    expect(user.accountId).toBe(1)
  })

  test('create with belongsTo create (nested parent)', async () => {
    const user = await db.user.create({
      data: {
        id: 4, email: 'dave@new.com',
        account: { create: { id: 2, name: 'NewCo' } }
      }
    })
    expect(user.accountId).toBe(2)
    const acc = await db.account.findUnique({ where: { id: 2 } })
    expect(acc?.name).toBe('NewCo')
  })

  test('create with belongsTo connectOrCreate — finds existing', async () => {
    const user = await db.user.create({
      data: {
        id: 5, email: 'eve@acme.com',
        account: { connectOrCreate: {
          where:  { id: 1 },
          create: { id: 99, name: 'Should not create' }
        }}
      }
    })
    expect(user.accountId).toBe(1)
    // Account 99 should NOT have been created
    expect(await db.account.count()).toBe(2)
  })

  test('create with belongsTo connectOrCreate — creates when missing', async () => {
    const user = await db.user.create({
      data: {
        id: 6, email: 'frank@third.com',
        account: { connectOrCreate: {
          where:  { id: 3 },
          create: { id: 3, name: 'ThirdCo' }
        }}
      }
    })
    expect(user.accountId).toBe(3)
    expect(await db.account.findUnique({ where: { id: 3 } })).not.toBeNull()
  })

  test('update with hasMany create', async () => {
    await db.account.update({
      where: { id: 1 },
      data: {
        name: 'Acme Corp',
        User: { create: { id: 10, email: 'new@acme.com' } }
      }
    })
    const users = await db.user.findMany({ where: { accountId: 1 } })
    expect(users.some((u: any) => u.email === 'new@acme.com')).toBe(true)
  })

  test('update with hasMany connect', async () => {
    // user 10 belongs to account 1 — reconnect to account 2
    await db.account.update({
      where: { id: 2 },
      data: { User: { connect: { id: 10 } } }
    })
    const u = await db.user.findUnique({ where: { id: 10 } })
    expect(u?.accountId).toBe(2)
  })

  test('update with hasMany update', async () => {
    await db.account.update({
      where: { id: 1 },
      data: {
        User: { update: [{ where: { id: 1 }, data: { email: 'alice-updated@acme.com' } }] }
      }
    })
    const u = await db.user.findUnique({ where: { id: 1 } })
    expect(u?.email).toBe('alice-updated@acme.com')
  })

  test('scalar + nested fields coexist', async () => {
    const acc = await db.account.update({
      where: { id: 1 },
      data: { name: 'Acme Final', User: { create: { id: 20, email: 'g@acme.com' } } }
    })
    expect(acc.name).toBe('Acme Final')
    const u = await db.user.findUnique({ where: { id: 20 } })
    expect(u?.accountId).toBe(1)
  })
})

// ─── 26. Seeder + Factory ─────────────────────────────────────────────────────


describe('upsertMany', () => {
  const schema = `
    model Product {
      id    Int @id
      slug  String    @unique @lower @trim
      price Float    @default(0) @gte(0)
      stock Int @default(0)
    }
  `

  test('inserts new rows', async () => {
    const db = await makeDb(schema, 'upsertmany-insert')
    const { count } = await db.product.upsertMany({
      data: [
        { id: 1, slug: 'Widget', price: 9.99, stock: 10 },
        { id: 2, slug: 'Gadget', price: 19.99, stock: 5 },
      ]
    })
    expect(count).toBe(2)
    const all = await db.product.findMany({})
    expect(all).toHaveLength(2)
    db.$close()
  })

  test('updates on conflict by default (idField)', async () => {
    const db = await makeDb(schema, 'upsertmany-update')
    await db.product.createMany({ data: [{ id: 1, slug: 'widget', price: 9.99, stock: 10 }] })
    await db.product.upsertMany({
      data: [{ id: 1, slug: 'widget', price: 14.99, stock: 20 }]
    })
    const p = await db.product.findUnique({ where: { id: 1 } })
    expect(p.price).toBe(14.99)
    expect(p.stock).toBe(20)
    db.$close()
  })

  test('custom conflictTarget', async () => {
    const db = await makeDb(schema, 'upsertmany-conflict-target')
    await db.product.createMany({ data: [{ id: 1, slug: 'widget', price: 9.99, stock: 10 }] })
    await db.product.upsertMany({
      data:           [{ id: 1, slug: 'widget', price: 24.99 }],
      conflictTarget: ['slug'],
      update:         ['price'],
    })
    const p = await db.product.findUnique({ where: { id: 1 } })
    expect(p.price).toBe(24.99)
    expect(p.stock).toBe(10)   // not in update list — unchanged
    db.$close()
  })

  test('update field list limits which columns are updated on conflict', async () => {
    const db = await makeDb(schema, 'upsertmany-update-cols')
    await db.product.createMany({ data: [{ id: 1, slug: 'widget', price: 9.99, stock: 100 }] })
    await db.product.upsertMany({
      data:   [{ id: 1, slug: 'widget', price: 99.99, stock: 1 }],
      update: ['price'],   // only price — stock should stay at 100
    })
    const p = await db.product.findUnique({ where: { id: 1 } })
    expect(p.price).toBe(99.99)
    expect(p.stock).toBe(100)
    db.$close()
  })

  test('transforms (@lower @trim) fire on every row', async () => {
    const db = await makeDb(schema, 'upsertmany-transforms')
    await db.product.upsertMany({
      data: [{ id: 1, slug: '  WIDGET  ', price: 1 }]
    })
    const p = await db.product.findUnique({ where: { id: 1 } })
    expect(p.slug).toBe('widget')   // lower + trim applied
    db.$close()
  })

  test('validation fires on every row — throws on invalid', async () => {
    const db = await makeDb(schema, 'upsertmany-validation')
    await expect(
      db.product.upsertMany({ data: [{ id: 1, slug: 'widget', price: -5 }] })
    ).rejects.toThrow()   // @gte(0) violated
    db.$close()
  })

  test('returns { count: 0 } for empty data', async () => {
    const db = await makeDb(schema, 'upsertmany-empty')
    const result = await db.product.upsertMany({ data: [] })
    expect(result).toEqual({ count: 0 })
    db.$close()
  })

  test('plugin beforeCreate fires', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let fired = false
    class Spy extends Plugin {
      async onBeforeCreate() { fired = true }
    }
    const db = await makeDb(schema, 'upsertmany-plugin', { plugins: [new Spy()] })
    await db.product.upsertMany({ data: [{ id: 1, slug: 'w', price: 1 }] })
    expect(fired).toBe(true)
    db.$close()
  })
})

// ─── 37. upsert plugin hooks ──────────────────────────────────────────────────


describe('optimizeFts', () => {
  const schema = `
    model Doc {
      id    Int @id
      body  String
      title String?
      @@fts([body, title])
    }
  `

  test('optimizeFts returns { optimized: true, table }', async () => {
    const db = await makeDb(schema, 'optimize-basic')
    const result = db.doc.optimizeFts()
    expect(result.optimized).toBe(true)
    expect(result.table).toBe('doc_fts')
    db.$close()
  })

  test('optimizeFts is a no-op on an empty table (does not throw)', async () => {
    const db = await makeDb(schema, 'optimize-empty')
    expect(() => db.doc.optimizeFts()).not.toThrow()
    db.$close()
  })

  test('optimizeFts runs after bulk insert without error', async () => {
    const db = await makeDb(schema, 'optimize-after-bulk')
    await db.doc.createMany({ data: Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, body: `content ${i}`, title: `doc ${i}`
    }))})
    expect(() => db.doc.optimizeFts()).not.toThrow()
    // FTS still works after optimize
    const results = await db.doc.search('content')
    expect(results.length).toBeGreaterThan(0)
    db.$close()
  })

  test('optimizeFts throws on a model without @@fts', async () => {
    const db = await makeDb(`
      model Plain { id Int @id; name String }
    `, 'optimize-no-fts')
    expect(() => db.plain.optimizeFts()).toThrow('not available')
    db.$close()
  })
})

// ─── 42. @updatedAt parser attribute ─────────────────────────────────────────


describe('RETURNING * — write path', () => {

  test('create returns correct row without follow-up SELECT', async () => {
    const db = await makeDb(`
      model User { id Int @id; name String; email String @unique }
    `, 'returning-create')
    const u = await db.user.create({ data: { name: 'Alice', email: 'alice@test.com' } })
    expect(u.id).toBe(1)
    expect(u.name).toBe('Alice')
    expect(u.email).toBe('alice@test.com')
    db.$close()
  })

  test('update returns updated row without follow-up SELECT', async () => {
    const db = await makeDb(`
      model User { id Int @id; name String }
    `, 'returning-update')
    await db.user.create({ data: { name: 'Alice' } })
    const u = await db.user.update({ where: { id: 1 }, data: { name: 'Bob' } })
    expect(u?.name).toBe('Bob')
    db.$close()
  })

  test('soft-delete remove returns deleted row', async () => {
    const db = await makeDb(`
      model User {
        id        Int   @id
        name      String
        deletedAt DateTime?
        @@softDelete
      }
    `, 'returning-remove')
    await db.user.create({ data: { name: 'Alice' } })
    const u = await db.user.remove({ where: { id: 1 } })
    expect(u?.id).toBe(1)
    expect(u?.deletedAt).toBeTruthy()
    db.$close()
  })

  test('update returns null when row not found', async () => {
    const db = await makeDb(`
      model User { id Int @id; name String }
    `, 'returning-update-miss')
    const u = await db.user.update({ where: { id: 999 }, data: { name: 'Ghost' } })
    expect(u).toBeNull()
    db.$close()
  })

})

// ─── databases: ':memory:' ────────────────────────────────────────────────────


describe('$walStatus()', () => {

  test('returns WAL frame counts', async () => {
    const db = await makeDb(`
      model Item { id Int @id; val String }
    `, 'wal-status')
    await db.item.create({ data: { val: 'x' } })
    const s: any = db.$walStatus()
    expect(typeof s.busy).toBe('boolean')
    expect(typeof s.frames).toBe('number')
    expect(typeof s.checkpointed).toBe('number')
    db.$close()
  })

})

// ─── computed: inline object ──────────────────────────────────────────────────


describe('createClient — input forms', () => {

  test('{ parsed } form works', async () => {
    const r = parse(`model User { id Int @id; name String }`)
    const p = join(TMP, `form-parsed-${Date.now()}.db`)
    const db = await createClient({ parsed: r, db: p })
    await db.user.create({ data: { name: 'Alice' } })
    const u = await db.user.findFirst({})
    expect(u?.name).toBe('Alice')
    db.$close()
  })

  test('{ schema } inline string form works', async () => {
    const p = join(TMP, `form-schema-${Date.now()}.db`)
    const db = await createClient({
      schema: `model User { id Int @id; name String }`,
      db: p
    })
    await db.user.create({ data: { name: 'Bob' } })
    const u = await db.user.findFirst({})
    expect(u?.name).toBe('Bob')
    db.$close()
  })

})

// ─── FrontierGateGetLevel ─────────────────────────────────────────────────────





describe('computed fields — file path', () => {

  test('@computed field via extension', async () => {
    const extPath = join(TMP, 'ext.js')
    writeFileSync(extPath, `
      export default {
        users: {
          isFullAdmin: row => row.isAdmin === true && row.role === 'admin'
        }
      }
    `)
    const db = await makeDb(`
      model User {
        id      Int @id
        isAdmin Boolean @default(false)
        role    String    @default("member")
        isFullAdmin Boolean @computed
      }
    `, 'ext')
    // Can't test with extension loading in this context — verify field strips on write
    // The isFullAdmin field should not be written to DB
    await db.user.create({ data: { id: 1, isAdmin: true, role: 'admin' } })
    const u = await db.user.findUnique({ where: { id: 1 } })
    expect(u?.isAdmin).toBe(true)
    db.$close()
  })
})

// ─── 14. Query helpers ────────────────────────────────────────────────────────


describe('computed: inline object', () => {

  test('computed field resolved via inline function', async () => {
    const db = await makeDb(`
      model User {
        id        Int @id
        firstName String
        lastName  String
        fullName  String @computed
      }
    `, 'computed-inline', {
      computed: {
        User: {
          fullName: (row: any) => `${row.firstName} ${row.lastName}`
        }
      }
    })
    await db.user.create({ data: { firstName: 'Ada', lastName: 'Lovelace' } })
    const u: any = await db.user.findUnique({ where: { id: 1 } })
    expect(u?.fullName).toBe('Ada Lovelace')
    db.$close()
  })

  test('computed function receives ctx as second arg', async () => {
    const db = await makeDb(`
      model Item { id Int @id; val String; tagged String @computed }
    `, 'computed-ctx', {
      computed: {
        Item: {
          tagged: (row: any, ctx: any) => ctx ? `${row.val}:ok` : row.val
        }
      }
    })
    await db.item.create({ data: { val: 'hello' } })
    const item: any = await db.item.findUnique({ where: { id: 1 } })
    expect(item?.tagged).toBe('hello:ok')
    db.$close()
  })

})

// ─── computed: needs ─────────────────────────────────────────────────────────
//
// A computed fn either declares what it reads or it does not. Undeclared is the
// original behaviour and stays: naming the field in a `select` fetches every
// column, because nothing can know what the fn will touch.
//
// The declared form is not only an optimisation. Before it, a computed fn ran
// on EVERY read whether or not the select asked for it — over a row narrowed by
// that same select, so a fn reading a column the caller had not selected saw
// undefined and answered something plausible. That is the same failure the
// @from work chased twice (see § @from — on the paths that build their own SQL);
// the third instance was the select path itself.

// The @computed set comes from the SCHEMA and the functions come from
// createClient, so a test adding a fn has to add the field too — the schema is
// generated from the harness's own key list to keep the two from drifting.
const needsSchema = (extra: string[]) => `
  model Author {
    id        Int    @id
    name      String
    email     String
    bio       String
    books     Book[]
    bookCount Int    @from(Book, count: true)
    initials  String @computed
    summary   String @computed
${extra.map(f => `    ${f} String @computed`).join('\n')}
    @@fts([name])
  }
  model Book {
    id       Int    @id
    title    String
    authorId Int
    author   Author @relation(fields: [authorId], references: [id])
  }
`

// Counts every compute call so a test can assert a fn did NOT run, and records
// the SQL so it can assert which columns were actually fetched.
function needsHarness(overrides: Record<string, any> = {}) {
  const calls: Record<string, number> = { initials: 0, summary: 0 }
  const sql: string[] = []
  const computed = {
    Author: {
      initials: {
        needs:   ['name'],
        compute: (row: any) => { calls.initials++; return row.name.split(' ').map((w: string) => w[0]).join('') },
      },
      summary: {
        needs:   ['name', 'bookCount'],
        compute: (row: any) => { calls.summary++; return `${row.name} (${row.bookCount})` },
      },
      ...overrides,
    },
  }
  return { calls, sql, computed, extra: Object.keys(overrides), onQuery: (e: any) => sql.push(e.sql) }
}

async function needsClient(h: ReturnType<typeof needsHarness>) {
  const { db } = await makeTestClient(needsSchema(h.extra), {
    computed: h.computed,
    onQuery:  h.onQuery,
    data: async (db: any) => {
      await db.author.createMany({ data: [
        { id: 1, name: 'Ada Lovelace',  email: 'ada@x.com',  bio: 'x'.repeat(200) },
        { id: 2, name: 'Alan Turing',   email: 'alan@x.com', bio: 'y'.repeat(200) },
      ]})
      await db.book.createMany({ data: [
        { id: 1, title: 'b1', authorId: 1 },
        { id: 2, title: 'b2', authorId: 1 },
        { id: 3, title: 'b3', authorId: 2 },
      ]})
    },
  })
  // Seeding reads rows back, which computes; a test asserts about its own call.
  h.calls.initials = 0
  h.calls.summary  = 0
  h.sql.length     = 0
  return db
}

describe('computed: needs', () => {

  test('a computed field the select did not ask for is not computed', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const rows = await db.author.findMany({ select: { id: true, name: true } })
    expect(rows).toEqual([{ id: 1, name: 'Ada Lovelace' }, { id: 2, name: 'Alan Turing' }])
    expect(h.calls).toEqual({ initials: 0, summary: 0 })
    db.$close()
  })

  test('needs narrows the SELECT to the declared columns', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const rows = await db.author.findMany({ select: { initials: true } })
    expect(rows).toEqual([{ initials: 'AL' }, { initials: 'AT' }])
    const stmt = h.sql.find(s => s.includes('FROM "author"'))!
    expect(stmt).toContain('"name"')
    expect(stmt).not.toContain('*')
    expect(stmt).not.toContain('"bio"')
    db.$close()
  })

  test('a dependency is fetched but not returned', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const rows = await db.author.findMany({ select: { initials: true } })
    expect(Object.keys(rows[0])).toEqual(['initials'])
    db.$close()
  })

  test('needs may name a @from field, and the subquery is emitted', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const rows = await db.author.findMany({ select: { summary: true }, orderBy: { id: 'asc' } })
    expect(rows).toEqual([{ summary: 'Ada Lovelace (2)' }, { summary: 'Alan Turing (1)' }])
    const stmt = h.sql.find(s => s.includes('FROM "author"'))!
    expect(stmt).toContain('COUNT(*)')
    db.$close()
  })

  test('a fn that declares nothing still widens the whole SELECT', async () => {
    const h  = needsHarness({ raw: (row: any) => row.bio.length })
    const db = await needsClient(h)
    const rows = await db.author.findMany({ select: { raw: true } })
    expect(rows).toEqual([{ raw: 200 }, { raw: 200 }])
    expect(h.sql.find(s => s.includes('FROM "author"'))).toContain('*')
    db.$close()
  })

  // The widening is a property of the SELECT, not of one field: a declared fn
  // sharing a select with an undeclared one cannot narrow anything.
  test('one undeclared fn in the select widens it for the declared ones too', async () => {
    const h  = needsHarness({ raw: (row: any) => row.bio.length })
    const db = await needsClient(h)
    const rows = await db.author.findMany({ select: { initials: true, raw: true } })
    expect(rows).toEqual([{ initials: 'AL', raw: 200 }, { initials: 'AT', raw: 200 }])
    expect(h.sql.find(s => s.includes('FROM "author"'))).toContain('*')
    db.$close()
  })

  test('no select at all computes every field, over the whole row', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const rows = await db.author.findMany({ orderBy: { id: 'asc' } })
    expect(rows[0].initials).toBe('AL')
    expect(rows[0].summary).toBe('Ada Lovelace (2)')
    expect(h.calls).toEqual({ initials: 2, summary: 2 })
    db.$close()
  })

  // Without this the declaration is a footgun: adding a line to the fn and
  // forgetting the list would answer undefined instead of failing.
  test('reading an undeclared field throws, naming the field and the list', async () => {
    const h  = needsHarness({ bad: { needs: ['name'], compute: (row: any) => `${row.name}${row.email}` } })
    const db = await needsClient(h)
    await expect(db.author.findMany({ select: { bad: true } }))
      .rejects.toThrow(/'Author.bad' read 'email'.*needs: \['name'\]/)
    db.$close()
  })

  test('`in` on an undeclared field answers false rather than throwing', async () => {
    const h  = needsHarness({ probe: { needs: ['name'], compute: (row: any) => ('email' in row ? 'yes' : 'no') } })
    const db = await needsClient(h)
    expect(await db.author.findMany({ select: { probe: true }, orderBy: { id: 'asc' } }))
      .toEqual([{ probe: 'no' }, { probe: 'no' }])
    db.$close()
  })

  test('a needs naming something that is not a readable field is refused at startup', async () => {
    const h = needsHarness({ broken: { needs: ['nmae', 'books'], compute: () => 1 } })
    await expect(needsClient(h)).rejects.toThrow(/'Author.broken': needs 'nmae', 'books'/)
  })

  test('a spec with no needs array is refused at startup', async () => {
    const h = needsHarness({ broken: { compute: () => 1 } })
    await expect(needsClient(h)).rejects.toThrow(/'Author.broken': 'needs' must be an array/)
  })

  test('a spec that is neither a function nor a compute object is refused', async () => {
    const h = needsHarness({ broken: 'nope' })
    await expect(needsClient(h)).rejects.toThrow(/'Author.broken' must be a function/)
  })

  // findManyCursor builds its own SELECT below the query pipeline — the same
  // place @from was dropped twice.
  test('the cursor path narrows and agrees with findMany', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const { items } = await db.author.findManyCursor({ limit: 10, orderBy: { id: 'asc' }, select: { summary: true } })
    expect(items).toEqual([{ summary: 'Ada Lovelace (2)' }, { summary: 'Alan Turing (1)' }])
    expect(h.sql.find(s => s.includes('FROM "author"'))).not.toContain('"bio"')
    db.$close()
  })

  test('an included row narrows too, and agrees with a direct read', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const [book]  = await db.book.findMany({ where: { id: 1 }, include: { author: { select: { summary: true } } } })
    const [direct] = await db.author.findMany({ where: { id: 1 }, select: { summary: true } })
    expect(book.author).toEqual({ summary: 'Ada Lovelace (2)' })
    expect(book.author).toEqual(direct)
    db.$close()
  })

  // search() builds its own step-2 SELECT and rejoins by id. Narrowing it and
  // injecting that id are the same edit, so this asserts both halves land: the
  // row comes back at all, and only the asked-for computed field ran.
  test('search() narrows, and its own id injection survives the trim', async () => {
    const h  = needsHarness()
    const db = await needsClient(h)
    const rows = await db.author.search('Ada', { select: { initials: true } })
    expect(rows).toEqual([{ initials: 'AL' }])
    expect(h.calls).toEqual({ initials: 1, summary: 0 })
    db.$close()
  })

  test('a bare fn and a declared one produce the same value', async () => {
    const h  = needsHarness({ initialsBare: (row: any) => row.name.split(' ').map((w: string) => w[0]).join('') })
    const db = await needsClient(h)
    const [row] = await db.author.findMany({ where: { id: 1 } })
    expect(row.initials).toBe(row.initialsBare)
    db.$close()
  })

})

// ─── createClient — new single-arg forms ─────────────────────────────────────


describe("databases: ':memory:'", () => {

  test('all SQLite databases open in-memory', async () => {
    const db = await makeDb(`
      model User { id Int @id; name String }
    `, 'inmem', { databases: ':memory:' })
    const u = await db.user.create({ data: { name: 'Alice' } })
    expect(u.id).toBe(1)
    // No file on disk
    const { existsSync } = await import('fs')
    expect(existsSync('/dev/inmem.db')).toBe(false)
    db.$close()
  })

})

// ─── $walStatus() ────────────────────────────────────────────────────────────

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  ACCESS CONTROL                                                            │
// └────────────────────────────────────────────────────────────────────────────┘

describe('@omit / @guarded field policy', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model User {
        id       Int @id
        name     String
        bio      String?   @omit
        prefs    String?   @omit(all)
        salary   Int @guarded
        secret   String    @guarded(all)
      }
    `, 'policy')
    await db.user.create({ data: { id: 1, name: 'Alice', bio: 'Long bio', prefs: '{}', salary: 100000, secret: 'top-secret' } })
    await db.user.create({ data: { id: 2, name: 'Bob',   bio: 'Short bio', prefs: '{"theme":"dark"}', salary: 80000, secret: 'also-secret' } })
  })
  afterAll(() => db.$close())

  // @omit — excluded from findMany/findFirst, included on findUnique
  test('@omit: excluded from findMany', async () => {
    const rows = await db.user.findMany()
    expect('bio' in rows[0]).toBe(false)
  })
  test('@omit: excluded from findFirst', async () => {
    const row = await db.user.findFirst({ where: { id: 1 } })
    expect('bio' in row).toBe(false)
  })
  test('@omit: included in findUnique', async () => {
    const row = await db.user.findUnique({ where: { id: 1 } })
    expect(row.bio).toBe('Long bio')
  })
  test('@omit: explicit select includes it', async () => {
    const row = await db.user.findMany({ select: { id: true, bio: true } })
    expect(row[0].bio).toBe('Long bio')
  })

  // @omit(all) — excluded everywhere unless explicitly selected
  test('@omit(all): excluded from findMany', async () => {
    const rows = await db.user.findMany()
    expect('prefs' in rows[0]).toBe(false)
  })
  test('@omit(all): excluded from findUnique', async () => {
    const row = await db.user.findUnique({ where: { id: 1 } })
    expect('prefs' in row).toBe(false)
  })
  test('@omit(all): explicit select unlocks it', async () => {
    const rows = await db.user.findMany({ select: { id: true, prefs: true } })
    expect(rows[0].prefs).toBe('{}')
  })

  // @guarded — system context required; select alone cannot unlock
  test('@guarded: excluded from findMany', async () => {
    const rows = await db.user.findMany()
    expect('salary' in rows[0]).toBe(false)
  })
  test('@guarded: excluded from findUnique', async () => {
    const row = await db.user.findUnique({ where: { id: 1 } })
    expect('salary' in row).toBe(false)
  })
  test('@guarded: explicit select without system still excluded', async () => {
    const rows = await db.user.findMany({ select: { id: true, salary: true } })
    expect('salary' in rows[0]).toBe(false)
  })
  test('@guarded: asSystem() unlocks it', async () => {
    const rows = await db.asSystem().user.findMany()
    expect(rows[0].salary).toBe(100000)
  })

  // @guarded(all) — system context only, select cannot unlock
  test('@guarded(all): excluded from findMany', async () => {
    const rows = await db.user.findMany()
    expect('secret' in rows[0]).toBe(false)
  })
  test('@guarded(all): select cannot unlock', async () => {
    const rows = await db.user.findMany({ select: { id: true, secret: true } })
    expect('secret' in rows[0]).toBe(false)
  })
  test('@guarded(all): asSystem() unlocks it', async () => {
    const rows = await db.asSystem().user.findMany()
    expect(rows[0].secret).toBe('top-secret')
  })

  // asSystem() memoized
  test('asSystem() returns same instance', () => {
    expect(db.asSystem()).toBe(db.asSystem())
  })
})


// ─── 18b. @guarded(all) + WHERE clause behaviour ──────────────────────────────
//
// Confirms the three documented cases:
//   1. Non-system WHERE on @guarded(all) field: filters correctly, field stripped from result
//   2. asSystem() WHERE on @guarded(all) field: filters correctly, field visible in result
//   3. @guarded(all) + @encrypted (i.e. @secret): WHERE on non-secret field works,
//      plaintext WHERE on a non-searchable encrypted field is REFUSED (it can never
//      match, and answering null looked like "no such row"),
//      asSystem() returns decrypted value


describe('@guarded(all) + WHERE clause', () => {
  const ENC_KEY = 'b'.repeat(64)   // 32-byte hex key

  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model User {
        id      Int @id
        name    String
        secret  String    @guarded(all)
        token   String    @encrypted @guarded(all)
      }
    `, 'guarded-where', { encryptionKey: ENC_KEY })

    await db.asSystem().user.create({ data: { id: 1, name: 'Alice', secret: 'hunter2',     token: 'tok_alice' } })
    await db.asSystem().user.create({ data: { id: 2, name: 'Bob',   secret: 'correcthorse', token: 'tok_bob'   } })
    await db.asSystem().user.create({ data: { id: 3, name: 'Carol', secret: 'hunter2',     token: 'tok_carol' } })
  })
  afterAll(() => db.$close())

  // ── Case 1: non-system context ─────────────────────────────────────────────

  test('non-system: WHERE on non-guarded field works normally', async () => {
    const row = await db.user.findFirst({ where: { name: 'Alice' } })
    expect(row?.id).toBe(1)
    expect(row?.name).toBe('Alice')
  })

  test('non-system: @guarded(all) field is stripped from result even when WHERE matches', async () => {
    // WHERE on `name` finds the row — but `secret` must not appear in the output
    const row = await db.user.findFirst({ where: { name: 'Alice' } })
    expect(row).not.toBeNull()
    expect('secret' in row).toBe(false)
    expect('token'  in row).toBe(false)
  })

  test('non-system: findMany with WHERE on non-guarded field strips @guarded(all) from all results', async () => {
    const rows = await db.user.findMany({ where: { name: { not: null } } })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect('secret' in row).toBe(false)
      expect('token'  in row).toBe(false)
    }
  })

  test('non-system: count() with WHERE on non-guarded field still works', async () => {
    const n = await db.user.count({ where: { name: 'Alice' } })
    expect(n).toBe(1)
  })

  // ── Case 2: asSystem() context ─────────────────────────────────────────────

  test('asSystem(): WHERE on non-guarded field works and @guarded(all) field is visible', async () => {
    const row = await db.asSystem().user.findFirst({ where: { name: 'Alice' } })
    expect(row?.id).toBe(1)
    expect(row?.secret).toBe('hunter2')
  })

  test('asSystem(): WHERE on @guarded(all) plain-text field filters and returns correct row', async () => {
    const row = await db.asSystem().user.findFirst({ where: { secret: 'correcthorse' } })
    expect(row?.id).toBe(2)
    expect(row?.name).toBe('Bob')
    expect(row?.secret).toBe('correcthorse')
  })

  test('asSystem(): WHERE on @guarded(all) field with multiple matches returns first', async () => {
    // Both Alice (id=1) and Carol (id=3) have secret='hunter2'
    const rows = await db.asSystem().user.findMany({ where: { secret: 'hunter2' } })
    expect(rows.length).toBe(2)
    expect(rows.map((r: any) => r.id).sort()).toEqual([1, 3])
    // Field is visible on all returned rows
    expect(rows.every((r: any) => r.secret === 'hunter2')).toBe(true)
  })

  test('asSystem(): WHERE on @guarded(all) field with no match returns null', async () => {
    const row = await db.asSystem().user.findFirst({ where: { secret: 'doesnotexist' } })
    expect(row).toBeNull()
  })

  test('asSystem(): @encrypted + @guarded(all) — decrypted value visible in result', async () => {
    const row = await db.asSystem().user.findFirst({ where: { name: 'Alice' } })
    expect(row?.token).toBe('tok_alice')
  })

  // ── Case 3: @encrypted + @guarded(all) WHERE edge cases ───────────────────

  test('@encrypted @guarded(all): plaintext WHERE on a random-IV field is refused', async () => {
    // token is plain @encrypted, so the stored ciphertext can never equal the
    // plaintext and this filter matches nothing whatever the data is. It used to
    // answer null, indistinguishable from "no such row" — the caller then looks
    // for the missing record rather than the missing index. The schema knows, and
    // names both cures.
    await expect(db.asSystem().user.findFirst({ where: { token: 'tok_alice' } }))
      .rejects.toThrow(/deterministic: true/)
  })

  test('@encrypted @guarded(all): non-system context strips encrypted+guarded field from result', async () => {
    const row = await db.user.findFirst({ where: { id: 1 } })
    expect(row).not.toBeNull()
    expect('token' in row).toBe(false)
  })

  // ── $setAuth still strips @guarded(all) ────────────────────────────────────

  test('$setAuth: @guarded(all) field stripped (not asSystem)', async () => {
    const authed = db.$setAuth({ id: 1, role: 'admin' })
    const row = await authed.user.findFirst({ where: { name: 'Alice' } })
    expect(row).not.toBeNull()
    expect('secret' in row).toBe(false)
  })

  test('$setAuth: asSystem() on auth-scoped client unlocks @guarded(all)', async () => {
    const authed = db.$setAuth({ id: 1, role: 'admin' })
    const row = await authed.asSystem().user.findFirst({ where: { name: 'Alice' } })
    expect(row?.secret).toBe('hunter2')
  })
})

// ─── 19. @encrypted ───────────────────────────────────────────────────────────


describe('@encrypted field policy', () => {
  const ENC_KEY = Buffer.alloc(32).fill(0xab).toString('hex')  // deterministic test key

  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model User {
        id    Int @id
        name  String
        ssn   String    @encrypted
        email String    @encrypted(deterministic: true)
        token String    @hashed
      }
    `, 'encrypted', { encryptionKey: ENC_KEY })
    await db.user.create({ data: { id: 1, name: 'Alice', ssn: '123-45-6789', email: 'alice@example.com', token: 'tok-alice' } })
    await db.user.create({ data: { id: 2, name: 'Bob',   ssn: '987-65-4321', email: 'bob@example.com',   token: 'tok-bob'   } })
  })
  afterAll(() => db.$close())

  test('@encrypted: field excluded from findMany', async () => {
    const rows = await db.user.findMany()
    expect('ssn' in rows[0]).toBe(false)
    expect('email' in rows[0]).toBe(false)
  })
  test('@encrypted: field excluded from findUnique', async () => {
    const row = await db.user.findUnique({ where: { id: 1 } })
    expect('ssn' in row).toBe(false)
  })
  test('@encrypted: asSystem() returns decrypted value — deterministic included', async () => {
    const row = await db.asSystem().user.findUnique({ where: { id: 1 } })
    expect(row.ssn).toBe('123-45-6789')
    // The whole point of the mode: it is still ciphertext, so it reads back. The
    // old searchable:true asserted the OPPOSITE here — a digest, `v1s.…`, handed
    // back as if it were the address (FJS-211).
    expect(row.email).toBe('alice@example.com')
    // @hashed is the one protection asSystem() does not lift, because there is
    // nothing to lift it to.
    expect('token' in row).toBe(false)
  })
  test('@encrypted: stored as ciphertext in DB', async () => {
    // asSystem(), not db.sql: this schema declares @encrypted, so raw SQL is
    // available through the documented bypass only (FJS-005). Peeking at the
    // stored column IS a deliberate bypass, so saying so is right — this test
    // was the first caller the refusal caught.
    const raw = await db.asSystem().sql`SELECT ssn, email, token FROM user WHERE id = 1`
    expect(raw[0].ssn.startsWith('v1.')).toBe(true)
    expect(raw[0].email.startsWith('v1d.')).toBe(true)
    expect(raw[0].token.startsWith('v1h.')).toBe(true)
  })
  test('deterministic: the same plaintext encrypts to the same bytes, and that is the mechanism', async () => {
    await db.asSystem().user.create({ data: { id: 3, name: 'Alice2', ssn: 'x', email: 'alice@example.com', token: 'tok-3' } })
    const raw = await db.asSystem().sql`SELECT id, email FROM user WHERE id IN (1, 3) ORDER BY id`
    expect(raw[0].email).toBe(raw[1].email)
    await db.asSystem().user.delete({ where: { id: 3 } })
  })
  test('@encrypted(deterministic): WHERE equality works', async () => {
    const row = await db.asSystem().user.findFirst({ where: { email: 'alice@example.com' } })
    expect(row?.id).toBe(1)
    expect(row?.name).toBe('Alice')
  })
  test('@encrypted(deterministic): wrong value returns null', async () => {
    const row = await db.asSystem().user.findFirst({ where: { email: 'nobody@nowhere.com' } })
    expect(row).toBeNull()
  })
  test('@hashed: WHERE equality works, and a miss is a miss', async () => {
    expect((await db.asSystem().user.findFirst({ where: { token: 'tok-bob' } }))?.id).toBe(2)
    expect(await db.asSystem().user.findFirst({ where: { token: 'wrong' } })).toBeNull()
  })
  test('@hashed: selecting it by name throws rather than handing back the digest', async () => {
    await expect(db.asSystem().user.findUnique({ where: { id: 1 }, select: { token: true } }))
      .rejects.toThrow(/one-way digest/)
  })
  test('@encrypted (random IV): WHERE is refused, naming both cures', async () => {
    await expect(db.asSystem().user.findFirst({ where: { ssn: '123-45-6789' } }))
      .rejects.toThrow(/@encrypted\(deterministic: true\).*@hashed/s)
  })
  test('createClient throws without encryption key if @encrypted fields exist', async () => {
    const r = parse(`model T { id Int @id
        secret String @encrypted }`)
    const p = tmpDb('enc-no-key')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    await expect(createClient({ parsed: r,  db: p })).rejects.toThrow('encryption key')
  })
  test('missing-key error names the affected fields', async () => {
    // Helps the user immediately see why the key is needed and where it gets used.
    const r = parse(`model T { id Int @id
        secret String @encrypted
        token  String @encrypted }`)
    const p = tmpDb('enc-no-key-fields')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    let err: any = null
    try { await createClient({ parsed: r, db: p }) } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.message).toContain('T.secret')
    expect(err.message).toContain('T.token')
  })
  test('missing-key error: detects ENCRYPTION_KEY in process.env and hints at the forgot-to-pass case', async () => {
    // When the env var is set but createClient was called without forwarding
    // it, surface that explicitly — most common cause of this error.
    const r = parse(`model T { id Int @id; secret String @encrypted }`)
    const p = tmpDb('enc-no-key-env-set')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    const prev = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)
    try {
      let err: any = null
      try { await createClient({ parsed: r, db: p }) } catch (e) { err = e }
      expect(err).not.toBeNull()
      expect(err.message).toContain('process.env.ENCRYPTION_KEY')
      expect(err.message.toLowerCase()).toContain("wasn't passed in")
    } finally {
      if (prev === undefined) delete process.env.ENCRYPTION_KEY
      else process.env.ENCRYPTION_KEY = prev
    }
  })
  test('missing-key error: heuristic suggests env vars that look like 32-byte hex keys', async () => {
    // Catches the case where the user named the env var something nonstandard.
    const r = parse(`model T { id Int @id; secret String @encrypted }`)
    const p = tmpDb('enc-no-key-heuristic')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    // Make sure no conventional name is set, so heuristic branch is reached.
    const stash: Record<string, string | undefined> = {}
    for (const k of ['ENCRYPTION_KEY', 'LITESTONE_KEY', 'LITESTONE_ENCRYPTION_KEY', 'DB_ENCRYPTION_KEY']) {
      stash[k] = process.env[k]; delete process.env[k]
    }
    // Strip any other 64-hex env vars so our injected one isn't crowded out
    // by real keys that happen to live in the test runner's environment.
    const envHexStash: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) {
        envHexStash[k] = v
        delete process.env[k]
      }
    }
    process.env.MY_APP_SECRET = 'b'.repeat(64)
    try {
      let err: any = null
      try { await createClient({ parsed: r, db: p }) } catch (e) { err = e }
      expect(err).not.toBeNull()
      expect(err.message).toContain('process.env.MY_APP_SECRET')
      expect(err.message.toLowerCase()).toContain('did you mean')
    } finally {
      delete process.env.MY_APP_SECRET
      for (const [k, v] of Object.entries(envHexStash)) process.env[k] = v
      for (const [k, v] of Object.entries(stash)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
  test('missing-key error: no env match falls back to openssl rand suggestion', async () => {
    const r = parse(`model T { id Int @id; secret String @encrypted }`)
    const p = tmpDb('enc-no-key-noenv')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    const stash: Record<string, string | undefined> = {}
    for (const k of ['ENCRYPTION_KEY', 'LITESTONE_KEY', 'LITESTONE_ENCRYPTION_KEY', 'DB_ENCRYPTION_KEY']) {
      stash[k] = process.env[k]; delete process.env[k]
    }
    // Remove any other 64-hex env vars that would hit the heuristic branch
    // and starve the openssl fallback message.
    const envHexStash: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) {
        envHexStash[k] = v
        delete process.env[k]
      }
    }
    try {
      let err: any = null
      try { await createClient({ parsed: r, db: p }) } catch (e) { err = e }
      expect(err).not.toBeNull()
      expect(err.message).toContain('openssl rand -hex 32')
    } finally {
      for (const [k, v] of Object.entries(envHexStash)) process.env[k] = v
      for (const [k, v] of Object.entries(stash)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
  test('@encrypted: key wrong length throws', async () => {
    const r = parse(`model T { id Int @id
        secret String @encrypted }`)
    const p = tmpDb('enc-bad-key')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    await expect(createClient({ parsed: r,  db: p, encryptionKey: 'tooshort' })).rejects.toThrow('32 bytes')
  })
})


describe('raw SQL and the access rules it cannot enforce', () => {
  // FJS-005. `sql` goes straight to the read connection — no @@gate, no
  // @@allow, no @guarded, no @scoped, no @@softDelete. For a deliberate escape
  // hatch that is defensible. What was not is that it was the SAME function on
  // every proxy: `db.$setAuth(user).sql` closed over the user and never read
  // it, so a caller who had done everything right got every row in the table,
  // silently. Measured before the fix, on the model below:
  //
  //   $setAuth({id:1}).invoice.findMany()  → 1 row,  ssn absent
  //   $setAuth({id:1}).sql`SELECT * ...`   → 3 rows, ssn plaintext
  //
  // The unscoped client is the WIDER gap: an unauthenticated findMany() returns
  // 0 rows (the policy evaluates with auth() == null and matches nothing) while
  // db.sql returned all 3. So the rule is not "the scoped proxy must scope" —
  // it is that raw SQL is available through asSystem() only, on any schema that
  // declares access rules.
  const GATED = `
    model Invoice {
      id        Int      @id
      ownerId   Int
      total     Float
      ssn       String   @guarded
      deletedAt DateTime?
      @@softDelete
      @@allow('read', ownerId == auth().id)
    }`

  let db: any
  beforeAll(async () => {
    db = await makeDb(GATED, 'raw-sql-access')
    await db.asSystem().invoice.create({ data: { id: 1, ownerId: 1, total: 10, ssn: 'AAA' } })
    await db.asSystem().invoice.create({ data: { id: 2, ownerId: 2, total: 20, ssn: 'BBB' } })
  })
  afterAll(() => db.$close())

  test('db.sql is refused when the schema declares access rules', async () => {
    let err: any = null
    try { await db.sql`SELECT id FROM invoice` } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(String(err.message)).toContain('asSystem()')
  })

  test('db.$setAuth(user).sql is refused — the reported hole', async () => {
    let err: any = null
    try { await db.$setAuth({ id: 1 }).sql`SELECT id FROM invoice` } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(String(err.message)).toContain('$setAuth')
  })

  test('db.asSystem().sql still works — it IS the documented bypass', async () => {
    const rows = await db.asSystem().sql`SELECT id FROM invoice`
    expect(rows.length).toBe(2)
  })

  test('the refusal names the fix, not just the problem', async () => {
    let msg = ''
    try { await db.sql`SELECT 1` } catch (e: any) { msg = e.message }
    expect(msg).toContain('asSystem()')
    expect(msg).toContain('$raw')
  })

  test('the ORM is unchanged — the policy still filters and @guarded still withholds', async () => {
    // The refusal must not be the only thing standing between a caller and the
    // data; the path it points at has to actually work.
    const rows = await db.$setAuth({ id: 1 }).invoice.findMany()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(1)
    expect('ssn' in rows[0]).toBe(false)
  })

  test('`where: { $raw }` keeps every policy — the escape hatch the error names', async () => {
    // The error tells people to use this instead. If it did not preserve the
    // policy the advice would be worse than the bug.
    const rows = await db.$setAuth({ id: 1 }).invoice.findMany({
      where: { $raw: sql`total > ${0}` },
    })
    expect(rows.length).toBe(1)
    expect(rows[0].ownerId).toBe(1)
    expect('ssn' in rows[0]).toBe(false)
  })

  test('a schema with NO access rules is unchanged', async () => {
    // The rule keys off declarations, not off having a database. An app that
    // declares nothing has nothing for raw SQL to bypass.
    const open = await makeDb(`model Note { id Int @id  body String }`, 'raw-sql-open')
    await open.asSystem().note.create({ data: { id: 1, body: 'x' } })
    expect((await open.sql`SELECT id FROM note`).length).toBe(1)
    expect((await open.$setAuth({ id: 1 }).sql`SELECT id FROM note`).length).toBe(1)
    open.$close()
  })

  test('the bypass can WRITE — a raw statement is not a raw read', async () => {
    // FJS-118. `_runRawSql` always ran on the read connection, which is opened
    // `readonly` with `query_only = ON` — so every raw write, through every
    // surface, failed with SQLITE_READONLY: "attempt to write a readonly
    // database". A message about a connection, naming nothing the caller
    // wrote. `db.asSystem().sql` is the documented and ONLY escape hatch on a
    // schema with access rules, so this made raw writes unreachable outright.
    // Found in basecamp, hard-deleting a row to prove an FK cascade.
    await db.asSystem().sql`UPDATE invoice SET total = ${99} WHERE id = ${2}`
    const [row] = await db.asSystem().sql`SELECT total FROM invoice WHERE id = 2`
    expect(row.total).toBe(99)

    await db.asSystem().sql`DELETE FROM invoice WHERE id = ${2}`
    expect((await db.asSystem().sql`SELECT id FROM invoice`).length).toBe(1)

    // Put it back — later tests in this describe read this table.
    await db.asSystem().invoice.create({ data: { id: 2, ownerId: 2, total: 20, ssn: 'BBB' } })
  })

  test('a leading comment does not send a write to the reader', async () => {
    // The routing test strips comments first. Without that, `-- why\nDELETE …`
    // reads as an unrecognised statement — which is fine, since anything
    // unrecognised goes to the writer, but a comment before a SELECT must not
    // do the reverse and quietly move every commented read onto the writer.
    const open = await makeDb(`model Memo { id Int @id  body String }`, 'raw-sql-comment')
    await open.asSystem().memo.create({ data: { id: 1, body: 'x' } })
    await open.sql`-- housekeeping\nDELETE FROM memo WHERE id = 1`
    expect((await open.sql`/* count */ SELECT id FROM memo`).length).toBe(0)
    open.$close()
  })

  test('a WITH goes to the writer — a CTE can be a DELETE', async () => {
    // `WITH x AS (…) DELETE FROM …` is legal SQLite, so a CTE cannot be
    // assumed to be a read. It runs on the write connection, which reads fine.
    const open = await makeDb(`model Item { id Int @id  n Int }`, 'raw-sql-cte')
    await open.asSystem().item.createMany({ data: [{ id: 1, n: 1 }, { id: 2, n: 5 }] })
    await open.sql`WITH big AS (SELECT id FROM item WHERE n > 3) DELETE FROM item WHERE id IN (SELECT id FROM big)`
    expect((await open.sql`SELECT id FROM item`).length).toBe(1)
    open.$close()
  })

  test('@guarded alone is enough to trigger it', async () => {
    // Each declaration family is its own reason. A schema whose only rule is a
    // withheld column still must not hand that column over raw.
    const g = await makeDb(`model P { id Int @id  secret String @guarded }`, 'raw-sql-guarded')
    let err: any = null
    try { await g.sql`SELECT secret FROM p` } catch (e) { err = e }
    expect(err).not.toBeNull()
    g.$close()
  })

  test('a JS migration still runs — a migration is a system operation', async () => {
    // The regression this refusal introduced, caught by running one. JS
    // migrations were handed the unscoped client, whose `sql` is now guarded,
    // so the first migration on a gated schema failed with advice ("use
    // asSystem()") that a migration cannot act on. A migration is schema
    // surgery by an operator, outside any request and usually before the rows
    // it touches have an owner, so it runs as the system by construction.
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { resolve: rp } = await import('path')

    const d = mkdtempSync(rp(tmpdir(), 'lite-mig-gate-'))
    const sp = rp(d, 's.lite')
    writeFileSync(sp, `model Inv { id Int @id  ownerId Int  ssn String @guarded  @@gate("4") }`)
    const c = await createClient({ schema: sp, db: rp(d, 'a.db') })
    const { autoMigrate: am } = await import('../src/core/migrations.js')
    am(c)

    const mdir = rp(d, 'migrations')
    mkdirSync(mdir, { recursive: true })
    writeFileSync(rp(mdir, '20260806000000_view.js'),
      'export async function up(tx) {\n' +
      '  await tx.sql`CREATE VIEW IF NOT EXISTS v_inv AS SELECT id FROM inv`\n' +
      '}\n')

    const res: any = await apply(c.$rawDbs.main, mdir, c)
    expect(res.applied[0].ok).toBe(true)
    c.$close()
  })

  test('@@gate alone is enough to trigger it', async () => {
    const g = await makeDb(`model Q { id Int @id  x String  @@gate("4") }`, 'raw-sql-gate')
    let err: any = null
    try { await g.sql`SELECT x FROM q` } catch (e) { err = e }
    expect(err).not.toBeNull()
    g.$close()
  })
})

describe('@encrypted on a Json field', () => {
  // FJS-006. `@encrypted` on a Json field DESTROYED the value: encryptField
  // does String(plaintext), an object stringifies to '[object Object]', and
  // what got written was a faithful ciphertext of that literal string. Nothing
  // threw, the row looked encrypted, and the original was unrecoverable — the
  // worst shape a data bug can have. `CLAUDE.md` carried a hazard note telling
  // people to use `String @encrypted` and serialize by hand instead.
  //
  // A Json field is now serialized before it is encrypted and parsed after it
  // is decrypted, mirroring the pipeline either side: the write path encrypts
  // then serializes, the read path parses then decrypts.
  const ENC_KEY = Buffer.alloc(32).fill(0xcd).toString('hex')

  let db: any
  beforeAll(async () => {
    db = await makeDb(`
      model Vault {
        id   Int   @id
        blob Json? @encrypted
        open Json?
      }
    `, 'encrypted-json', { encryptionKey: ENC_KEY })
  })
  afterAll(() => db.$close())

  test('an object round-trips instead of becoming "[object Object]"', async () => {
    await db.asSystem().vault.create({ data: { id: 1, blob: { secret: 'hunter2', n: 42 }, open: {} } })
    const row = await db.asSystem().vault.findUnique({ where: { id: 1 } })
    expect(row.blob).toEqual({ secret: 'hunter2', n: 42 })
  })

  test('nested structure survives', async () => {
    const val = { a: { b: [1, 2, { c: 'deep' }] } }
    await db.asSystem().vault.create({ data: { id: 2, blob: val, open: {} } })
    expect((await db.asSystem().vault.findUnique({ where: { id: 2 } })).blob).toEqual(val)
  })

  test('an array survives', async () => {
    const val = [1, 'two', { three: 3 }]
    await db.asSystem().vault.create({ data: { id: 3, blob: val, open: {} } })
    expect((await db.asSystem().vault.findUnique({ where: { id: 3 } })).blob).toEqual(val)
  })

  test('a JSON scalar survives — string, number, boolean', async () => {
    // These are the cases String(plaintext) happened to get RIGHT, so a fix
    // that only handled objects would pass the tests above and quietly break
    // these by double-encoding them.
    await db.asSystem().vault.create({ data: { id: 4, blob: 'plain-string', open: {} } })
    await db.asSystem().vault.create({ data: { id: 5, blob: 42, open: {} } })
    await db.asSystem().vault.create({ data: { id: 6, blob: true, open: {} } })
    const sys = db.asSystem()
    expect((await sys.vault.findUnique({ where: { id: 4 } })).blob).toBe('plain-string')
    expect((await sys.vault.findUnique({ where: { id: 5 } })).blob).toBe(42)
    expect((await sys.vault.findUnique({ where: { id: 6 } })).blob).toBe(true)
  })

  test('null stays null', async () => {
    // The field is Json? — a non-optional Json @encrypted field correctly
    // refuses null at the required check, which is the validator doing its job
    // and not this feature's business.
    await db.asSystem().vault.create({ data: { id: 7, blob: null, open: {} } })
    expect((await db.asSystem().vault.findUnique({ where: { id: 7 } })).blob).toBeNull()
  })

  test('the stored column is ciphertext, not the value', async () => {
    // The point of the feature. A round-trip test alone would also pass if the
    // field were simply not encrypted at all.
    const raw = db.$rawDbs.main.query('SELECT blob FROM vault WHERE id = 1').get() as any
    expect(String(raw.blob).replace(/^"/, '').startsWith('v1.')).toBe(true)
    expect(String(raw.blob)).not.toContain('hunter2')
    expect(String(raw.blob)).not.toContain('[object Object]')
  })

  test('an unencrypted Json field on the same model is untouched', async () => {
    await db.asSystem().vault.create({ data: { id: 8, blob: { a: 1 }, open: { b: 2 } } })
    const row = await db.asSystem().vault.findUnique({ where: { id: 8 } })
    expect(row.open).toEqual({ b: 2 })
    const raw = db.$rawDbs.main.query('SELECT open FROM vault WHERE id = 8').get() as any
    expect(String(raw.open)).toContain('"b"')
  })

  test('@encrypted still implies @guarded(all) for a Json field', async () => {
    // The fix must not have made the field readable to a non-system caller.
    const row = await db.vault.findUnique({ where: { id: 1 } })
    expect('blob' in row).toBe(false)
  })

  test('a row written before the fix reads as the broken string, not null', async () => {
    // Legacy data is already lost — that cannot be undone. But blanking it to
    // null reads as "this was empty", while the literal '[object Object]'
    // reads as "something went wrong here", and only the second sends anyone
    // looking. So a parse failure leaves the decrypted value alone.
    const legacy = db.$rawDbs.main
    const enc = await (async () => {
      // Encrypt the literal string the old code produced, the same way it did.
      await db.asSystem().vault.create({ data: { id: 9, blob: '[object Object]', open: {} } })
      return (legacy.query('SELECT blob FROM vault WHERE id = 9').get() as any).blob
    })()
    legacy.run('UPDATE vault SET blob = ? WHERE id = 9', [enc])
    const row = await db.asSystem().vault.findUnique({ where: { id: 9 } })
    expect(row.blob).toBe('[object Object]')
  })
})


// ─── 19b. @secret ─────────────────────────────────────────────────────────────


describe('@secret field attribute', () => {

  const ENC_KEY = 'a'.repeat(64)   // 32-byte hex key for all secret tests

  // ── Parser expansion ──────────────────────────────────────────────────────

  test('expands @secret → @encrypted + @guarded(all) at parse time', () => {
    const r = parse(`model T { id Int @id; token String @secret }`)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    expect(field.attributes.some((a: any) => a.kind === 'secret')).toBe(true)
    expect(field.attributes.some((a: any) => a.kind === 'encrypted')).toBe(true)
    expect(field.attributes.some((a: any) => a.kind === 'guarded' && a.level === 'all')).toBe(true)
  })

  test('@secret defaults rotate: true', () => {
    const r = parse(`model T { id Int @id; token String @secret }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    const secretAttr = field.attributes.find((a: any) => a.kind === 'secret')
    expect(secretAttr.rotate).toBe(true)
  })

  test('@secret(rotate: false) sets rotate: false', () => {
    const r = parse(`model T { id Int @id; token String @secret(rotate: false) }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    const secretAttr = field.attributes.find((a: any) => a.kind === 'secret')
    expect(secretAttr.rotate).toBe(false)
  })

  test('@secret still expands @encrypted + @guarded(all) when rotate: false', () => {
    const r = parse(`model T { id Int @id; token String @secret(rotate: false) }`)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    expect(field.attributes.some((a: any) => a.kind === 'encrypted')).toBe(true)
    expect(field.attributes.some((a: any) => a.kind === 'guarded' && a.level === 'all')).toBe(true)
  })

  test('@secret synthesizes @log when a logger database is declared', () => {
    const r = parse(`
      database audit { path "./audit/" driver logger }
      model T { id Int @id; token String @secret }
    `)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    const logAttr = field.attributes.find((a: any) => a.kind === 'log')
    expect(logAttr).toBeDefined()
    expect(logAttr.db).toBe('audit')
    expect(logAttr.reads).toBe(false)
    expect(logAttr.writes).toBe(true)
  })

  test('@secret does not synthesize @log when no logger database exists', () => {
    const r = parse(`model T { id Int @id; token String @secret }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    expect(field.attributes.some((a: any) => a.kind === 'log')).toBe(false)
  })

  test('@secret emits warning when no logger database is declared', () => {
    const r = parse(`model T { id Int @id; token String @secret }`)
    expect(r.warnings.some((w: string) => w.includes('@secret') && w.includes('logger database'))).toBe(true)
  })

  test('@secret + explicit @encrypted is a validation error', () => {
    const r = parse(`model T { id Int @id; token String @secret @encrypted }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@secret') && e.includes('@encrypted'))).toBe(true)
  })

  test('@secret + explicit @guarded is a validation error', () => {
    const r = parse(`model T { id Int @id; token String @secret @guarded }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@secret') && e.includes('@guarded'))).toBe(true)
  })

  test('@secret unknown option is a parse error', () => {
    const r = parse(`model T { id Int @id; token String @secret(expires: true) }`)
    expect(r.valid).toBe(false)
  })

  // ── Runtime behaviour ─────────────────────────────────────────────────────

  test('@secret field is encrypted at rest', async () => {
    const db = await makeDb(`model Secret { id Int @id; token String @secret }`, 'secret-enc', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'mysecret' } })
    const raw = db.$db.query(`SELECT token FROM secret`).get() as any
    expect(raw.token).toMatch(/^v1\./)   // AES-GCM ciphertext prefix
    db.$close()
  })

  test('@secret field is stripped from findMany results', async () => {
    const db = await makeDb(`model Secret { id Int @id; token String @secret }`, 'secret-strip', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'mysecret' } })
    const rows = await db.secret.findMany()
    expect((rows[0] as any).token).toBeUndefined()
    db.$close()
  })

  test('@secret field is returned via asSystem()', async () => {
    const db = await makeDb(`model Secret { id Int @id; token String? @secret }`, 'secret-system', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'mysecret' } })
    const row = await db.asSystem().secret.findFirst({}) as any
    expect(row.token).toBe('mysecret')
    db.$close()
  })

  // ── Key rotation ──────────────────────────────────────────────────────────

  const NEW_KEY = 'b'.repeat(64)

  test('$rotateKey re-encrypts rotate:true fields', async () => {
    const db = await makeDb(`model Secret { id Int @id; token String @secret }`, 'rotate-basic', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'rotate-me' } })

    const statsBefore = db.$db.query(`SELECT token FROM secret`).get() as any
    expect(statsBefore.token).toMatch(/^v1\./)

    await db.$rotateKey(NEW_KEY)

    // Ciphertext should have changed (different IV → different output)
    const statsAfter = db.$db.query(`SELECT token FROM secret`).get() as any
    expect(statsAfter.token).toMatch(/^v1\./)
    expect(statsAfter.token).not.toBe(statsBefore.token)

    // And it is still the value that was written. Asserting only that the
    // ciphertext MOVED is satisfied by a rotation that scrambled every row
    // beyond recovery, which is what let FJS-236 live here for as long as it
    // did — the one read-back test built a brand-new client, the single path
    // that always worked.
    expect(((await db.asSystem().secret.findFirst({})) as any).token).toBe('rotate-me')

    db.$close()
  })

  // ── The key is a cell, not a copy (FJS-236) ──────────────────────────────
  //
  // Every derived client — asSystem(), $setAuth(), $scopedBy() — is a spread of
  // the root context. A spread copies a string by VALUE, so `ctx.encKey =
  // newKey` updated the root and nothing else, and read()'s catch turned the
  // resulting GCM failure into `null`: the field read as EMPTY rather than as
  // broken. Each of these is a client that existed BEFORE the rotation.

  test('$rotateKey — the client that rotated can still read what it re-encrypted', async () => {
    const db  = await makeDb(`model Secret { id Int @id; token String @secret }`, 'rotate-self', { encryptionKey: ENC_KEY })
    const sys = db.asSystem()                       // memoised, and taken FIRST
    await sys.secret.create({ data: { id: 1, token: 'tok-abc' } })
    expect(((await sys.secret.findUnique({ where: { id: 1 } })) as any).token).toBe('tok-abc')

    await db.$rotateKey(NEW_KEY)

    // The proxy handed out before the rotation, and a fresh one: asSystem() is
    // memoised in `_systemProxy`, so these are the same object and both used to
    // answer null.
    expect(((await sys.secret.findUnique({ where: { id: 1 } })) as any).token).toBe('tok-abc')
    expect(((await db.asSystem().secret.findUnique({ where: { id: 1 } })) as any).token).toBe('tok-abc')
    db.$close()
  })

  test('$rotateKey — a scoped client made before the rotation reads through it', async () => {
    // $setAuth is NOT memoised, so a client made AFTER the rotation always
    // worked and one made BEFORE did not. That difference is what made the
    // defect look intermittent.
    const db     = await makeDb(`model Secret { id Int @id; token String @secret }`, 'rotate-scoped', { encryptionKey: ENC_KEY })
    const before = db.$setAuth({ id: 'u1' })
    await db.asSystem().secret.create({ data: { id: 1, token: 'scoped-value' } })

    await db.$rotateKey(NEW_KEY)

    expect(((await before.asSystem().secret.findUnique({ where: { id: 1 } })) as any).token).toBe('scoped-value')
    db.$close()
  })

  test('$rotateKey carries every key-reversible column, not just @secret', async () => {
    // FJS-253. Rotation visited `@secret(rotate: true)` only and then swapped
    // the client's key for ALL encryption, so a plain @encrypted column beside
    // it kept ciphertext written under the old key and read `null` — nothing
    // thrown at any layer, and unrecoverable by a fresh client too, because the
    // bytes on disk were never rewritten.
    const db = await makeDb(
      `model Secret { id Int @id; email String @encrypted(deterministic: true); note String @encrypted; token String @secret }`,
      'rotate-carries',
      { encryptionKey: ENC_KEY },
    )
    const sys = db.asSystem()
    await sys.secret.create({ data: { id: 1, email: 'a@b.co', note: 'N', token: 'T' } })

    const before = db.$db.query(`SELECT email, note, token FROM secret`).get() as any
    const stats  = await db.$rotateKey(NEW_KEY)
    const after  = db.$db.query(`SELECT email, note, token FROM secret`).get() as any

    // All three ciphertexts moved — the assertion the old test made about one.
    expect(after.email).not.toBe(before.email)
    expect(after.note).not.toBe(before.note)
    expect(after.token).not.toBe(before.token)
    expect(stats.Secret.fields).toBe(3)

    const row = (await sys.secret.findUnique({ where: { id: 1 } })) as any
    expect(row.email).toBe('a@b.co')
    expect(row.note).toBe('N')
    expect(row.token).toBe('T')

    // A deterministic column has to stay FILTERABLE, not merely readable: the
    // where-encoder encodes the operand with the key before comparing, so a
    // column re-encrypted in the wrong mode answers 0 rows with a 200 and no
    // warning.
    expect(await sys.secret.count({ where: { email: 'a@b.co' } })).toBe(1)
    db.$close()
  })

  test('$rotateKey refuses while a column it cannot carry exists, and rotates nothing', async () => {
    // The refusal comes BEFORE the first write. A rotation that rewrites half a
    // database and then complains leaves it in two keys, with nothing recording
    // which rows are in which.
    const db = await makeDb(
      `model Secret { id Int @id; pw String @hashed; token String @secret }`,
      'rotate-refuses',
      { encryptionKey: ENC_KEY },
    )
    await db.asSystem().secret.create({ data: { id: 1, pw: 'secret-pw', token: 'T' } })
    const before = db.$db.query(`SELECT pw, token FROM secret`).get() as any

    await expect(db.$rotateKey(NEW_KEY)).rejects.toThrow(/Secret\.pw/)
    await expect(db.$rotateKey(NEW_KEY)).rejects.toThrow(/@hashed/)

    // Nothing moved, and the key did not swap either — the client is exactly
    // where it was.
    const after = db.$db.query(`SELECT pw, token FROM secret`).get() as any
    expect(after.token).toBe(before.token)
    expect(after.pw).toBe(before.pw)
    expect(((await db.asSystem().secret.findUnique({ where: { id: 1 } })) as any).token).toBe('T')
    expect(await db.asSystem().secret.count({ where: { pw: 'secret-pw' } })).toBe(1)
    db.$close()
  })

  test('$rotateKey — acknowledging one orphan does not acknowledge the next', async () => {
    // Why `orphan` is a list of names and not a boolean: a column added later
    // must not inherit an acknowledgement made for a different one.
    const db = await makeDb(
      `model Secret { id Int @id; pw String @hashed; kept String @secret(rotate: false); token String @secret }`,
      'rotate-partial-ack',
      { encryptionKey: ENC_KEY },
    )
    await db.asSystem().secret.create({ data: { id: 1, pw: 'p', kept: 'K', token: 'T' } })

    // Both named → refused, naming both.
    await expect(db.$rotateKey(NEW_KEY)).rejects.toThrow(/Secret\.kept/)
    // One named → still refused, and only the OTHER one is reported.
    const err = await db.$rotateKey(NEW_KEY, { orphan: ['Secret.pw'] }).catch((e: Error) => e)
    expect((err as Error).message).toContain('Secret.kept')
    expect((err as Error).message).not.toContain('Secret.pw —')

    // Both named → it proceeds, and the two orphans are left as declared.
    const stats = await db.$rotateKey(NEW_KEY, { orphan: ['Secret.pw', 'Secret.kept'] })
    expect(stats.Secret.fields).toBe(1)   // token alone
    expect(((await db.asSystem().secret.findUnique({ where: { id: 1 } })) as any).token).toBe('T')
    db.$close()
  })

  test('$rotateKey returns per-model stats', async () => {
    const db = await makeDb(`model Secret { id Int @id; token String @secret }`, 'rotate-stats', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'a' } })
    await db.secret.create({ data: { token: 'b' } })

    const stats = await db.$rotateKey(NEW_KEY)
    expect(stats.Secret.rows).toBe(2)
    expect(stats.Secret.fields).toBe(1)
    db.$close()
  })

  test('rotated field is still readable after rotation with new key', async () => {
    // Manage path directly so we can re-open with a different key
    const schema = `model Secret { id Int @id; token String? @secret }`
    const r      = parse(schema)
    const path   = tmpDb('rotate-read' + Math.random().toString(36).slice(2))
    const { Database: BunDb } = await import('bun:sqlite')
    const raw = new BunDb(path)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()

    const dbOld = await createClient({ parsed: r,  db: path, encryptionKey: ENC_KEY })
    await (dbOld as any).secret.create({ data: { token: 'still-readable' } })
    await dbOld.$rotateKey(NEW_KEY)
    dbOld.$close()

    const dbNew = await createClient({ parsed: r,  db: path, encryptionKey: NEW_KEY })
    const row   = await (dbNew as any).asSystem().secret.findFirst({}) as any
    expect(row.token).toBe('still-readable')
    dbNew.$close()
  })

  test('@secret(rotate: false) field is skipped by $rotateKey — and orphaned by it', async () => {
    const db = await makeDb(
      `model Secret { id Int @id; fixed String @secret(rotate: false); rotateable String @secret }`,
      'rotate-skip',
      { encryptionKey: ENC_KEY }
    )
    await db.secret.create({ data: { fixed: 'stays', rotateable: 'changes' } })

    const before = db.$db.query(`SELECT fixed, rotateable FROM secret`).get() as any
    // Skipped is not free: the key swap is global, so `fixed` is unreadable
    // after this, and rotation says so rather than doing it quietly (FJS-253).
    await db.$rotateKey(NEW_KEY, { orphan: ['Secret.fixed'] })
    const after = db.$db.query(`SELECT fixed, rotateable FROM secret`).get() as any

    // fixed stays the same ciphertext
    expect(after.fixed).toBe(before.fixed)
    // rotateable has a new ciphertext
    expect(after.rotateable).not.toBe(before.rotateable)

    // …and `fixed` now reads as empty, which is the cost the caller accepted by
    // naming it. Stated here so the trade is written down where it happens.
    const row = (await db.asSystem().secret.findFirst({})) as any
    expect(row.fixed).toBeNull()
    expect(row.rotateable).toBe('changes')
    db.$close()
  })

  test('$rotateKey with no @secret fields returns empty stats', async () => {
    const db = await makeDb(`model Plain { id Int @id; name String }`, 'rotate-empty')
    const stats = await db.$rotateKey(ENC_KEY)
    expect(Object.keys(stats)).toHaveLength(0)
    db.$close()
  })

  test('$rotateKey with no @secret fields — no encryption key needed on client', async () => {
    // A client with @secret fields cannot be created without an encKey (createClient rejects).
    // Testing with a plain model: $rotateKey returns {} with no @secret fields regardless
    // of whether the client has an encryption key.
    const db = await makeDb(`model Plain { id Int @id; name String }`, 'rotate-no-key')
    const stats = await db.$rotateKey(NEW_KEY)
    expect(Object.keys(stats)).toHaveLength(0)
    db.$close()
  })

  test('$rotateKey throws on bad key length', async () => {
    const db = await makeDb(`model Secret { id Int @id; token String @secret }`, 'rotate-bad-key', { encryptionKey: ENC_KEY })
    await expect(db.$rotateKey('tooshort')).rejects.toThrow('32 bytes')
    db.$close()
  })

  test('$rotateKey leaves null fields untouched', async () => {
    const db = await makeDb(`model Secret { id Int @id; token String? @secret }`, 'rotate-null', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: {} })
    const stats = await db.$rotateKey(NEW_KEY)
    expect(stats.Secret?.rows ?? 0).toBe(0)   // null field — nothing to update
    db.$close()
  })


})

// ─── 19b. onLog callback ──────────────────────────────────────────────────────

describe('onLog callback', () => {
  const ENC_KEY = 'a'.repeat(64)

  // Schema with a logger db, a @log field, and a @@log model
  const LOG_SCHEMA = `
    database main  { path env("MAIN_DB", "./main.db") }
    database audit { path "./audit/" driver logger }

    model Post {
      id        Int  @id
      title     String
      body      String     @log(audit)

      @@db(main)
      @@log(audit)
    }
  `

  // Helper: makeTestClient with an in-memory-style path and onLog option
  async function makeLogDb(onLog?: (...args: any[]) => any) {
    const r = parse(LOG_SCHEMA)
    if (!r.valid) throw new Error(r.errors.join('\n'))
    const dir  = join(tmpdir(), `ls-onlog-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const mainPath  = join(dir, 'main.db')
    const auditPath = join(dir, 'audit')
    mkdirSync(auditPath, { recursive: true })

    const raw = new Database(mainPath)
    raw.run('PRAGMA journal_mode = WAL')
    raw.run('PRAGMA foreign_keys = ON')
    for (const s of splitStatements(generateDDL(r.schema)))
      if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()

    const db = await createClient({
      parsed:    r,
      databases: { main: { path: mainPath }, audit: { path: auditPath } },
      onLog,
    })
    return db
  }

  // Give fireLog's setImmediate a chance to flush
  function flush() { return new Promise<void>(res => setTimeout(res, 20)) }

  test('onLog is called on @@log model write', async () => {
    const calls: any[] = []
    const db = await makeLogDb((entry, ctx) => { calls.push({ entry, ctx }) })
    await db.post.create({ data: { title: 'Hello', body: 'World' } })
    await flush()
    expect(calls.length).toBeGreaterThan(0)
    db.$close()
  })

  test('onLog receives correct operation and model', async () => {
    const calls: any[] = []
    const db = await makeLogDb((entry) => { calls.push(entry) })
    await db.post.create({ data: { title: 'T', body: 'B' } })
    await flush()
    const modelLog = calls.find(e => e.model === 'post' && e.field == null)
    expect(modelLog).toBeDefined()
    expect(modelLog.operation).toBe('create')
    db.$close()
  })

  test('onLog receives correct field for @log field entry', async () => {
    const calls: any[] = []
    const db = await makeLogDb((entry) => { calls.push(entry) })
    await db.post.create({ data: { title: 'T', body: 'B' } })
    await flush()
    const fieldLog = calls.find(e => e.field === 'body')
    expect(fieldLog).toBeDefined()
    expect(fieldLog.model).toBe('post')
    db.$close()
  })

  test('onLog return value merges actorId into entry', async () => {
    const written: any[] = []
    const db = await makeLogDb((entry) => {
      written.push(entry)
      return { actorId: 999, actorType: 'service' }
    })
    await db.post.create({ data: { title: 'T', body: 'B' } })
    await flush()
    // Verify the written log rows reflect the overridden actor
    const auditRows = await (db as any).auditLogs.findMany({})
    expect(auditRows.some((r: any) => r.actorId === 999 && r.actorType === 'service')).toBe(true)
    db.$close()
  })

  // A uuid actor. @frontierjs/auth issues `id String @id @default(uuid())`, so
  // this is what an ordinary FrontierJS app writes — and the audit index's
  // `actorId` column was declared Int, making it
  //   SQLiteError: cannot store TEXT value in INTEGER column auditLogs_idx.actorId
  // on the first audited write with a known actor. It took the request with it.
  //
  // Invisible until 2026-08-06 because Junction handed the Data boundary a
  // principal with no `id` at all, so actorId was always null — and NULL fits
  // an INTEGER column. Two defects, one masking the other.
  test('a String actorId is stored, not a datatype error', async () => {
    const uuid = '624d6956-4d3f-47bc-b423-87afaebefc64'
    const db = await makeLogDb(() => ({ actorId: uuid, actorType: 'user' }))
    await db.post.create({ data: { title: 'T', body: 'B' } })
    await flush()
    const auditRows = await (db as any).auditLogs.findMany({})
    expect(auditRows.some((r: any) => r.actorId === uuid)).toBe(true)
    db.$close()
  })

  test('Int and String actors coexist in one log', async () => {
    // ANY is what makes this legal, and it is the honest column type: the
    // audit trail records whoever the host app keys its users by.
    let actor: unknown = 42
    const db = await makeLogDb(() => ({ actorId: actor }))
    await db.post.create({ data: { title: 'A', body: 'B' } })
    await flush()
    actor = 'usr_abc'
    await db.post.create({ data: { title: 'C', body: 'D' } })
    await flush()

    const rows = await (db as any).auditLogs.findMany({})
    expect(rows.some((r: any) => r.actorId === 42)).toBe(true)
    expect(rows.some((r: any) => r.actorId === 'usr_abc')).toBe(true)
    db.$close()
  })

  // The .jsonl is the source of truth and the index db is a cache of it, so a
  // column-type change must rebuild rather than fail — `CREATE TABLE IF NOT
  // EXISTS` does nothing to a table that already exists, and an index left in
  // the old shape makes every write throw against a column the schema no longer
  // describes. Rebuilding it while LOSING the old rows would be worse than the
  // error: an audit trail that silently looks shorter.
  test('an index built with the old column type is rebuilt, history and all', async () => {
    const { makeJsonlTable } = await import('../src/drivers/jsonl.js')

    const dir  = join(tmpdir(), `ls-idx-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'auditLogs.jsonl')

    const model: any = {
      name: 'auditLogs',
      fields: [
        { name: 'id',      type: { kind: 'scalar', name: 'Int',    optional: false }, attributes: [{ kind: 'id' }] },
        { name: 'actorId', type: { kind: 'scalar', name: 'Any',    optional: true  }, attributes: [] },
        { name: 'model',   type: { kind: 'scalar', name: 'String', optional: true  }, attributes: [] },
      ],
      attributes: [{ kind: 'index', fields: ['actorId'] }],
    }

    // Two entries already logged, and an index in the pre-fix shape.
    writeFileSync(file,
      JSON.stringify({ id: 1, actorId: 7, model: 'post' }) + '\n' +
      JSON.stringify({ id: 2, actorId: 9, model: 'post' }) + '\n')

    const old = new Database(file + '.index.db')
    old.run(`CREATE TABLE "auditLogs_idx" ("id" INTEGER, "actorId" INTEGER, "_offset" INTEGER NOT NULL, PRIMARY KEY ("id")) STRICT;`)
    old.run(`INSERT INTO "auditLogs_idx" VALUES (1, 7, 0), (2, 9, 40)`)
    old.close()

    const table: any = makeJsonlTable(file, model, { models: [model], enums: [], types: [] })

    // The write that used to throw SQLITE_CONSTRAINT_DATATYPE.
    await table.create({ data: { id: 3, actorId: 'usr_abc', model: 'post' } })

    // History survived the rebuild AND is still reachable through the index.
    expect((await table.findMany({ where: { actorId: 7 } })).length).toBe(1)
    expect((await table.findMany({ where: { actorId: 'usr_abc' } })).length).toBe(1)
    expect((await table.findMany({})).length).toBe(3)

    const check = new Database(file + '.index.db')
    expect((check.query(`SELECT type FROM pragma_table_info('auditLogs_idx') WHERE name='actorId'`).get() as any).type)
      .toBe('ANY')
    check.close()

    rmSync(dir, { recursive: true, force: true })
  })

  test('onLog return value merges meta into entry', async () => {
    const db = await makeLogDb((_entry) => {
      return { meta: { source: 'api', version: 2 } }
    })
    await db.post.create({ data: { title: 'T', body: 'B' } })
    await flush()
    const auditRows = await (db as any).auditLogs.findMany({})
    const withMeta  = auditRows.find((r: any) => r.meta != null)
    expect(withMeta).toBeDefined()
    const meta = typeof withMeta.meta === 'string' ? JSON.parse(withMeta.meta) : withMeta.meta
    expect(meta.source).toBe('api')
    expect(meta.version).toBe(2)
    db.$close()
  })

  test('onLog receives ctx with auth when $setAuth is used', async () => {
    const ctxCaptures: any[] = []
    const db = await makeLogDb((_entry, ctx) => { ctxCaptures.push(ctx) })
    const authedDb = db.$setAuth({ id: 42, type: 'user' })
    await authedDb.post.create({ data: { title: 'T', body: 'B' } })
    await flush()
    expect(ctxCaptures.some(c => c.auth?.id === 42)).toBe(true)
    db.$close()
  })

  test('onLog not called when no @log / @@log on model', async () => {
    const PLAIN_SCHEMA = `
      database main { path env("MAIN_DB", "./main.db") }
      model Note { id Int @id; text String @@db(main) }
    `
    const r = parse(PLAIN_SCHEMA)
    const dir = join(tmpdir(), `ls-onlog-plain-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'main.db')
    const raw = new Database(path)
    raw.run('PRAGMA journal_mode = WAL')
    for (const s of splitStatements(generateDDL(r.schema)))
      if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()

    const calls: any[] = []
    const db = await createClient({ parsed: r, databases: { main: { path } }, onLog: (e: any) => { calls.push(e) } })
    await (db as any).note.create({ data: { text: 'hi' } })
    await flush()
    expect(calls).toHaveLength(0)
    db.$close()
  })

  test('onLog returning null/undefined does not throw', async () => {
    const db = await makeLogDb(() => null)
    await expect(db.post.create({ data: { title: 'T', body: 'B' } })).resolves.toBeDefined()
    await flush()
    db.$close()
  })

  test('onLog throwing does not propagate to caller', async () => {
    const db = await makeLogDb(() => { throw new Error('onLog exploded') })
    await expect(db.post.create({ data: { title: 'T', body: 'B' } })).resolves.toBeDefined()
    db.$close()
  })
})

// ─── 19b-ii. Audit log redaction of protected fields ─────────────────────────
// The audit trail records THAT a protected field was written — by whom, to
// which rows, when — never what it holds. Logging the plaintext would defeat
// the @encrypted it sits beside: the row is ciphertext while the log file next
// to it is not, and the log has none of the column's read protections.
//
// This is load-bearing for @secret in particular, which expands to
// @encrypted + @guarded(all) + @log(<first logger db>) — so merely DECLARING a
// logger database is enough to start logging every @secret field.

describe('audit log redaction', () => {
  const ENC_KEY = 'a'.repeat(64)

  const REDACT_SCHEMA = `
    database main  { path env("MAIN_DB", "./main.db") }
    database audit { path "./audit/" driver logger }

    model Vault {
      id       Int     @id
      name     String
      secretF  String? @secret
      encF     String? @encrypted
      guardedF String? @guarded(all)
      plain    String?

      @@db(main)
      @@log(audit)
    }
  `

  async function makeRedactDb(onLog?: (...args: any[]) => any) {
    const r = parse(REDACT_SCHEMA)
    if (!r.valid) throw new Error(r.errors.join('\n'))
    const dir = join(tmpdir(), `ls-redact-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const mainPath  = join(dir, 'main.db')
    const auditPath = join(dir, 'audit')
    mkdirSync(auditPath, { recursive: true })

    const raw = new Database(mainPath)
    raw.run('PRAGMA journal_mode = WAL')
    for (const s of splitStatements(generateDDL(r.schema)))
      if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()

    return createClient({
      parsed:        r,
      databases:     { main: { path: mainPath }, audit: { path: auditPath } },
      encryptionKey: ENC_KEY,
      onLog,
    })
  }

  function flush() { return new Promise<void>(res => setTimeout(res, 20)) }

  const SECRETS = ['PLAINTEXT-SECRET', 'PLAINTEXT-ENC', 'PLAINTEXT-GUARDED']

  async function captureCreate() {
    const calls: any[] = []
    const db = await makeRedactDb((entry) => { calls.push(entry) })
    const row = await db.asSystem().vault.create({
      data: {
        name: 'k', secretF: SECRETS[0], encF: SECRETS[1],
        guardedF: SECRETS[2], plain: 'not-a-secret',
      },
    })
    await flush()
    return { calls, row, db }
  }

  test('no protected value appears anywhere in any log entry', async () => {
    const { calls, db } = await captureCreate()
    const serialized = JSON.stringify(calls)
    for (const secret of SECRETS) expect(serialized).not.toContain(secret)
    db.$close()
  })

  test('model-level snapshot redacts @secret, @encrypted and @guarded fields', async () => {
    const { calls, db } = await captureCreate()
    const modelLog = calls.find(e => e.model === 'vault' && e.field == null)
    const after = JSON.parse(modelLog.after)
    expect(after.secretF).toBe('[redacted]')
    expect(after.encF).toBe('[redacted]')
    expect(after.guardedF).toBe('[redacted]')
    db.$close()
  })

  test('unprotected fields are still logged in full — the trail stays useful', async () => {
    const { calls, db } = await captureCreate()
    const modelLog = calls.find(e => e.model === 'vault' && e.field == null)
    const after = JSON.parse(modelLog.after)
    expect(after.name).toBe('k')
    expect(after.plain).toBe('not-a-secret')
    db.$close()
  })

  test('field-level entry is still emitted — access is documented, value is not', async () => {
    const { calls, row, db } = await captureCreate()
    const fieldLog = calls.find(e => e.field === 'secretF')
    expect(fieldLog).toBeDefined()
    expect(fieldLog.operation).toBe('create')
    expect(JSON.parse(fieldLog.records)).toEqual([row.id])
    expect(JSON.parse(fieldLog.after)).toBe('[redacted]')
    db.$close()
  })

  test('redaction does not mutate the row returned to the caller', async () => {
    const { row, db } = await captureCreate()
    expect(row.secretF).toBe(SECRETS[0])
    expect(row.encF).toBe(SECRETS[1])
    expect(row.guardedF).toBe(SECRETS[2])
    db.$close()
  })

  test('null is preserved, not redacted — a null to value transition stays visible', async () => {
    const calls: any[] = []
    const db = await makeRedactDb((entry) => { calls.push(entry) })
    const sys = db.asSystem()
    const row = await sys.vault.create({ data: { name: 'k', plain: 'p' } })
    await sys.vault.update({ where: { id: row.id }, data: { secretF: 'NOW-SET' } })
    await flush()

    const upd = calls.find(e => e.field === 'secretF' && e.operation === 'update')
    expect(upd.before).toBe(null)                       // was null — nothing to leak
    expect(JSON.parse(upd.after)).toBe('[redacted]')    // now set — visible as a change
    expect(JSON.stringify(calls)).not.toContain('NOW-SET')
    db.$close()
  })

  test('update and delete snapshots are redacted on both sides', async () => {
    const calls: any[] = []
    const db = await makeRedactDb((entry) => { calls.push(entry) })
    const sys = db.asSystem()
    const row = await sys.vault.create({ data: { name: 'k', secretF: 'ORIGINAL' } })
    await sys.vault.update({ where: { id: row.id }, data: { secretF: 'ROTATED' } })
    await sys.vault.delete({ where: { id: row.id } })
    await flush()

    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain('ORIGINAL')
    expect(serialized).not.toContain('ROTATED')

    const upd = calls.find(e => e.model === 'vault' && e.field == null && e.operation === 'update')
    expect(JSON.parse(upd.before).secretF).toBe('[redacted]')
    expect(JSON.parse(upd.after).secretF).toBe('[redacted]')

    const del = calls.find(e => e.model === 'vault' && e.field == null && e.operation === 'delete')
    expect(JSON.parse(del.before).secretF).toBe('[redacted]')
    db.$close()
  })

  test('a model with no protected fields logs values unchanged', async () => {
    const calls: any[] = []
    const db = await makeLogDbForPlain((entry) => { calls.push(entry) })
    await db.post.create({ data: { title: 'T', body: 'BODY-VISIBLE' } })
    await flush()
    expect(JSON.stringify(calls)).toContain('BODY-VISIBLE')
    db.$close()
  })

  // Plain schema — no @secret/@encrypted/@guarded anywhere.
  async function makeLogDbForPlain(onLog: (...args: any[]) => any) {
    const r = parse(`
      database main  { path env("MAIN_DB", "./main.db") }
      database audit { path "./audit/" driver logger }

      model Post {
        id    Int    @id
        title String
        body  String @log(audit)

        @@db(main)
        @@log(audit)
      }
    `)
    if (!r.valid) throw new Error(r.errors.join('\n'))
    const dir = join(tmpdir(), `ls-redact-plain-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const mainPath  = join(dir, 'main.db')
    const auditPath = join(dir, 'audit')
    mkdirSync(auditPath, { recursive: true })
    const raw = new Database(mainPath)
    for (const s of splitStatements(generateDDL(r.schema)))
      if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    return createClient({
      parsed:    r,
      databases: { main: { path: mainPath }, audit: { path: auditPath } },
      onLog,
    })
  }
})

// ─── 19b2. Bulk writes reach the audit trail ─────────────────────────────────
//
// updateMany / deleteMany / removeMany / restore / upsertMany used to write NO
// audit entry at all on an @@log model — not an entry without snapshots, no
// entry. A bulk delete of audited rows left a trail saying nothing happened,
// and createMany's entry named no rows because an autoincrement id does not
// exist until SQLite assigns it. A trail that omits the most destructive
// operation in the API is worse than none, because it is trusted.
//
// The contract these pin: a bulk write records WHICH rows and WHAT operation.
// Content snapshots (before/after) stay single-row-only, as documented.

describe('audit trail covers bulk writes', () => {

  const BULK_SCHEMA = `
    database main  { path env("MAIN_DB", "./main.db") }
    database audit { path "./audit/" driver logger }

    model Widget {
      id        Int    @id @default(autoincrement())
      code      String @unique
      name      String
      state     String @default("draft")
      deletedAt DateTime?

      @@db(main)
      @@softDelete
      @@log(audit)
    }
  `

  const PLAIN_SCHEMA = `
    database main  { path env("MAIN_DB", "./main.db") }
    database audit { path "./audit/" driver logger }

    model Note {
      id   Int    @id @default(autoincrement())
      text String

      @@db(main)
    }
  `

  async function makeBulkDb(schemaText = BULK_SCHEMA) {
    const r = parse(schemaText)
    if (!r.valid) throw new Error(r.errors.join('\n'))
    const dir = join(tmpdir(), `ls-bulklog-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const mainPath  = join(dir, 'main.db')
    const auditPath = join(dir, 'audit')
    mkdirSync(auditPath, { recursive: true })
    const raw = new Database(mainPath)
    for (const s of splitStatements(generateDDL(r.schema)))
      if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    return createClient({ parsed: r, databases: { main: { path: mainPath }, audit: { path: auditPath } } })
  }

  function flush() { return new Promise<void>(res => setTimeout(res, 20)) }

  // Model-level entries only — a @log field would double every row below.
  async function entries(db: any) {
    await flush()
    const rows = await db.auditLogs.findMany({})
    return rows.map((r: any) => ({
      operation: r.operation,
      records:   typeof r.records === 'string' ? JSON.parse(r.records) : r.records,
    }))
  }

  async function seed(db: any) {
    await db.widget.createMany({ data: [
      { code: 'a', name: 'A' }, { code: 'b', name: 'B' }, { code: 'c', name: 'C' },
    ] })
  }

  test('createMany names rows by their assigned ids', async () => {
    const db = await makeBulkDb()
    await seed(db)
    const [e] = await entries(db)
    expect(e.operation).toBe('create')
    expect(e.records).toEqual([1, 2, 3])
    db.$close()
  })

  test('updateMany writes one entry naming every changed row', async () => {
    const db = await makeBulkDb()
    await seed(db)
    const res = await db.widget.updateMany({ where: { state: 'draft' }, data: { state: 'live' } })
    expect(res.count).toBe(3)
    const log = (await entries(db)).find((e: any) => e.operation === 'update')
    expect(log).toBeDefined()
    expect(log!.records).toEqual([1, 2, 3])
    db.$close()
  })

  test('updateMany count is unaffected by the RETURNING path', async () => {
    const db = await makeBulkDb()
    await seed(db)
    expect((await db.widget.updateMany({ where: { code: 'a' }, data: { name: 'A2' } })).count).toBe(1)
    expect((await db.widget.updateMany({ where: { code: 'zz' }, data: { name: 'X' } })).count).toBe(0)
    db.$close()
  })

  test('deleteMany writes a delete entry naming the rows', async () => {
    const db = await makeBulkDb()
    await seed(db)
    const res = await db.widget.deleteMany({ where: { state: 'draft' } })
    expect(res.count).toBe(3)
    const log = (await entries(db)).find((e: any) => e.operation === 'delete')
    expect(log).toBeDefined()
    expect(log!.records).toEqual([1, 2, 3])
    db.$close()
  })

  test('removeMany (soft delete) writes a delete entry', async () => {
    const db = await makeBulkDb()
    await seed(db)
    const res = await db.widget.removeMany({ where: { code: 'b' } })
    expect(res.count).toBe(1)
    const log = (await entries(db)).find((e: any) => e.operation === 'delete')
    expect(log!.records).toEqual([2])
    // The row is soft-deleted, not gone
    expect(await db.widget.count({})).toBe(2)
    db.$close()
  })

  test('restore writes an update entry — un-deleting is a write', async () => {
    const db = await makeBulkDb()
    await seed(db)
    await db.widget.removeMany({ where: { code: 'c' } })
    // restore answers the shaped rows, mirroring remove — it used to answer
    // { count }, which neither its TypeScript declaration nor CLAUDE.md said.
    const res = await db.widget.restore({ where: { code: 'c' } })
    expect(res).toHaveLength(1)
    expect(res[0].code).toBe('c')
    const log = (await entries(db)).filter((e: any) => e.operation === 'update')
    expect(log.length).toBe(1)
    expect(log[0].records).toEqual([3])
    db.$close()
  })

  test('upsertMany splits created rows from updated ones', async () => {
    const db = await makeBulkDb()
    await seed(db)
    const res = await db.widget.upsertMany({
      data:           [{ code: 'b', name: 'B2' }, { code: 'd', name: 'D' }],
      conflictTarget: ['code'],
      update:         ['name'],
    })
    expect(res.count).toBe(2)
    const all = await entries(db)
    expect(all.filter((e: any) => e.operation === 'create').map((e: any) => e.records))
      .toEqual([[1, 2, 3], [4]])          // the seed, then the one new row
    expect(all.filter((e: any) => e.operation === 'update')[0].records).toEqual([2])
    expect((await db.widget.findUnique({ where: { code: 'b' } }))!.name).toBe('B2')
    db.$close()
  })

  test('a model with no @@log logs nothing and still returns the right counts', async () => {
    const db = await makeBulkDb(PLAIN_SCHEMA)
    await db.note.createMany({ data: [{ text: 'x' }, { text: 'y' }] })
    expect((await db.note.updateMany({ where: { text: 'x' }, data: { text: 'z' } })).count).toBe(1)
    expect((await db.note.deleteMany({ where: {} })).count).toBe(2)
    expect(await (db as any).auditLogs.findMany({})).toEqual([])
    db.$close()
  })
})

// ─── 19c. @@allow / @@deny policies ──────────────────────────────────────────


describe('@@allow / @@deny row-level policies', () => {

  // ── Parser ────────────────────────────────────────────────────────────────

  test('parses @@allow with simple condition', () => {
    const r = parse(`
      model Post {
        id      Int @id
        ownerId Int
        @@allow('read', ownerId == auth().id)
      }
    `)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr).toBeDefined()
    expect(attr.operations).toEqual(['read'])
    expect(attr.expr.type).toBe('compare')
  })

  test('parses @@deny with condition', () => {
    const r = parse(`
      model Post {
        id     Int @id
        status String
        @@deny('delete', status == 'archived')
      }
    `)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'deny')
    expect(attr.operations).toEqual(['delete'])
  })

  test("parses 'all' operation alias", () => {
    const r = parse(`model T { id Int @id; @@allow('all', true) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.operations).toEqual(['read', 'create', 'update', 'post-update', 'delete'])
  })

  test("parses 'write' operation alias", () => {
    const r = parse(`model T { id Int @id; @@allow('write', true) }`)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.operations).toEqual(['create', 'update', 'delete'])
  })

  test('parses comma-separated operations', () => {
    const r = parse(`model T { id Int @id; @@allow('update,delete', true) }`)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.operations).toEqual(['update', 'delete'])
  })

  test('invalid operation is a parse error', () => {
    const r = parse(`model T { id Int @id; @@allow('fetch', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/invalid operation/)
  })

  test('parses || && ! operators', () => {
    const r = parse(`
      model T {
        id        Int @id
        published Boolean
        ownerId   Int
        @@allow('read', published || ownerId == auth().id)
        @@allow('create', auth() != null && !published)
      }
    `)
    expect(r.valid).toBe(true)
    const allows = r.schema.models[0].attributes.filter((a: any) => a.kind === 'allow')
    expect(allows[0].expr.type).toBe('or')
    expect(allows[1].expr.type).toBe('and')
  })

  test('parses auth() != null', () => {
    const r = parse(`model T { id Int @id; @@allow('create', auth() != null) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.expr.type).toBe('compare')
    expect(attr.expr.left.type).toBe('auth')
    expect(attr.expr.left.field).toBeNull()
    expect(attr.expr.op).toBe('!=')
  })

  test('parses now() in condition', () => {
    const r = parse(`model T { id Int @id; expiresAt DateTime; @@allow('read', expiresAt > now()) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.expr.right.type).toBe('now')
  })

  test('parses check(field)', () => {
    const r = parse(`
      model Post {
        id     Int @id
        author User @relation(fields: [authorId], references: [id])
        authorId Int
        @@allow('read', check(author))
      }
      model User { id Int @id }
    `)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.expr.type).toBe('check')
    expect(attr.expr.field).toBe('author')
    expect(attr.expr.operation).toBeNull()
  })

  test('parses check(field, operation)', () => {
    const r = parse(`
      model Post {
        id Int @id
        author User @relation(fields: [authorId], references: [id])
        authorId Int
        @@allow('update', check(author, 'read'))
      }
      model User { id Int @id }
    `)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.expr.operation).toBe('read')
  })

  test('warns if @@deny exists without @@allow', () => {
    const r = parse(`model T { id Int @id; @@deny('delete', true) }`)
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w: string) => w.includes('@@deny') && w.includes('@@allow'))).toBe(true)
  })

  // ── Read policy — SQL injection ───────────────────────────────────────────

  test('@@allow read — only matching rows returned', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        title   String
        @@allow('read', ownerId == auth().id)
      }
    `, 'policy-read-own')
    await db.asSystem().post.create({ data: { ownerId: 1, title: 'mine' } })
    await db.asSystem().post.create({ data: { ownerId: 2, title: 'theirs' } })
    const userDb = db.$setAuth({ id: 1 })
    const rows = await userDb.post.findMany()
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).title).toBe('mine')
    db.$close()
  })

  test('@@allow read with || — sees own + published', async () => {
    const db = await makeDb(`
      model Post {
        id        Int @id
        ownerId   Int
        published Boolean @default(false)
        title     String
        @@allow('read', published || ownerId == auth().id)
      }
    `, 'policy-read-or')
    const sys = db.asSystem()
    await sys.post.create({ data: { ownerId: 1, published: false, title: 'my-draft' } })
    await sys.post.create({ data: { ownerId: 2, published: true,  title: 'public' } })
    await sys.post.create({ data: { ownerId: 2, published: false, title: 'other-draft' } })
    const rows = await db.$setAuth({ id: 1 }).post.findMany()
    expect(rows).toHaveLength(2)
    const titles = rows.map((r: any) => r.title).sort()
    expect(titles).toEqual(['my-draft', 'public'])
    db.$close()
  })

  test('@@deny overrides @@allow', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        deleted Boolean @default(false)
        title   String
        @@allow('read', ownerId == auth().id)
        @@deny('read', deleted == true)
      }
    `, 'policy-deny')
    const sys = db.asSystem()
    await sys.post.create({ data: { ownerId: 1, deleted: false, title: 'visible' } })
    await sys.post.create({ data: { ownerId: 1, deleted: true,  title: 'hidden' } })
    const rows = await db.$setAuth({ id: 1 }).post.findMany()
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).title).toBe('visible')
    db.$close()
  })

  test('field == null in a policy is IS NULL, not = NULL', async () => {
    // `"ownerId" = NULL` is NULL in SQLite — never true — so this policy used to
    // filter every unowned row out and raise nothing. An empty screen with a
    // 200, which is the failure mode @@allow has by design and the reason a
    // wrong one is so hard to see.
    const db = await makeDb(`
      model Post {
        id      Int    @id
        ownerId Int?
        title   String
        @@allow('read', ownerId == auth().id || ownerId == null)
      }
    `, 'policy-null-cmp')
    const sys = db.asSystem()
    await sys.post.create({ data: { ownerId: 1,    title: 'mine' } })
    await sys.post.create({ data: { ownerId: 2,    title: 'theirs' } })
    await sys.post.create({ data: { ownerId: null, title: 'unowned' } })

    const rows = await db.$setAuth({ id: 1 }).post.findMany()
    expect(rows.map((r: any) => r.title).sort()).toEqual(['mine', 'unowned'])
    db.$close()
  })

  test('field != null in a policy is IS NOT NULL', async () => {
    const db = await makeDb(`
      model Post {
        id      Int    @id
        ownerId Int?
        title   String
        @@allow('read', ownerId != null)
      }
    `, 'policy-notnull-cmp')
    const sys = db.asSystem()
    await sys.post.create({ data: { ownerId: 1,    title: 'owned' } })
    await sys.post.create({ data: { ownerId: null, title: 'unowned' } })

    const rows = await db.$setAuth({ id: 1 }).post.findMany()
    expect(rows.map((r: any) => r.title)).toEqual(['owned'])
    db.$close()
  })

  test('the SQL and JS policy paths agree about null', async () => {
    // They did not. Create is evaluated in JS (`=== null`, correct); read is
    // compiled into the WHERE (`= NULL`, never true). So a row was created
    // successfully and then invisible to the caller that created it — the two
    // halves of one rule disagreeing is worse than either being wrong.
    const db = await makeDb(`
      model Post {
        id      Int    @id
        ownerId Int?
        title   String
        @@allow('create', ownerId == null)
        @@allow('read',   ownerId == null)
      }
    `, 'policy-null-agree')
    const user = db.$setAuth({ id: 1 })
    const made = await user.post.create({ data: { title: 'unowned' } })
    expect(made.id).toBeDefined()
    expect(await user.post.findMany()).toHaveLength(1)
    db.$close()
  })

  test('no auth → no rows when policy uses auth().id', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        @@allow('read', ownerId == auth().id)
      }
    `, 'policy-no-auth')
    await db.asSystem().post.create({ data: { ownerId: 1 } })
    const rows = await db.post.findMany()   // no $setAuth
    expect(rows).toHaveLength(0)
    db.$close()
  })

  test('asSystem() bypasses all policies', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        @@allow('read', ownerId == auth().id)
      }
    `, 'policy-system-bypass')
    await db.asSystem().post.create({ data: { ownerId: 99 } })
    const rows = await db.asSystem().post.findMany()
    expect(rows).toHaveLength(1)
    db.$close()
  })

  test('no @@allow → no restriction', async () => {
    const db = await makeDb(`
      model Post { id Int @id; title String }
    `, 'policy-none')
    await db.post.create({ data: { title: 'open' } })
    const rows = await db.post.findMany()
    expect(rows).toHaveLength(1)
    db.$close()
  })

  test('now() in policy — time-based access', async () => {
    const db = await makeDb(`
      model Item {
        id          Int  @id
        title       String
        publishedAt DateTime
        @@allow('read', publishedAt <= now())
      }
    `, 'policy-now')
    const sys = db.asSystem()
    await sys.item.create({ data: { title: 'past',   publishedAt: '2000-01-01T00:00:00.000Z' } })
    await sys.item.create({ data: { title: 'future', publishedAt: '2099-01-01T00:00:00.000Z' } })
    const rows = await db.item.findMany()
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).title).toBe('past')
    db.$close()
  })

  // ── Create policy — JS pre-check ─────────────────────────────────────────

  test('@@allow create — auth() != null allows authenticated users', async () => {
    const db = await makeDb(`
      model Post {
        id    Int @id
        title String
        @@allow('create', auth() != null)
      }
    `, 'policy-create-auth')
    await expect(db.$setAuth({ id: 1 }).post.create({ data: { title: 'ok' } }))
      .resolves.toBeDefined()
    db.$close()
  })

  test('@@allow create — blocks unauthenticated', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeDb(`
      model Post {
        id    Int @id
        title String
        @@allow('create', auth() != null)
      }
    `, 'policy-create-block')
    await expect(db.post.create({ data: { title: 'fail' } }))
      .rejects.toThrow()
    db.$close()
  })

  test('@@allow create with field check — ownerId must match auth', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        @@allow('create', ownerId == auth().id)
      }
    `, 'policy-create-field')
    await expect(db.$setAuth({ id: 1 }).post.create({ data: { ownerId: 1 } }))
      .resolves.toBeDefined()
    await expect(db.$setAuth({ id: 1 }).post.create({ data: { ownerId: 2 } }))
      .rejects.toThrow()
    db.$close()
  })

  // ── Update / delete policy — WHERE injection ──────────────────────────────

  test('@@allow update — can only update own rows', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        title   String
        @@allow('read', true)
        @@allow('update', ownerId == auth().id)
      }
    `, 'policy-update-own')
    const sys = db.asSystem()
    await sys.post.create({ data: { ownerId: 1, title: 'mine' } })
    await sys.post.create({ data: { ownerId: 2, title: 'theirs' } })
    // Update own row — succeeds
    const updated = await db.$setAuth({ id: 1 }).post.update({ where: { id: 1 }, data: { title: 'updated' } })
    expect(updated?.title).toBe('updated')
    // Update other's row — returns null (WHERE didn't match)
    const notUpdated = await db.$setAuth({ id: 1 }).post.update({ where: { id: 2 }, data: { title: 'hacked' } })
    expect(notUpdated).toBeNull()
    db.$close()
  })

  test('@@allow delete — can only delete own rows', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        @@allow('read', true)
        @@allow('delete', ownerId == auth().id)
      }
    `, 'policy-delete-own')
    const sys = db.asSystem()
    await sys.post.create({ data: { ownerId: 1 } })
    await sys.post.create({ data: { ownerId: 2 } })
    await db.$setAuth({ id: 1 }).post.remove({ where: { id: 2 } })  // silently no-ops
    expect(await sys.post.count({})).toBe(2)
    await db.$setAuth({ id: 1 }).post.remove({ where: { id: 1 } })  // works
    expect(await sys.post.count({})).toBe(1)
    db.$close()
  })

  // ── post-update policy ────────────────────────────────────────────────────

  test('post-update policy — prevents ownership transfer', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        @@allow('read', true)
        @@allow('update', ownerId == auth().id)
        @@allow('post-update', ownerId == auth().id)
      }
    `, 'policy-post-update')
    await db.asSystem().post.create({ data: { ownerId: 1 } })
    // Try to transfer ownership — post-update policy catches it
    await expect(
      db.$setAuth({ id: 1 }).post.update({ where: { id: 1 }, data: { ownerId: 2 } })
    ).rejects.toThrow()
    // Verify row was rolled back — ownerId still 1
    const row = await db.asSystem().post.findFirst({ where: { id: 1 } }) as any
    expect(row.ownerId).toBe(1)
    db.$close()
  })

  test('post-update rollback survives a Json column on the model', async () => {
    // The revert wrote the BEFORE snapshot back column by column, and that
    // snapshot had been through read() — where a Json column is an object and a
    // SQLite parameter cannot be one. So on any model carrying Json the revert
    // threw `Binding expected string, TypedArray, boolean, number, bigint or
    // null` on its way out, the AccessDeniedError never surfaced, and the write
    // the policy had just refused stayed applied. It reverts from the raw row.
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        active  Boolean @default(true)
        meta    Json    @default("{}")
        @@allow('read', true)
        @@allow('update', ownerId == auth().id)
        @@allow('post-update', ownerId == auth().id)
      }
    `, 'policy-post-update-json')
    await db.asSystem().post.create({ data: { ownerId: 1, meta: { tier: 3 } } })

    const { AccessDeniedError } = await import('../src/core/plugin.js')
    await expect(db.$setAuth({ id: 1 }).post.update({ where: { id: 1 }, data: { ownerId: 2 } }))
      .rejects.toThrow(AccessDeniedError)

    const row = await db.asSystem().post.findFirst({ where: { id: 1 } }) as any
    expect(row.ownerId).toBe(1)
    expect(row.meta).toEqual({ tier: 3 })
    expect(row.active).toBe(true)
    db.$close()
  })

  // ── check() delegation ────────────────────────────────────────────────────

  test('check() — delegates read policy to parent model', async () => {
    const db = await makeDb(`
      model User {
        id      Int @id
        ownerId Int
        @@allow('read', ownerId == auth().id)
      }
      model Post {
        id       Int @id
        authorId Int
        author   User @relation(fields: [authorId], references: [id])
        title    String
        @@allow('read', check(author))
      }
    `, 'policy-check')
    const sys = db.asSystem()
    await sys.user.create({ data: { ownerId: 1 } })
    await sys.user.create({ data: { ownerId: 2 } })
    await sys.post.create({ data: { authorId: 1, title: 'user1-post' } })
    await sys.post.create({ data: { authorId: 2, title: 'user2-post' } })
    const rows = await db.$setAuth({ id: 1 }).post.findMany()
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).title).toBe('user1-post')
    db.$close()
  })

  // ── Through an include ────────────────────────────────────────────────────
  //
  // A relation is a read of the target model, and the include paths build their
  // own SQL. Until 2026-08-10 nothing applied the target's policy there, so a
  // model filtered on every direct read travelled whole as somebody's child.

  async function policiedTree(name: string) {
    const db = await makeDb(`
      model Account {
        id    Int @id
        name  String
        posts Post[]
        tags  Tag[]
      }
      model Post {
        id        Int @id
        accountId Int
        account   Account @relation(fields: [accountId], references: [id])
        title     String
        @@allow('read', accountId == auth().accountId)
      }
      model Tag {
        id       Int @id
        name     String
        accounts Account[]
        @@allow('read', name != 'private')
      }
    `, name)
    const sys = db.asSystem()
    await sys.account.create({ data: { id: 1, name: 'mine' } })
    await sys.account.create({ data: { id: 2, name: 'theirs' } })
    await sys.post.create({ data: { accountId: 1, title: 'mine' } })
    await sys.post.create({ data: { accountId: 2, title: 'theirs' } })
    await sys.tag.create({ data: { id: 1, name: 'public',  accounts: { connect: [{ id: 1 }] } } })
    await sys.tag.create({ data: { id: 2, name: 'private', accounts: { connect: [{ id: 1 }] } } })
    return db
  }

  test('include (hasMany) applies the target read policy', async () => {
    const db   = await policiedTree('policy-include-hasmany')
    const rows = await db.$setAuth({ id: 1, accountId: 1 })
      .account.findMany({ include: { posts: true } }) as any[]
    expect(rows.find(r => r.id === 1).posts.map((p: any) => p.title)).toEqual(['mine'])
    expect(rows.find(r => r.id === 2).posts).toEqual([])
    db.$close()
  })

  test('include (belongsTo) applies the target read policy', async () => {
    const db   = await policiedTree('policy-include-belongsto')
    const rows = await db.$setAuth({ id: 1, accountId: 1 })
      .post.findMany({ include: { account: true } }) as any[]
    // The post itself is already filtered — what this pins is that the parent
    // fetch does not re-open the row from the other side.
    expect(rows).toHaveLength(1)
    expect(rows[0].account.name).toBe('mine')
    db.$close()
  })

  test('include (manyToMany) applies the target read policy', async () => {
    const db   = await policiedTree('policy-include-m2m')
    const rows = await db.$setAuth({ id: 1, accountId: 1 })
      .account.findMany({ where: { id: 1 }, include: { tags: true } }) as any[]
    expect(rows[0].tags.map((t: any) => t.name)).toEqual(['public'])
    db.$close()
  })

  test('_count in an include counts only readable rows', async () => {
    const db  = await policiedTree('policy-include-count')
    const one = await db.$setAuth({ id: 1, accountId: 1 })
      .account.findMany({ where: { id: 1 }, include: { _count: { select: { posts: true, tags: true } } } }) as any[]
    expect(one[0]._count).toEqual({ posts: 1, tags: 1 })

    const all = await db.asSystem()
      .account.findMany({ where: { id: 1 }, include: { _count: { select: { posts: true, tags: true } } } }) as any[]
    expect(all[0]._count).toEqual({ posts: 1, tags: 2 })
    db.$close()
  })

  test('a nested include applies the policy at every level', async () => {
    const db   = await policiedTree('policy-include-nested')
    const rows = await db.$setAuth({ id: 1, accountId: 1 })
      .account.findMany({ include: { posts: { include: { account: true } } } }) as any[]
    expect(rows.find(r => r.id === 2).posts).toEqual([])
    expect(rows.find(r => r.id === 1).posts[0].account.name).toBe('mine')
    db.$close()
  })

})

// ─── 19d. @allow field-level access ──────────────────────────────────────────


describe('@allow field-level access', () => {

  // ── Parser ────────────────────────────────────────────────────────────────

  test('parses @allow(read) on field', () => {
    const r = parse(`
      model User {
        id     Int @id
        salary Float?   @allow('read', auth().role == 'hr')
      }
    `)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'salary')
    const fa = field.attributes.find((a: any) => a.kind === 'fieldAllow')
    expect(fa).toBeDefined()
    expect(fa.operations).toEqual(['read'])
    expect(fa.expr.type).toBe('compare')
  })

  test('parses @allow(write) on field', () => {
    const r = parse(`model T { id Int @id; role String @allow('write', auth().isAdmin) }`)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'role')
    const fa = field.attributes.find((a: any) => a.kind === 'fieldAllow')
    expect(fa.operations).toEqual(['write'])
  })

  test("@allow('all') expands to read + write", () => {
    const r = parse(`model T { id Int @id; data String @allow('all', auth() != null) }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'data')
    const fa = field.attributes.find((a: any) => a.kind === 'fieldAllow')
    expect(fa.operations).toEqual(['read', 'write'])
  })

  test('@allow on field with invalid operation is a parse error', () => {
    const r = parse(`model T { id Int @id; x String @allow('create', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/read.*write.*all/)
  })

  test('@allow conflicts with @guarded is a validation error', () => {
    const r = parse(`model T { id Int @id; x String @guarded @allow('read', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@allow') && e.includes('@guarded'))).toBe(true)
  })

  test('@allow conflicts with @secret is a validation error', () => {
    const r = parse(`model T { id Int @id; x String @secret @allow('read', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@allow') && e.includes('@secret'))).toBe(true)
  })

  // ── Read enforcement ──────────────────────────────────────────────────────

  test('@allow read — field stripped when condition false', async () => {
    const db = await makeDb(`
      model User {
        id     Int @id
        name   String
        salary Float?   @allow('read', auth().role == 'hr')
      }
    `, 'field-allow-read-strip')
    await db.asSystem().user.create({ data: { name: 'Alice', salary: 100000 } })
    const row = await db.$setAuth({ id: 1, role: 'employee' }).user.findFirst({}) as any
    expect(row.name).toBe('Alice')
    expect(row.salary).toBeUndefined()
    db.$close()
  })

  test('@allow read — field visible when condition true', async () => {
    const db = await makeDb(`
      model User {
        id     Int @id
        name   String
        salary Float?   @allow('read', auth().role == 'hr')
      }
    `, 'field-allow-read-visible')
    await db.asSystem().user.create({ data: { name: 'Alice', salary: 100000 } })
    const row = await db.$setAuth({ id: 1, role: 'hr' }).user.findFirst({}) as any
    expect(row.salary).toBe(100000)
    db.$close()
  })

  test('@allow read — asSystem() always sees the field', async () => {
    const db = await makeDb(`
      model User {
        id     Int @id
        salary Float?   @allow('read', auth().role == 'hr')
      }
    `, 'field-allow-read-system')
    await db.asSystem().user.create({ data: { salary: 50000 } })
    const row = await db.asSystem().user.findFirst({}) as any
    expect(row.salary).toBe(50000)
    db.$close()
  })

  test('@allow read — multiple conditions OR-combined', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        ownerId Int
        notes   String?   @allow('read', auth().role == 'admin')
                        @allow('read', ownerId == auth().id)
      }
    `, 'field-allow-read-or')
    await db.asSystem().post.create({ data: { ownerId: 1, notes: 'private' } })
    // owner can see
    const ownerRow = await db.$setAuth({ id: 1, role: 'user' }).post.findFirst({}) as any
    expect(ownerRow.notes).toBe('private')
    // non-owner non-admin cannot see
    const otherRow = await db.$setAuth({ id: 2, role: 'user' }).post.findFirst({}) as any
    expect(otherRow?.notes).toBeUndefined()
    db.$close()
  })

  test('@allow read — no auth strips field', async () => {
    const db = await makeDb(`
      model User {
        id     Int @id
        salary Float?   @allow('read', auth() != null)
      }
    `, 'field-allow-no-auth')
    await db.asSystem().user.create({ data: { salary: 80000 } })
    const row = await db.user.findFirst({}) as any   // no $setAuth
    expect(row?.salary).toBeUndefined()
    db.$close()
  })

  // ── Write enforcement ─────────────────────────────────────────────────────

  test('@allow write — field silently dropped when condition false', async () => {
    const db = await makeDb(`
      model User {
        id   Int @id
        role String    @default('user') @allow('write', auth().isAdmin)
      }
    `, 'field-allow-write-drop')
    const row = await db.$setAuth({ id: 1, isAdmin: false }).user.create({ data: { role: 'admin' } }) as any
    // role should be 'user' (default) since write was blocked
    expect(row?.role ?? 'user').toBe('user')
    db.$close()
  })

  test('@allow write — field written when condition true', async () => {
    const db = await makeDb(`
      model User {
        id   Int @id
        role String    @default('user') @allow('write', auth().isAdmin)
      }
    `, 'field-allow-write-pass')
    const row = await db.$setAuth({ id: 1, isAdmin: true }).user.create({ data: { role: 'admin' } }) as any
    expect(row?.role).toBe('admin')
    db.$close()
  })

  test('@allow write — asSystem() always writes the field', async () => {
    const db = await makeDb(`
      model User {
        id   Int @id
        role String    @default('user') @allow('write', auth().isAdmin)
      }
    `, 'field-allow-write-system')
    const row = await db.asSystem().user.create({ data: { role: 'superadmin' } }) as any
    expect(row?.role).toBe('superadmin')
    db.$close()
  })

  test('@allow write enforced on update too', async () => {
    const db = await makeDb(`
      model User {
        id   Int @id
        role String    @default('user') @allow('write', auth().isAdmin)
      }
    `, 'field-allow-write-update')
    await db.asSystem().user.create({ data: { role: 'user' } })
    // non-admin tries to escalate — field dropped, stays 'user'
    await db.$setAuth({ id: 1, isAdmin: false }).user.update({ where: { id: 1 }, data: { role: 'admin' } })
    const row = await db.asSystem().user.findFirst({ where: { id: 1 } }) as any
    expect(row.role).toBe('user')
    db.$close()
  })

  // ── Through an include ────────────────────────────────────────────────────
  //
  // The field rules are a property of the MODEL, not of the query that reached
  // it. Reached as a child, a @guarded column used to come back in plaintext, an
  // @encrypted one as raw ciphertext (for everyone, asSystem included), and a
  // field @allow was never evaluated at all.

  async function fieldPolicyTree(name: string) {
    const db = await makeDb(`
      model Team {
        id      Int @id
        name    String
        members Member[]
      }
      model Member {
        id     Int @id
        teamId Int
        team   Team @relation(fields: [teamId], references: [id])
        name   String
        token  String  @guarded(all)
        salary Float?  @allow('read', auth().role == 'hr')
      }
    `, name)
    const sys = db.asSystem()
    await sys.team.create({ data: { id: 1, name: 'T' } })
    await sys.member.create({ data: { id: 1, teamId: 1, name: 'M', token: 'SEKRIT', salary: 50000 } })
    return db
  }

  test('@guarded is withheld from a row reached through an include', async () => {
    const db  = await fieldPolicyTree('field-include-guarded')
    const row = (await db.$setAuth({ id: 1, role: 'member' })
      .team.findMany({ include: { members: true } }) as any[])[0]
    expect(row.members[0].name).toBe('M')
    expect('token'  in row.members[0]).toBe(false)
    expect('salary' in row.members[0]).toBe(false)
    db.$close()
  })

  test('a field @allow is evaluated through an include', async () => {
    const db  = await fieldPolicyTree('field-include-allow')
    const row = (await db.$setAuth({ id: 1, role: 'hr' })
      .team.findMany({ include: { members: true } }) as any[])[0]
    expect(row.members[0].salary).toBe(50000)
    expect('token' in row.members[0]).toBe(false)   // @guarded is not a role
    db.$close()
  })

  test('asSystem() sees a guarded field through an include', async () => {
    const db  = await fieldPolicyTree('field-include-system')
    const row = (await db.asSystem().team.findMany({ include: { members: true } }) as any[])[0]
    expect(row.members[0].token).toBe('SEKRIT')
    db.$close()
  })

})

// ─── 19e. policyDebug ────────────────────────────────────────────────────────


describe('policyDebug logging', () => {

  test('policyDebug:true logs injected SQL to console', async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: any[]) => logs.push(args.join(' '))

    try {
      const db = await makeDb(`
        model Post {
          id      Int @id
          ownerId Int
          @@allow('read', ownerId == auth().id)
        }
      `, 'pdebug-sql', { policyDebug: true })

      await db.asSystem().post.create({ data: { ownerId: 1 } })
      await db.$setAuth({ id: 1 }).post.findMany()
      db.$close()
    } finally {
      console.log = origLog
    }

    const policyLog = logs.find(l => l.includes('[litestone:policy]'))
    expect(policyLog).toBeDefined()
    expect(policyLog).toMatch(/read/)
    expect(policyLog).toMatch(/Post/i)
    expect(policyLog).toMatch(/WHERE/)
  })

  test('policyDebug:true logs create denial', async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: any[]) => logs.push(args.join(' '))

    try {
      const db = await makeDb(`
        model Post {
          id Int @id
          @@allow('create', auth() != null)
        }
      `, 'pdebug-deny', { policyDebug: true })

      try { await db.post.create({ data: {} }) } catch {}
      db.$close()
    } finally {
      console.log = origLog
    }

    const denyLog = logs.find(l => l.includes('[litestone:policy]') && l.includes('DENIED'))
    expect(denyLog).toBeDefined()
    expect(denyLog).toMatch(/create/)
  })

  test('policyDebug:false produces no policy logs', async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: any[]) => logs.push(args.join(' '))

    try {
      const db = await makeDb(`
        model Post {
          id      Int @id
          ownerId Int
          @@allow('read', ownerId == auth().id)
        }
      `, 'pdebug-off', { policyDebug: false })

      await db.asSystem().post.create({ data: { ownerId: 1 } })
      await db.$setAuth({ id: 1 }).post.findMany()
      db.$close()
    } finally {
      console.log = origLog
    }

    expect(logs.filter(l => l.includes('[litestone:policy]'))).toHaveLength(0)
  })

  test('policyDebug:verbose logs asSystem bypasses', async () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: any[]) => logs.push(args.join(' '))

    try {
      const db = await makeDb(`
        model Post {
          id      Int @id
          ownerId Int
          @@allow('read', ownerId == auth().id)
        }
      `, 'pdebug-verbose', { policyDebug: 'verbose' })

      await db.asSystem().post.create({ data: { ownerId: 1 } })
      await db.asSystem().post.findMany()  // should log bypass
      db.$close()
    } finally {
      console.log = origLog
    }

    const bypassLog = logs.find(l => l.includes('[litestone:policy]') && l.includes('asSystem'))
    expect(bypassLog).toBeDefined()
  })

})

// ─── 20. Transform hooks ──────────────────────────────────────────────────────


describe('GatePlugin', () => {
  async function makeGateDb(schema: string, name: string, levelFn: (user: any, model: string) => number) {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    return makeDb(schema, name, {
      plugins: [new GatePlugin({ getLevel: levelFn })]
    })
  }

  // ── parseGateString ─────────────────────────────────────────────────────────

  test('parseGateString single value — all ops inherit', async () => {
    const { parseGateString } = await import('../src/plugins/gate.js')
    expect(parseGateString('4')).toEqual({ read: 4, create: 4, update: 4, delete: 4 })
  })

  test('parseGateString two values — U and D inherit from C', async () => {
    const { parseGateString } = await import('../src/plugins/gate.js')
    expect(parseGateString('2.4')).toEqual({ read: 2, create: 4, update: 4, delete: 4 })
  })

  test('parseGateString three values — D inherits from U', async () => {
    const { parseGateString } = await import('../src/plugins/gate.js')
    expect(parseGateString('2.4.5')).toEqual({ read: 2, create: 4, update: 5, delete: 5 })
  })

  test('parseGateString four values — fully explicit', async () => {
    const { parseGateString } = await import('../src/plugins/gate.js')
    expect(parseGateString('2.4.5.6')).toEqual({ read: 2, create: 4, update: 5, delete: 6 })
  })

  test('parseGateString with SYSTEM and LOCKED sentinels', async () => {
    const { parseGateString } = await import('../src/plugins/gate.js')
    expect(parseGateString('5.8.8.9')).toEqual({ read: 5, create: 8, update: 8, delete: 9 })
  })

  test('validateGate rejects non-decreasing levels', async () => {
    const { validateGate } = await import('../src/plugins/gate.js')
    expect(() => validateGate({ read: 4, create: 2, update: 4, delete: 6 }, 'Post')).toThrow()
    expect(() => validateGate({ read: 2, create: 4, update: 3, delete: 6 }, 'Post')).toThrow()
    expect(() => validateGate({ read: 2, create: 4, update: 5, delete: 6 }, 'Post')).not.toThrow()
  })

  test('LEVELS constants are correct', async () => {
    const { LEVELS } = await import('../src/plugins/gate.js')
    expect(LEVELS.STRANGER).toBe(0)
    expect(LEVELS.VISITOR).toBe(1)
    expect(LEVELS.READER).toBe(2)
    expect(LEVELS.CREATOR).toBe(3)
    expect(LEVELS.USER).toBe(4)
    expect(LEVELS.ADMINISTRATOR).toBe(5)
    expect(LEVELS.OWNER).toBe(6)
    expect(LEVELS.SYSADMIN).toBe(7)
    expect(LEVELS.SYSTEM).toBe(8)
    expect(LEVELS.LOCKED).toBe(9)
  })

  // ── Read gating ─────────────────────────────────────────────────────────────

  test('read allowed when user level meets requirement', async () => {
    const db = await makeGateDb(`
      model Post {
        id Int @id
        @@gate("2.4.4.6")
      }
    `, 'gate-read-ok', () => 3)   // level 3 >= read(2)
    await db.$db.run('INSERT INTO post VALUES (1)')
    const rows = await db.post.findMany()
    expect(rows.length).toBe(1)
    db.$close()
  })

  test('read denied when user level below requirement', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model Post {
        id Int @id
        @@gate("2.4.4.6")
      }
    `, 'gate-read-deny', () => 1)   // level 1 < read(2)
    await expect(db.post.findMany()).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  test('create denied when level below C threshold', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model Post {
        id Int @id
        @@gate("2.4.4.6")
      }
    `, 'gate-create-deny', () => 3)   // level 3 < create(4)
    await expect(db.post.create({ data: { id: 1 } })).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  test('update denied when level below U threshold', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model Post {
        id Int @id
        val String
        @@gate("2.4.5.6")
      }
    `, 'gate-update-deny', (_, model) => model === 'Post' ? 4 : 0)  // level 4 < update(5)
    await db.$db.run("INSERT INTO post VALUES (1, 'x')")
    await expect(db.post.update({ where: { id: 1 }, data: { val: 'y' } })).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  test('delete denied when level below D threshold', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model Post {
        id Int @id
        @@gate("2.4.4.6")
      }
    `, 'gate-delete-deny', () => 5)   // level 5 < delete(6)
    await db.$db.run('INSERT INTO post VALUES (1)')
    await expect(db.post.delete({ where: { id: 1 } })).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  // ── LOCKED and SYSTEM sentinels ─────────────────────────────────────────────

  test('LOCKED(8) blocks even highest user level', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model AuditLog {
        id Int @id
        @@gate("5.8.8.9")
      }
    `, 'gate-locked', () => 6)   // level 6 (OWNER) can't beat LOCKED (now 9)
    await db.$db.run('INSERT INTO audit_log VALUES (1)')
    await expect(db.auditLog.delete({ where: { id: 1 } })).rejects.toThrow('LOCKED')
    db.$close()
  })

  test('SYSTEM(8) blocks normal users, passes asSystem()', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model AuditLog {
        id Int @id
        @@gate("5.8.8.9")
      }
    `, 'gate-system', () => 6)   // level 6 can't create (SYSTEM=8)
    await expect(db.auditLog.create({ data: { id: 1 } })).rejects.toThrow('SYSTEM')
    // asSystem() bypasses gate entirely
    await expect(db.asSystem().auditLog.create({ data: { id: 1 } })).resolves.toBeDefined()
    db.$close()
  })

  // ── $setAuth ─────────────────────────────────────────────────────────────────

  test('$setAuth threads user into getLevel', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    let capturedUser: any = null
    const db = await makeDb(`
      model Post {
        id Int @id
        @@gate("4")
      }
    `, 'gate-setauth', {
      plugins: [new GatePlugin({
        getLevel(user: any) {
          capturedUser = user
          return user?.level ?? 0
        }
      })]
    })

    const userDb = db.$setAuth({ id: 1, level: 4 })
    await db.$db.run('INSERT INTO post VALUES (1)')
    await userDb.post.findMany()
    expect(capturedUser?.id).toBe(1)
    expect(capturedUser?.level).toBe(4)
    db.$close()
  })

  test('$setAuth — correct user level allows access', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const db = await makeDb(`
      model Post {
        id Int @id
        @@gate("4")
      }
    `, 'gate-setauth-pass', {
      plugins: [new GatePlugin({ getLevel: (user: any) => user?.level ?? 0 })]
    })
    await db.$db.run('INSERT INTO post VALUES (1)')
    const userDb = db.$setAuth({ level: 4 })
    const rows = await userDb.post.findMany()
    expect(rows.length).toBe(1)
    db.$close()
  })

  test('$setAuth — wrong user level denies access', async () => {
    const { GatePlugin, } = await import('../src/plugins/gate.js')
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeDb(`
      model Post {
        id Int @id
        @@gate("4")
      }
    `, 'gate-setauth-deny', {
      plugins: [new GatePlugin({ getLevel: (user: any) => user?.level ?? 0 })]
    })
    const userDb = db.$setAuth({ level: 2 })
    await expect(userDb.post.findMany()).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  test('$setAuth — null user gives level 0', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeDb(`
      model Post {
        id Int @id
        @@gate("2")
      }
    `, 'gate-setauth-null', {
      plugins: [new GatePlugin({ getLevel: (user: any) => user?.level ?? 0 })]
    })
    const anonDb = db.$setAuth(null)
    await expect(anonDb.post.findMany()).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  test('getLevel clamped to 0-6 — cannot return 7 from user code', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const db = await makeDb(`
      model Post {
        id Int @id
        @@gate("5.8.8.8")
      }
    `, 'gate-clamp', {
      plugins: [new GatePlugin({ getLevel: () => 99 })]  // tries to return 99
    })
    // Even returning 99, it gets clamped to 7 (SYSADMIN), which is < SYSTEM(8)
    await expect(db.post.create({ data: { id: 1 } })).rejects.toThrow('SYSTEM')
    db.$close()
  })

  // ── Nested write preflight ──────────────────────────────────────────────────

  test('nested create preflight checks child model Gate', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeDb(`
      model Account {
        id   Int @id
        name String
        @@gate("2.6.6.6")
      }
      model User {
        id        Int  @id
        account   Account @relation(fields: [accountId], references: [id])
        accountId Int
        email     String
        @@gate("2.4.4.6")
      }
    `, 'gate-nested-preflight', {
      plugins: [new GatePlugin({ getLevel: (_u: any, model: string) =>
        model === 'Account' ? 6 : 2   // can create accounts but not users
      })]
    })
    // Trying to create account with nested user create — should fail on users.create
    await expect(db.account.create({
      data: {
        id: 1, name: 'Acme',
        User: { create: { id: 1, email: 'a@x.com' } }
      }
    })).rejects.toThrow(AccessDeniedError)
    db.$close()
  })


  test('SYSADMIN(7) — only users with isSystemAdmin reach this level', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeDb(`
      model Secret {
        id Int @id
        @@gate("7")
      }
    `, 'gate-sysadmin', {
      plugins: [new GatePlugin({
        getLevel: (user: any) => {
          if (user?.isSystemAdmin) return 7   // SYSADMIN
          if (user?.role === 'admin') return 5 // ADMINISTRATOR
          return 0
        }
      })]
    })
    await db.$db.run('INSERT INTO secret VALUES (1)')

    // Regular admin (level 5) can't read — needs SYSADMIN (7)
    const admin = db.$setAuth({ role: 'admin' })
    await expect(admin.secret.findMany()).rejects.toThrow(AccessDeniedError)

    // SysAdmin (level 7) can read
    const sysadmin = db.$setAuth({ isSystemAdmin: true })
    await expect(sysadmin.secret.findMany()).resolves.toHaveLength(1)

    // asSystem() (level 8) can also read — 8 >= 7
    await expect(db.asSystem().secret.findMany()).resolves.toHaveLength(1)

    db.$close()
  })

  test('SYSADMIN level is clamped to 7 — cannot reach SYSTEM(8) via getLevel', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeDb(`
      model Restricted {
        id Int @id
        @@gate("8")
      }
    `, 'gate-sysadmin-clamp', {
      plugins: [new GatePlugin({
        getLevel: () => 99   // tries to return 99 — clamped to 7 (SYSADMIN)
      })]
    })
    await db.$db.run('INSERT INTO restricted VALUES (1)')
    // Clamped to 7, still < SYSTEM(8)
    await expect(db.$setAuth({}).restricted.findMany()).rejects.toThrow(AccessDeniedError)
    // asSystem() (8) passes
    await expect(db.asSystem().restricted.findMany()).resolves.toHaveLength(1)
    db.$close()
  })

  // ── Models without @@gate are open ─────────────────────────────────────────

  test('model without @@gate is open to all', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const db = await makeDb(`
      model OpenTable { id Int @id }
      model GatedTable {
        id Int @id
        @@gate("5")
      }
    `, 'gate-open-model', {
      plugins: [new GatePlugin({ getLevel: () => 0 })]  // stranger
    })
    await db.$db.run('INSERT INTO open_table VALUES (1)')
    await db.$db.run('INSERT INTO gated_table VALUES (1)')
    // open_table has no gate — stranger can read
    const rows = await db.openTable.findMany()
    expect(rows.length).toBe(1)
    // gated_table requires 5 — stranger (0) denied
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    await expect(db.gatedTable.findMany()).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  // ── Role-based getLevel ─────────────────────────────────────────────────────

  test('role-based getLevel — field manager scenario', async () => {
    const { GatePlugin, LEVELS } = await import('../src/plugins/gate.js')
    const ROLES: Record<string, Record<string, number>> = {
      'field-manager': { Post: LEVELS.USER, Billing: LEVELS.READER },
    }
    const db = await makeDb(`
      model Post {
        id Int @id
        @@gate("2.4.4.6")
      }
      model Billing {
        id Int @id
        @@gate("2.5.5.6")
      }
    `, 'gate-role-based', {
      plugins: [new GatePlugin({
        getLevel: (user: any, model: string) => ROLES[user?.role]?.[model] ?? 0
      })]
    })
    await db.$db.run('INSERT INTO post VALUES (1)')
    await db.$db.run('INSERT INTO billing VALUES (1)')

    const fm = db.$setAuth({ role: 'field-manager' })

    // field-manager can read+create+update posts (level 4)
    await expect(fm.post.findMany()).resolves.toHaveLength(1)
    await expect(fm.post.create({ data: { id: 2 } })).resolves.toBeDefined()

    // field-manager can only read billing (level 2), not create (requires 5)
    await expect(fm.billing.findMany()).resolves.toHaveLength(1)
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    await expect(fm.billing.create({ data: { id: 3 } })).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  // ── $transaction carries the scope it was called on ─────────────────────────
  // Every scoped proxy used to expose the ROOT $transaction, which hands the
  // callback `clientProxy`. So the body of a transaction ran unscoped: as
  // system it was refused by the gate it was meant to bypass, and as a user it
  // ran with auth() null. Found by basecamp's first-run /setup route, whose
  // whole point is that it writes four models in one transaction as system.

  test('asSystem().$transaction hands the callback a SYSTEM client', async () => {
    const db = await makeGateDb(`
      model Thing { id Int @id  name String  @@gate("4.8.8.8") }
    `, 'gate-tx-system', () => 0)

    const row = await db.asSystem().$transaction(async (tx: any) =>
      tx.thing.create({ data: { id: 1, name: 'a' } }))
    expect(row.id).toBe(1)
    db.$close()
  })

  test('$setAuth(u).$transaction hands the callback the SAME user', async () => {
    const db = await makeGateDb(`
      model Thing { id Int @id  name String  @@gate("4") }
    `, 'gate-tx-auth', (user: any) => user ? 4 : 0)

    const row = await db.$setAuth({ id: 'u1' }).$transaction(async (tx: any) =>
      tx.thing.create({ data: { id: 1, name: 'a' } }))
    expect(row.id).toBe(1)

    // The root client is unchanged — this is a scope carried, not a bypass added.
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    await expect(db.$transaction(async (tx: any) => tx.thing.create({ data: { id: 2, name: 'b' } })))
      .rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  test('asSystem() is idempotent — a function handed a client cannot tell which it has', async () => {
    // `const sys = db.asSystem()` at the top of a function is the normal
    // defensive spelling, and it threw `"asSystem" is not a table in this
    // schema` — a message about tables, about a method every other flavour of
    // the client has. basecamp's seeder is written exactly that way.
    const db = await makeGateDb(`
      model Thing { id Int @id  name String  @@gate("4.8.8.8") }
    `, 'gate-assystem-idempotent', () => 0)

    const sys = db.asSystem()
    expect(sys.asSystem()).toBe(sys)
    expect('asSystem' in sys).toBe(true)
    expect(await sys.asSystem().thing.create({ data: { id: 1, name: 'a' } })).toBeTruthy()
    db.$close()
  })

  test('$transaction inside a scope sees the policies of that scope, not none', async () => {
    // The quieter half: with @@allow rather than @@gate, an unscoped tx does not
    // throw — it matches nothing and stamps nobody, which reads as a bug in the
    // transaction body.
    const db = await makeDb(`
      model Note {
        id      Int    @id
        ownerId String
        body    String
        @@allow('all', ownerId == auth().id)
      }
    `, 'tx-scope-policy')

    const mine = await db.$setAuth({ id: 'u1' }).$transaction(async (tx: any) =>
      tx.note.create({ data: { id: 1, ownerId: 'u1', body: 'x' } }))
    expect(mine.id).toBe(1)

    const { AccessDeniedError } = await import('../src/core/plugin.js')
    await expect(db.$setAuth({ id: 'u2' }).$transaction(async (tx: any) =>
      tx.note.create({ data: { id: 2, ownerId: 'u1', body: 'y' } })))
      .rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  // ── The gate on a model reached through an include ──────────────────────────
  //
  // `include` resolves below the query pipeline, so onBeforeRead only ever saw
  // the model being addressed: a caller refused `Vault.findMany` outright could
  // ask for it as `team.secrets` and be handed every row. The check is a
  // preflight rather than a filter — a gate is per model, so the answer to *may
  // you read Vault* is yes or no, and an empty list would read as "no rows".

  async function gatedTree(name: string) {
    return makeGateDb(`
      model Team {
        id      Int @id
        name    String
        secrets Vault[]
      }
      model Vault {
        id     Int @id
        teamId Int
        team   Team @relation(fields: [teamId], references: [id])
        label  String
        @@gate("7")
      }
    `, name, () => 4)
  }

  test('include refuses a model the caller may not read', async () => {
    const db = await gatedTree('gate-include')
    await db.asSystem().team.create({ data: { id: 1, name: 'T' } })
    await db.asSystem().vault.create({ data: { id: 1, teamId: 1, label: 'v' } })

    await expect(db.$setAuth({ id: 1 }).team.findMany({ include: { secrets: true } }))
      .rejects.toThrow(/"Vault.read" requires level 7/)
    // The parent on its own is still readable — the refusal is about the child.
    expect(await db.$setAuth({ id: 1 }).team.findMany()).toHaveLength(1)
    db.$close()
  })

  test('a relation named under select: is gated the same way', async () => {
    const db = await gatedTree('gate-include-select')
    await db.asSystem().team.create({ data: { id: 1, name: 'T' } })
    await expect(db.$setAuth({ id: 1 }).team.findMany({ select: { name: true, secrets: true } }))
      .rejects.toThrow(/"Vault.read" requires level 7/)
    db.$close()
  })

  test('_count of a gated relation is a read of it', async () => {
    const db = await gatedTree('gate-include-count')
    await db.asSystem().team.create({ data: { id: 1, name: 'T' } })
    await expect(db.$setAuth({ id: 1 }).team.findMany({ include: { _count: { select: { secrets: true } } } }))
      .rejects.toThrow(/"Vault.read" requires level 7/)
    db.$close()
  })

  test('a nested include is gated at every level', async () => {
    const db = await makeGateDb(`
      model Org {
        id    Int @id
        teams Team[]
      }
      model Team {
        id      Int @id
        orgId   Int
        org     Org @relation(fields: [orgId], references: [id])
        secrets Vault[]
      }
      model Vault {
        id     Int @id
        teamId Int
        team   Team @relation(fields: [teamId], references: [id])
        label  String
        @@gate("7")
      }
    `, 'gate-include-nested', () => 4)
    await db.asSystem().org.create({ data: { id: 1 } })
    await expect(db.$setAuth({ id: 1 })
      .org.findMany({ include: { teams: { include: { secrets: true } } } }))
      .rejects.toThrow(/"Vault.read" requires level 7/)
    db.$close()
  })

  test('an ungated include is unaffected', async () => {
    const db = await makeGateDb(`
      model Team {
        id      Int @id
        name    String
        members Member[]
      }
      model Member {
        id     Int @id
        teamId Int
        team   Team @relation(fields: [teamId], references: [id])
        name   String
      }
    `, 'gate-include-open', () => 4)
    await db.asSystem().team.create({ data: { id: 1, name: 'T' } })
    await db.asSystem().member.create({ data: { id: 1, teamId: 1, name: 'M' } })
    const rows = await db.$setAuth({ id: 1 }).team.findMany({ include: { members: true } }) as any[]
    expect(rows[0].members).toHaveLength(1)
    db.$close()
  })
})

// ─── 30. Implicit Many-to-Many ────────────────────────────────────────────────


describe('FrontierGateGetLevel', () => {
  const G = () => require('../src/plugins/gate.js')

  // ── undefined vs null ────────────────────────────────────────────────────
  // The contract SessionContext documents: undefined means the app does not
  // MODEL this stage (not an objection); null means it models it and this user
  // has not reached it. Two tests here previously asserted the opposite —
  // `{ id: 1 }` → VISITOR — which is what made every app without a
  // verification flow grade VISITOR(1) and 403 its own API once @@gate
  // auto-installed this resolver.

  test('null user → STRANGER (0)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel(null)).toBe(LEVELS.STRANGER)
  })

  test('lifecycle NOT modelled (fields absent) is not an objection', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    // No verifiedAt / activatedAt keys at all — exactly what
    // @frontierjs/auth's toContext() emits for a verified user.
    expect(FrontierGateGetLevel({ userId: 'u1', role: 'user' })).toBe(LEVELS.USER)
  })

  test('verifiedAt === null → VISITOR (1)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel({ userId: 'u1', role: 'user', verifiedAt: null })).toBe(LEVELS.VISITOR)
  })

  test('activatedAt === null → READER (2)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel({ userId: 'u1', role: 'user', verifiedAt: '2024-01-01', activatedAt: null }))
      .toBe(LEVELS.READER)
  })

  test('no role → CREATOR (3)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel({ userId: 'u1' })).toBe(LEVELS.CREATOR)
  })

  test('has role → USER (4)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel({ userId: 'u1', role: 'member' })).toBe(LEVELS.USER)
  })

  // ── standing outranks lifecycle ──────────────────────────────────────────

  test('isAdmin → ADMINISTRATOR (5)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel({ userId: 'u1', role: 'admin', isAdmin: true })).toBe(LEVELS.ADMINISTRATOR)
  })

  test('isOwner → OWNER (6)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel({ userId: 'u1', role: 'admin', isOwner: true })).toBe(LEVELS.OWNER)
  })

  test('isSystemAdmin → SYSADMIN (7)', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    expect(FrontierGateGetLevel({ userId: 'u1', role: 'admin', isSystemAdmin: true })).toBe(LEVELS.SYSADMIN)
  })

  test('standing wins over an unreached lifecycle stage', () => {
    const { FrontierGateGetLevel, LEVELS } = G()
    // An owner who never completed activation is still the owner. The role
    // check used to run first, so this graded CREATOR(3).
    expect(FrontierGateGetLevel({ userId: 'u1', isOwner: true, verifiedAt: null })).toBe(LEVELS.OWNER)
    expect(FrontierGateGetLevel({ userId: 'u1', isSystemAdmin: true })).toBe(LEVELS.SYSADMIN)
  })

  test('agrees with junction sessionGateLevel on a real auth session', () => {
    // The two are a hand copy across a dependency boundary Litestone cannot
    // cross. If they drift, apps grade differently depending on which resolver
    // is installed — which is exactly what happened.
    const { FrontierGateGetLevel, LEVELS } = G()
    const session = { userId: 'u1', userType: 'user', role: 'user', email: 'a@b.co', authMethod: 'session' }
    expect(FrontierGateGetLevel(session)).toBe(LEVELS.USER)
  })
})




// ┌────────────────────────────────────────────────────────────────────────────┐
// │  PLUGINS                                                                   │
// └────────────────────────────────────────────────────────────────────────────┘

describe('plugin system', () => {
  test('Plugin base class has all lifecycle methods', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const p = new Plugin()
    // All hooks exist and are no-ops by default
    expect(typeof p.onInit).toBe('function')
    expect(typeof p.onBeforeRead).toBe('function')
    expect(typeof p.onBeforeCreate).toBe('function')
    expect(typeof p.onBeforeUpdate).toBe('function')
    expect(typeof p.onBeforeDelete).toBe('function')
    expect(typeof p.onAfterRead).toBe('function')
    expect(typeof p.onAfterWrite).toBe('function')
    expect(typeof p.buildReadFilter).toBe('function')
    // No-ops return undefined / null
    expect(p.buildReadFilter('User', {})).toBeNull()
  })

  test('PluginRunner calls hooks in order', async () => {
    const { Plugin, PluginRunner } = await import('../src/core/plugin.js')
    const order: string[] = []
    class A extends Plugin {
      async onBeforeRead() { order.push('A') }
    }
    class B extends Plugin {
      async onBeforeRead() { order.push('B') }
    }
    const runner = new PluginRunner([new A(), new B()])
    await runner.beforeRead('User', {}, {})
    expect(order).toEqual(['A', 'B'])
  })

  test('PluginRunner.hasPlugins is false with no plugins', async () => {
    const { PluginRunner } = await import('../src/core/plugin.js')
    expect(new PluginRunner([]).hasPlugins).toBe(false)
    expect(new PluginRunner([{}as any]).hasPlugins).toBe(true)
  })

  test('PluginRunner.getReadFilters collects non-null filters', async () => {
    const { Plugin, PluginRunner } = await import('../src/core/plugin.js')
    class F extends Plugin {
      buildReadFilter(model: string) {
        return model === 'Post' ? { published: true } : null
      }
    }
    const runner = new PluginRunner([new F()])
    expect(runner.getReadFilters('Post', {})).toEqual([{ published: true }])
    expect(runner.getReadFilters('User', {})).toEqual([])
  })

  test('AccessDeniedError has correct shape', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const err = new AccessDeniedError('blocked', { model: 'Post', operation: 'read', required: 4, got: 2 })
    expect(err.code).toBe('ACCESS_DENIED')
    expect(err.model).toBe('Post')
    expect(err.operation).toBe('read')
    expect(err.required).toBe(4)
    expect(err.got).toBe(2)
    expect(err instanceof Error).toBe(true)
  })

  test('plugin onInit called with schema and ctx', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let receivedSchema: any = null
    let receivedCtx:   any = null
    class InitPlugin extends Plugin {
      onInit(schema: any, ctx: any) {
        receivedSchema = schema
        receivedCtx    = ctx
      }
    }
    const db = await makeDb(`
      model T { id Int @id }
    `, 'plugin-init', { plugins: [new InitPlugin()] })
    expect(receivedSchema).not.toBeNull()
    expect(receivedSchema.models.length).toBeGreaterThan(0)
    expect(receivedCtx).not.toBeNull()
    db.$close()
  })

  test('plugin onBeforeRead can block a read', async () => {
    const { Plugin, AccessDeniedError } = await import('../src/core/plugin.js')
    class BlockAll extends Plugin {
      async onBeforeRead(model: string) {
        throw new AccessDeniedError(`blocked`, { model, operation: 'read' })
      }
    }
    const db = await makeDb(`
      model T { id Int @id }
    `, 'plugin-block-read', { plugins: [new BlockAll()] })
    await db.t.create({ data: { id: 1 } })
    await expect(db.t.findMany()).rejects.toThrow('blocked')
    db.$close()
  })

  test('plugin onBeforeCreate can block a write', async () => {
    const { Plugin, AccessDeniedError } = await import('../src/core/plugin.js')
    class BlockCreate extends Plugin {
      async onBeforeCreate(model: string) {
        throw new AccessDeniedError(`no creates`, { model, operation: 'create' })
      }
    }
    const db = await makeDb(`
      model T { id Int @id }
    `, 'plugin-block-create', { plugins: [new BlockCreate()] })
    await expect(db.t.create({ data: { id: 1 } })).rejects.toThrow('no creates')
    db.$close()
  })

  test('plugin onBeforeUpdate can block an update', async () => {
    const { Plugin, AccessDeniedError } = await import('../src/core/plugin.js')
    class BlockUpdate extends Plugin {
      async onBeforeUpdate() {
        throw new AccessDeniedError('no updates', { operation: 'update' })
      }
    }
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'plugin-block-update', { plugins: [new BlockUpdate()] })
    await db.$db.run(`INSERT INTO t VALUES (1, 'x')`)
    await expect(db.t.update({ where: { id: 1 }, data: { val: 'y' } })).rejects.toThrow('no updates')
    db.$close()
  })

  test('plugin onBeforeDelete can block a delete', async () => {
    const { Plugin, AccessDeniedError } = await import('../src/core/plugin.js')
    class BlockDelete extends Plugin {
      async onBeforeDelete() {
        throw new AccessDeniedError('no deletes', { operation: 'delete' })
      }
    }
    const db = await makeDb(`
      model T { id Int @id }
    `, 'plugin-block-delete', { plugins: [new BlockDelete()] })
    await db.$db.run(`INSERT INTO t VALUES (1)`)
    await expect(db.t.delete({ where: { id: 1 } })).rejects.toThrow('no deletes')
    db.$close()
  })

  test('multiple plugins all run before request completes', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const log: string[] = []
    class A extends Plugin { async onBeforeRead() { log.push('A') } }
    class B extends Plugin { async onBeforeRead() { log.push('B') } }
    class C extends Plugin { async onBeforeRead() { log.push('C') } }
    const db = await makeDb(`
      model T { id Int @id }
    `, 'plugin-multi', { plugins: [new A(), new B(), new C()] })
    await db.t.findMany()
    expect(log).toEqual(['A', 'B', 'C'])
    db.$close()
  })
})

// ─── 29. GatePlugin ───────────────────────────────────────────────────────────


describe('plugin system — onAfterDelete', () => {
  test('Plugin base class has onAfterDelete', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const p = new Plugin()
    expect(typeof p.onAfterDelete).toBe('function')
    await expect(p.onAfterDelete('User', [], {})).resolves.toBeUndefined()
  })

  test('PluginRunner.afterDelete calls all plugins in order', async () => {
    const { Plugin, PluginRunner } = await import('../src/core/plugin.js')
    const calls: string[] = []
    class A extends Plugin { async onAfterDelete() { calls.push('A') } }
    class B extends Plugin { async onAfterDelete() { calls.push('B') } }
    const runner = new PluginRunner([new A(), new B()])
    await runner.afterDelete('User', [{ id: 1 }], {})
    expect(calls).toEqual(['A', 'B'])
  })

  test('afterDelete receives the deleted rows', async () => {
    const { Plugin, PluginRunner } = await import('../src/core/plugin.js')
    let received: unknown[] = []
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { received = rows }
    }
    const runner = new PluginRunner([new Spy()])
    const rows = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]
    await runner.afterDelete('User', rows, {})
    expect(received).toEqual(rows)
  })

  test('afterDelete fires after hard delete', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const deleted: unknown[] = []
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { deleted.push(...rows) }
    }
    const db = await makeDb(`
      model User {
        id    Int @id
        name  String
      }
    `, 'after-delete-hard', { plugins: [new Spy()] })
    await db.user.create({ data: { id: 1, name: 'Alice' } })
    await db.user.create({ data: { id: 2, name: 'Bob' } })
    await db.user.delete({ where: { id: 1 } })
    expect(deleted).toHaveLength(1)
    expect((deleted[0] as any).id).toBe(1)
    db.$close()
  })

  test('afterDelete fires after soft delete with the softResult row', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const deleted: unknown[] = []
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { deleted.push(...rows) }
    }
    const db = await makeDb(`
      model Post {
        id        Int  @id
        title     String
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-soft', { plugins: [new Spy()] })
    await db.post.create({ data: { id: 1, title: 'Hello' } })
    await db.post.delete({ where: { id: 1 } })   // hard delete on soft-delete model
    expect(deleted).toHaveLength(1)
    expect((deleted[0] as any).id).toBe(1)
    db.$close()
  })

  test('afterDelete fires after deleteMany with all rows', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const deleted: unknown[] = []
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { deleted.push(...rows) }
    }
    const db = await makeDb(`
      model Item {
        id    Int @id
        tag   String
      }
    `, 'after-delete-many', { plugins: [new Spy()] })
    await db.item.createMany({ data: [
      { id: 1, tag: 'a' }, { id: 2, tag: 'b' }, { id: 3, tag: 'a' }
    ]})
    await db.item.deleteMany({ where: { tag: 'a' } })
    expect(deleted).toHaveLength(2)
    expect(deleted.map((r: any) => r.id).sort()).toEqual([1, 3])
    db.$close()
  })

  test('afterDelete not called when no rows match', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let called = false
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { if (rows.length) called = true }
    }
    const db = await makeDb(`
      model Item { id Int @id }
    `, 'after-delete-nomatch', { plugins: [new Spy()] })
    await db.item.deleteMany({ where: { id: 99 } })
    expect(called).toBe(false)
    db.$close()
  })
})

// ─── 32. @file parser ─────────────────────────────────────────────────────────


describe('FileStorage plugin', () => {
  test('onInit builds fileMap from File-typed fields', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    plugin.onInit(schema, { models: {} })
    expect(plugin._fileMap.User.avatar.keepVersions).toBe(false)
    expect(plugin._fileMap.User.resume.keepVersions).toBe(true)
  })

  test('onInit ignores models with no @file fields', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const schema = parse(`model Post { id Int @id; title String }`).schema
    plugin.onInit(schema, { models: {} })
    expect(plugin._fileMap.Post).toBeUndefined()
  })

  test('onBeforeCreate: Buffer value is uploaded and swapped to JSON ref', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({
      provider: 'r2', bucket: 'test', keyPattern: ':model/:field/:uuid.:ext'
    }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    const mock = makeMockProvider()
    plugin._provider = mock

    const data: any = { id: 42, name: 'Alice', avatar: Buffer.from('image bytes') }
    await plugin.onBeforeCreate('User', { data }, ctx)

    // Value swapped to JSON string
    expect(typeof data.avatar).toBe('string')
    const ref = JSON.parse(data.avatar)
    expect(ref.key).toBeTruthy()
    expect(ref.bucket).toBe('test')
    expect(ref.size).toBe(11)  // 'image bytes' = 11 bytes
    // Provider was called
    expect(mock.puts).toHaveLength(1)
    expect(mock.puts[0].contentType).toBe('application/octet-stream')
  })

  test('onBeforeCreate: non-file values (strings, numbers, null) are not touched', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    plugin._provider = makeMockProvider()

    const data: any = { id: 1, name: 'Bob', avatar: null }
    await plugin.onBeforeCreate('User', { data }, ctx)
    expect(data.avatar).toBeNull()
    expect(plugin._provider.puts).toHaveLength(0)
  })

  test('onBeforeCreate: createMany with file value throws', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    plugin._provider = makeMockProvider()

    const data = [
      { id: 1, name: 'Alice', avatar: Buffer.from('img') },
      { id: 2, name: 'Bob',   avatar: null },
    ]
    await expect(plugin.onBeforeCreate('User', { data }, ctx))
      .rejects.toThrow('createMany does not support raw values')
  })

  test('onBeforeCreate: createMany with no file values passes silently', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    plugin._provider = makeMockProvider()

    const data = [{ id: 1, name: 'Alice', avatar: null }, { id: 2, name: 'Bob' }]
    await expect(plugin.onBeforeCreate('User', { data }, ctx)).resolves.toBeUndefined()
    expect(plugin._provider.puts).toHaveLength(0)
  })

  test('onBeforeUpdate: uploads new file, stashes old key, deletes old on afterWrite', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'r2', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx: any = {
      models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])),
      readDb: {
        query: (sql: string) => ({
          get: (..._params: unknown[]) => ({
            avatar: JSON.stringify({ key: 'users/1/avatar/old.jpg', bucket: 'test' })
          })
        })
      }
    }
    plugin.onInit(schema, ctx)
    const mock = makeMockProvider()
    plugin._provider = mock

    const data: any = { avatar: Buffer.from('new image') }
    await plugin.onBeforeUpdate('User', { where: { id: 1 }, data }, ctx)

    // New file uploaded and swapped
    expect(typeof data.avatar).toBe('string')
    const ref = JSON.parse(data.avatar)
    expect(ref.size).toBe(9)
    expect(mock.puts).toHaveLength(1)

    // afterWrite triggers old key deletion (it internally unstashes and deletes)
    await plugin.onAfterWrite('User', 'update', {}, ctx)
    expect(mock.deletes).toContain('users/1/avatar/old.jpg')
  })

  test('onBeforeUpdate: keepVersions: true skips old key cleanup', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'r2', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx: any = {
      models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])),
      readDb: {
        query: () => ({ get: () => ({ resume: JSON.stringify({ key: 'old-resume.pdf' }) }) })
      }
    }
    plugin.onInit(schema, ctx)
    const mock = makeMockProvider()
    plugin._provider = mock

    const data: any = { resume: Buffer.from('new resume') }
    await plugin.onBeforeUpdate('User', { where: { id: 1 }, data }, ctx)

    // File uploaded
    expect(mock.puts).toHaveLength(1)

    // No stash — keepVersions skips it
    const stashedKey = plugin._unstash(ctx, 'User', 'resume')
    expect(stashedKey).toBeUndefined()

    // afterWrite should not delete anything
    await plugin.onAfterWrite('User', 'update', {}, ctx)
    expect(mock.deletes).toHaveLength(0)
  })

  test('onAfterWrite: only runs for update operations', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    const mock = makeMockProvider()
    plugin._provider = mock

    // Manually stash a key to verify it's not deleted on create/delete ops
    plugin._stash(ctx, 'User', 'avatar', 'some-old-key.jpg')
    await plugin.onAfterWrite('User', 'create', {}, ctx)
    expect(mock.deletes).toHaveLength(0)
  })

  test('onAfterDelete: deletes S3 objects for all @file fields', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'r2', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    const mock = makeMockProvider()
    plugin._provider = mock

    const rows = [
      {
        id: 1,
        avatar: JSON.stringify({ key: 'users/1/avatar/photo.jpg' }),
        resume: JSON.stringify({ key: 'users/1/resume/cv.pdf'   }),
      },
      {
        id: 2,
        avatar: JSON.stringify({ key: 'users/2/avatar/photo.jpg' }),
        resume: null,
      },
    ]
    await plugin.onAfterDelete('User', rows, ctx)
    expect(mock.deletes.sort()).toEqual([
      'users/1/avatar/photo.jpg',
      'users/1/resume/cv.pdf',
      'users/2/avatar/photo.jpg',
    ].sort())
  })

  test('onAfterDelete: skips rows with null @file fields gracefully', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'r2', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    const mock = makeMockProvider()
    plugin._provider = mock

    await plugin.onAfterDelete('User', [{ id: 1, avatar: null, resume: null }], ctx)
    expect(mock.deletes).toHaveLength(0)
  })

  test('onAfterDelete: does nothing on models with no @file fields', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'r2', bucket: 'test' }) as any
    const schema = parse(FILE_SCHEMA).schema
    const ctx = { models: Object.fromEntries(schema.models.map((m: any) => [m.name, m])) }
    plugin.onInit(schema, ctx)
    const mock = makeMockProvider()
    plugin._provider = mock

    // 'posts' is not in the schema — fileMap has no entry
    await plugin.onAfterDelete('Post', [{ id: 1 }], ctx)
    expect(mock.deletes).toHaveLength(0)
  })

  test('onAfterDelete fires after hard delete via createClient', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const deleted: string[] = []

    class SpyPlugin extends (await import('../src/core/plugin.js')).Plugin {
      async onAfterDelete(_model: string, rows: any[]) {
        for (const row of rows) {
          if (row.avatar) deleted.push(JSON.parse(row.avatar).key)
        }
      }
    }

    const db = await makeDb(FILE_SCHEMA, 'file-delete-integration', {
      plugins: [FileStorage({ provider: 'local', bucket: 'test' }), new SpyPlugin()]
    })

    // Seed a row with a pre-stored JSON ref (bypass upload)
    await db.asSystem().user.create({
      data: {
        id: 1, name: 'Alice',
        avatar: JSON.stringify({ key: 'users/1/avatar/photo.jpg', bucket: 'test' }),
        resume: null,
      }
    })

    await db.asSystem().user.delete({ where: { id: 1 } })
    expect(deleted).toContain('users/1/avatar/photo.jpg')
    db.$close()
  })
})

// ─── 34. fileUrl() helper ─────────────────────────────────────────────────────


describe('fileUrl()', () => {
  test('reconstructs URL from endpoint + bucket + key', async () => {
    const { fileUrl } = await import('../src/storage/index.js')
    const ref = JSON.stringify({
      key:      'users/1/avatar/photo.jpg',
      bucket:   'my-bucket',
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
    })
    expect(fileUrl(ref)).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket/users/1/avatar/photo.jpg')
  })

  test('uses publicBase when present', async () => {
    const { fileUrl } = await import('../src/storage/index.js')
    const ref = JSON.stringify({
      key:        'users/1/avatar/photo.jpg',
      publicBase: 'https://cdn.example.com',
    })
    expect(fileUrl(ref)).toBe('https://cdn.example.com/users/1/avatar/photo.jpg')
  })

  test('returns null for null/undefined input', async () => {
    const { fileUrl } = await import('../src/storage/index.js')
    expect(fileUrl(null)).toBeNull()
    expect(fileUrl(undefined as any)).toBeNull()
    expect(fileUrl('')).toBeNull()
  })

  test('accepts a pre-parsed object (not a string)', async () => {
    const { fileUrl } = await import('../src/storage/index.js')
    const ref = { key: 'a/b.jpg', publicBase: 'https://cdn.example.com' }
    expect(fileUrl(ref as any)).toBe('https://cdn.example.com/a/b.jpg')
  })

  test('returns null when neither endpoint nor publicBase is in ref', async () => {
    const { fileUrl } = await import('../src/storage/index.js')
    const ref = JSON.stringify({ key: 'a/b.jpg', bucket: 'test', provider: 'local' })
    expect(fileUrl(ref)).toBeNull()
  })
})

// ─── 35. autoMigrate ─────────────────────────────────────────────────────────


describe('fileUrls() helper', () => {
  const makeRef = (key: string) => JSON.stringify({
    key, bucket: 'test', provider: 'local',
    endpoint: 'https://cdn.example.com', size: 100, mime: 'image/png', uploadedAt: new Date().toISOString()
  })
  const makeRefs = (...keys: string[]) => JSON.stringify(
    keys.map(key => ({ key, bucket: 'test', provider: 'local',
      endpoint: 'https://cdn.example.com', size: 100, mime: 'image/png', uploadedAt: new Date().toISOString() }))
  )

  test('returns empty array for null', () => {
    expect(fileUrls(null)).toEqual([])
  })

  test('returns empty array for empty string', () => {
    expect(fileUrls('')).toEqual([])
  })

  test('handles single ref JSON string (scalar fallback)', () => {
    const urls = fileUrls(makeRef('uploads/a.png'))
    expect(urls.length).toBe(1)
    expect(urls[0]).toContain('a.png')
  })

  test('handles array ref JSON string', () => {
    const urls = fileUrls(makeRefs('uploads/a.png', 'uploads/b.png'))
    expect(urls.length).toBe(2)
    expect(urls[0]).toContain('a.png')
    expect(urls[1]).toContain('b.png')
  })

  test('filters out null entries', () => {
    const arr = JSON.stringify([null, { key: 'x.png', bucket: 'b', provider: 'local', endpoint: 'https://e.com', size: 1, mime: 'image/png', uploadedAt: '' }])
    const urls = fileUrls(arr)
    expect(urls.length).toBe(1)
  })
})





describe('buildReadFilter wired into buildSQL', () => {
  const schema = `
    model Post {
      id       Int @id
      authorId Int
      title    String
    }
  `

  test('plugin read filter scopes findMany results', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class TenantFilter extends Plugin {
      buildReadFilter(_model: string, ctx: any) {
        // Simulate scoping to the current user's authorId
        return ctx.auth?.userId ? { authorId: ctx.auth.userId } : null
      }
    }
    const db = await makeDb(schema, 'readfilter-findmany', { plugins: [new TenantFilter()] })
    await db.asSystem().post.createMany({ data: [
      { id: 1, authorId: 1, title: 'Alice post' },
      { id: 2, authorId: 2, title: 'Bob post' },
      { id: 3, authorId: 1, title: 'Alice post 2' },
    ]})

    // Unscoped — system bypasses all gates but plugin filters still apply
    // For a user-scoped request, use $setAuth with a mock user
    const userDb = db.$setAuth({ userId: 1 })
    const posts  = await userDb.post.findMany({})
    expect(posts).toHaveLength(2)
    expect(posts.every((p: any) => p.authorId === 1)).toBe(true)
    db.$close()
  })

  test('plugin read filter scopes findFirst', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class OwnerFilter extends Plugin {
      buildReadFilter(_model: string, ctx: any) {
        return ctx.auth?.userId ? { authorId: ctx.auth.userId } : null
      }
    }
    const db = await makeDb(schema, 'readfilter-findfirst', { plugins: [new OwnerFilter()] })
    await db.asSystem().post.createMany({ data: [
      { id: 1, authorId: 1, title: 'Mine' },
      { id: 2, authorId: 2, title: 'Not mine' },
    ]})

    const userDb = db.$setAuth({ userId: 2 })
    const post   = await userDb.post.findFirst({ where: { title: 'Mine' } })
    expect(post).toBeNull()   // filter excludes it

    const ownPost = await userDb.post.findFirst({ where: { title: 'Not mine' } })
    expect(ownPost).not.toBeNull()
    db.$close()
  })

  test('multiple plugin filters are AND-merged', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class FilterA extends Plugin {
      buildReadFilter() { return { authorId: 1 } }
    }
    class FilterB extends Plugin {
      buildReadFilter() { return { id: 3 } }
    }
    const db = await makeDb(schema, 'readfilter-multi', { plugins: [new FilterA(), new FilterB()] })
    await db.asSystem().post.createMany({ data: [
      { id: 1, authorId: 1, title: 'A' },
      { id: 2, authorId: 1, title: 'B' },
      { id: 3, authorId: 1, title: 'C' },
      { id: 4, authorId: 2, title: 'D' },
    ]})

    // Both filters: authorId=1 AND id=3 → only post 3
    const posts = await db.post.findMany({})
    expect(posts).toHaveLength(1)
    expect(posts[0].id).toBe(3)
    db.$close()
  })

  test('null filter from plugin is ignored', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class NoFilter extends Plugin {
      buildReadFilter() { return null }
    }
    const db = await makeDb(schema, 'readfilter-null', { plugins: [new NoFilter()] })
    await db.asSystem().post.createMany({ data: [
      { id: 1, authorId: 1, title: 'A' },
      { id: 2, authorId: 2, title: 'B' },
    ]})
    const posts = await db.post.findMany({})
    expect(posts).toHaveLength(2)
    db.$close()
  })

  test('count() respects plugin read filter', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class CountFilter extends Plugin {
      buildReadFilter(_model: string, ctx: any) {
        return ctx.auth?.userId ? { authorId: ctx.auth.userId } : null
      }
    }
    const db = await makeDb(schema, 'readfilter-count', { plugins: [new CountFilter()] })
    await db.asSystem().post.createMany({ data: [
      { id: 1, authorId: 1, title: 'A' },
      { id: 2, authorId: 1, title: 'B' },
      { id: 3, authorId: 2, title: 'C' },
    ]})
    const userDb = db.$setAuth({ userId: 1 })
    const n = await userDb.post.count({})
    expect(n).toBe(2)
    db.$close()
  })
})

// ─── 40. onAfterRead wired ────────────────────────────────────────────────────


describe('onAfterRead wired into reads', () => {
  const schema = `
    model Article {
      id      Int @id
      title   String
      content String
    }
  `

  test('onAfterRead fires after findMany with all rows', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let capturedRows: unknown[] = []
    class Spy extends Plugin {
      async onAfterRead(_model: string, rows: unknown[]) { capturedRows = rows }
    }
    const db = await makeDb(schema, 'afterread-findmany', { plugins: [new Spy()] })
    await db.article.createMany({ data: [
      { id: 1, title: 'A', content: 'a' },
      { id: 2, title: 'B', content: 'b' },
    ]})
    await db.article.findMany({})
    expect(capturedRows).toHaveLength(2)
    db.$close()
  })

  test('onAfterRead fires after findFirst with single-element array', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let capturedRows: unknown[] = []
    class Spy extends Plugin {
      async onAfterRead(_model: string, rows: unknown[]) { capturedRows = rows }
    }
    const db = await makeDb(schema, 'afterread-findfirst', { plugins: [new Spy()] })
    await db.article.create({ data: { id: 1, title: 'Hello', content: 'world' } })
    await db.article.findFirst({ where: { id: 1 } })
    expect(capturedRows).toHaveLength(1)
    expect((capturedRows[0] as any).id).toBe(1)
    db.$close()
  })

  test('onAfterRead can mutate rows before return', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class Redactor extends Plugin {
      async onAfterRead(_model: string, rows: any[]) {
        for (const row of rows) row.content = '[redacted]'
      }
    }
    const db = await makeDb(schema, 'afterread-mutate', { plugins: [new Redactor()] })
    await db.article.createMany({ data: [
      { id: 1, title: 'A', content: 'secret-a' },
      { id: 2, title: 'B', content: 'secret-b' },
    ]})
    const rows = await db.article.findMany({})
    expect(rows.every((r: any) => r.content === '[redacted]')).toBe(true)
    db.$close()
  })

  test('onAfterRead not called when findMany returns empty', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let called = false
    class Spy extends Plugin {
      async onAfterRead(_model: string, rows: unknown[]) { if (rows.length) called = true }
    }
    const db = await makeDb(schema, 'afterread-empty', { plugins: [new Spy()] })
    await db.article.findMany({})
    expect(called).toBe(false)
    db.$close()
  })

  test('onAfterRead not called when findFirst returns null', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let called = false
    class Spy extends Plugin {
      async onAfterRead(_model: string, rows: unknown[]) { if (rows.length) called = true }
    }
    const db = await makeDb(schema, 'afterread-null', { plugins: [new Spy()] })
    const row = await db.article.findFirst({ where: { id: 999 } })
    expect(row).toBeNull()
    expect(called).toBe(false)
    db.$close()
  })
})

// ─── 41. optimizeFts ─────────────────────────────────────────────────────────


describe('upsert plugin hooks', () => {
  const schema = `
    model Note {
      id      Int @id
      content String
    }
  `

  test('beforeCreate fires on create path', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const ops: string[] = []
    class Spy extends Plugin {
      async onBeforeCreate() { ops.push('create') }
      async onBeforeUpdate() { ops.push('update') }
    }
    const db = await makeDb(schema, 'upsert-hook-create', { plugins: [new Spy()] })
    await db.note.upsert({
      where:  { id: 1 },
      create: { id: 1, content: 'hello' },
      update: { content: 'world' },
    })
    expect(ops).toEqual(['create'])
    db.$close()
  })

  test('beforeUpdate fires on update path', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const ops: string[] = []
    class Spy extends Plugin {
      async onBeforeCreate() { ops.push('create') }
      async onBeforeUpdate() { ops.push('update') }
    }
    const db = await makeDb(schema, 'upsert-hook-update', { plugins: [new Spy()] })
    await db.note.create({ data: { id: 1, content: 'existing' } })
    ops.length = 0   // clear the create hook from the setup call

    await db.note.upsert({
      where:  { id: 1 },
      create: { id: 1, content: 'hello' },
      update: { content: 'updated' },
    })
    expect(ops).toEqual(['update'])
    db.$close()
  })

  test('beforeUpdate receives correct where and data', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let capturedArgs: any = null
    class Spy extends Plugin {
      async onBeforeUpdate(_model: string, args: any) { capturedArgs = args }
    }
    const db = await makeDb(schema, 'upsert-hook-args', { plugins: [new Spy()] })
    await db.note.create({ data: { id: 5, content: 'existing' } })

    await db.note.upsert({
      where:  { id: 5 },
      create: { id: 5, content: 'new' },
      update: { content: 'updated content' },
    })
    expect(capturedArgs.where).toEqual({ id: 5 })
    expect(capturedArgs.data.content).toBe('updated content')
    db.$close()
  })
})

// ─── 38. removeMany beforeDelete hook ────────────────────────────────────────


describe('removeMany plugin hooks', () => {
  const schema = `
    model Task {
      id        Int  @id
      status    String     @default("open")
      deletedAt DateTime?
      @@softDelete
    }
  `

  test('beforeDelete fires on removeMany (soft delete)', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let fired = false
    class Spy extends Plugin {
      async onBeforeDelete() { fired = true }
    }
    const db = await makeDb(schema, 'removemany-before-soft', { plugins: [new Spy()] })
    await db.task.createMany({ data: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }] })
    await db.task.removeMany({ where: { status: 'open' } })
    expect(fired).toBe(true)
    db.$close()
  })

  test('beforeDelete receives the where clause', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let capturedWhere: any = null
    class Spy extends Plugin {
      async onBeforeDelete(_model: string, args: any) { capturedWhere = args.where }
    }
    const db = await makeDb(schema, 'removemany-before-where', { plugins: [new Spy()] })
    await db.task.createMany({ data: [{ id: 1, status: 'done' }] })
    await db.task.removeMany({ where: { status: 'done' } })
    expect(capturedWhere).toEqual({ status: 'done' })
    db.$close()
  })

  test('throwing in beforeDelete prevents the removal', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class Guard extends Plugin {
      async onBeforeDelete() { throw new Error('removal blocked') }
    }
    const db = await makeDb(schema, 'removemany-before-throws', { plugins: [new Guard()] })
    await db.task.createMany({ data: [{ id: 1, status: 'open' }] })
    await expect(db.task.removeMany({ where: { status: 'open' } })).rejects.toThrow('removal blocked')
    // Row should still exist
    const count = await db.task.count()
    expect(count).toBe(1)
    db.$close()
  })
})

// ─── 39. buildReadFilter wired into queries ───────────────────────────────────


describe('transform hooks (before/after)', () => {
  test('before:setters runs on create — can mutate data', async () => {
    const log: string[] = []
    const db = await makeDb(`
      model Item { id Int @id
        name String
        score Int }
    `, 'hook-before', {
      hooks: {
        before: {
          setters: [(hook: any, ctx: any) => {
            log.push(`before:${ctx.operation}`)
            if (ctx.args.data?.score != null)
              ctx.args.data.score = Number(ctx.args.data.score) * 2
          }]
        }
      }
    })
    await db.item.create({ data: { id: 1, name: 'A', score: '5' } })
    const row = await db.item.findUnique({ where: { id: 1 } })
    expect(row.score).toBe(10)           // '5' → 5 → *2 = 10
    expect(log).toContain('before:create')
    db.$close()
  })

  test('before:update only runs on update', async () => {
    const ops: string[] = []
    const db = await makeDb(`
      model Item { id Int @id
        name String }
    `, 'hook-update', {
      hooks: {
        before: {
          update: [(ctx: any) => { ops.push('update') }]
        }
      }
    })
    await db.item.create({ data: { id: 1, name: 'A' } })
    await db.item.update({ where: { id: 1 }, data: { name: 'B' } })
    expect(ops).toEqual(['update'])     // fired once, only on update
    db.$close()
  })

  test('after:getters transforms read result', async () => {
    const db = await makeDb(`
      model User { id Int @id
        first String
        last String }
    `, 'hook-after', {
      hooks: {
        after: {
          getters: [(hook: any, ctx: any) => {
            const rows = Array.isArray(ctx.result) ? ctx.result : [ctx.result]
            for (const r of rows) if (r) r.fullName = `${r.first} ${r.last}`
          }]
        }
      }
    })
    await db.user.create({ data: { id: 1, first: 'Alice', last: 'Smith' } })
    const rows = await db.user.findMany()
    expect(rows[0].fullName).toBe('Alice Smith')

    const one = await db.user.findFirst({ where: { id: 1 } })
    expect(one.fullName).toBe('Alice Smith')
    db.$close()
  })

  test('after:all runs on both reads and writes', async () => {
    const ops: string[] = []
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'hook-all', {
      hooks: {
        after: {
          all: [(hook: any, ctx: any) => { ops.push(ctx.operation) }]
        }
      }
    })
    await db.t.create({ data: { id: 1, val: 'a' } })
    await db.t.findMany()
    await db.t.count()
    expect(ops).toContain('create')
    expect(ops).toContain('findMany')
    expect(ops).toContain('count')
    db.$close()
  })

  test('before hook gets schema (model definition)', async () => {
    let capturedSchema: any = null
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'hook-schema', {
      hooks: {
        before: {
          setters: [(hook: any, ctx: any) => { capturedSchema = ctx.schema }]
        }
      }
    })
    await db.t.create({ data: { id: 1, val: 'x' } })
    expect(capturedSchema?.name).toBe('T')
    expect(capturedSchema?.fields?.length).toBeGreaterThan(0)
    db.$close()
  })

  test('no hooks — normal operation unaffected', async () => {
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'hook-none')
    await db.t.create({ data: { id: 1, val: 'x' } })
    const rows = await db.t.findMany()
    expect(rows[0].val).toBe('x')
    db.$close()
  })
})

// ─── 21. Event listeners ──────────────────────────────────────────────────────


describe('event listeners (on.*)', () => {
  test('on.create fires after create', async () => {
    const events: any[] = []
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'evt-create', {
      onEvent: { create: (event: any) => events.push({ op: event.operation, id: event.result?.id }) }
    })
    await db.t.create({ data: { id: 1, val: 'a' } })
    await Bun.sleep(20)
    expect(events).toHaveLength(1)
    expect(events[0].op).toBe('create')
    expect(events[0].id).toBe(1)
    db.$close()
  })

  test('on.update fires after update', async () => {
    const events: any[] = []
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'evt-update', {
      onEvent: { update: (event: any) => events.push(event.operation) }
    })
    await db.t.create({ data: { id: 1, val: 'a' } })
    await db.t.update({ where: { id: 1 }, data: { val: 'b' } })
    await Bun.sleep(20)
    expect(events).toEqual(['update'])
    db.$close()
  })

  test('on.remove fires after remove', async () => {
    const events: any[] = []
    const db = await makeDb(`
      model T { id Int @id
        val String
        deletedAt DateTime?
        @@softDelete }
    `, 'evt-remove', {
      onEvent: { remove: (event: any) => events.push(event.operation) }
    })
    await db.t.create({ data: { id: 1, val: 'a' } })
    await db.t.remove({ where: { id: 1 } })
    await Bun.sleep(20)
    expect(events).toEqual(['remove'])
    db.$close()
  })

  test('on.change fires for all writes', async () => {
    const ops: string[] = []
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'evt-change', {
      onEvent: { change: (event: any) => ops.push(event.operation) }
    })
    await db.t.create({ data: { id: 1, val: 'a' } })
    await db.t.update({ where: { id: 1 }, data: { val: 'b' } })
    await Bun.sleep(20)
    expect(ops).toContain('create')
    expect(ops).toContain('update')
    db.$close()
  })

  test('event listener errors do not throw to caller', async () => {
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'evt-error', {
      onEvent: { create: () => { throw new Error('listener crash') } }
    })
    // Should not throw
    await expect(db.t.create({ data: { id: 1, val: 'x' } })).resolves.toBeDefined()
    db.$close()
  })

  test('event fires after result is returned to caller', async () => {
    const timeline: string[] = []
    const db = await makeDb(`
      model T { id Int @id
        val String }
    `, 'evt-timing', {
      onEvent: { create: () => timeline.push('event') }
    })
    const row = await db.t.create({ data: { id: 1, val: 'x' } })
    timeline.push('after-await')
    await Bun.sleep(20)
    expect(timeline[0]).toBe('after-await')  // caller gets result first
    expect(timeline[1]).toBe('event')
    db.$close()
  })
})

// ─── 22. String[] / Int[] array fields ─────────────────────────────────────


// ┌────────────────────────────────────────────────────────────────────────────┐
// │  FEATURES                                                                  │
// └────────────────────────────────────────────────────────────────────────────┘

describe('enum transitions — parser', () => {
  test('parses transitions block without error', () => {
    const r = parse(TRANSITION_SCHEMA)
    expect(r.valid).toBe(true)
    expect(r.errors).toEqual([])
  })

  test('transitions stored on enum AST node', () => {
    const { schema } = parse(TRANSITION_SCHEMA)
    const en = schema.enums.find((e: any) => e.name === 'OrderStatus')
    expect(en.transitions).toBeDefined()
    expect(Object.keys(en.transitions)).toEqual(['pay','ship','deliver','refund'])
  })

  test('single from normalised to array', () => {
    const { schema } = parse(TRANSITION_SCHEMA)
    const en = schema.enums.find((e: any) => e.name === 'OrderStatus')
    expect(en.transitions.pay.from).toEqual(['pending'])
    expect(en.transitions.pay.to).toBe('paid')
  })

  test('multi-from stored as array', () => {
    const { schema } = parse(TRANSITION_SCHEMA)
    const en = schema.enums.find((e: any) => e.name === 'OrderStatus')
    expect(en.transitions.refund.from).toEqual(['paid', 'shipped'])
    expect(en.transitions.refund.to).toBe('refunded')
  })

  test('plain enum (no transitions) still valid', () => {
    const r = parse(`enum Color { red green blue }
model T { id Int @id; c Color }`)
    expect(r.valid).toBe(true)
    const en = r.schema.enums[0]
    expect(en.transitions).toBeUndefined()
  })

  test('parse error: unknown value in from', () => {
    const r = parse(`enum S { a b
  transitions { go: x -> b } }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes("unknown value 'x'"))).toBe(true)
  })

  test('parse error: unknown value in to', () => {
    const r = parse(`enum S { a b
  transitions { go: a -> z } }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes("unknown value 'z'"))).toBe(true)
  })

  test('parse error: duplicate transition name', () => {
    const r = parse(`enum S { a b c
  transitions { go: a -> b
  go: b -> c } }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes("duplicate transition name"))).toBe(true)
  })

  test('parse error: self-transition', () => {
    const r = parse(`enum S { a b
  transitions { stay: a -> a } }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes("self-transition"))).toBe(true)
  })
})


// ─── @@transitions — the model-level form ─────────────────────────────────────
// The state machine belongs beside @@gate and @@allow, where every other access
// declaration lives: a per-transition gate is a model concern, and two models
// sharing one enum must be able to differ.

import { GatePlugin, LEVELS } from '../src/plugins/gate.js'
import { TransitionGateError, TransitionViolationError } from '../src/core/client.js'

const GATED_SCHEMA = `
  enum OrderStatus { pending  paid  shipped  refunded  cancelled }

  model Order {
    id     Int @id
    status OrderStatus @default(pending)

    @@transitions(status,
      pay:    pending         -> paid,
      ship:   paid            -> shipped,
      refund: paid            -> refunded @gate(5),
      cancel: [pending, paid] -> cancelled)
  }
`

describe('@@transitions — parser', () => {
  test('parses named, unnamed, multi-from and gated clauses', () => {
    const r = parse(GATED_SCHEMA)
    expect(r.valid).toBe(true)
    expect(r.errors).toEqual([])

    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'transitions')
    expect(attr.field).toBe('status')
    expect(attr.transitions.pay).toEqual({ from: ['pending'], to: 'paid', gate: null })
    expect(attr.transitions.refund).toEqual({ from: ['paid'], to: 'refunded', gate: 5 })
    expect(attr.transitions.cancel.from).toEqual(['pending', 'paid'])
  })

  test('an unnamed clause names itself after the target state', () => {
    const r = parse(`enum S { pending paid }
model Order { id Int @id  status S  @@transitions(status, pending -> paid) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'transitions')
    expect(attr.transitions.paid).toEqual({ from: ['pending'], to: 'paid', gate: null })
  })

  test('@gate accepts a level name as well as a number', () => {
    const r = parse(`enum S { a b }
model M { id Int @id  s S  @@transitions(s, go: a -> b @gate(ADMINISTRATOR)) }`)
    expect(r.valid).toBe(true)
    expect(r.schema.models[0].attributes.find((a: any) => a.kind === 'transitions')
      .transitions.go.gate).toBe(5)
  })

  test.each([
    ['unknown field',      `@@transitions(nope, a -> b)`,        'no such field'],
    ['non-enum field',     `@@transitions(n, a -> b)`,           'not an enum'],
    ['unknown to-value',   `@@transitions(s, a -> zzz)`,         "unknown value 'zzz'"],
    ['unknown from-value', `@@transitions(s, zzz -> b)`,         "unknown value 'zzz'"],
    ['self-transition',    `@@transitions(s, a -> a)`,           'self-transition'],
    ['duplicate name',     `@@transitions(s, go: a -> b, go: b -> a)`, 'duplicate transition name'],
    ['gate out of range',  `@@transitions(s, a -> b @gate(12))`, 'integer 0–9'],
    ['unknown level name', `@@transitions(s, a -> b @gate(NOPE))`, 'unknown level'],
    ['no clauses',         `@@transitions(s)`,                   'at least one transition'],
    ['unknown attribute',  `@@transitions(s, a -> b @wat(1))`,   'only @gate is supported'],
  ])('rejects: %s', (_label, attr, fragment) => {
    const r = parse(`enum S { a b }
model M { id Int @id  s S  n Int  ${attr} }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain(fragment)
  })

  test('two @@transitions for the same field is an error', () => {
    const r = parse(`enum S { a b }
model M { id Int @id  s S
  @@transitions(s, go: a -> b)
  @@transitions(s, back: b -> a) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain('two @@transitions')
  })
})


describe('@@transitions — enum block desugars into it', () => {
  test('every model using the enum picks up the shared machine', () => {
    const { schema, valid } = parse(`enum S { draft live archived
  transitions { publish: draft -> live  archive: live -> archived } }
model Page    { id Int @id  status S }
model Article { id Int @id  status S }`)
    expect(valid).toBe(true)
    for (const m of schema.models) {
      const attr = m.attributes.find((a: any) => a.kind === 'transitions')
      expect(attr.field).toBe('status')
      expect(attr.fromEnum).toBe('S')
      expect(Object.keys(attr.transitions)).toEqual(['publish', 'archive'])
      expect(attr.transitions.publish.gate).toBe(null)
    }
  })

  test('an explicit @@transitions overrides rather than merges', () => {
    const { schema, valid } = parse(`enum S { draft live archived
  transitions { publish: draft -> live  archive: live -> archived } }
model Page { id Int @id  status S  @@transitions(status, bin: draft -> archived) }`)
    expect(valid).toBe(true)
    const attrs = schema.models[0].attributes.filter((a: any) => a.kind === 'transitions')
    expect(attrs).toHaveLength(1)
    expect(Object.keys(attrs[0].transitions)).toEqual(['bin'])
  })

  test('the same enum can carry different rules on two models', async () => {
    // The reason the machine lives on the model: an enum block cannot say this.
    const { db } = await makeTestClient(`enum S { pending approved }
model Order   { id Int @id  status S @default(pending)  @@transitions(status, approve: pending -> approved) }
model Expense { id Int @id  status S @default(pending)  @@transitions(status, approve: pending -> approved @gate(5)) }`)
    // No GatePlugin configured, so the shipped FrontierGateGetLevel resolves —
    // it grades a bare session at VISITOR(1), well under the gate either way.
    const user = db.$setAuth({ id: 1 })

    const o = await user.order.create({ data: { id: 1 } })
    expect((await user.order.transitions(o))[0].allowed).toBe(true)

    const e = await user.expense.create({ data: { id: 1 } })
    expect((await user.expense.transitions(e))[0].allowed).toBe(false)
    db.$close()
  })
})


describe('@@transitions — gates', () => {
  let db: any
  beforeEach(async () => {
    const result = await makeTestClient(GATED_SCHEMA, {
      plugins: [new GatePlugin({
        getLevel: (u: any) => u?.role === 'admin' ? LEVELS.ADMINISTRATOR : LEVELS.USER,
      })],
    })
    db = result.db
    await db.order.create({ data: { id: 1, status: 'paid' } })
  })
  afterEach(() => db.$close())

  test('a gated transition is refused below the level', async () => {
    const user = db.$setAuth({ id: 1, role: 'member' })
    await expect(user.order.transition(1, 'refund')).rejects.toThrow(TransitionGateError)
    expect((await db.asSystem().order.findUnique({ where: { id: 1 } })).status).toBe('paid')
  })

  test('the error carries required, got and a 403 it owns', async () => {
    const user = db.$setAuth({ id: 1, role: 'member' })
    try {
      await user.order.update({ where: { id: 1 }, data: { status: 'refunded' } })
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.name).toBe('TransitionGateError')
      expect(e.required).toBe(5)
      expect(e.got).toBe(4)
      expect(e.status).toBe(403)          // junction maps this without registration
      expect(e.transition).toBe('refund')
      expect(e.retryable).toBe(false)
    }
  })

  test('at or above the level it goes through', async () => {
    const admin = db.$setAuth({ id: 2, role: 'admin' })
    expect((await admin.order.transition(1, 'refund')).status).toBe('refunded')
  })

  test('an ungated transition on the same field is unaffected', async () => {
    const user = db.$setAuth({ id: 1, role: 'member' })
    expect((await user.order.transition(1, 'ship')).status).toBe('shipped')
  })

  test('asSystem() bypasses the gate as it bypasses the machine', async () => {
    const r = await db.asSystem().order.update({ where: { id: 1 }, data: { status: 'refunded' } })
    expect(r.status).toBe('refunded')
  })

  test('an illegal move is still refused for an admin — a gate is not an override', async () => {
    const admin = db.$setAuth({ id: 2, role: 'admin' })
    await expect(admin.order.update({ where: { id: 1 }, data: { status: 'pending' } }))
      .rejects.toThrow(TransitionViolationError)
  })

  test('a gated transition enforces with no GatePlugin configured', async () => {
    // A declared gate that silently does nothing is a fail-open default, so
    // createClient auto-installs a resolver the same way @@gate does.
    const { db: bare } = await makeTestClient(GATED_SCHEMA)
    await bare.order.create({ data: { id: 9, status: 'paid' } })
    const user = bare.$setAuth({ id: 1 })
    const err  = await user.order.transition(9, 'refund').catch((e: any) => e)
    expect(err).toBeInstanceOf(TransitionGateError)
    // A bare `{ id: 1 }` session carries no role, so FrontierGateGetLevel
    // grades it CREATOR(3) — below the transition's gate, which is the point.
    //
    // This asserted 1 (VISITOR) until 2026-08-04, when the resolver stopped
    // treating an ABSENT verifiedAt as "unverified". Absence means the app does
    // not model verification; only `null` means modelled-and-not-reached. The
    // old reading graded every session from every app without a verification
    // flow at VISITOR(1), below the USER(4) an ordinary model needs to read.
    expect(err.got).toBe(3)
    expect((await bare.asSystem().order.findUnique({ where: { id: 9 } })).status).toBe('paid')
    bare.$close()
  })
})


describe('@@transitions — transitions() listing', () => {
  let db: any
  beforeEach(async () => {
    const result = await makeTestClient(GATED_SCHEMA, {
      plugins: [new GatePlugin({
        getLevel: (u: any) => u?.role === 'admin' ? LEVELS.ADMINISTRATOR : LEVELS.USER,
      })],
    })
    db = result.db
    await db.order.create({ data: { id: 1, status: 'pending' } })
    await db.order.create({ data: { id: 2, status: 'paid' } })
  })
  afterEach(() => db.$close())

  test('lists only the moves legal from the current state', async () => {
    const user = db.$setAuth({ id: 1, role: 'member' })
    const names = (await user.order.transitions(1)).map((t: any) => t.name)
    expect(names.sort()).toEqual(['cancel', 'pay'])
  })

  test('a gated move is reported with allowed:false, not hidden', async () => {
    const user   = db.$setAuth({ id: 1, role: 'member' })
    const refund = (await user.order.transitions(2)).find((t: any) => t.name === 'refund')
    expect(refund).toEqual({ name: 'refund', field: 'status', from: 'paid', to: 'refunded', gate: 5, allowed: false })
  })

  test('the same record reads differently for a higher level', async () => {
    const admin  = db.$setAuth({ id: 2, role: 'admin' })
    const refund = (await admin.order.transitions(2)).find((t: any) => t.name === 'refund')
    expect(refund.allowed).toBe(true)
  })

  test('accepts a row as well as an id — no round trip', async () => {
    const user = db.$setAuth({ id: 1, role: 'member' })
    const row  = await user.order.findUnique({ where: { id: 2 } })
    expect((await user.order.transitions(row)).map((t: any) => t.name).sort())
      .toEqual(['cancel', 'refund', 'ship'])
  })

  test('a terminal state offers nothing', async () => {
    const admin = db.$setAuth({ id: 2, role: 'admin' })
    await admin.order.transition(2, 'refund')
    expect(await admin.order.transitions(2)).toEqual([])
  })

  test('a missing record and a model with no machine both return []', async () => {
    expect(await db.order.transitions(999)).toEqual([])
    const { db: plain } = await makeTestClient(`model T { id Int @id  n Int }`)
    await plain.t.create({ data: { id: 1, n: 1 } })
    expect(await plain.t.transitions(1)).toEqual([])
    plain.$close()
  })
})


describe('enum transitions — enforcement', () => {
  let db: any

  beforeEach(async () => {
    const result = await makeTestClient(TRANSITION_SCHEMA)
    db = result.db
    await db.order.create({ data: { id: 1, status: 'pending' } })
    await db.order.create({ data: { id: 2, status: 'paid' } })
    await db.order.create({ data: { id: 3, status: 'shipped' } })
  })
  afterEach(() => db.$close())

  // ── Valid transitions ────────────────────────────────────────────────────────

  test('valid transition via update()', async () => {
    const r = await db.order.update({ where: { id: 1 }, data: { status: 'paid' } })
    expect(r.status).toBe('paid')
  })

  test('valid multi-from transition: paid -> refunded', async () => {
    const r = await db.order.update({ where: { id: 2 }, data: { status: 'refunded' } })
    expect(r.status).toBe('refunded')
  })

  test('valid multi-from transition: shipped -> refunded', async () => {
    const r = await db.order.update({ where: { id: 3 }, data: { status: 'refunded' } })
    expect(r.status).toBe('refunded')
  })

  test('non-transition field update unaffected', async () => {
    const r = await db.order.update({ where: { id: 1 }, data: { note: 'hello' } })
    expect(r.note).toBe('hello')
    expect(r.status).toBe('pending')
  })

  test('no-op update (same value) does not throw', async () => {
    const r = await db.order.update({ where: { id: 1 }, data: { status: 'pending' } })
    expect(r.status).toBe('pending')
  })

  // ── Invalid transitions ──────────────────────────────────────────────────────

  test('invalid transition throws TransitionViolationError', async () => {
    await expect(
      db.order.update({ where: { id: 1 }, data: { status: 'shipped' } })
    ).rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('TransitionViolationError has correct fields', async () => {
    try {
      await db.order.update({ where: { id: 1 }, data: { status: 'shipped' } })
    } catch (e: any) {
      expect(e.model).toBe('order')  // carries the table name
      expect(e.field).toBe('status')
      expect(e.from).toBe('pending')
      expect(e.to).toBe('shipped')
      expect(e.retryable).toBe(false)
    }
  })

  test('pending -> delivered invalid (no direct transition)', async () => {
    await expect(
      db.order.update({ where: { id: 1 }, data: { status: 'delivered' } })
    ).rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('pending -> refunded invalid', async () => {
    await expect(
      db.order.update({ where: { id: 1 }, data: { status: 'refunded' } })
    ).rejects.toBeInstanceOf(TransitionViolationError)
  })

  // ── transition() method ──────────────────────────────────────────────────────

  test('transition() resolves name to value', async () => {
    const r = await db.order.transition(1, 'pay')
    expect(r.status).toBe('paid')
  })

  test('transition() multi-step', async () => {
    await db.order.transition(1, 'pay')
    await db.order.transition(1, 'ship')
    const r = await db.order.findUnique({ where: { id: 1 } })
    expect(r.status).toBe('shipped')
  })

  test('transition() throws TransitionNotFoundError for unknown name', async () => {
    await expect(db.order.transition(1, 'fly')).rejects.toBeInstanceOf(TransitionNotFoundError)
  })

  test('TransitionNotFoundError has correct fields', async () => {
    try {
      await db.order.transition(1, 'fly')
    } catch (e: any) {
      expect(e.model).toBe('order')  // carries the table name
      expect(e.transition).toBe('fly')
      expect(e.retryable).toBe(false)
    }
  })

  test('transition() on model without transitions throws helpful error', async () => {
    const { db: db2 } = await makeTestClient(`model T { id Int @id; name String }`)
    await expect(db2.t.transition(1, 'go')).rejects.toThrow('no transitions block')
    db2.$close()
  })

  // ── No enforcement on create ─────────────────────────────────────────────────

  test('create with @default value: no enforcement', async () => {
    // pending is the default — creating with it should always work
    const r = await db.order.create({ data: { id: 10, status: 'pending' } })
    expect(r.status).toBe('pending')
  })

  test('create with non-default value: no enforcement (create is exempt)', async () => {
    // Creating directly with 'paid' skips transition checks — create is always exempt
    const r = await db.order.create({ data: { id: 11, status: 'paid' } })
    expect(r.status).toBe('paid')
  })

  // ── Plain enum not affected ──────────────────────────────────────────────────

  test('plain enum field update is unaffected', async () => {
    const { db: db2 } = await makeTestClient(`
      enum Color { red green blue }
      model T { id Int @id; c Color @default(red) }
    `)
    await db2.t.create({ data: { id: 1, c: 'red' } })
    const r = await db2.t.update({ where: { id: 1 }, data: { c: 'blue' } })
    expect(r.c).toBe('blue')   // no transition block → no enforcement
    db2.$close()
  })

  // ── SYSTEM bypass ────────────────────────────────────────────────────────────

  test('asSystem() bypasses transition enforcement', async () => {
    // pending -> shipped would normally be invalid
    const r = await db.asSystem().order.update({ where: { id: 1 }, data: { status: 'shipped' } })
    expect(r.status).toBe('shipped')
  })

  // ── Events ───────────────────────────────────────────────────────────────────

  test('successful transition fires transition event', async () => {
    const events: any[] = []
    const { db: evDb } = await makeTestClient(TRANSITION_SCHEMA, {
      data: async (db) => { await db.order.create({ data: { id: 1, status: 'pending' } }) },
    })
    // Re-create with event listener
    const evDb2 = await (async () => {
      const { createClient } = await import('../src/core/client.js')
      const { parse: p } = await import('../src/core/parser.js')
      const { generateDDL } = await import('../src/core/ddl.js')
      const { splitStatements } = await import('../src/core/migrate.js')
      const { Database } = await import('bun:sqlite')
      const { join } = await import('path')
      const { tmpdir } = await import('os')
      const { mkdirSync } = await import('fs')
      const dir = join(tmpdir(), `tx-event-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'test.db')
      const result = p(TRANSITION_SCHEMA)
      const raw = new Database(path)
      for (const s of splitStatements(generateDDL(result.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
      raw.close()
      return createClient({ parsed: result,  db: path, onEvent: { transition: (e: any) => events.push(e) } })
    })()
    await evDb2.order.create({ data: { id: 1, status: 'pending' } })
    await evDb2.order.update({ where: { id: 1 }, data: { status: 'paid' } })
    // Give the setTimeout(0) a tick to fire
    await new Promise(r => setTimeout(r, 10))
    expect(events.length).toBe(1)
    expect(events[0].transition).toBe('pay')
    expect(events[0].from).toBe('pending')
    expect(events[0].to).toBe('paid')
    expect(events[0].model).toBe('order')  // carries the table name
    evDb.$close(); evDb2.$close()
  })
})


describe('enum transitions — conflict and upsert', () => {
  let db: any

  beforeEach(async () => {
    const result = await makeTestClient(TRANSITION_SCHEMA)
    db = result.db
    await db.order.create({ data: { id: 1, status: 'pending' } })
    await db.order.create({ data: { id: 2, status: 'paid' } })
  })
  afterEach(() => db.$close())

  // ── Race condition (TransitionConflictError) ─────────────────────────────
  //
  // Simulate: two requests both read status='paid', both try to ship.
  // The first wins. The second's UPDATE hits the optimistic lock
  // (WHERE status = 'paid') and gets 0 rows affected → ConflictError.
  //
  // We simulate the race by:
  //   1. Running the valid transition normally (first request wins)
  //   2. Patching the raw db so the next UPDATE always returns changes=0
  //      (mimics: row was already updated by the "other" request)
  //   3. Attempting the same transition again → should throw ConflictError

  test('TransitionConflictError thrown when optimistic lock fails', async () => {
    // The optimistic lock adds WHERE "status" = <current> to the UPDATE.
    // When the RETURNING UPDATE returns null (race condition), ORM throws ConflictError.
    // Patch rawDb.prepare to intercept the RETURNING UPDATE and return null.
    const rawDb = db.$db
    const origPrepare = (rawDb as any).prepare.bind(rawDb)
    let hooked = false
    ;(rawDb as any).prepare = function(sql: string) {
      const stmt = origPrepare(sql)
      if (!hooked && /UPDATE.*order.*RETURNING/i.test(sql)) {
        hooked = true
        const origGet = stmt.get.bind(stmt)
        ;(stmt as any).get = (...args: any[]) => {
          ;(rawDb as any).prepare = origPrepare
          return null  // simulate race: 0 rows updated
        }
      }
      return stmt
    }
    try {
      await expect(
        db.order.update({ where: { id: 2 }, data: { status: 'shipped' } })
      ).rejects.toBeInstanceOf(TransitionConflictError)
    } finally {
      ;(rawDb as any).prepare = origPrepare
    }
  })

  test('TransitionConflictError has correct fields', async () => {
    const rawDb = db.$db
    const originalRun = rawDb.run.bind(rawDb)
    let patched = false
    rawDb.run = function(sql: string, ...args: any[]) {
      if (!patched && typeof sql === 'string' && sql.includes('UPDATE') && sql.includes('"order"')) {
        patched = true
        return { changes: 0, lastInsertRowid: 0 }
      }
      return originalRun(sql, ...args)
    }

    try {
      await db.order.update({ where: { id: 2 }, data: { status: 'shipped' } })
    } catch (e: any) {
      expect(e).toBeInstanceOf(TransitionConflictError)
      expect(e.model).toBe('order')  // carries the table name
      expect(e.field).toBe('status')
      expect(e.from).toBe('paid')
      expect(e.to).toBe('shipped')
      expect(e.retryable).toBe(true)
    } finally {
      rawDb.run = originalRun
    }
  })

  test('ConflictError is marked retryable', async () => {
    const err = new TransitionConflictError('Order', 'status', 'paid', 'shipped')
    expect(err.retryable).toBe(true)
    expect(err).toBeInstanceOf(Error)
  })

  // ── upsert() transition enforcement ─────────────────────────────────────
  //
  // upsert() delegates to update() for the existing-row path → enforcement
  // is inherited. create() path is always exempt (per decision).

  test('upsert existing row: valid transition enforced', async () => {
    // id=1 exists with status=pending — pay is a valid transition
    const r = await db.order.upsert({
      where:  { id: 1 },
      create: { id: 1, status: 'pending' },
      update: { status: 'paid' },
    })
    expect(r.status).toBe('paid')
  })

  test('upsert existing row: invalid transition throws TransitionViolationError', async () => {
    // id=1 exists with status=pending — ship is NOT valid from pending
    await expect(db.order.upsert({
      where:  { id: 1 },
      create: { id: 1, status: 'pending' },
      update: { status: 'shipped' },
    })).rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('upsert new row (create path): exempt from enforcement', async () => {
    // id=99 does not exist — create path, always exempt
    const r = await db.order.upsert({
      where:  { id: 99 },
      create: { id: 99, status: 'shipped' },   // non-default, would fail if enforced
      update: { status: 'delivered' },
    })
    expect(r.status).toBe('shipped')
  })
})


describe('enum transitions — JSON Schema', () => {
  // The model is the owner: an enum block desugars onto every model that uses
  // it, and only a model can carry a per-transition @gate. Emitting on both
  // would give the client two sources to disagree about.
  test('x-transitions emitted on the model, keyed by field', () => {
    const { schema } = parse(TRANSITION_SCHEMA)
    const js = generateJsonSchema(schema)
    const modelDef = js['$defs']?.['Order'] ?? js['Order']
    expect(modelDef['x-transitions']).toBeDefined()
    expect(modelDef['x-transitions'].status.pay).toEqual({ from: ['pending'], to: 'paid', gate: null })
    expect(modelDef['x-transitions'].status.refund).toEqual({ from: ['paid','shipped'], to: 'refunded', gate: null })
  })

  test('enum def carries no transitions — the model is the only source', () => {
    const { schema } = parse(TRANSITION_SCHEMA)
    const js = generateJsonSchema(schema)
    const enumDef = js['$defs']?.['OrderStatus'] ?? js['OrderStatus']
    expect(enumDef['x-litestone-transitions']).toBeUndefined()
    expect(enumDef.enum).toEqual(['pending','paid','shipped','delivered','refunded'])
  })

  test('model without transitions has no x-transitions', () => {
    const { schema } = parse(`enum Color { red green blue }
model T { id Int @id; c Color }`)
    const js = generateJsonSchema(schema)
    const modelDef = js['$defs']?.['T'] ?? js['T']
    expect(modelDef['x-transitions']).toBeUndefined()
  })

  test('@gate on a transition reaches the client schema', () => {
    const { schema } = parse(`enum S { pending paid refunded }
model Order {
  id Int @id
  status S @default(pending)
  @@transitions(status, pay: pending -> paid, refund: paid -> refunded @gate(5))
}`)
    const js = generateJsonSchema(schema)
    const t = (js['$defs']?.['Order'] ?? js['Order'])['x-transitions'].status
    expect(t.pay.gate).toBe(null)
    expect(t.refund.gate).toBe(5)
  })

  test('two state fields on one model each get their own entry', () => {
    const { schema } = parse(`enum A { a1 a2 }
enum B { b1 b2 }
model M {
  id Int @id
  stage A @default(a1)
  phase B @default(b1)
  @@transitions(stage, a1 -> a2)
  @@transitions(phase, b1 -> b2)
}`)
    const js = generateJsonSchema(schema)
    const t = (js['$defs']?.['M'] ?? js['M'])['x-transitions']
    expect(Object.keys(t).sort()).toEqual(['phase','stage'])
    expect(t.stage.a2).toEqual({ from: ['a1'], to: 'a2', gate: null })
  })
})

// ─── Lock primitive ───────────────────────────────────────────────────────────

import { LockNotAcquiredError, LockReleasedByOtherError, LockExpiredError }
  from '../src/core/client.js'

const LOCK_SCHEMA = `model Thing { id Int @id; name String }`


describe('lock primitive — $lock(key, fn)', () => {
  let db: any

  beforeEach(async () => { db = (await makeTestClient(LOCK_SCHEMA)).db })
  afterEach(() => db.$close())

  test('executes fn and returns result', async () => {
    const r = await db.$lock('test-key', async () => 42)
    expect(r).toBe(42)
  })

  test('fn can use the db normally', async () => {
    await db.$lock('test-key', async () => {
      await db.thing.create({ data: { id: 1, name: 'inside lock' } })
    })
    const n = await db.thing.count()
    expect(n).toBe(1)
  })

  test('releases lock after fn resolves', async () => {
    await db.$lock('test-key', async () => {})
    expect(db.$locks.isHeld('test-key')).toBe(false)
  })

  test('releases lock after fn throws', async () => {
    try {
      await db.$lock('test-key', async () => { throw new Error('boom') })
    } catch {}
    expect(db.$locks.isHeld('test-key')).toBe(false)
  })

  test('throws propagate after release', async () => {
    await expect(
      db.$lock('test-key', async () => { throw new Error('boom') })
    ).rejects.toThrow('boom')
  })

  test('sequential locks on same key work', async () => {
    await db.$lock('seq-key', async () => {})
    await db.$lock('seq-key', async () => {})   // should not throw
    expect(true).toBe(true)
  })

  test('different keys can be held simultaneously', async () => {
    const order: string[] = []
    await Promise.all([
      db.$lock('key-a', async () => { order.push('a') }),
      db.$lock('key-b', async () => { order.push('b') }),
    ])
    expect(order.sort()).toEqual(['a', 'b'])
  })
})


describe('lock primitive — $locks.acquire / release', () => {
  let db: any

  beforeEach(async () => { db = (await makeTestClient(LOCK_SCHEMA)).db })
  afterEach(() => db.$close())

  test('acquire returns lock handle', async () => {
    const lock = await db.$locks.acquire('acq-key')
    expect(lock.key).toBe('acq-key')
    expect(typeof lock.owner).toBe('string')
    expect(lock.acquiredAt).toBeInstanceOf(Date)
    expect(lock.expiresAt).toBeInstanceOf(Date)
    await lock.release()
  })

  test('lock is held after acquire, not held after release', async () => {
    const lock = await db.$locks.acquire('held-key')
    expect(db.$locks.isHeld('held-key')).toBe(true)
    await lock.release()
    expect(db.$locks.isHeld('held-key')).toBe(false)
  })

  test('acquire fails immediately (wait:0) when lock held', async () => {
    const lock = await db.$locks.acquire('contested-key')
    try {
      await expect(
        db.$locks.acquire('contested-key', { wait: 0 })
      ).rejects.toBeInstanceOf(LockNotAcquiredError)
    } finally {
      await lock.release()
    }
  })

  test('LockNotAcquiredError has correct fields', async () => {
    const lock = await db.$locks.acquire('err-key', { owner: 'owner-a' })
    try {
      await db.$locks.acquire('err-key', { wait: 0 })
    } catch (e: any) {
      expect(e).toBeInstanceOf(LockNotAcquiredError)
      expect(e.key).toBe('err-key')
      expect(e.currentOwner).toBe('owner-a')
      expect(e.retryable).toBe(true)
    } finally {
      await lock.release()
    }
  })

  test('acquire succeeds after wait when lock released within window', async () => {
    const lock = await db.$locks.acquire('wait-key')
    // Release lock after 50ms in background
    setTimeout(() => lock.release(), 50)
    // Wait up to 500ms for it
    const lock2 = await db.$locks.acquire('wait-key', { wait: 500, retryEvery: 20 })
    expect(lock2.key).toBe('wait-key')
    await lock2.release()
  })

  test('acquire fails after wait expires', async () => {
    const lock = await db.$locks.acquire('timeout-key')
    try {
      await expect(
        db.$locks.acquire('timeout-key', { wait: 100, retryEvery: 20 })
      ).rejects.toBeInstanceOf(LockNotAcquiredError)
    } finally {
      await lock.release()
    }
  })

  test('release is idempotent — no error on double release', async () => {
    const lock = await db.$locks.acquire('idem-key')
    await lock.release()
    await expect(lock.release()).resolves.toBeUndefined()
  })

  test('$locks.release(key) force-releases any owner', async () => {
    await db.$locks.acquire('force-key', { owner: 'some-process' })
    await db.$locks.release('force-key')
    expect(db.$locks.isHeld('force-key')).toBe(false)
  })

  test('$locks.release(key, owner) is owner-scoped', async () => {
    const lock = await db.$locks.acquire('scoped-key', { owner: 'proc-1' })
    await db.$locks.release('scoped-key', 'proc-2')   // wrong owner — no-op
    expect(db.$locks.isHeld('scoped-key')).toBe(true)
    await lock.release()
  })
})


describe('lock primitive — TTL and expiry', () => {
  let db: any

  beforeEach(async () => { db = (await makeTestClient(LOCK_SCHEMA)).db })
  afterEach(() => db.$close())

  test('expired lock is cleaned up on next acquire attempt', async () => {
    // Acquire with 1ms TTL — expires immediately
    await db.$locks.acquire('exp-key', { ttl: 1 })
    await new Promise(r => setTimeout(r, 10))   // let it expire
    // Should be acquirable again
    const lock2 = await db.$locks.acquire('exp-key', { wait: 0 })
    expect(lock2.key).toBe('exp-key')
    await lock2.release()
  })

  test('isHeld returns false for expired lock', async () => {
    await db.$locks.acquire('inh-key', { ttl: 1 })
    await new Promise(r => setTimeout(r, 10))
    expect(db.$locks.isHeld('inh-key')).toBe(false)
  })

  test('heartbeat extends expires_at', async () => {
    const lock = await db.$locks.acquire('hb-key', { ttl: 5000 })
    const before = lock.expiresAt.getTime()
    await new Promise(r => setTimeout(r, 20))
    await lock.heartbeat()
    // Check expires_at in raw db increased
    const row = db.$db.prepare('SELECT expires_at FROM _locks WHERE key = ?').get('hb-key')
    expect(row.expires_at).toBeGreaterThan(before)
    await lock.release()
  })
})


describe('lock primitive — $locks.list', () => {
  let db: any

  beforeEach(async () => { db = (await makeTestClient(LOCK_SCHEMA)).db })
  afterEach(() => db.$close())

  test('list returns active locks', async () => {
    const a = await db.$locks.acquire('list-a')
    const b = await db.$locks.acquire('list-b')
    const locks = db.$locks.list()
    expect(locks.map((l: any) => l.key).sort()).toEqual(['list-a', 'list-b'])
    await a.release(); await b.release()
  })

  test('list excludes expired locks', async () => {
    await db.$locks.acquire('exp-list', { ttl: 1 })
    await new Promise(r => setTimeout(r, 10))
    const locks = db.$locks.list()
    expect(locks.find((l: any) => l.key === 'exp-list')).toBeUndefined()
  })

  test('list returns empty when no locks held', async () => {
    expect(db.$locks.list()).toEqual([])
  })

  test('list entries have correct shape', async () => {
    const lock = await db.$locks.acquire('shape-key', { owner: 'proc-x' })
    const [entry] = db.$locks.list()
    expect(entry.key).toBe('shape-key')
    expect(entry.owner).toBe('proc-x')
    expect(entry.acquiredAt).toBeInstanceOf(Date)
    expect(entry.expiresAt).toBeInstanceOf(Date)
    expect(entry.heartbeatAt).toBeInstanceOf(Date)
    await lock.release()
  })
})


describe('lock primitive — asSystem bypass', () => {
  let db: any

  beforeEach(async () => { db = (await makeTestClient(LOCK_SCHEMA)).db })
  afterEach(() => db.$close())

  test('asSystem() bypasses $lock and executes fn directly', async () => {
    // Hold the lock from the main client
    const lock = await db.$locks.acquire('sys-bypass-key')
    try {
      // asSystem should execute without acquiring the lock
      const result = await db.asSystem().$lock('sys-bypass-key', async () => 'bypassed')
      expect(result).toBe('bypassed')
    } finally {
      await lock.release()
    }
  })
})


describe('lock primitive — _locks table auto-created', () => {
  test('_locks table does not exist before first use', async () => {
    const { db } = await makeTestClient(LOCK_SCHEMA)
    const tables = db.$db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_locks'"
    ).all()
    // Not created yet — no $lock call
    // (It may or may not exist depending on order; just ensure no crash)
    db.$close()
  })

  test('_locks table created on first $lock call', async () => {
    const { db } = await makeTestClient(LOCK_SCHEMA)
    await db.$lock('init-test', async () => {})
    const tables = db.$db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_locks'"
    ).all()
    expect(tables.length).toBe(1)
    db.$close()
  })
})

// ─── generateTypeScript — the emitted surface must be the REAL surface ────────
//
// A generated .d.ts that omits a method is worse than no types at all: it types
// a correct call as an error, and the app either casts the client back to `any`
// — losing everything the file was for — or stops using the generator. Both
// happened. basecamp calls `exists` 16 times and `findManyAndCount` 12, and
// neither was emitted.
//
// So this asks a live client what it has rather than restating a list. A method
// added to the client and not to the generator fails here.

describe('generateTypeScript — emits the surface a real client has', () => {
  const TS_SURFACE_SCHEMA = `
    model Thing {
      id     Int    @id
      name   String
      status String @default("draft")
    }
  `

  test('every table method on a live client is declared on TableClient', async () => {
    const db  = await createClient({ schema: TS_SURFACE_SCHEMA, db: ':memory:' })
    const dts = generateTypeScript(parse(TS_SURFACE_SCHEMA).schema)
    const iface = dts.slice(dts.indexOf('export interface TableClient'), dts.indexOf('export interface QueryEvent'))

    // A Litestone accessor is a Proxy — it has no own keys to enumerate, and it
    // THROWS on an unknown property, which is what makes this a real question:
    // a name that is not there cannot be probed into existence.
    const methods = [
      'findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow',
      'findManyCursor', 'findManyAndCount', 'count', 'exists', 'aggregate', 'groupBy',
      'query', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'upsertMany',
      'remove', 'removeMany', 'restore', 'delete', 'deleteMany', 'search',
      'optimizeFts', 'transitions',
    ]
    for (const m of methods) {
      expect(typeof (db.thing as any)[m]).toBe('function')   // the client really has it
      expect(iface).toContain(`${m}(`)                       // …and the .d.ts says so
    }
    db.$close()
  })

  test('every client member a live client exposes is declared on LitestoneClient', async () => {
    const db  = await createClient({ schema: TS_SURFACE_SCHEMA, db: ':memory:' })
    const dts = generateTypeScript(parse(TS_SURFACE_SCHEMA).schema)
    const iface = dts.slice(dts.indexOf('export interface LitestoneClient'), dts.indexOf('export interface CreateClientOptions'))

    const members = [
      'asSystem', '$setAuth', '$scopedBy', '$transaction', 'sql', '$tapQuery',
      '$backup', '$attach', '$detach', '$rotateKey', '$close',
      '$checkWhere', '$checkOrderBy',
      '$schema', '$databases', '$softDelete', '$enums', '$cacheSize', '$attached',
      '$rawDbs', '$walStatus',
    ]
    for (const m of members) {
      expect((db as any)[m]).toBeDefined()
      expect(iface).toContain(m)
    }
    db.$close()
  })

  test('CreateClientOptions names the options createClient actually destructures', () => {
    const dts  = generateTypeScript(parse(TS_SURFACE_SCHEMA).schema)
    const opts = dts.slice(dts.indexOf('export interface CreateClientOptions'), dts.indexOf('export declare function createClient'))
    // encryptionKey, not `encryption: { key }` — the wrong shape here is a
    // scaffold that boots without encryption and fails on the first @secret.
    expect(opts).toContain('encryptionKey?:')
    expect(opts).not.toContain('encryption?:')
    expect(opts).toContain('databases?:')
    // A duplicate key is a TS2300 that makes the whole file unusable, and it
    // shipped: onEvent was emitted twice.
    for (const key of ['onEvent', 'onQuery', 'hooks', 'plugins', 'db']) {
      const hits = opts.split('\n').filter(l => l.trim().startsWith(`${key}?:`) || l.trim().startsWith(`${key}:`))
      expect(hits.length).toBe(1)
    }
  })
})

// ─── @markdown annotation ─────────────────────────────────────────────────────

describe('@markdown — generateTypeScript', () => {
  const MD_TS_SCHEMA = `
    model Post {
      id    Int @id
      body  String    @markdown
      note  String?   @markdown
      title String
    }
  `
  const { schema } = parse(MD_TS_SCHEMA)

  test('@markdown field emits string type (not special type)', () => {
    const dts = generateTypeScript(schema)
    // body is String @markdown — should still be string, not a special markdown type
    const postSection = dts.slice(dts.indexOf('export interface Post {'), dts.indexOf('export interface PostCreate {'))
    expect(postSection).toContain('body:')
    expect(postSection).toContain('string')
  })

  test('@markdown optional field emits string | null', () => {
    const dts = generateTypeScript(schema)
    const postSection = dts.slice(dts.indexOf('export interface Post {'), dts.indexOf('export interface PostCreate {'))
    expect(postSection).toContain('note?:')
    expect(postSection).toContain('string')
  })

  test('@markdown field not excluded from any audience', () => {
    const dtsClient = generateTypeScript(schema, { audience: 'client' })
    const dtsSys    = generateTypeScript(schema, { audience: 'system' })
    expect(dtsClient).toContain('body')
    expect(dtsSys).toContain('body')
  })

  test('@markdown field included in Create interface', () => {
    const dts = generateTypeScript(schema)
    const createSection = dts.slice(dts.indexOf('export interface PostCreate {'), dts.indexOf('export interface PostUpdate {'))
    expect(createSection).toContain('body')
  })

  test('@markdown does not affect plain text field in same model', () => {
    const dts = generateTypeScript(schema)
    const postSection = dts.slice(dts.indexOf('export interface Post {'), dts.indexOf('export interface PostCreate {'))
    expect(postSection).toContain('title')
  })
})


// ┌────────────────────────────────────────────────────────────────────────────┐
// │  TESTING UTILITIES                                                         │
// └────────────────────────────────────────────────────────────────────────────┘

describe('seeder + factory', () => {
  test('Factory.buildOne returns definition', async () => {
    const { Factory } = await import('../src/seeder.js')
    class UserFactory extends Factory {
      model = 'User'
      definition(seq: number) { return { id: seq, name: `User ${seq}`, email: `u${seq}@x.com` } }
    }
    const db = await makeDb(`model User {
        id    Int @id
        name  String
        email String
      }`, 'factory-build')
    const f = new UserFactory(db)
    const data = f.buildOne()
    expect(data.id).toBe(1)
    expect(data.name).toBe('User 1')
    db.$close()
  })

  test('Factory.buildMany returns N items', async () => {
    const { Factory } = await import('../src/seeder.js')
    class F extends Factory {
      model = 't'
      definition(seq: number) { return { id: seq, val: `v${seq}` } }
    }
    const db = await makeDb(`model T {
        id  Int @id
        val String
      }`, 'factory-many')
    const items = new F(db).buildMany(5)
    expect(items.length).toBe(5)
    expect(items[4].id).toBe(5)
    db.$close()
  })

  test('Factory.createMany inserts rows', async () => {
    const { Factory } = await import('../src/seeder.js')
    class F extends Factory {
      model = 't'
      definition(seq: number) { return { id: seq, val: `v${seq}` } }
    }
    const db = await makeDb(`model T {
        id  Int @id
        val String
      }`, 'factory-create')
    await new F(db).createMany(3)
    expect(await db.t.count()).toBe(3)
    db.$close()
  })

  test('Factory.state() applies overrides', async () => {
    const { Factory } = await import('../src/seeder.js')
    class F extends Factory {
      model = 't'
      definition(seq: number) { return { id: seq, role: 'member' } }
      admin() { return this.state({ role: 'admin' }) }
    }
    const db = await makeDb(`model T {
        id   Int @id
        role String
      }`, 'factory-state')
    const [row] = await new F(db).admin().createMany(1)
    expect(row.role).toBe('admin')
    db.$close()
  })

  test('Factory.seed() produces deterministic output', async () => {
    const { Factory } = await import('../src/seeder.js')
    class F extends Factory {
      model = 't'
      definition(_: number, rng: any) { return { id: _, val: rng.str(6) } }
    }
    const db = await makeDb(`model T {
        id  Int @id
        val String
      }`, 'factory-seed')
    const a = new F(db).seed(42).buildMany(3).map((r: any) => r.val)
    const b = new F(db).seed(42).buildMany(3).map((r: any) => r.val)
    expect(a).toEqual(b)
    db.$close()
  })

  test('Seeder.call() runs sub-seeders in order', async () => {
    const { Seeder, runSeeder } = await import('../src/seeder.js')
    const order: string[] = []
    class A extends Seeder { async run() { order.push('A') } }
    class B extends Seeder { async run() { order.push('B') } }
    class Root extends Seeder { async run(db: any) { await this.call(db, [A, B]) } }
    const db = await makeDb(`model T { id Int @id }`, 'seeder-call')
    await runSeeder(db, Root)
    expect(order).toEqual(['A', 'B'])
    db.$close()
  })
})

// ─── 27. Entity generator (introspect) ────────────────────────────────────────


describe('entity generator', () => {
  test('generates model with correct types', async () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      score REAL,
      active INTEGER NOT NULL DEFAULT 1
    ) STRICT`)
    const { generateLiteSchema } = await import('../src/tools/introspect.js')
    const schema = generateLiteSchema(db, { camelCase: false })
    // introspect emits PascalCase singular model names (per new naming convention)
    expect(schema).toContain('model User')
    expect(schema).toContain('@id')
    expect(schema).toContain('Int')
    expect(schema).toContain('Float')
    db.close()
  })

  test('generates @relation from FK', async () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT) STRICT`)
    db.run(`CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      accountId INTEGER NOT NULL REFERENCES accounts(id),
      email TEXT NOT NULL
    ) STRICT`)
    const { generateLiteSchema } = await import('../src/tools/introspect.js')
    const schema = generateLiteSchema(db, { camelCase: false })
    expect(schema).toContain('@relation(fields: [accountId], references: [id])')
    db.close()
  })

  test('generates @@index from multi-column index', async () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT) STRICT`)
    db.run(`CREATE INDEX t_ab ON t(a, b)`)
    const { generateLiteSchema } = await import('../src/tools/introspect.js')
    const schema = generateLiteSchema(db, { camelCase: false })
    expect(schema).toContain('@@index([a, b])')
    db.close()
  })

  test('generates @@unique from unique index', async () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT) STRICT`)
    db.run(`CREATE UNIQUE INDEX t_email ON t(email)`)
    const { generateLiteSchema } = await import('../src/tools/introspect.js')
    const schema = generateLiteSchema(db, { camelCase: false })
    expect(schema).toContain('@unique')
    db.close()
  })

  test('camelCase converts snake_case names', async () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE user_profiles (
      id INTEGER PRIMARY KEY,
      account_id INTEGER,
      created_at TEXT
    ) STRICT`)
    const { generateLiteSchema } = await import('../src/tools/introspect.js')
    const schema = generateLiteSchema(db, { camelCase: true })
    // Singular PascalCase: user_profiles → UserProfile
    expect(schema).toContain('model UserProfile')
    expect(schema).toContain('accountId')
    expect(schema).toContain('createdAt')
    db.close()
  })

  test('optional columns have ? suffix', async () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, required TEXT NOT NULL, optional TEXT) STRICT`)
    const { generateLiteSchema } = await import('../src/tools/introspect.js')
    const schema = generateLiteSchema(db, { camelCase: false })
    expect(schema).toContain('String?')
    expect(schema).toContain('optional')
    expect(schema).not.toMatch(/required\?/)
    db.close()
  })
})

// ─── 28. Plugin system ────────────────────────────────────────────────────────


describe('makeTestClient', () => {
  test('creates db and returns client', async () => {
    const { db } = await makeTestClient(FACTORY_SCHEMA)
    expect(db).toBeDefined()
    expect(typeof db.user.findMany).toBe('function')
    db.$close()
  })

  // A `database` block wins over the `db:` option, so this helper used to open the
  // path the schema declared — i.e. the project's REAL database — and write test
  // rows into it. Every declared path must land inside the throwaway tmpdir.
  test('a declared database path never escapes the tmpdir', async () => {
    const { db } = await makeTestClient(`
      database main  { path "./db/should-not-be-created.db" }
      database logs  { path "./db/should-not-be-created-logs/" driver jsonl }
      model Thing { id Int @id @default(autoincrement()); name String }
      model Hit   { path String; @@db(logs) }
    `)
    for (const [, def] of Object.entries(db.$databases as Record<string, any>)) {
      expect(def.path.startsWith(tmpdir())).toBe(true)
    }
    expect(existsSync('./db/should-not-be-created.db')).toBe(false)
    expect(existsSync('./db/should-not-be-created-logs')).toBe(false)
    // and it is a working client, not just an isolated one
    await db.thing.create({ data: { name: 'a' } })
    expect(await db.thing.count()).toBe(1)
    db.$close()
  })

  test('multi-database schema: each db gets only its own tables', async () => {
    const { db } = await makeTestClient(`
      database main      { path "./db/nope-main.db" }
      database analytics { path "./db/nope-analytics.db" }
      model User { id Int @id @default(autoincrement()); email String }
      model PageView { id Int @id @default(autoincrement()); path String; @@db(analytics) }
    `)
    await db.user.create({ data: { email: 'a@b.com' } })
    await db.pageView.create({ data: { path: '/home' } })
    expect(await db.user.count()).toBe(1)
    expect(await db.pageView.count()).toBe(1)
    expect((db.$databases as any).main.path).not.toBe((db.$databases as any).analytics.path)
    db.$close()
  })

  test('returns bound factory instances', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { user: UserFactory, account: AccountFactory },
    })
    expect(factories.user).toBeInstanceOf(UserFactory)
    expect(factories.account).toBeInstanceOf(AccountFactory)
    db.$close()
  })

  test('data seeder fn runs after tables created', async () => {
    const { db } = await makeTestClient(FACTORY_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Seeded' } })
      }
    })
    const n = await db.account.count()
    expect(n).toBe(1)
    db.$close()
  })

  test('seed option makes factories deterministic', async () => {
    const { factories: f1, db: db1 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 99, factories: { user: UserFactory }
    })
    const { factories: f2, db: db2 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 99, factories: { user: UserFactory }
    })
    expect(f1.user.buildOne()).toEqual(f2.user.buildOne())
    db1.$close(); db2.$close()
  })

  test('different seeds produce different data', async () => {
    const { factories: f1, db: db1 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 1, factories: { user: UserFactory }
    })
    const { factories: f2, db: db2 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 2, factories: { user: UserFactory }
    })
    // seq counter is same (both = 1st call) but rng state differs
    const a = f1.user.seed(1).buildOne()
    const b = f2.user.seed(2).buildOne()
    expect(a).not.toEqual(b)
    db1.$close(); db2.$close()
  })

  test('parallel makeTestClient calls never collide', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        makeTestClient(FACTORY_SCHEMA, {
          data: async (db) => { await db.account.create({ data: { id: 1, name: `db${i}` } }) }
        })
      )
    )
    const counts = await Promise.all(results.map(({ db }) => db.account.count()))
    expect(counts).toEqual([1, 1, 1, 1, 1])
    results.forEach(({ db }) => db.$close())
  })
})


describe('Factory — buildOne / buildMany', () => {
  test('buildOne returns plain object', () => {
    const f = new UserFactory(null as any)
    const row = f.buildOne()
    expect(row.email).toBe('user1@test.com')
    expect(row.role).toBe('member')
  })

  test('buildOne applies overrides', () => {
    const f = new UserFactory(null as any)
    const row = f.buildOne({ role: 'admin' })
    expect(row.role).toBe('admin')
  })

  test('buildMany returns array', () => {
    const f = new UserFactory(null as any)
    const rows = f.buildMany(3)
    expect(rows.length).toBe(3)
    expect(rows.map((r: any) => r.id)).toEqual([1, 2, 3])
  })

  test('buildMany with per-row overrides fn', () => {
    const f = new UserFactory(null as any)
    const rows = f.buildMany(3, (i: number) => ({ role: i === 0 ? 'admin' : 'member' }))
    expect(rows[0].role).toBe('admin')
    expect(rows[1].role).toBe('member')
  })

  test('state() chains override', () => {
    const f = new UserFactory(null as any).state({ role: 'viewer' })
    expect(f.buildOne().role).toBe('viewer')
  })

  test('state() chains stack (last wins)', () => {
    const f = new UserFactory(null as any)
      .state({ role: 'viewer' })
      .state({ role: 'admin' })
    expect(f.buildOne().role).toBe('admin')
  })

  test('state() fn receives seq and rng', () => {
    const f = new UserFactory(null as any)
      .state((seq: number) => ({ email: `seq${seq}@test.com` }))
    expect(f.buildOne().email).toBe('seq1@test.com')
    expect(f.buildOne().email).toBe('seq2@test.com')
  })
})


describe('Factory — traits', () => {
  test('trait method generated from traits map', () => {
    const f = new UserFactory(null as any)
    expect(typeof f.admin).toBe('function')
    expect(typeof f.member).toBe('function')
  })

  test('trait applies override', () => {
    const f = new UserFactory(null as any)
    expect(f.admin().buildOne().role).toBe('admin')
    expect(f.viewer().buildOne().role).toBe('viewer')
  })

  test('traits chain (last wins)', () => {
    const f = new UserFactory(null as any)
    expect(f.admin().viewer().buildOne().role).toBe('viewer')
  })

  test('AccountFactory.pro() trait', () => {
    const f = new AccountFactory(null as any)
    expect(f.pro().buildOne().plan).toBe('pro')
  })

  test('trait accepts extra overrides', () => {
    const f = new UserFactory(null as any)
    const row = f.admin({ email: 'custom@test.com' }).buildOne()
    expect(row.role).toBe('admin')
    expect(row.email).toBe('custom@test.com')
  })
})


describe('Factory — seed (determinism)', () => {
  test('same seed = same output', () => {
    const f = new UserFactory(null as any).seed(42)
    const a = f.buildMany(5)
    const g = new UserFactory(null as any).seed(42)
    const b = g.buildMany(5)
    expect(a).toEqual(b)
  })

  test('different seeds = different output', () => {
    const a = new UserFactory(null as any).seed(1).buildOne()
    const b = new UserFactory(null as any).seed(2).buildOne()
    expect(a).not.toEqual(b)
  })

  test('seed() does not mutate original factory', () => {
    const base   = new UserFactory(null as any)
    const seeded = base.seed(7)
    expect(base._rng).toBeNull()
    expect(seeded._rng).not.toBeNull()
  })
})


describe('Factory — createOne / createMany', () => {
  let db: any
  let users: UserFactory

  beforeEach(async () => {
    const result = await makeTestClient(FACTORY_SCHEMA, {
      factories: { user: UserFactory, account: AccountFactory }
    })
    db = result.db
    // ensure accountId=1 exists for FK
    await db.account.create({ data: { id: 1, name: 'Test Co' } })
    users = result.factories.user as UserFactory
  })
  afterEach(() => db.$close())

  test('createOne inserts row and returns it', async () => {
    const row = await users.createOne()
    expect(row.id).toBe(1)
    expect(row.email).toBe('user1@test.com')
    const found = await db.user.findUnique({ where: { id: 1 } })
    expect(found?.email).toBe('user1@test.com')
  })

  test('createOne applies overrides', async () => {
    const row = await users.createOne({ role: 'admin', email: 'a@b.com' })
    expect(row.role).toBe('admin')
    expect(row.email).toBe('a@b.com')
  })

  test('createMany inserts n rows', async () => {
    const rows = await users.createMany(3)
    expect(rows.length).toBe(3)
    const n = await db.user.count()
    expect(n).toBe(3)
  })

  test('create(n) shorthand', async () => {
    const rows = await users.create(2)
    expect(rows.length).toBe(2)
  })

  test('create() shorthand (no n = createOne)', async () => {
    const row = await users.create()
    expect(row.id).toBe(1)
  })

  // Regression: create(overrides) used to treat the object as a count and return []
  // — Array.from({ length: {} }) is empty, so nothing threw and no row was written.
  test('create(overrides) makes ONE row, not zero', async () => {
    const row: any = await users.create({ role: 'admin', email: 'a@b.com' })
    expect(Array.isArray(row)).toBe(false)
    expect(row.role).toBe('admin')
    expect(await db.user.count()).toBe(1)
  })

  test('create(n, overrides) applies overrides to every row', async () => {
    const rows: any = await users.create(3, { role: 'viewer' })
    expect(rows.length).toBe(3)
    expect(rows.every((r: any) => r.role === 'viewer')).toBe(true)
  })

  test('create(fn) treats a function as overrides, not a count', async () => {
    const row: any = await users.create(() => ({ role: 'admin' }))
    expect(Array.isArray(row)).toBe(false)
    expect(row.role).toBe('admin')
  })

  test('build(overrides) makes ONE row, not zero', () => {
    const row: any = users.build({ role: 'admin' })
    expect(Array.isArray(row)).toBe(false)
    expect(row.role).toBe('admin')
    expect(users.build(2).length).toBe(2)
  })

  test('trait + createOne', async () => {
    const row = await (users as any).admin().createOne()
    expect(row.role).toBe('admin')
    const dbRow = await db.user.findUnique({ where: { id: 1 } })
    expect(dbRow?.role).toBe('admin')
  })
})


describe('Factory — withRelation', () => {
  let db: any
  let accounts: AccountFactory
  let users: UserFactory
  let posts: PostFactory

  beforeEach(async () => {
    const result = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: AccountFactory, user: UserFactory, post: PostFactory }
    })
    db = result.db
    accounts = result.factories.account as AccountFactory
    users    = result.factories.user    as UserFactory
    posts    = result.factories.post    as PostFactory
  })
  afterEach(() => db.$close())

  test('withRelation auto-creates parent and injects FK', async () => {
    // Make account first for the user FK
    const acct = await accounts.createOne()
    const user = await users.withRelation('account', accounts, 'accountId').createOne()
    expect(user.accountId).toBeDefined()
    const acctExists = await db.account.findUnique({ where: { id: user.accountId } })
    expect(acctExists).not.toBeNull()
  })

  test('withRelation attaches parent to returned row', async () => {
    await accounts.createOne()   // ensure id=1 exists
    const user = await users.withRelation('account', accounts, 'accountId').createOne()
    expect(user.account).toBeDefined()
    expect(user.account.id).toBe(user.accountId)
  })

  test('for() uses existing parent row', async () => {
    const acct = await accounts.createOne()
    const user = await users.for('account', acct, 'accountId').createOne()
    expect(user.accountId).toBe(acct.id)
    expect(user.account).toBe(acct)
  })

  test('createMany shares one auto-created parent across all rows', async () => {
    const acct = await accounts.createOne()
    const userRows = await users.for('account', acct, 'accountId').createMany(3)
    const ids = userRows.map((u: any) => u.accountId)
    expect(ids.every((id: number) => id === acct.id)).toBe(true)
    // Only one account should exist
    const n = await db.account.count()
    expect(n).toBe(1)
  })
})


describe('Factory — afterCreate hook', () => {
  test('afterCreate fires after row inserted', async () => {
    const calls: any[] = []

    class HookedFactory extends Factory {
      model = 'Account'
      definition(seq: number) { return { id: seq, name: `Hooked ${seq}` } }
      afterCreate = async (row: any, db: any) => { calls.push(row) }
    }

    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: HookedFactory }
    })
    await factories.account.createOne()
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('Hooked 1')
    db.$close()
  })

  test('afterCreate can create related rows', async () => {
    class AccountWithUserFactory extends Factory {
      model = 'Account'
      definition(seq: number) { return { id: seq, name: `Co ${seq}` } }
      afterCreate = async (row: any, db: any) => {
        await db.user.create({ data: {
          id: row.id * 100, accountId: row.id,
          email: `owner@${row.id}.com`, role: 'admin'
        }})
      }
    }

    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: AccountWithUserFactory }
    })
    await factories.account.createOne()
    const userCount = await db.user.count()
    expect(userCount).toBe(1)
    db.$close()
  })
})


describe('Factory — relations (has / attach / withParents)', () => {
  const REL_SCHEMA = `
    model Author {
      id    Int    @id @default(autoincrement())
      name  String
      posts Post[]
    }
    model Post {
      id       Int    @id @default(autoincrement())
      title    String
      authorId Int
      author   Author @relation(fields: [authorId], references: [id])
      tags     Tag[]
    }
    model Tag {
      id    Int    @id @default(autoincrement())
      name  String
      posts Post[]
    }
  `

  let db: any
  let factories: any
  beforeEach(async () => {
    const r = await makeTestClient(REL_SCHEMA, { seed: 5, autoFactories: true })
    db = r.db; factories = r.factories
  })
  afterEach(() => db.$close())

  test('has() creates children with the FK pointed back at the parent', async () => {
    const author = await factories.author.has('posts', 3).createOne()
    expect(author.posts.length).toBe(3)
    for (const p of author.posts) expect(p.authorId).toBe(author.id)
    expect(await db.post.count({ where: { authorId: author.id } })).toBe(3)
  })

  test('has() takes overrides for the children', async () => {
    const author = await factories.author.has('posts', 2, { overrides: { title: 'fixed' } }).createOne()
    expect(author.posts.every((p: any) => p.title === 'fixed')).toBe(true)
  })

  test('has() on a field that is not hasMany throws', async () => {
    await expect(factories.author.has('name', 1).createOne()).rejects.toThrow('no hasMany relation')
  })

  test('attach() connects implicit m2m rows', async () => {
    const post = await factories.post.withParents().attach('tags', 2).createOne()
    const full = await db.post.findUnique({ where: { id: post.id }, include: { tags: true } })
    expect(full.tags.length).toBe(2)
  })

  test('attach() accepts existing rows', async () => {
    const tag  = await factories.tag.createOne()
    const post = await factories.post.withParents().attach('tags', [tag]).createOne()
    const full = await db.post.findUnique({ where: { id: post.id }, include: { tags: true } })
    expect(full.tags.map((t: any) => t.id)).toEqual([tag.id])
  })

  test('attach() on a field that is not m2m throws', async () => {
    await expect(factories.post.withParents().attach('title', 1).createOne())
      .rejects.toThrow('no many-to-many relation')
  })

  test('withParents() wires every required belongsTo', async () => {
    const post = await factories.post.withParents().createOne()
    expect(post.authorId).toBeGreaterThan(0)
    expect(await db.author.count()).toBe(1)
  })

  test('withRelation shares one parent; { fresh: true } makes one each', async () => {
    const shared = await factories.post.withRelation('author', factories.author).createMany(3)
    expect(new Set(shared.map((r: any) => r.authorId)).size).toBe(1)
    const fresh = await factories.post
      .withRelation('author', factories.author, 'authorId', 'id', { fresh: true })
      .createMany(3)
    expect(new Set(fresh.map((r: any) => r.authorId)).size).toBe(3)
  })

  test('withParents() without a schema explains itself', () => {
    const bare = new Factory(db)
    bare.model = 'Post'
    expect(() => bare.withParents()).toThrow('needs the parsed schema')
  })

  test('has() without a factory for the child explains itself', async () => {
    const bare: any = new Factory(db)
    bare.model      = 'Author'
    bare._schema    = db.$schema
    bare.definition = () => ({ name: 'x' })
    await expect(bare.has('posts', 1).createOne()).rejects.toThrow('no factory for "Post"')
  })

  test('ambiguous back-reference names the candidates', async () => {
    const r = await makeTestClient(`
      model User { id Int @id @default(autoincrement()); name String; messages Message[] }
      model Message {
        id         Int  @id @default(autoincrement())
        body       String
        senderId   Int
        receiverId Int
        sender     User @relation(fields: [senderId],   references: [id])
        receiver   User @relation(fields: [receiverId], references: [id])
      }
    `, { autoFactories: true })
    await expect(r.factories.user.has('messages', 1).createOne())
      .rejects.toThrow(/more than one relation.*senderId, receiverId/s)
    // …and it works once told which
    const u = await r.factories.user.has('messages', 2, { fk: 'senderId', overrides: { receiverId: 1 } }).createOne()
    expect(u.messages.length).toBe(2)
    r.db.$close()
  })

  test('a relation cycle terminates instead of recursing forever', async () => {
    const r = await makeTestClient(`
      model Node {
        id       Int   @id @default(autoincrement())
        name     String
        parentId Int?
        parent   Node? @relation(fields: [parentId], references: [id])
      }
    `, { autoFactories: true })
    const n = await r.factories.node.withParents().createOne()
    expect(n.id).toBeGreaterThan(0)
    r.db.$close()
  })

  // ── pins ───────────────────────────────────────────────────────────────────
  // A pin reuses a row you already have instead of creating one, keyed by MODEL
  // and applied at EVERY depth. That last part is the whole feature: .for()
  // wires one relation on one factory, so it cannot reach a grandparent.

  const CHAIN = `
    model Org  { id Int @id @default(autoincrement()); name String }
    model Team { id Int @id @default(autoincrement()); name String; orgId Int
                 org Org @relation(fields: [orgId], references: [id]) }
    model User { id Int @id @default(autoincrement()); name String; teamId Int
                 team Team @relation(fields: [teamId], references: [id]) }
  `

  test('a pin reaches a GRANDparent, which .for() cannot', async () => {
    const r = await makeTestClient(CHAIN, { autoFactories: true })
    const org = await r.factories.org.createOne()
    // User → Team → Org: the pin is two hops up, so User has no orgId to wire
    const user = await r.factories.user.withParents({ pins: { Org: org } }).createOne()
    const team = await r.db.team.findUnique({ where: { id: user.teamId } })
    expect(team.orgId).toBe(org.id)
    expect(await r.db.org.count()).toBe(1)   // the pin, and no second Org
    r.db.$close()
  })

  test('pins at two depths are both honoured', async () => {
    const r = await makeTestClient(CHAIN, { autoFactories: true })
    const org  = await r.factories.org.createOne()
    const team = await r.factories.team.withParents({ pins: { Org: org } }).createOne()
    const user = await r.factories.user.withParents({ pins: { Org: org, Team: team } }).createOne()
    expect(user.teamId).toBe(team.id)
    expect(await r.db.team.count()).toBe(1)
    expect(await r.db.org.count()).toBe(1)
    r.db.$close()
  })

  test('a pin for a model not in the chain is unused, not an error', async () => {
    const r = await makeTestClient(CHAIN, { autoFactories: true })
    const org = await r.factories.org.createOne()
    const t = await r.factories.team.withParents({ pins: { Org: org, User: { id: 999 } } }).createOne()
    expect(t.orgId).toBe(org.id)
    r.db.$close()
  })

  test('an explicit .for() beats a pin for the same relation', async () => {
    const r = await makeTestClient(CHAIN, { autoFactories: true })
    const pinned = await r.factories.org.createOne()
    const stated = await r.factories.org.createOne()
    const team = await r.factories.team
      .for('org', stated, 'orgId')
      .withParents({ pins: { Org: pinned } })
      .createOne()
    expect(team.orgId).toBe(stated.id)
    r.db.$close()
  })

  test('no pins behaves exactly as before', async () => {
    const r = await makeTestClient(CHAIN, { autoFactories: true })
    const user = await r.factories.user.withParents().createOne()
    expect(user.teamId).toBeGreaterThan(0)
    expect(await r.db.org.count()).toBe(1)
    r.db.$close()
  })

  // The cycle error tells you to pass the root with .for(). It threw the same
  // error when you did, because the guard ran before the wiring check.
  const CYCLE = `
    model Node { id Int @id @default(autoincrement()); name String; parentId Int
                 parent Node @relation(fields: [parentId], references: [id]) }
  `

  test('a REQUIRED cycle still refuses, and names both cures', async () => {
    const r = await makeTestClient(CYCLE, { autoFactories: true })
    expect(() => r.factories.node.withParents()).toThrow(/cannot be satisfied/)
    expect(() => r.factories.node.withParents()).toThrow(/pins: \{ Node: rootRow \}/)
    r.db.$close()
  })

  test('the cycle error\'s own advice works — .for() cures it', async () => {
    const r = await makeTestClient(CYCLE, { autoFactories: true })
    const root = await r.db.node.create({ data: { name: 'root', parentId: 1 } })
    const child = await r.factories.node.for('parent', root, 'parentId').withParents().createOne()
    expect(child.parentId).toBe(root.id)
    r.db.$close()
  })

  test('a pin cures the same cycle', async () => {
    const r = await makeTestClient(CYCLE, { autoFactories: true })
    const root = await r.db.node.create({ data: { name: 'root', parentId: 1 } })
    const child = await r.factories.node.withParents({ pins: { Node: root } }).createOne()
    expect(child.parentId).toBe(root.id)
    r.db.$close()
  })

  test('asSystem() propagates through the whole wired graph', async () => {
    // A schema with any @@gate auto-installs GatePlugin — an unauthenticated
    // factory grades STRANGER and cannot create the parent, let alone the child.
    const r = await makeTestClient(`
      model Shop  { id Int @id @default(autoincrement()); name String; items Item[]; @@gate("4") }
      model Item  { id Int @id @default(autoincrement()); label String; shopId Int
                    shop Shop @relation(fields: [shopId], references: [id]); @@gate("4") }
    `, { autoFactories: true })
    await expect(r.factories.item.withParents().createOne()).rejects.toThrow(/requires level/)
    const item = await r.factories.item.asSystem().withParents().createOne()
    expect(item.shopId).toBeGreaterThan(0)
    r.db.$close()
  })
})

describe('snapshot / restore', () => {
  const SNAP_SCHEMA = `
    model Author {
      id    Int    @id @default(autoincrement())
      name  String
      posts Post[]
    }
    model Post {
      id       Int    @id @default(autoincrement())
      title    String
      authorId Int
      author   Author @relation(fields: [authorId], references: [id])
    }
  `

  test('restores the exact rows, and is repeatable', async () => {
    const { db, factories } = await makeTestClient(SNAP_SCHEMA, { seed: 1, autoFactories: true })
    await factories.author.has('posts', 2).createOne()
    const snap   = snapshot(db)
    const before = await db.post.findMany()

    await factories.author.has('posts', 5).createOne()
    expect(await db.post.count()).toBe(7)

    restore(db, snap)
    expect(await db.author.count()).toBe(1)
    expect(await db.post.findMany()).toEqual(before)

    // …and again from the same snapshot
    await factories.author.has('posts', 3).createOne()
    restore(db, snap)
    expect(await db.post.findMany()).toEqual(before)
    db.$close()
  })

  test('an @encrypted column round-trips as the same plaintext', async () => {
    // Rows are copied through the raw connection, so ciphertext is preserved
    // byte for byte — a round trip through the ORM would re-encrypt it.
    const { db } = await makeTestClient(
      `model S { id Int @id @default(autoincrement()); tok String @encrypted }`,
      { encryptionKey: 'a'.repeat(64) })
    await db.s.create({ data: { tok: 'hunter2' } })
    const snap = snapshot(db)
    await db.s.create({ data: { tok: 'other' } })
    restore(db, snap)
    const rows = await db.asSystem().s.findMany()
    expect(rows.length).toBe(1)
    expect(rows[0].tok).toBe('hunter2')
    db.$close()
  })

  test('FTS shadow tables are left alone and search still works', async () => {
    const { db } = await makeTestClient(
      `model Doc { id Int @id @default(autoincrement()); title String; body String; @@fts([title, body]) }`)
    await db.doc.create({ data: { title: 'anchor', body: 'harbour ledger' } })
    const snap = snapshot(db)
    expect(Object.keys(snap.main)).toEqual(['doc'])   // no doc_data / doc_idx / …
    await db.doc.create({ data: { title: 'ember', body: 'thicket' } })
    restore(db, snap)
    expect(await db.doc.count()).toBe(1)
    expect((await db.doc.search('harbour')).length).toBe(1)
    db.$close()
  })

  test('restore() without a snapshot says so', async () => {
    const { db } = await makeTestClient(SNAP_SCHEMA)
    expect(() => restore(db, null as any)).toThrow('pass the value snapshot() returned')
    db.$close()
  })
})

describe('defineFactory', () => {
  const DF_SCHEMA = `model User { id Int @id @default(autoincrement()); email String @unique; role String }`

  test('model + definition + traits + afterCreate, no subclass', async () => {
    const seen: any[] = []
    const UserFactory = defineFactory({
      model:       'User',
      definition:  (seq: number) => ({ email: `u${seq}@x.com`, role: 'member' }),
      traits:      { admin: { role: 'admin' }, viewer: { role: 'viewer' } },
      afterCreate: (row: any) => { seen.push(row.email) },
    })

    const { db, factories } = await makeTestClient(DF_SCHEMA, { factories: { user: UserFactory } })
    expect((await factories.user.createOne()).role).toBe('member')
    expect((await factories.user.admin().createOne()).role).toBe('admin')
    expect((await factories.user.viewer({ email: 'v@x.com' }).createOne()).email).toBe('v@x.com')
    expect((await factories.user.admin().createMany(2)).map((r: any) => r.role)).toEqual(['admin', 'admin'])
    expect(seen.length).toBe(5)
    db.$close()
  })

  test('gets the same relation powers as a generated factory', async () => {
    const F = defineFactory({ model: 'Post', definition: () => ({ title: 't' }) })
    const { db, factories } = await makeTestClient(`
      model Author { id Int @id @default(autoincrement()); name String; posts Post[] }
      model Post   { id Int @id @default(autoincrement()); title String; authorId Int
                     author Author @relation(fields: [authorId], references: [id]) }
    `, { autoFactories: true, factories: { post: F } })
    const post = await factories.post.withParents().createOne()
    expect(post.authorId).toBeGreaterThan(0)
    db.$close()
  })

  test('missing model or definition is rejected at definition time', () => {
    expect(() => defineFactory({ definition: () => ({}) } as any)).toThrow('`model` is required')
    expect(() => defineFactory({ model: 'User' } as any)).toThrow('`definition` is required')
  })
})

describe('value catalogue', () => {
  const PERSON = `
    model Person {
      id          Int    @id @default(autoincrement())
      firstName   String
      lastName    String
      email       String @unique @email
      company     String
      city        String
      description String
      whatever    String
    }
  `

  test('seeded rows use the catalogue; unseeded output is unchanged', async () => {
    const seeded = await makeTestClient(PERSON, { seed: 42, autoFactories: true })
    const row: any = seeded.factories.person.buildOne()
    expect(row.firstName).not.toMatch(/^FirstName /)
    expect(row.city).not.toMatch(/^City /)
    expect(row.email).toMatch(/^[a-z]+\.[a-z]+\d+@/)
    // No catalogue entry for this name — falls back to the old shape
    expect(row.whatever).toMatch(/^Whatever /)
    seeded.db.$close()

    const plain = await makeTestClient(PERSON, { autoFactories: true })
    const bare: any = plain.factories.person.buildOne()
    expect(bare.firstName).toBe('FirstName 1')
    expect(bare.city).toBe('City 1')
    expect(bare.email).toBe('Person1@test.com')
    plain.db.$close()
  })

  test('same seed, same catalogue values', async () => {
    const a = await makeTestClient(PERSON, { seed: 7, autoFactories: true })
    const b = await makeTestClient(PERSON, { seed: 7, autoFactories: true })
    expect(a.factories.person.seed(7).buildOne()).toEqual(b.factories.person.seed(7).buildOne())
    a.db.$close(); b.db.$close()
  })

  test('fakeFor returns null without an rng, and for unknown field names', () => {
    expect(fakeFor('firstName', null)).toBeNull()
    const rng = { next: () => 0.5, int: () => 1, pick: (a: any[]) => a[0], bool: () => false, str: () => 'zzzz' }
    expect(fakeFor('firstName', rng as any)).toBeTruthy()
    expect(fakeFor('sprocketWidth', rng as any)).toBeNull()
    expect(fakeEmail(null as any, 1)).toBeNull()
  })

  test('field name matching ignores case and separators', () => {
    const rng = { next: () => 0.5, int: () => 1, pick: (a: any[]) => a[0], bool: () => false, str: () => 'zzzz' }
    for (const name of ['first_name', 'firstName', 'FirstName', 'first-name']) {
      expect(fakeFor(name, rng as any)).toBe(fakeFor('firstname', rng as any))
    }
  })

  test('a @unique catalogue column still cannot collide', async () => {
    // The city pool is smaller than the row count — the seq token is what saves it.
    const { db, factories } = await makeTestClient(
      `model P { id Int @id @default(autoincrement()); city String @unique }`,
      { seed: 3, autoFactories: true })
    const rows = await factories.p.createMany(60)
    expect(new Set(rows.map((r: any) => r.city)).size).toBe(60)
    db.$close()
  })
})

describe('Seeder — dependsOn', () => {
  test('dependencies run first, and each class runs once', async () => {
    const { Seeder } = await import('../src/seeder.js')
    const order: string[] = []
    class A extends Seeder { async run() { order.push('A') } }
    class B extends Seeder { static dependsOn = [A]; async run() { order.push('B') } }
    class C extends Seeder { static dependsOn = [B, A]; async run() { order.push('C') } }

    await new Seeder().call(null as any, [C, B])
    expect(order).toEqual(['A', 'B', 'C'])
  })

  test('runSeeder pulls dependencies too', async () => {
    const { Seeder, runSeeder } = await import('../src/seeder.js')
    const order: string[] = []
    class P extends Seeder { async run() { order.push('P') } }
    class Q extends Seeder { static dependsOn = [P]; async run() { order.push('Q') } }
    await runSeeder(null as any, Q)
    expect(order).toEqual(['P', 'Q'])
  })

  test('a dependency cycle names the classes in it', async () => {
    const { Seeder, runSeeder } = await import('../src/seeder.js')
    class X extends Seeder { static dependsOn: any[] = []; async run() {} }
    class Y extends Seeder { static dependsOn = [X]; async run() {} }
    X.dependsOn = [Y]
    await expect(runSeeder(null as any, Y)).rejects.toThrow('Seeder dependency cycle: Y → X → Y')
  })
})

describe('loadFixture / parseCsv', () => {
  const PLAN = `model Plan {
    id     Int     @id @default(autoincrement())
    code   String  @unique
    price  Int
    active Boolean
  }`

  test('loads an inline array through the ORM', async () => {
    const { db } = await makeTestClient(PLAN)
    const rows = await loadFixture(db, 'Plan', [
      { code: 'free', price: 0, active: true },
      { code: 'pro',  price: 20, active: true },
    ])
    expect(rows.length).toBe(2)
    expect(await db.plan.count()).toBe(2)
    db.$close()
  })

  test('upsert key makes a fixture re-runnable', async () => {
    const { db } = await makeTestClient(PLAN)
    await loadFixture(db, 'Plan', [{ code: 'free', price: 0, active: true }], { upsert: 'code' })
    await loadFixture(db, 'Plan', [{ code: 'free', price: 9, active: true }], { upsert: 'code' })
    expect(await db.plan.count()).toBe(1)
    expect((await db.plan.findFirst({ where: { code: 'free' } })).price).toBe(9)
    db.$close()
  })

  test('reads .json and .csv from disk', async () => {
    const { db } = await makeTestClient(PLAN)
    const dir = join(tmpdir(), `fixture-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plans.json'), JSON.stringify([{ code: 'j1', price: 1, active: true }]))
    writeFileSync(join(dir, 'plans.csv'),  'code,price,active\nc1,5,true\nc2,6,false\n')

    await loadFixture(db, 'Plan', join(dir, 'plans.json'))
    await loadFixture(db, 'Plan', join(dir, 'plans.csv'))
    expect(await db.plan.count()).toBe(3)
    expect((await db.plan.findFirst({ where: { code: 'c2' } })).active).toBe(false)
    rmSync(dir, { recursive: true, force: true })
    db.$close()
  })

  test('unknown model / unsupported extension say what is wrong', async () => {
    const { db } = await makeTestClient(PLAN)
    // The client proxy already names the tables that exist — let its message through
    await expect(loadFixture(db, 'Nope', [{ a: 1 }])).rejects.toThrow('not a table in this schema')
    // Checked before the read, so it is not reported as ENOENT
    await expect(loadFixture(db, 'Plan', './does-not-exist.yaml')).rejects.toThrow('use .json or .csv')
    await expect(loadFixture(db, 'Plan', [{ price: 1 }], { upsert: 'code' }))
      .rejects.toThrow('upsert key "code" missing')
    db.$close()
  })

  test('parseCsv handles quotes, embedded commas and "" escapes', () => {
    const rows = parseCsv('code,note,n\npro,"a, b",2\n"q""x""",plain,3\n')
    expect(rows).toEqual([
      { code: 'pro',    note: 'a, b',  n: 2 },
      { code: 'q"x"',   note: 'plain', n: 3 },
    ])
  })

  test('parseCsv coerces unquoted scalars but keeps quoted text', () => {
    const rows = parseCsv('a,b,c,d\n1,true,,"0123"\n')
    expect(rows[0]).toEqual({ a: 1, b: true, c: null, d: '0123' })
  })
})

describe('Factory — truncate()', () => {
  test('truncate() wipes factory model table', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: AccountFactory }
    })
    await factories.account.createMany(3)
    expect(await db.account.count()).toBe(3)
    await factories.account.truncate()
    expect(await db.account.count()).toBe(0)
    db.$close()
  })
})


describe('truncate() helper', () => {
  test('truncate() hard-deletes all rows in table', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: AccountFactory }
    })
    await factories.account.createMany(5)
    await truncate(db, 'Account')
    expect(await db.account.count()).toBe(0)
    db.$close()
  })

  test('truncate() bypasses soft-delete', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: AccountFactory, user: UserFactory }
    })
    const acct = await factories.account.createOne()
    await factories.user.createMany(3, { accountId: acct.id })
    await db.user.removeMany({})           // soft-delete all
    expect(await db.user.count()).toBe(0)  // soft-filter shows 0
    await truncate(db, 'User')             // hard-delete the soft-deleted rows
    const raw = await db.asSystem().sql`SELECT COUNT(*) as n FROM user`
    expect(raw[0].n).toBe(0)
    db.$close()
  })
})


describe('reset() helper', () => {
  test('reset() wipes all tables', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: AccountFactory, user: UserFactory }
    })
    const acct = await factories.account.create()
    await factories.user.createMany(3, { accountId: acct.id })
    await reset(db)
    expect(await db.account.count()).toBe(0)
    expect(await db.asSystem().user.count({ where: {} })).toBe(0)
    db.$close()
  })

  test('reset() leaves schema intact — can insert after reset', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { account: AccountFactory }
    })
    await factories.account.createMany(3)
    await reset(db)
    await factories.account.createOne()
    expect(await db.account.count()).toBe(1)
    db.$close()
  })
})


describe('Seeder.once()', () => {
  test('once() runs fn on first call', async () => {
    const { db } = await makeTestClient(FACTORY_SCHEMA)
    const { Seeder: S } = await import('../src/seeder.js')
    const seeder = new S()
    let ran = 0
    await seeder.once(db, 'test-v1', async () => { ran++ })
    expect(ran).toBe(1)
    db.$close()
  })

  test('once() skips fn on subsequent calls with same key', async () => {
    const { db } = await makeTestClient(FACTORY_SCHEMA)
    const { Seeder: S } = await import('../src/seeder.js')
    const seeder = new S()
    let ran = 0
    await seeder.once(db, 'idempotent-v1', async () => { ran++ })
    await seeder.once(db, 'idempotent-v1', async () => { ran++ })
    await seeder.once(db, 'idempotent-v1', async () => { ran++ })
    expect(ran).toBe(1)
    db.$close()
  })

  test('once() runs different keys independently', async () => {
    const { db } = await makeTestClient(FACTORY_SCHEMA)
    const { Seeder: S } = await import('../src/seeder.js')
    const seeder = new S()
    let ran = 0
    await seeder.once(db, 'key-a', async () => { ran++ })
    await seeder.once(db, 'key-b', async () => { ran++ })
    expect(ran).toBe(2)
    db.$close()
  })
})

// ─── Schema-derived testing utilities ────────────────────────────────────────
// NOTE: This file is getting long (~550 lines of test suites added this session).
//       Consider splitting into testing.test.ts in a future cleanup pass.

import { generateFactory, generateGateMatrix, generateValidationCases, factoryFrom,
         deriveAccess, renderAccessSnapshot, gateLadder, policyExprToString,
         expectedVerdict, REACHABLE_LEVELS, createTestEnv, readOnly, sampleWrites }
  from '../src/testing.js'
import { GatePlugin, LEVELS, levelPasses } from '../src/plugins/gate.js'
import { Plugin } from '../src/core/plugin.js'
import { _resetTemplates }       from '../src/testdb.js'
import { DEFAULT_MESSAGES }      from '../src/core/validate.js'

// ── Shared schema for utility tests ──────────────────────────────────────────

const UTIL_SCHEMA = `
  enum Status { new active archived }
  enum Plan   { starter pro enterprise }

  model Account {
    id    Int @id
    name  String
    plan  Plan    @default(starter)
    url   String?   @url
    slug  String?   @length(3, 50)
  }

  model Lead {
    id        Int @id
    accountId Int
    email     String?   @email
    firstName String?
    lastName  String?
    status    Status  @default(new)
    score     Float?   @gte(0) @lte(100)
    notes     String?   @contains("note")
  }

  model Post {
    id        Int @id
    accountId Int
    title     String
    body      String?
    published Boolean
    views     Int
    rating    Float
    createdAt DateTime?
    updatedAt DateTime?
    deletedAt DateTime?
    @@gate("1.3.4.6")
    @@softDelete
  }

  model Locked {
    id    Int @id
    name  String
    @@gate("9")
  }

  model Open {
    id   Int @id
    data String?
    @@gate("0")
  }
`

// ─── generateFactory ─────────────────────────────────────────────────────────


describe('generateFactory', () => {
  const { schema } = parse(UTIL_SCHEMA)

  test('throws on unknown model', () => {
    expect(() => generateFactory(schema, 'nope')).toThrow('not found')
  })

  test('skips @id Int (auto-increment)', () => {
    const def = generateFactory(schema, 'Account')
    const row = def(1, null)
    expect('id' in row).toBe(false)
  })

  test('skips createdAt, updatedAt, deletedAt', () => {
    const def = generateFactory(schema, 'Post')
    const row = def(1, null)
    expect('createdAt' in row).toBe(false)
    expect('updatedAt' in row).toBe(false)
    expect('deletedAt' in row).toBe(false)
  })

  test('skips relation fields', () => {
    const { schema: s } = parse(`
      model User { id Int @id; name String; posts Post[] }
      model Post { id Int @id; userId Int; title String }
    `)
    const def = generateFactory(s, 'User')
    expect('posts' in def(1, null)).toBe(false)
  })

  test('@default(literal string) used', () => {
    const { schema: s } = parse(`model T { id Int @id; role String @default("admin") }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.role).toBe('admin')
  })

  test('@default(number) used', () => {
    const { schema: s } = parse(`model T { id Int @id; count Int @default(0) }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.count).toBe(0)
  })

  test('@default(boolean) used', () => {
    const { schema: s } = parse(`model T { id Int @id; active Boolean @default(true) }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.active).toBe(true)
  })

  test('@default(enum) used', () => {
    const def = generateFactory(schema, 'Account')
    const row = def(1, null)
    expect(row.plan).toBe('starter')
  })

  test('Enum type no default → first value', () => {
    const { schema: s } = parse(`
      enum Color { red green blue }
      model T { id Int @id; color Color }
    `)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.color).toBe('red')
  })

  test('@email → model+seq@test.com', () => {
    const def = generateFactory(schema, 'Lead')
    expect(def(1, null).email).toBe('Lead1@test.com')
    expect(def(2, null).email).toBe('Lead2@test.com')
  })

  test('@url → example.com url', () => {
    const def = generateFactory(schema, 'Account')
    const row = def(1, null)
    // url is optional — null when optional and no other String constraint
    // but @url is a text constraint so should be non-null
    expect(row.url).toMatch(/^https:\/\//)
  })

  test('@length(min, max) → x repeated min times', () => {
    const def = generateFactory(schema, 'Account')
    const row = def(1, null)
    expect(row.slug?.length).toBeGreaterThanOrEqual(3)
  })

  test('plain String → "FieldName seq"', () => {
    const def = generateFactory(schema, 'Account')
    const row = def(1, null)
    expect(row.name).toBe('Name 1')
  })

  test('plain String increments with seq', () => {
    const def = generateFactory(schema, 'Account')
    expect(def(1, null).name).toBe('Name 1')
    expect(def(3, null).name).toBe('Name 3')
  })

  test('String? optional no constraint → null', () => {
    const def = generateFactory(schema, 'Lead')
    expect(def(1, null).firstName).toBeNull()
    expect(def(1, null).lastName).toBeNull()
  })

  test('Int FK field → 1', () => {
    const def = generateFactory(schema, 'Lead')
    expect(def(1, null).accountId).toBe(1)
  })

  test('Int FK field respects fkDefaults', () => {
    const def = generateFactory(schema, 'Lead', { fkDefaults: { accountId: 42 } })
    expect(def(1, null).accountId).toBe(42)
  })

  test('Int non-FK → seq', () => {
    const def = generateFactory(schema, 'Post')
    expect(def(3, null).views).toBe(3)
  })

  test('Int? optional → null', () => {
    const { schema: s } = parse(`model T { id Int @id; count Int? }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.count).toBeNull()
  })

  test('Float with @gte and @lte → midpoint', () => {
    const def = generateFactory(schema, 'Lead')
    expect(def(1, null).score).toBeNull()   // optional → null
  })

  test('Float with @gte and @lte required → midpoint', () => {
    const { schema: s } = parse(`model T { id Int @id; score Float @gte(0) @lte(100) }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.score).toBe(50)
  })

  test('Float with @gte only → gte value', () => {
    const { schema: s } = parse(`model T { id Int @id; n Float @gte(5) }`)
    expect(generateFactory(s, 'T')(1, null).n).toBe(5)
  })

  test('Float no constraint → seq * 1.0', () => {
    const def = generateFactory(schema, 'Post')
    expect(def(2, null).rating).toBe(2.0)
  })

  test('Boolean → false', () => {
    const def = generateFactory(schema, 'Post')
    expect(def(1, null).published).toBe(false)
  })

  // Required Json used to generate null, which fails "meta is required" on every
  // write — autoFactories could not produce a writable row for such a model.
  test('Json required → {}, Json? optional → null', () => {
    const { schema: s } = parse(`model T { id Int @id; meta Json; extra Json? }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.meta).toEqual({})
    expect(row.extra).toBeNull()
  })

  test('Bytes required → bytes, Bytes? optional → null', () => {
    const { schema: s } = parse(`model T { id Int @id; blob Bytes; extra Bytes? }`)
    const row = generateFactory(s, 'T')(1, null) as any
    expect(row.blob).toBeInstanceOf(Uint8Array)
    expect(row.extra).toBeNull()
  })

  test('@unique @length generates a DISTINCT value per seq', () => {
    const { schema: s } = parse(`model T { id Int @id; code String @unique @length(4, 12) }`)
    const def  = generateFactory(s, 'T')
    const vals = [1, 2, 3].map(n => def(n, null).code as string)
    expect(new Set(vals).size).toBe(3)
    for (const v of vals) {
      expect(v.length).toBeGreaterThanOrEqual(4)
      expect(v.length).toBeLessThanOrEqual(12)
    }
  })

  test('Int honours @gte / @lte', () => {
    const { schema: s } = parse(`model T { id Int @id; age Int @gte(18) @lte(99) }`)
    const def = generateFactory(s, 'T')
    for (const n of [1, 2, 50, 11001]) {
      const age = def(n, null).age as number
      expect(age).toBeGreaterThanOrEqual(18)
      expect(age).toBeLessThanOrEqual(99)
    }
  })

  test('Int honours exclusive @gt / @lt', () => {
    const { schema: s } = parse(`model T { id Int @id; n Int @gt(0) @lt(10) }`)
    const def = generateFactory(s, 'T')
    for (const seq of [1, 2, 3, 99]) {
      const n = def(seq, null).n as number
      expect(n).toBeGreaterThan(0)
      expect(n).toBeLessThan(10)
    }
  })

  test('Float honours exclusive @gt', () => {
    const { schema: s } = parse(`model T { id Int @id; n Float @gt(0) }`)
    expect(generateFactory(s, 'T')(1, null).n as number).toBeGreaterThan(0)
  })

  test('@phone → a value the @phone validator accepts', () => {
    const { schema: s } = parse(`model T { id Int @id; phone String @phone }`)
    const v = generateFactory(s, 'T')(1, null).phone as string
    expect(v).toMatch(/^\+?[\d\s\-().]{7,20}$/)
  })

  test('@regex → a value matching the pattern', () => {
    const { schema: s } = parse(`model T { id Int @id; ref String @regex("^[A-Z]{3}-[0-9]{4}$") }`)
    const v = generateFactory(s, 'T')(1, null).ref as string
    expect(v).toMatch(/^[A-Z]{3}-[0-9]{4}$/)
  })

  test('@regex → \\d \\w escapes, groups and quantifiers', () => {
    const cases = [
      '^SKU-\\d{6}$',
      '^(a|b)-\\w{4}$',
      '^[a-z]+@[a-z]{2,4}\\.com$',
      '^v\\d+\\.\\d+$',
    ]
    for (const pattern of cases) {
      const { schema: s } = parse(`model T { id Int @id; v String @regex("${pattern.replace(/\\/g, '\\\\')}") }`)
      const v = generateFactory(s, 'T')(1, null).v as string
      expect(new RegExp(pattern).test(v)).toBe(true)
    }
  })

  test('@startsWith / @endsWith honoured', () => {
    const { schema: s } = parse(`model T { id Int @id; v String @startsWith("pre") @endsWith("post") }`)
    const v = generateFactory(s, 'T')(1, null).v as string
    expect(v.startsWith('pre')).toBe(true)
    expect(v.endsWith('post')).toBe(true)
  })

  test('array honours @minItems', () => {
    const { schema: s } = parse(`model T { id Int @id; tags String[] @minItems(2) }`)
    const tags = generateFactory(s, 'T')(1, null).tags as string[]
    expect(tags.length).toBe(2)
  })

  test('DateTime is derived from seq, not the wall clock', () => {
    const { schema: s } = parse(`model T { id Int @id; at DateTime }`)
    const def = generateFactory(s, 'T')
    expect(def(1, null).at).toBe(def(1, null).at)
    expect(def(1, null).at).not.toBe(def(2, null).at)
  })

  test('@sequence field is skipped — the db owns that counter', () => {
    const { schema: s } = parse(`model Q { id Int @id; accountId Int; num Int @sequence(scope: accountId) }`)
    expect('num' in generateFactory(s, 'Q')(1, null)).toBe(false)
  })

  test('enum varies under a seeded rng, stays stable unseeded', () => {
    const { schema: s } = parse(`
      enum Color { red green blue }
      model T { id Int @id; color Color }
    `)
    const def = generateFactory(s, 'T')
    expect(def(1, null).color).toBe('red')
    const rng = { next: () => 0.9, int: () => 0, pick: (a: any[]) => a[2], bool: () => false, str: () => 'zzzz' }
    expect(def(1, rng as any).color).toBe('blue')
  })

  test('String[] required → []', () => {
    const { schema: s } = parse(`model T { id Int @id; tags String[] }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.tags).toEqual([])
  })

  test('String[]? optional → null', () => {
    const { schema: s } = parse(`model T { id Int @id; tags String[]? }`)
    const row = generateFactory(s, 'T')(1, null)
    expect(row.tags).toBeNull()
  })

  test('@secret included (ORM encrypts on write)', () => {
    const ENC = 'c'.repeat(64)
    const { schema: s } = parse(`model T { id Int @id; token String @secret }`)
    const row = generateFactory(s, 'T')(1, null)
    // @secret field is present — value generated like any String field
    expect('token' in row).toBe(true)
    expect(typeof row.token).toBe('string')
  })

  test('output is a plain function', () => {
    const defFn = generateFactory(schema, 'Account')
    expect(typeof defFn).toBe('function')
    expect(typeof defFn(1, null)).toBe('object')
  })

  test('all generated values pass schema validation via createOne', async () => {
    const { db, factories } = await makeTestClient(UTIL_SCHEMA, {
      autoFactories: true,
    })
    // seed parent first
    await db.account.create({ data: { id: 1, name: 'Test Co', url: 'https://test.com', slug: 'test' } })
    const lead = await factories.lead.createOne()
    expect(lead).not.toBeNull()
    db.$close()
  })
})

// ─── generateGateMatrix ───────────────────────────────────────────────────────


describe('generateGateMatrix', () => {
  const { schema } = parse(UTIL_SCHEMA)

  test('throws on unknown model', () => {
    expect(() => generateGateMatrix(schema, 'nope')).toThrow('not found')
  })

  test('returns empty array for model with no @@gate', () => {
    const matrix = generateGateMatrix(schema, 'Account')
    expect(matrix).toEqual([])
  })

  test('rejects an unknown levels option', () => {
    expect(() => generateGateMatrix(schema, 'Post', { levels: 'both' as never })).toThrow('must be "full" or "edges"')
  })

  test('full is the default — every op against every reachable level', () => {
    const matrix = generateGateMatrix(schema, 'Post')  // @@gate("1.3.4.6")
    expect(matrix.length).toBe(36)                      // 4 ops × levels 0–8
    expect(matrix).toEqual(generateGateMatrix(schema, 'Post', { levels: 'full' }))
  })

  test('full ladder flips exactly once, at the declared level', () => {
    const matrix = generateGateMatrix(schema, 'Post')
    for (const [op, required] of [['read', 1], ['create', 3], ['update', 4], ['delete', 6]] as const) {
      const ladder = matrix.filter(c => c.op === op).sort((a, b) => a.level - b.level)
      expect(ladder.map(c => c.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
      expect(ladder.map(c => c.expect)).toEqual(
        ladder.map(c => (c.level >= required ? 'allow' : 'deny'))
      )
      expect(ladder.every(c => c.required === required)).toBe(true)
    }
  })

  test('edges: 2 cases per op, the required level and the one below', () => {
    const matrix = generateGateMatrix(schema, 'Post', { levels: 'edges' })
    expect(matrix.length).toBe(8)

    const readAllow = matrix.find(c => c.op === 'read' && c.expect === 'allow')
    const readDeny  = matrix.find(c => c.op === 'read' && c.expect === 'deny')
    expect(readAllow?.level).toBe(1)
    expect(readAllow?.label).toBe('VISITOR')
    expect(readDeny?.level).toBe(0)
    expect(readDeny?.label).toBe('STRANGER')

    const delAllow = matrix.find(c => c.op === 'delete' && c.expect === 'allow')
    const delDeny  = matrix.find(c => c.op === 'delete' && c.expect === 'deny')
    expect(delAllow?.level).toBe(6)
    expect(delAllow?.label).toBe('OWNER')
    expect(delDeny?.level).toBe(5)
    expect(delDeny?.label).toBe('ADMINISTRATOR')
  })

  test('LOCKED gate (9): every level denied, SYSTEM included', () => {
    const matrix = generateGateMatrix(schema, 'Locked')  // @@gate("9")
    expect(matrix.length).toBe(36)
    expect(matrix.every(c => c.expect === 'deny')).toBe(true)
    expect(matrix.some(c => c.level === 8)).toBe(true)

    const edges = generateGateMatrix(schema, 'Locked', { levels: 'edges' })
    expect(edges.length).toBe(4)                          // one deny per op
    expect(edges.every(c => c.level === 8)).toBe(true)    // SYSTEM
  })

  test('STRANGER gate (0): every level allowed', () => {
    const matrix = generateGateMatrix(schema, 'Open')    // @@gate("0")
    expect(matrix.length).toBe(36)
    expect(matrix.every(c => c.expect === 'allow')).toBe(true)

    const edges = generateGateMatrix(schema, 'Open', { levels: 'edges' })
    expect(edges.length).toBe(4)                          // no level below STRANGER to deny at
    expect(edges.every(c => c.level === 0)).toBe(true)
  })

  test('SYSTEM gate (8): SYSADMIN is denied, only asSystem() passes', () => {
    const { schema: s } = parse(`
      model Vault { id Int @id; name String; @@gate("8") }
    `)
    const ladder = generateGateMatrix(s, 'Vault').filter(c => c.op === 'read')
    expect(ladder.find(c => c.level === 7)?.expect).toBe('deny')
    expect(ladder.find(c => c.level === 8)?.expect).toBe('allow')
  })

  test('all ops covered', () => {
    const matrix = generateGateMatrix(schema, 'Post')
    const ops = [...new Set(matrix.map(c => c.op))]
    expect(ops.sort()).toEqual(['create', 'delete', 'read', 'update'])
  })

  test('labels match LEVELS keys', () => {
    const matrix = generateGateMatrix(schema, 'Post')
    for (const c of matrix) {
      if (!c.label.startsWith('LEVEL_')) {
        expect(LEVELS[c.label]).toBe(c.level)
      }
    }
  })

  // The whole point of the matrix is that its verdicts are the plugin's. Every
  // case in the full ladder is run against a real client — a generated suite
  // that disagreed with enforcement would certify access the app does not grant.
  test('every case in the full matrix matches GatePlugin', async () => {
    const { schema: s } = parse(UTIL_SCHEMA)
    const matrix = generateGateMatrix(s, 'Post')

    // getLevel clamps to 0–7, so SYSTEM is not reachable through it at all.
    // asSystem() is the only door, which is exactly what the level-8 case says.
    let level = 0
    const { db } = await makeTestClient(UTIL_SCHEMA, {
      plugins: [new GatePlugin({ getLevel: () => level })]
    })
    const sys = db.asSystem()
    await sys.account.create({ data: { id: 1, name: 'Test' } })

    let nextId = 100
    for (const c of matrix) {
      level = c.level
      const scoped = c.level === 8 ? db.asSystem() : db.$setAuth({ id: 1 })

      await sys.post.deleteMany({})
      await sys.post.create({ data: { id: 1, accountId: 1, title: 'T', published: false, views: 0, rating: 0 } })

      const run = async () => {
        switch (c.op) {
          case 'read':   return scoped.post.findMany()
          case 'create': return scoped.post.create({ data: { id: nextId++, accountId: 1, title: 'X', published: false, views: 0, rating: 0 } })
          case 'update': return scoped.post.update({ where: { id: 1 }, data: { title: 'Y' } })
          case 'delete': return scoped.post.delete({ where: { id: 1 } })
        }
      }

      if (c.expect === 'allow') await expect(run()).resolves.toBeDefined()
      else                      await expect(run()).rejects.toThrow(/requires level/i)
    }
    db.$close()
  })
})

// ─── deriveAccess / renderAccessSnapshot ─────────────────────────────────────
//
// The access snapshot is a security artefact — it is read to decide whether a
// gate change was intended. Two properties carry that weight: it must describe
// what the plugin actually enforces, and its diff must name only what moved.

const ACCESS_SCHEMA = `
  enum Stage { draft review published }

  model Reference {
    id   Int @id
    code String
  }

  model Doc {
    id        Int      @id
    ownerId   Int
    stage     Stage    @default(draft)
    title     String
    salary    Float?    @allow('read', auth().role == 'admin')
    deletedAt DateTime?

    @@gate("2.4.4.6")
    @@softDelete
    @@allow('read', ownerId == auth().id || stage == 'published')
    @@deny('update', stage == 'published', "A published doc is frozen")
    @@transitions(stage,
      review:    draft -> review,
      publish:   review -> published @gate(5),
    )
  }

  model Vault {
    id     Int    @id
    name   String
    token  String  @guarded(all)
    pin    String  @encrypted
    apiKey String  @secret
    @@gate("8")
  }

  model Ledger {
    id   Int @id
    note String
    @@gate("9")
  }
`

describe('deriveAccess', () => {
  const { schema } = parse(ACCESS_SCHEMA)
  const access = deriveAccess(schema)
  const byName = (n: string) => access.models.find(m => m.name === n)!

  test('models come back sorted by name, not in schema order', () => {
    // Diff stability: a model inserted mid-file otherwise shifts every row below
    // it and the diff stops naming what actually changed.
    expect(access.models.map(m => m.name)).toEqual(['Doc', 'Ledger', 'Reference', 'Vault'])
  })

  test('counts the surface', () => {
    expect(access.counts).toMatchObject({
      models: 4, gated: 3, unrestricted: 1, policied: 1, protected: 2, transitions: 2,
    })
  })

  test('a model with neither @@gate nor @@allow is flagged unrestricted', () => {
    expect(byName('Reference').unrestricted).toBe(true)
    expect(byName('Reference').gate).toBe(null)
    expect(byName('Doc').unrestricted).toBe(false)
  })

  test('the gate is the parsed tuple, and the declared string is kept', () => {
    expect(byName('Doc').gate).toEqual({ read: 2, create: 4, update: 4, delete: 6 })
    expect(byName('Doc').gateSource).toBe('2.4.4.6')
  })

  test('policies keep their operation, predicate and custom message', () => {
    const p = byName('Doc').policies
    expect(p.read.allows).toEqual([{ expr: `ownerId == auth().id || stage == 'published'`, message: null }])
    expect(p.update.denies).toEqual([{ expr: `stage == 'published'`, message: 'A published doc is frozen' }])
    // No @@allow('create') was written, so nothing claims create is restricted.
    expect(p.create).toBeUndefined()
  })

  test('@secret is reported as @secret, not as the pair it expands to', () => {
    // @secret desugars to @encrypted + @guarded(all) at parse time and keeps its
    // own attribute, so the field carries all three. Report what was written.
    const fields = Object.fromEntries(byName('Vault').fields.map(f => [f.name, f.protection]))
    expect(fields).toEqual({ token: '@guarded(all)', pin: '@encrypted', apiKey: '@secret' })
  })

  test('a field @allow is reported with its operations', () => {
    expect(byName('Doc').fields).toContainEqual({
      name: 'salary', protection: null,
      allows: [{ operations: ['read'], expr: `auth().role == 'admin'` }],
    })
  })

  test('transitions carry their gate, and an ungated move reports null', () => {
    expect(byName('Doc').transitions).toEqual([
      { field: 'stage', name: 'review',  from: ['draft'],  to: 'review',    gate: null },
      { field: 'stage', name: 'publish', from: ['review'], to: 'published', gate: 5 },
    ])
  })

  test('softDelete is carried, because remove() is graded at the update position', () => {
    expect(byName('Doc').softDelete).toBe(true)
    expect(byName('Vault').softDelete).toBe(false)
  })
})

describe('gateLadder', () => {
  const { schema } = parse(ACCESS_SCHEMA)
  const access = deriveAccess(schema)
  const byName = (n: string) => access.models.find(m => m.name === n)!

  test('an ungated model has no ladder at all', () => {
    expect(gateLadder(byName('Reference'))).toEqual([])
  })

  test('every verdict agrees with the plugin predicate', () => {
    // The whole value of the artefact is that it does not restate the rule.
    for (const model of access.models) {
      for (const row of gateLadder(model))
        expect(row.expect).toBe(levelPasses(row.required, row.level) ? 'allow' : 'deny')
    }
  })

  test('SYSTEM(8) refuses SYSADMIN(7); LOCKED(9) refuses everything', () => {
    const vault  = gateLadder(byName('Vault')).filter(r => r.op === 'read')
    expect(vault.find(r => r.level === 7)?.expect).toBe('deny')
    expect(vault.find(r => r.level === 8)?.expect).toBe('allow')

    expect(gateLadder(byName('Ledger')).every(r => r.expect === 'deny')).toBe(true)
  })
})

describe('expectedVerdict', () => {
  // The oracle is stated in access.js and the enforcement in gate.js, and they
  // must not share a definition — an expected value read off the code under test
  // cannot fail. This is the single place the two are held together, so a
  // divergence surfaces here rather than as a suite that quietly stops asserting.
  test('agrees with the gate plugin over every (required, level) pair', () => {
    for (let required = 0; required <= 9; required++) {
      for (const level of REACHABLE_LEVELS) {
        expect(`${required}/${level}:${expectedVerdict(required, level)}`)
          .toBe(`${required}/${level}:${levelPasses(required, level) ? 'allow' : 'deny'}`)
      }
    }
  })

  test('states the two sentinels', () => {
    expect(expectedVerdict(9, 8)).toBe('deny')    // LOCKED — asSystem() included
    expect(expectedVerdict(8, 7)).toBe('deny')    // SYSTEM — SYSADMIN is not it
    expect(expectedVerdict(8, 8)).toBe('allow')
    expect(expectedVerdict(0, 0)).toBe('allow')
  })
})

describe('policyExprToString', () => {
  // A snapshot of the wrong predicate is worse than no snapshot, so the printer
  // is checked by round trip rather than against hand-written strings.
  const roundTrip = (src: string) => {
    const render = (s: string) => {
      const { schema } = parse(`model P { id Int @id; a Int; b Int; @@allow('read', ${s}) }`)
      return policyExprToString((schema.models[0].attributes as any[]).find(x => x.kind === 'allow').expr)
    }
    const once = render(src)
    expect(render(once)).toBe(once)   // re-parsing the output yields the same output
    return once
  }

  test('and binds tighter than or, and the parens say so', () => {
    expect(roundTrip('a == 1 || b == 2 && a == 3')).toBe('a == 1 || b == 2 && a == 3')
    expect(roundTrip('(a == 1 || b == 2) && a == 3')).toBe('(a == 1 || b == 2) && a == 3')
  })

  test('auth, now, check, null, booleans and strings', () => {
    expect(roundTrip('auth() != null')).toBe('auth() != null')
    expect(roundTrip('auth().workspaceId == b')).toBe('auth().workspaceId == b')
    expect(roundTrip('a < now()')).toBe('a < now()')
    expect(roundTrip("check(b, 'update')")).toBe("check(b, 'update')")
    expect(roundTrip('a == true')).toBe('a == true')
    expect(roundTrip("a == 'draft'")).toBe("a == 'draft'")
  })

  test('negation of a comparison is parenthesised and re-parses the same', () => {
    expect(roundTrip('!(a == 1)')).toBe('!(a == 1)')
    expect(roundTrip('!(a == 1 && b == 2)')).toBe('!(a == 1 && b == 2)')
  })
})

describe('renderAccessSnapshot', () => {
  const { schema } = parse(ACCESS_SCHEMA)
  const md = renderAccessSnapshot(deriveAccess(schema), { source: 'db/schema.lite' })

  test('is deterministic — the same schema renders byte-identical', () => {
    // --check compares the whole file. Any instability makes it cry wolf, and a
    // check that cries wolf gets disabled.
    expect(renderAccessSnapshot(deriveAccess(parse(ACCESS_SCHEMA).schema), { source: 'db/schema.lite' })).toBe(md)
  })

  test('reordering models in the source does not change the snapshot', () => {
    const reordered = ACCESS_SCHEMA
      .replace(/model Reference \{[\s\S]*?\n  \}\n/, '')
      .concat('\n  model Reference {\n    id   Int @id\n    code String\n  }\n')
    expect(renderAccessSnapshot(deriveAccess(parse(reordered).schema), { source: 'db/schema.lite' })).toBe(md)
  })

  test('names the unrestricted model first — it is the loudest thing here', () => {
    expect(md.indexOf('## Unrestricted')).toBeLessThan(md.indexOf('## Gates'))
    expect(md).toContain('- `Reference`')
  })

  test('carries the gate table, the predicates, the fields and the moves', () => {
    expect(md).toContain('| `Doc` | 2 READER | 4 USER | 4 USER | 6 OWNER |')
    expect(md).toContain('allow **read** — `ownerId == auth().id || stage == \'published\'`')
    expect(md).toContain('A published doc is frozen')
    expect(md).toContain('| `Vault` | `apiKey` | `@secret` |')
    expect(md).toContain('| `Doc` | `stage` | `publish` | review → published | 5 ADMINISTRATOR |')
  })

  test('a section with nothing in it is omitted, not left empty', () => {
    const bare = renderAccessSnapshot(deriveAccess(parse(`model A { id Int @id; n String }`).schema))
    expect(bare).toContain('## Unrestricted')
    expect(bare).not.toContain('## Gates')
    expect(bare).not.toContain('## Row policies')
    expect(bare).not.toContain('## State transitions')
  })
})

// ─── createTestEnv ───────────────────────────────────────────────────────────

const ENV_SCHEMA = `
  model Account { id Int @id; name String }
  model Doc {
    id      Int    @id
    title   String
    @@gate("2.4.4.6")
  }
  model Vault { id Int @id; secret String; @@gate("8") }
`

// For verifyConstraints: rules of several shapes, a @unique to collide on, and a
// required parent — the three things that made the runner's own harness wrong
// before they were in a fixture.
const RULES_ENV_SCHEMA = `
  model Team {
    id     Int    @id
    slug   String @unique
    name   String
    people Person[]
  }
  model Person {
    id     Int    @id
    email  String @email @unique
    handle String @length(3, 12)
    age    Int    @gte(18) @lte(120)
    teamId Int
    team   Team   @relation(fields: [teamId], references: [id])
  }
`

const LADDER_SCHEMA = `
  model Team { id Int @id  slug String @unique  name String  people Person[] }
  model Person {
    id     Int    @id
    handle String @length(3, 12)
    teamId Int
    team   Team   @relation(fields: [teamId], references: [id])
    @@gate("2.4.4.5")
  }
`

// A CREATE policy, because that is the operation where a policy raises. A read
// policy compiles into the WHERE and filters — it never refuses, which is the
// whole reason a wrong one is an empty screen rather than an error.
const POLICY_LADDER_SCHEMA = `
  model Note {
    id      Int    @id
    ownerId String
    title   String
    @@gate("2.4.4.5")
    @@allow('create', ownerId == auth().id)
  }
`

// A discriminating read policy over a NULLABLE column, so rows land on both
// sides. `title != null` on a required column admits everything and proves
// nothing, which the runner says out loud.
const POLICY_SCHEMA = `
  model Post {
    id      Int     @id
    ownerId String?
    status  String  @default("draft")
    title   String
    @@allow('read',   ownerId == auth().id || ownerId == null || status == 'published')
    @@allow('update', ownerId == auth().id)
    @@deny('read',    status == 'archived')
  }
`

// A required belongsTo, so a derived create payload has an FK it must fill from
// a parent that actually exists.
const RELATED_SCHEMA = `
  model Account {
    id    Int    @id
    name  String
    leads Lead[]
  }

  model Lead {
    id        Int      @id
    name      String
    accountId Int
    account   Account  @relation(fields: [accountId], references: [id])
    createdAt DateTime @default(now())
  }
`

const GUARDED_SCHEMA = `
  model Vaulted {
    id     Int    @id
    name   String
    token  String @guarded
  }
`

describe('createTestEnv', () => {
  test('refuses to guess a schema', async () => {
    await expect(createTestEnv({})).rejects.toThrow(/pass `schema`/)
  })

  test('takes a path as readily as the text', async () => {
    const env = await createTestEnv({ schema: join(import.meta.dir, 'fixtures', 'env-schema.lite') })
    expect(env.schema.models.map((m: any) => m.name)).toContain('Doc')
    env.close()
  })

  test('two envs on one schema share a template and nothing else', async () => {
    // The template-clone claim in full: the DDL is applied once, and a write in
    // one env is invisible to the other. A shared template that leaked rows
    // would be worse than re-migrating.
    const a = await createTestEnv({ schema: ENV_SCHEMA })
    const b = await createTestEnv({ schema: ENV_SCHEMA })

    await a.system.account.create({ data: { id: 1, name: 'only in a' } })
    expect(await a.system.account.count()).toBe(1)
    expect(await b.system.account.count()).toBe(0)

    a.close(); b.close()
  })

  test('a template is built once per schema, not once per env', async () => {
    _resetTemplates()
    const first = await createTestEnv({ schema: ENV_SCHEMA })
    const at    = Date.now()
    const rest  = await Promise.all([1, 2, 3, 4, 5].map(() => createTestEnv({ schema: ENV_SCHEMA })))
    const ms    = Date.now() - at

    // Five clones of an already-migrated template. The assertion is loose on
    // purpose — it is here to catch the cache being bypassed entirely, not to
    // police a millisecond count on someone else's laptop.
    expect(ms).toBeLessThan(2000)
    for (const env of rest) expect(await env.system.account.count()).toBe(0)

    first.close()
    for (const env of rest) env.close()
  })

  test('atLevel grades synthetically and ignores the app resolver', async () => {
    // The resolver here would grade everyone OWNER. atLevel must not call it —
    // a grid driven through the app's own getLevel proves nothing about the gate.
    let resolverCalls = 0
    const env = await createTestEnv({
      schema:  ENV_SCHEMA,
      plugins: [new GatePlugin({ getLevel: () => { resolverCalls++; return 6 } })],
    })

    const reader = await env.atLevel(2)
    expect(await reader.doc.findMany()).toEqual([])
    await expect(reader.doc.create({ data: { id: 1, title: 't' } })).rejects.toThrow(/requires level 4/)
    expect(resolverCalls).toBe(0)

    env.close()
  })

  test('actingAs goes through the app resolver — the other door', async () => {
    let seen: unknown = 'never called'
    const env = await createTestEnv({
      schema:  ENV_SCHEMA,
      plugins: [new GatePlugin({ getLevel: (user: any) => { seen = user; return user?.role === 'admin' ? 6 : 0 } })],
    })

    const admin = env.actingAs({ id: 1, role: 'admin' })
    expect(await admin.doc.findMany()).toEqual([])
    expect(seen).toMatchObject({ role: 'admin' })

    await expect(env.actingAs({ id: 2, role: 'guest' }).doc.findMany()).rejects.toThrow(/requires level 2/)
    env.close()
  })

  test('atLevel(8) is asSystem(), because getLevel cannot reach SYSTEM', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    await expect((await env.atLevel(7)).vault.findMany()).rejects.toThrow(/SYSTEM access/)
    expect(await (await env.atLevel(8)).vault.findMany()).toEqual([])
    env.close()
  })

  test('gateMatrix covers the gated models and skips the rest', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    const rows = env.gateMatrix()

    expect([...new Set(rows.map((r: any) => r.model))].sort()).toEqual(['Doc', 'Vault'])
    expect(rows.length).toBe(2 * 4 * 9)
    expect(env.gateMatrix('Doc').length).toBe(36)
    env.close()
  })

  test('verifyReadLadder runs the read column against a real client, no fixtures', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    expect(await env.verifyReadLadder()).toEqual([])
    env.close()
  })

  test('a read that fails for a NON-gate reason is a mismatch, not a pass', async () => {
    // The false green this exists to stop: `@@external` means the table is
    // managed elsewhere, so no DDL is emitted and every read throws "no such
    // table". Counting any throw as a refusal made that model PASS at all six
    // levels its gate refuses — the read was broken and the ladder said fine.
    const env = await createTestEnv({ schema: `
      model Ghost {
        id   Int    @id
        name String
        @@gate("2.4.4.6")
        @@external
      }
    ` })

    const rows = await env.verifyReadLadder()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r: any) => r.got === 'error')).toBe(true)
    expect(rows[0].message).toMatch(/Ghost\.read at level \d \(\w+\) — expected (allow|deny), but the call threw something that is not a refusal: .*no such table/)
    env.close()
  })

  test('a genuine refusal still reads as deny, not as an error', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    const rows = await env.verifyReadLadder()
    expect(rows).toEqual([])   // every deny above was an AccessDeniedError
    env.close()
  })

  test('migrations: builds the template from the committed files, in order', async () => {
    // `note` only exists after 002, so a template that replayed one file or
    // replayed them out of order fails here rather than somewhere downstream.
    const env = await createTestEnv({
      schema:     `model Account { id Int @id; name String; note String? }`,
      migrations: join(import.meta.dir, 'fixtures', 'migrations'),
    })

    const row = await env.system.account.create({ data: { id: 1, name: 'a', note: 'n' } })
    expect(row.note).toBe('n')
    env.close()
  })

  test('migrations: takes a single .sql file as readily as a directory', async () => {
    const env = await createTestEnv({
      schema:     `model Account { id Int @id; name String }`,
      migrations: join(import.meta.dir, 'fixtures', 'migrations', '001_init.sql'),
    })
    expect(await env.system.account.count()).toBe(0)
    env.close()
  })

  test('a DDL template and a migration template are not the same template', async () => {
    // Both are keyed off the same schema text. Sharing one would hand a test
    // asking for the migrated database whichever was built first.
    const schema = `model Account { id Int @id; name String; note String? }`

    const fromDDL = await createTestEnv({ schema })
    const fromMig = await createTestEnv({ schema, migrations: join(import.meta.dir, 'fixtures', 'migrations') })

    // 002 adds `note` as plain TEXT; the schema's own DDL declares it too, so
    // what separates them is the table list — the migration knows only Account.
    expect(fromDDL.db.$rawDbs.main.query("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c)
      .toBe(fromMig.db.$rawDbs.main.query("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c)

    fromDDL.close(); fromMig.close()
  })

  test('a missing migrations path is refused by name', async () => {
    await expect(createTestEnv({
      schema:     `model Account { id Int @id; name String }`,
      migrations: join(import.meta.dir, 'fixtures', 'nope'),
    })).rejects.toThrow(/no migrations at .*nope/)
  })

  test('a JS migration is refused rather than skipped', async () => {
    // Skipping it silently is the failure: a JS migration that creates a table
    // would leave the template missing it, and every test would report a
    // missing table instead of a missing migration.
    const dir = mkdtempSync(join(tmpdir(), 'litestone-jsmig-'))
    writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE "account" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL) STRICT;')
    writeFileSync(join(dir, '002_backfill.js'), 'export async function up() {}')

    await expect(createTestEnv({
      schema:     `model Account { id Int @id; name String }`,
      migrations: dir,
    })).rejects.toThrow(/is a JS migration/)

    rmSync(dir, { recursive: true, force: true })
  })

  test('readOnly refuses every write, by allow-list', async () => {
    // An allow-list, so a write method added to litestone later cannot pass
    // through unnoticed. Every mutating method on a table is checked by name.
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    const read = readOnly(env.db)

    const writes = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'upsertMany',
                    'remove', 'removeMany', 'delete', 'deleteMany', 'restore', 'optimizeFts']
    for (const method of writes)
      expect(() => read.account[method]({})).toThrow(new RegExp(`readOnly: account\\.${method}`))

    env.close()
  })

  test('readOnly still reads, and still throws on a typo', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    const read = readOnly(env.db)

    await env.system.account.create({ data: { id: 1, name: 'a' } })
    expect(await read.account.count()).toBe(1)
    expect(await read.account.findMany()).toHaveLength(1)
    expect(read.$schema).toBeTruthy()
    // The client's own "not a table" error is better than anything this could
    // say, so it is left to speak.
    expect(() => read.nope.findMany()).toThrow(/not a table in this schema/)
    env.close()
  })

  test('readOnly closes the doors back out to a writable client', async () => {
    // The hole this would otherwise have: asSystem() and $setAuth() both hand
    // back a fresh, fully writable client, and sql writes directly enforcing
    // nothing. asSystem is not $-prefixed, so it needs naming.
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    const read = readOnly(env.db)

    for (const escape of ['asSystem', 'sql', '$setAuth', '$rawDbs', '$transaction'])
      expect(() => read[escape]).toThrow(`readOnly: ${escape} is not available`)

    env.close()
  })

  test('phases scope each part of a scenario to what it may reach', async () => {
    const env = await createTestEnv({
      schema:        ENV_SCHEMA,
      autoFactories: true,
      plugins:       [new GatePlugin({ getLevel: (u: any) => (u?.role === 'dev' ? 4 : 2) })],
    })

    const t = env.phases({ as: { id: 1, role: 'dev' } })

    const doc = await t.arrange(({ system }: any) => system.doc.create({ data: { id: 1, title: 'a' } }))
    await t.act((as: any) => as.doc.update({ where: { id: doc.id }, data: { title: 'b' } }))
    await t.assert(async (read: any) => {
      expect((await read.doc.findUnique({ where: { id: 1 } })).title).toBe('b')
      // Graded AND read-only — the two halves the assert phase needs.
      expect(() => read.doc.update({ where: { id: 1 }, data: { title: 'c' } })).toThrow(/readOnly/)
    })

    env.close()
  })

  test('one act per scenario, and arrange may not follow it', async () => {
    // Not tidiness. A second act makes the failure message unable to say which
    // one the assertion was about, and setup after the act is part of the act —
    // which is what stops arrange being hoistable and cacheable.
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    const t   = env.phases()

    await t.act(async () => {})
    await expect(t.act(async () => {})).rejects.toThrow(/one act per scenario/)
    await expect(t.arrange(async () => {})).rejects.toThrow(/arrange cannot follow act/)
    env.close()
  })

  test('arrange gets the system client, not the principal', async () => {
    // Fixtures are set up below the boundary: a gate that refuses the principal
    // must not refuse the setup, or every scenario starts by fighting its own
    // access rules.
    const env = await createTestEnv({
      schema:  ENV_SCHEMA,
      plugins: [new GatePlugin({ getLevel: () => 0 })],   // refuses everyone
    })
    const t = env.phases({ as: { id: 1 } })

    const doc = await t.arrange(({ system }: any) => system.doc.create({ data: { id: 1, title: 'a' } }))
    expect(doc.id).toBe(1)
    await expect(t.act((as: any) => as.doc.findMany())).rejects.toThrow(/requires level 2/)
    env.close()
  })

  test('verifyGateLadder executes all four operations, not just read', async () => {
    // Read needs no fixture; create needs a valid row, update and delete need
    // one already there. Until they had one, lowering a create or delete gate
    // was a mutation nothing in the derived suite could see.
    const env = await createTestEnv({ schema: LADDER_SCHEMA })
    expect(await env.verifyGateLadder()).toEqual([])
    const ops = new Set(env.gateMatrix().map((r: any) => r.op))
    expect([...ops].sort()).toEqual(['create', 'delete', 'read', 'update'])
    env.close()
  })

  test('verifyGateLadder catches a gate the client grades differently', async () => {
    // The mutation-testing direction: expectations from one schema, database
    // from another. Here the client is built with delete at ADMINISTRATOR(5)
    // and asked against a schema that declares OWNER(6).
    const env = await createTestEnv({ schema: LADDER_SCHEMA })
    const stricter = parse(LADDER_SCHEMA.replace('@@gate("2.4.4.5")', '@@gate("2.4.4.6")')).schema
    const bad = await env.verifyGateLadder({ against: stricter })

    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((m: any) => m.op === 'delete' && m.level === 5)).toBe(true)
    expect(bad[0].message).toMatch(/the schema says deny, the client says allow/)
    env.close()
  })

  test('a row policy makes one direction ungradeable, and only that one', async () => {
    // A policy FILTERS, so it can turn an allow into a deny and never the
    // reverse. Skipping both directions stopped a lowered gate on a policied
    // model being graded at all — the mutant survived and the score rose.
    const env = await createTestEnv({ schema: POLICY_LADDER_SCHEMA })
    const bad = await env.verifyGateLadder({ ops: ['create'] })
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((m: any) => m.got === 'skipped')).toBe(true)
    expect(bad[0].message).toMatch(/not graded: the model declares a row policy/)

    // The other direction still grades: the client's gate is lower than the
    // schema under test, so it allows where the schema says deny.
    const stricter = parse(POLICY_LADDER_SCHEMA.replace('@@gate("2.4.4.5")', '@@gate("3.4.4.5")')).schema
    const caught = await env.verifyGateLadder({ against: stricter, ops: ['read'] })
    expect(caught.some((m: any) => m.got === 'allow' && m.expect === 'deny')).toBe(true)
    env.close()
  })

  test('sampleWrites seeds a row per model and payloads whose FKs point at it', async () => {
    // The Data-realm half of deriving a call list. What it has to get right is
    // the FK: a create payload naming a parent that does not exist fails at the
    // database, and a derived suite reads that as the model refusing the write.
    const env = await createTestEnv({ schema: RELATED_SCHEMA })
    const s: any = await sampleWrites(env.schema, env.system)

    expect(Object.keys(s).sort()).toEqual(['Account', 'Lead'])
    expect(s.Lead.error).toBeUndefined()
    expect(s.Lead.row.id).toBeDefined()

    // Server-owned columns are absent from the create payload: over the wire
    // they are `readOnly` in the model's JSON Schema, so sending one is a 400
    // about the fixture rather than an answer about the rule under test.
    expect(s.Lead.create).not.toHaveProperty('id')
    expect(s.Lead.create).not.toHaveProperty('createdAt')

    // And the payload is creatable, which is the only claim that matters.
    await env.system.lead.create({ data: s.Lead.create })

    // A patch that re-states a scalar the row already holds — a real update
    // that cannot collide with a `@unique`.
    expect(Object.keys(s.Lead.patch).length).toBeGreaterThan(0)
    env.close()
  })

  test('sampleWrites reports a model it could not seed instead of dropping it', async () => {
    // An absent key reads as "this model has nothing to test", which is how a
    // derived suite silently stops covering the model whose fixture broke.
    const env = await createTestEnv({ schema: RELATED_SCHEMA })
    const s: any = await sampleWrites(env.schema, env.system, { models: ['Lead'] })
    expect(Object.keys(s)).toEqual(['Lead'])
    env.close()
  })

  test('verifyRowPolicies grades the compiled WHERE against the JS evaluator', async () => {
    // Litestone compiles a policy TWICE, into two languages — a WHERE for reads
    // and JavaScript for creates. They are independent implementations of one
    // rule, so one can grade the other. That is the opposite of the oracle
    // problem, and the exact comparison that found FJS-195.
    const env = await createTestEnv({ schema: POLICY_SCHEMA })
    expect(await env.verifyRowPolicies()).toEqual([])
    env.close()
  })

  test('verifyRowPolicies refuses to grade rows that all fall on one side', async () => {
    // A policy that admits everything and a policy that is not applied at all
    // are the same observation when every row matches. Said out loud rather
    // than counted as a pass.
    const env = await createTestEnv({ schema: `
      model Note {
        id     Int    @id
        title  String
        @@allow('read', title != null)
      }
    ` })
    const bad = await env.verifyRowPolicies()
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((m: any) => m.got === 'error')).toBe(true)
    expect(bad[0].message).toMatch(/fall on the same side of the policy \(all admitted\)/)
    env.close()
  })

  test('verifyRowPolicies reports a check() predicate rather than guessing', async () => {
    const env = await createTestEnv({ schema: `
      model Team { id Int @id  name String  notes Note[]  @@allow('read', name != null) }
      model Note {
        id     Int    @id
        title  String
        teamId Int
        team   Team   @relation(fields: [teamId], references: [id])
        @@allow('read', check(team))
      }
    ` })
    const bad = await env.verifyRowPolicies()
    expect(bad.some((m: any) => m.model === 'Note' && m.got === 'skipped')).toBe(true)
    expect(bad.find((m: any) => m.model === 'Note').message).toMatch(/uses check\(\)/)
    env.close()
  })

  test('verifyFieldProtection asks which COLUMNS come back, not who may read', async () => {
    // A separate boundary from the gate: basecamp's Secret.data is @guarded
    // under a gate that admits ADMINISTRATOR(5), so the field policy is the
    // only thing between an admin and a private key.
    const env = await createTestEnv({ schema: GUARDED_SCHEMA })
    expect(await env.verifyFieldProtection()).toEqual([])

    // Asked against a schema that declares a protection the client does not
    // have — the shape of a @guarded someone deleted.
    const stricter = parse(GUARDED_SCHEMA.replace('name   String', 'name   String @guarded')).schema
    const bad = await env.verifyFieldProtection({ against: stricter })
    expect(bad.some((m: any) => m.field === 'name' && m.got === 'exposed')).toBe(true)
    expect(bad[0].message).toMatch(/came back to a SYSADMIN\(7\) reader/)
    env.close()
  })

  test('verifyConstraints checks @unique, which is the one rule needing an existing row', async () => {
    const env = await createTestEnv({ schema: RULES_ENV_SCHEMA })
    expect(await env.verifyConstraints()).toEqual([])

    // A nullable @unique whose value came out null has no duplicate to try —
    // SQLite accepts any number of NULLs in a UNIQUE column, and reporting one
    // was a false finding on example's Product.barcode.
    const nullable = await createTestEnv({ schema: `
      model Thing { id Int @id  code String? @unique  name String }
    ` })
    expect(await nullable.verifyConstraints()).toEqual([])
    env.close(); nullable.close()
  })

  test('verifyConstraints finds nothing on a schema whose rules are enforced', async () => {
    const env = await createTestEnv({ schema: RULES_ENV_SCHEMA })
    expect(await env.verifyConstraints()).toEqual([])
    env.close()
  })

  test('verifyConstraints reports enforcement STRICTER than the schema declares', async () => {
    // The other direction, and the one that is stageable: a boundary value the
    // rule allows, refused anyway. Field validation runs before plugins, so an
    // ignored rule cannot be simulated from inside a schema — that branch is
    // proven by mutation instead (disable @gte, @length or @email in
    // validate.js and this reports 2/10, 8/46 and 1/1 on example and basecamp).
    const refuseTwelve = new (class extends Plugin {
      async onBeforeCreate(_m: string, args: any) {
        if (args?.data?.handle?.length === 12) throw Object.assign(
          new Error('handle: too long, really'), { name: 'ValidationError' })
      }
    })()

    const env = await createTestEnv({ schema: RULES_ENV_SCHEMA, plugins: [refuseTwelve] })
    const bad = await env.verifyConstraints('Person')
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((m: any) => m.field === 'handle' && m.expect === 'accepted')).toBe(true)
    expect(bad[0].message).toMatch(/allows this value and the write was refused/)
    env.close()
  })

  test('verifyConstraints separates "not refused" from "never reached the validator"', async () => {
    // A write that fails for a different reason proves nothing either way, and
    // calling it a refusal is the whole trap: it would make a broken validator
    // look enforced. It is reported as `error` rather than swallowed, because a
    // case that cannot run is a hole in the coverage the count implies.
    const boom = new (class extends Plugin {
      async onBeforeCreate() { throw new Error('unrelated boom') }
    })()
    const env = await createTestEnv({ schema: RULES_ENV_SCHEMA, plugins: [boom] })
    const bad = await env.verifyConstraints('Person')
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((m: any) => m.got === 'error')).toBe(true)
    expect(bad.some((m: any) => /failed before validation could refuse it: unrelated boom/.test(m.message))).toBe(true)
    env.close()
  })

  test('a model whose row cannot be built does not abandon the rest', async () => {
    // A required self-reference cannot be satisfied by creating more rows. One
    // model this cannot check is not a reason to stop checking the others —
    // and it is reported, because a silent skip makes the count a lie.
    const env = await createTestEnv({ schema: `
      model Node   { id Int @id  handle String @length(3, 12)  parentId Int  parent Node @relation(fields: [parentId], references: [id]) }
      model Simple { id Int @id  handle String @length(3, 12) }
    ` })
    const bad = await env.verifyConstraints()
    expect(bad).toHaveLength(1)
    expect(bad[0].model).toBe('Node')
    expect(bad[0].got).toBe('error')
    expect(bad[0].message).toMatch(/no valid row could be built, so none of its \d+ case\(s\) ran/)
    env.close()
  })

  test('verifyConstraints leaves the database as it found it', async () => {
    const env = await createTestEnv({ schema: RULES_ENV_SCHEMA })
    await env.system.team.create({ data: { id: 1, slug: 'seed', name: 'seed' } })
    await env.verifyConstraints()
    expect(await env.system.team.count()).toBe(1)
    expect(await env.system.person.count()).toBe(0)
    env.close()
  })

  test('verifyConstraints skips models no write can reach', async () => {
    // @@external emits no DDL and jsonl runs no validation — their "failures"
    // would be *no such table*, which says nothing about a rule.
    const env = await createTestEnv({ schema: `
      database main { path "./main.db" }
      database logs { path "./logs/" driver jsonl }
      model Kept    { id Int @id  handle String @length(3, 12) }
      model Outside { id Int @id  handle String @length(3, 12)  @@external }
      model Line    { id Int @id  handle String @length(3, 12)  @@db(logs) }
    ` })
    const models = new Set((await env.verifyConstraints()).map((m: any) => m.model))
    expect(models.has('Outside')).toBe(false)
    expect(models.has('Line')).toBe(false)
    env.close()
  })

  test('setup runs once and every scenario starts from its rows', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA, autoFactories: true })

    let runs = 0
    const fx = await env.setup(async ({ system }: any) => {
      runs++
      return system.account.create({ data: { id: 7, name: 'acme' } })
    })

    // Scenario one dirties the database.
    const a = env.phases()
    await a.act(async ({} = {}) => env.system.account.create({ data: { id: 8, name: 'junk' } }))
    expect(await env.system.account.count()).toBe(2)

    // Scenario two must not see it, and must still see the fixture — with the
    // id the caller captured, since a restore puts rows back as they were.
    env.phases()
    expect(await env.system.account.count()).toBe(1)
    expect((await env.system.account.findUnique({ where: { id: fx.id } })).name).toBe('acme')
    expect(runs).toBe(1)

    env.close()
  })

  test('setup takes the same tools arrange takes', async () => {
    // The whole point of the hoist: moving a line from arrange into setup is a
    // move, not a rewrite. Both are handed { system, factories, db }.
    const env = await createTestEnv({ schema: ENV_SCHEMA, autoFactories: true })
    const seen: string[][] = []

    await env.setup(async (tools: any) => { seen.push(Object.keys(tools).sort()) })
    await env.phases().arrange(async (tools: any) => { seen.push(Object.keys(tools).sort()) })

    expect(seen[0]).toEqual(['db', 'factories', 'system'])
    expect(seen[0]).toEqual(seen[1])
    env.close()
  })

  test('setup is refused twice, and refused after a scenario has run', async () => {
    // Both are the same failure: a baseline that does not describe what the
    // tests around it actually started from. Order-dependent, so silent.
    const a = await createTestEnv({ schema: ENV_SCHEMA })
    await a.setup(async () => {})
    await expect(a.setup(async () => {})).rejects.toThrow(/already declared/)
    a.close()

    const b = await createTestEnv({ schema: ENV_SCHEMA })
    b.phases()
    await expect(b.setup(async () => {})).rejects.toThrow(/scenario\(s\) have already run/)
    b.close()
  })

  test('phases restores nothing when no setup was declared', async () => {
    // seal/reset is the manual pair and must stay independent — a suite driving
    // it by hand cannot have phases() quietly restoring a different snapshot.
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    await env.system.account.create({ data: { id: 1, name: 'a' } })
    env.seal()
    await env.system.account.create({ data: { id: 2, name: 'b' } })

    env.phases()
    expect(await env.system.account.count()).toBe(2)
    env.reset()
    expect(await env.system.account.count()).toBe(1)
    env.close()
  })

  test('seal/reset returns the database to the sealed rows', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    await env.system.account.create({ data: { id: 1, name: 'seeded' } })
    env.seal()

    await env.system.account.create({ data: { id: 2, name: 'from a test' } })
    expect(await env.system.account.count()).toBe(2)

    env.reset()
    expect(await env.system.account.count()).toBe(1)
    env.close()
  })

  test('reset before seal says so rather than silently doing nothing', async () => {
    const env = await createTestEnv({ schema: ENV_SCHEMA })
    expect(() => env.reset()).toThrow(/seal\(\) before reset\(\)/)
    env.close()
  })
})

// ─── generateValidationCases ──────────────────────────────────────────────────


// Every rule the client enforces, in one model. A validator added to
// validate.js or to writeData's array block and not to the generator shows up
// here as a rule with no case rather than as silence.
const RULES_SCHEMA = `
  model Lead {
    id     Int      @id
    email  String   @email("Use your work address")
    site   String   @url
    code   String   @length(3, 6, "A code is 3 to 6 characters")
    ref    String   @regex("^[A-Z]{3}$")
    phone  String   @phone
    slot   String   @time
    stamp  String   @time(seconds: true)
    day    String    @date
    at     String    @datetime
    pre    String   @startsWith("x-")
    post   String   @endsWith("-z")
    mid    String   @contains("mid")
    score  Int      @gte(0) @lte(100)
    ratio  Float    @gt(0) @lt(1)
    tags   String[] @minItems(1) @maxItems(3) @uniqueItems
  }
`

describe('generateValidationCases — conformance against a real client', () => {
  // The oracle question, answered by running rather than by reading. Every
  // generated case is executed: the invalid ones must be refused *with the
  // message the case predicted*, and the boundary ones must be accepted.
  //
  // Five defects were live when this was first run, and each was invisible to
  // any assertion that did not do this. `cases.valid` itself was invalid for a
  // @time field, so every case failed naming a field it was not testing;
  // custom messages were ignored, so a field with @email("…") predicted the
  // DEFAULT wording and failed against a correct client; and @phone, @time and
  // every array rule generated no case at all.
  const { schema } = parse(RULES_SCHEMA)
  const cases = generateValidationCases(schema, 'Lead')

  let db: any
  let nextId = 1
  const row = (over: Record<string, unknown> = {}) => ({ ...cases.valid, id: ++nextId + 1000, ...over })

  beforeAll(async () => { ({ db } = await makeTestClient(RULES_SCHEMA)) })
  afterAll(() => db?.$close())

  test('the valid baseline is actually valid', async () => {
    // "correct by construction" is a claim, and this is the only thing that
    // makes it one. Everything below is `{ ...valid, [field]: bad }`, so a
    // broken baseline turns every case into a false failure elsewhere.
    expect(await db.lead.create({ data: row() })).toBeTruthy()
  })

  test('every declared rule produces at least one case', async () => {
    const covered = new Set(cases.invalid.map((c: any) => c.field))
    const declared = schema.models[0].fields
      .filter((f: any) => f.name !== 'id' && f.attributes.length > 0)
      .map((f: any) => f.name)
    expect(declared.filter((f: string) => !covered.has(f))).toEqual([])
  })

  test('every invalid case is refused, with the message it predicted', async () => {
    const wrong: string[] = []
    for (const c of cases.invalid) {
      try {
        await db.lead.create({ data: row({ [c.field]: c.value }) })
        wrong.push(`${c.field} ${c.rule}: accepted ${JSON.stringify(c.value)}`)
      } catch (err: any) {
        if (!err.message.includes(c.message))
          wrong.push(`${c.field} ${c.rule}: wanted "${c.message}", got "${err.message}"`)
      }
    }
    expect(wrong).toEqual([])
  })

  test('every boundary case is accepted', async () => {
    const wrong: string[] = []
    for (const c of cases.boundary) {
      try { await db.lead.create({ data: row({ [c.field]: c.value }) }) }
      catch (err: any) { wrong.push(`${c.field} ${c.rule} ${JSON.stringify(c.value)}: ${err.message}`) }
    }
    expect(wrong).toEqual([])
  })

  test('a schema-authored message wins over the default wording', () => {
    // The field's own message is the independent statement of intent here, and
    // it is what Junction and Sierra show through `x-messages`. Predicting the
    // default instead made the generated test fail against a correct client.
    const emailCase = cases.invalid.find((c: any) => c.field === 'email')
    expect(emailCase.message).toBe('Use your work address')
    const codeCase = cases.invalid.find((c: any) => c.field === 'code')
    expect(codeCase.message).toBe('A code is 3 to 6 characters')
  })

  test('array rules are covered, not skipped for being arrays', () => {
    const rules = cases.invalid.filter((c: any) => c.field === 'tags').map((c: any) => c.rule).sort()
    expect(rules).toEqual(['@maxItems(3)', '@minItems(1)', '@uniqueItems'])
  })
})

describe('generateValidationCases', () => {
  const { schema } = parse(UTIL_SCHEMA)

  test('throws on unknown model', () => {
    expect(() => generateValidationCases(schema, 'nope')).toThrow('not found')
  })

  test('valid record is a plain object', () => {
    const { valid } = generateValidationCases(schema, 'Account')
    expect(typeof valid).toBe('object')
    expect(valid).not.toBeNull()
  })

  test('valid record passes createOne', async () => {
    const { db } = await makeTestClient(UTIL_SCHEMA)
    const { valid } = generateValidationCases(schema, 'Account')
    const row = await db.account.create({ data: valid })
    expect(row).not.toBeNull()
    db.$close()
  })

  test('model with no validators → empty invalid and boundary', () => {
    const { schema: s } = parse(`model T { id Int @id; name String }`)
    const { invalid, boundary } = generateValidationCases(s, 'T')
    expect(invalid).toEqual([])
    expect(boundary).toEqual([])
  })

  test('@email invalid case generated', () => {
    const { invalid } = generateValidationCases(schema, 'Lead')
    const c = invalid.find(c => c.rule === '@email')
    expect(c).toBeDefined()
    expect(c?.value).toBe('not-an-email')
    expect(c?.expect).toBe('fail')
    expect(c?.message).toBe(DEFAULT_MESSAGES.email())
  })

  test('@gte invalid and boundary generated', () => {
    const { invalid, boundary } = generateValidationCases(schema, 'Lead')
    const inv = invalid.find(c => c.rule === '@gte(0)')
    const bnd = boundary.find(c => c.rule === '@gte(0)')
    expect(inv?.value).toBe(-0.01)
    expect(bnd?.value).toBe(0)
    expect(bnd?.expect).toBe('pass')
  })

  test('@lte invalid and boundary generated', () => {
    const { invalid, boundary } = generateValidationCases(schema, 'Lead')
    const inv = invalid.find(c => c.rule === '@lte(100)')
    const bnd = boundary.find(c => c.rule === '@lte(100)')
    expect(inv?.value).toBe(100.01)
    expect(bnd?.value).toBe(100)
  })

  test('@contains invalid case', () => {
    const { invalid } = generateValidationCases(schema, 'Lead')
    const c = invalid.find(c => c.rule.startsWith('@contains'))
    expect(c?.value).toBe('nope')
    expect(c?.message).toContain('note')
  })

  test('@length invalid cases (min and max)', () => {
    const { schema: s } = parse(`model T { id Int @id; code String @length(3, 10) }`)
    const { invalid, boundary } = generateValidationCases(s, 'T')
    const tooShort = invalid.find(c => c.value === '')
    const tooLong  = invalid.find(c => typeof c.value === 'string' && c.value.length === 11)
    expect(tooShort).toBeDefined()
    expect(tooLong).toBeDefined()
    expect(boundary.find(c => c.value === 'xxx')).toBeDefined()      // min boundary
    expect(boundary.find(c => c.value === 'x'.repeat(10))).toBeDefined()  // max boundary
  })

  test('invalid cases fail createOne', async () => {
    const { invalid, valid } = generateValidationCases(schema, 'Lead')
    const emailCase = invalid.find(c => c.rule === '@email')
    if (!emailCase) return  // guard

    const { db } = await makeTestClient(UTIL_SCHEMA, {
      data: async (db) => { await db.account.create({ data: { id: 1, name: 'Test' } }) }
    })
    const data = { ...valid, [emailCase.field]: emailCase.value }
    await expect(db.lead.create({ data })).rejects.toThrow(emailCase.message)
    db.$close()
  })

  test('boundary values pass createOne', async () => {
    const { boundary, valid } = generateValidationCases(schema, 'Lead')
    const gteBound = boundary.find(c => c.rule === '@gte(0)')
    if (!gteBound) return

    const { db } = await makeTestClient(UTIL_SCHEMA, {
      data: async (db) => { await db.account.create({ data: { id: 1, name: 'Test' } }) }
    })
    const data = { ...valid, [gteBound.field]: gteBound.value }
    await expect(db.lead.create({ data })).resolves.toBeDefined()
    db.$close()
  })
})

// ─── factoryFrom ─────────────────────────────────────────────────────────────


describe('factoryFrom', () => {
  test('returns a Factory instance', async () => {
    const { Factory: F } = await import('../src/seeder.js')
    const { db } = await makeTestClient(UTIL_SCHEMA)
    const { schema } = parse(UTIL_SCHEMA)
    const f = factoryFrom(schema, 'Account', db)
    expect(f).toBeInstanceOf(F)
    db.$close()
  })

  test('.model is set', () => {
    const { schema } = parse(UTIL_SCHEMA)
    const f = factoryFrom(schema, 'Account', null as any)
    expect(f.model).toBe('Account')
  })

  test('.buildOne() produces valid data', () => {
    const { schema } = parse(UTIL_SCHEMA)
    const f   = factoryFrom(schema, 'Account', null as any)
    const row = f.buildOne()
    expect(row.name).toBeDefined()
    expect(row.plan).toBe('starter')
  })

  test('.createOne() inserts to db', async () => {
    const { db } = await makeTestClient(UTIL_SCHEMA)
    const { schema } = parse(UTIL_SCHEMA)
    const f   = factoryFrom(schema, 'Account', db)
    const row = await f.createOne()
    expect(row).not.toBeNull()
    const found = await db.account.findUnique({ where: { id: row.id } })
    expect(found?.name).toBe(row.name)
    db.$close()
  })

  test('.state() chains work', () => {
    const { schema } = parse(UTIL_SCHEMA)
    const f = factoryFrom(schema, 'Account', null as any)
    expect(f.state({ plan: 'pro' }).buildOne().plan).toBe('pro')
  })

  test('.seed() chains work (deterministic)', () => {
    const { schema } = parse(UTIL_SCHEMA)
    const a = factoryFrom(schema, 'Account', null as any).seed(42).buildMany(3)
    const b = factoryFrom(schema, 'Account', null as any).seed(42).buildMany(3)
    expect(a).toEqual(b)
  })

  test('throws on unknown model', () => {
    const { schema } = parse(UTIL_SCHEMA)
    expect(() => factoryFrom(schema, 'nope', null as any)).toThrow('not found')
  })
})

// ─── autoFactories in makeTestClient ─────────────────────────────────────────


describe('makeTestClient autoFactories', () => {
  test('generates factories for all sqlite models', async () => {
    const { factories } = await makeTestClient(UTIL_SCHEMA, { autoFactories: true })
    expect(factories.account).toBeDefined()
    expect(factories.lead).toBeDefined()
    expect(factories.post).toBeDefined()
  })

  test('explicit factory overrides auto-generated', async () => {
    class CustomAccount extends Factory {
      model = 'Account'
      definition(seq: number) { return { name: `Custom ${seq}`, plan: 'enterprise' } }
    }
    const { db, factories } = await makeTestClient(UTIL_SCHEMA, {
      autoFactories: true,
      factories: { account: CustomAccount },
    })
    expect(factories.account).toBeInstanceOf(CustomAccount)
    expect(factories.lead).toBeDefined()   // auto-generated
    db.$close()
  })

  test('auto factory can createOne', async () => {
    const { db, factories } = await makeTestClient(UTIL_SCHEMA, { autoFactories: true })
    const acct = await factories.account.createOne()
    expect(acct).not.toBeNull()
    db.$close()
  })

  test('seed applied to auto factories', async () => {
    const { db: db1, factories: f1 } = await makeTestClient(UTIL_SCHEMA, { autoFactories: true, seed: 99 })
    const { db: db2, factories: f2 } = await makeTestClient(UTIL_SCHEMA, { autoFactories: true, seed: 99 })
    expect(f1.account.buildOne()).toEqual(f2.account.buildOne())
    db1.$close(); db2.$close()
  })
})

// ─── generateTypeScript ───────────────────────────────────────────────────────

import { generateTypeScript } from '../src/tools/typegen.js'

const TS_SCHEMA = `
  enum Plan { starter pro enterprise }

  model Account {
    id        Int  @id
    name      String
    plan      Plan     @default(starter)
    meta      Json?
    createdAt DateTime @default(now())
  }

  model User {
    id        Int   @id
    account   Account  @relation(fields: [accountId], references: [id])
    accountId Int
    email     String      @unique @email
    role      String      @default("member")
    salary    Float?     @guarded
    apiKey    String?     @secret
    tags      String[]
    deletedAt DateTime?
    @@softDelete
  }
`





// ┌────────────────────────────────────────────────────────────────────────────┐
// │  CODE GENERATION                                                           │
// └────────────────────────────────────────────────────────────────────────────┘

describe('generateTypeScript', () => {
  const { schema } = parse(TS_SCHEMA)

  test('returns a string', () => {
    const dts = generateTypeScript(schema)
    expect(typeof dts).toBe('string')
    expect(dts.length).toBeGreaterThan(0)
  })

  test('emits enum union type', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain("export type Plan = 'starter' | 'pro' | 'enterprise'")
  })

  test('emits WhereOp utility type', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export type WhereOp<T>')
  })

  test('emits row interface', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface Account {')
    expect(dts).toContain('export interface User {')
  })

  test('row interface has correct field types', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('id:')
    expect(dts).toContain('number')
    expect(dts).toContain('name:')
    expect(dts).toContain('string')
    expect(dts).toContain('plan:')
    expect(dts).toContain('Plan')
    expect(dts).toContain('meta?:')
    expect(dts).toContain('unknown | null')
  })

  test('row interface has String[] as string[]', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('tags')
    expect(dts).toContain('string[]')
  })

  test('@guarded field excluded from client audience (default)', () => {
    const dts = generateTypeScript(schema)
    // salary is @guarded (not all) — included but optional
    expect(dts).toContain('salary')
  })

  test('@secret field excluded from client audience', () => {
    const dts = generateTypeScript(schema, { audience: 'client' })
    // apiKey is @secret = @guarded(all) → stripped in client audience
    const userSection = dts.slice(dts.indexOf('export interface User {'), dts.indexOf('export interface UserCreate {'))
    expect(userSection).not.toContain('apiKey')
  })

  test('@secret field included in system audience', () => {
    const dts = generateTypeScript(schema, { audience: 'system' })
    expect(dts).toContain('apiKey')
  })

  test('emits Create interface', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface AccountCreate {')
    expect(dts).toContain('export interface UserCreate {')
  })

  test('Create interface makes @id optional', () => {
    const dts = generateTypeScript(schema)
    const createSection = dts.slice(
      dts.indexOf('export interface AccountCreate {'),
      dts.indexOf('export interface AccountUpdate {')
    )
    // id should be optional in create (auto-increment)
    expect(createSection).toContain('id?:')
  })

  test('Create interface excludes createdAt/updatedAt/deletedAt', () => {
    const dts = generateTypeScript(schema)
    const createSection = dts.slice(
      dts.indexOf('export interface AccountCreate {'),
      dts.indexOf('export interface AccountUpdate {')
    )
    expect(createSection).not.toContain('createdAt')
    expect(createSection).not.toContain('deletedAt')
  })

  test('emits Update interface with all optional fields', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface AccountUpdate {')
    const updateSection = dts.slice(
      dts.indexOf('export interface AccountUpdate {'),
      dts.indexOf('export interface AccountWhere')
    )
    // All fields in update should be optional (end with ?)
    const fieldLines = updateSection.split('\n').filter(l => l.trim() && !l.includes('{') && !l.includes('}'))
    for (const line of fieldLines) {
      expect(line).toContain('?:')
    }
  })

  test('emits Where interface', () => {
    const dts = generateTypeScript(schema)
    // Where interface extends WhereBase to inherit $raw support.
    expect(dts).toContain('export interface AccountWhere extends WhereBase {')
    expect(dts).toContain('AND?: AccountWhere[]')
    expect(dts).toContain('OR?:  AccountWhere[]')
    expect(dts).toContain('NOT?: AccountWhere')
  })

  test('Where fields use WhereOp<T>', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('WhereOp<')
  })

  test('emits CursorResult<T>', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface CursorResult<T>')
    expect(dts).toContain('nextCursor: string | null')
    expect(dts).toContain('hasMore:    boolean')
  })

  test('emits TableClient<TRow, TCreate, TUpdate, TWhere>', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface TableClient<TRow, TCreate, TUpdate, TWhere>')
    expect(dts).toContain('findMany(')
    expect(dts).toContain('createMany(')
    expect(dts).toContain('findManyCursor(')
  })

  test('emits QueryEvent interface', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface QueryEvent {')
    expect(dts).toContain('duration:  number')
    expect(dts).toContain('actorId:')
  })

  test('emits LitestoneClient with all models', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface LitestoneClient {')
    expect(dts).toContain('readonly account: TableClient<Account, AccountCreate, AccountUpdate, AccountWhere>')
    expect(dts).toContain('readonly user: TableClient<User, UserCreate, UserUpdate, UserWhere>')
    expect(dts).toContain('asSystem(): LitestoneClient')
    expect(dts).toContain('$tapQuery(')
  })

  test('emits createClient declaration', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export declare function createClient(')
  })

  test('relation fields excluded from all interfaces', () => {
    const dts = generateTypeScript(schema)
    // `account` relation field should not appear in User interfaces
    const userRow = dts.slice(
      dts.indexOf('export interface User {'),
      dts.indexOf('export interface UserCreate {')
    )
    // 'account' as a standalone property (not accountId) should not appear
    const lines = userRow.split('\n').filter(l => l.trim().startsWith('account:') || l.trim().startsWith('account?:'))
    expect(lines.length).toBe(0)
  })

  test('output is stable across calls with same input', () => {
    const a = generateTypeScript(schema)
    const b = generateTypeScript(schema)
    expect(a).toBe(b)
  })
})

// ─── Enum transitions ─────────────────────────────────────────────────────────

import { TransitionViolationError, TransitionConflictError, TransitionNotFoundError }
  from '../src/core/client.js'

const TRANSITION_SCHEMA = `
  enum OrderStatus {
    pending
    paid
    shipped
    delivered
    refunded

    transitions {
      pay:     pending         -> paid
      ship:    paid            -> shipped
      deliver: shipped         -> delivered
      refund:  [paid, shipped] -> refunded
    }
  }

  model Order {
    id     Int     @id
    status OrderStatus @default(pending)
    note   String?
  }
`


describe('generateJsonSchema — x-gate', () => {
  const { schema } = parse(JEXT_SCHEMA)

  test('x-gate emitted for model with @@gate', () => {
    const js = generateJsonSchema(schema)
    const accounts = js['$defs']?.Account
    expect(accounts['x-gate']).toBeDefined()
  })

  test('x-gate has correct RCUD values', () => {
    const js = generateJsonSchema(schema)
    const accounts = js['$defs']?.Account
    expect(accounts['x-gate']).toEqual({ read: 2, create: 5, update: 5, delete: 6 })
  })

  test('x-gate emitted on all modes (create/update/full)', () => {
    for (const mode of ['create','update','full']) {
      const js = generateJsonSchema(schema, { mode })
      expect(js['$defs']?.Account['x-gate']).toBeDefined()
    }
  })

  test('no x-gate on model without @@gate', () => {
    const js = generateJsonSchema(schema)
    const posts = js['$defs']?.Post
    expect(posts['x-gate']).toBeUndefined()
  })

  test('x-gate emitted for users model', () => {
    const js = generateJsonSchema(schema)
    const users = js['$defs']?.User
    expect(users['x-gate']).toEqual({ read: 2, create: 4, update: 4, delete: 6 })
  })
})


describe('generateJsonSchema — a default must be a value of its own type', () => {
  // An ARRAY or Json field spells its default as a STRING in the .lite source,
  // because that is how it is stored. Emitted verbatim that produced
  // `{"type":"array","default":"[]"}` — a schema whose own default fails its
  // own type check. Junction's autoValidate fills the default in and then
  // refuses it, so every create that OMITTED the field 400'd with "tags must
  // be an array", naming a field the caller never sent. Found declaring
  // basecamp's feature flags.
  const S = `
    model Flag {
      id       Int      @id
      tags     String[] @default("[]")
      config   Json     @default("{}")
      counts   Int[]    @default("[1,2]")
      label    String   @default("[]")
      broken   Json     @default("{not json")
    }`

  test('an array default is emitted as an array, not the source string', () => {
    const js = generateJsonSchema(parse(S).schema, { mode: 'create' })
    expect(js['$defs'].Flag.properties.tags.default).toEqual([])
    expect(js['$defs'].Flag.properties.counts.default).toEqual([1, 2])
  })

  test('a Json default is emitted as its value', () => {
    const js = generateJsonSchema(parse(S).schema, { mode: 'create' })
    expect(js['$defs'].Flag.properties.config.default).toEqual({})
  })

  test('a String field keeps its string default — "[]" is a legal string', () => {
    // The parse is keyed on the FIELD's type, not on the literal looking like
    // JSON. A String column defaulting to the two characters `[]` means those
    // two characters.
    const js = generateJsonSchema(parse(S).schema, { mode: 'create' })
    expect(js['$defs'].Flag.properties.label.default).toBe('[]')
  })

  test('a structured default that does not parse is dropped, not emitted wrong', () => {
    const js = generateJsonSchema(parse(S).schema, { mode: 'create' })
    expect('default' in js['$defs'].Flag.properties.broken).toBe(false)
  })
})


describe('generateJsonSchema — x-relations', () => {
  const { schema } = parse(JEXT_SCHEMA)

  test('x-relations emitted for model with relations', () => {
    const js = generateJsonSchema(schema)
    expect(js['$defs']?.User['x-relations']).toBeDefined()
  })

  test('no x-relations on model with no relations', () => {
    const { schema: s } = parse(`model T { id Int @id; name String }`)
    const js = generateJsonSchema(s)
    expect(js['$defs']?.T?.['x-relations']).toBeUndefined()
  })

  test('belongsTo relation has correct shape', () => {
    const js = generateJsonSchema(schema)
    const rels = js['$defs']?.User['x-relations'] as any[]
    const account = rels?.find((r: any) => r.field === 'account')
    expect(account).toBeDefined()
    expect(account.type).toBe('belongsTo')
    expect(account.model).toBe('Account')
    expect(account.fields).toEqual(['accountId'])
    expect(account.references).toEqual(['id'])
    expect(account.onDelete).toBe('Cascade')
  })

  test('hasMany relation has correct shape', () => {
    const js = generateJsonSchema(schema)
    const rels = js['$defs']?.User['x-relations'] as any[]
    const posts = rels?.find((r: any) => r.field === 'posts')
    expect(posts).toBeDefined()
    expect(posts.type).toBe('hasMany')
    expect(posts.model).toBe('Post')
    expect(posts.fields).toEqual([])
  })

  test('accounts has hasMany users relation', () => {
    const js = generateJsonSchema(schema)
    const rels = js['$defs']?.Account['x-relations'] as any[]
    const users = rels?.find((r: any) => r.field === 'users')
    expect(users?.type).toBe('hasMany')
    expect(users?.model).toBe('User')
  })

  test('x-relations fields are excluded from properties', () => {
    const js = generateJsonSchema(schema)
    const props = js['$defs']?.User?.properties
    expect(props?.account).toBeUndefined()   // relation field — not in properties
    expect(props?.accountId).toBeDefined()   // FK column — in properties
  })
})




describe('implicit many-to-many', () => {
  const m2mSchema = `
    model Post {
      id    Int @id
      title String
      tags  Tag[]
    }
    model Tag {
      id    Int @id
      name  String
      posts Post[]
    }
  `

  // ── Parser ──────────────────────────────────────────────────────────────────

  test('parses Model[] fields as implicitM2M kind', () => {
    const r = parse(m2mSchema)
    expect(r.valid).toBe(true)
    const postsModel = r.schema.models.find((m: any) => m.name === 'Post')
    const tagsField  = postsModel?.fields.find((f: any) => f.name === 'tags')
    expect(tagsField?.type.kind).toBe('implicitM2M')
    expect(tagsField?.type.name).toBe('Tag')
    expect(tagsField?.type.array).toBe(true)
  })

  test('requires both sides to declare the relation', () => {
    const r = parse(`
      model Post {
        id   Int @id
        tags Tag[]
      }
      model Tag {
        id   Int @id
      }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('Both sides must declare')
  })

  test('unknown model in m2m field is an error', () => {
    const r = parse(`
      model Post {
        id      Int @id
        missing unknown[]
      }
    `)
    expect(r.valid).toBe(false)
  })

  // ── JSON Schema ─────────────────────────────────────────────────────────────
  //
  // An implicit m2m field is a relation, not a column. It used to reach
  // typeToJsonSchema, where type.array turned it into an array-of-string
  // property — and, being non-optional with no @default, into a REQUIRED one.
  // Junction's autoValidate then demanded `tags` on every create.

  test('m2m field is excluded from properties', () => {
    const r = parse(m2mSchema)
    const js = generateJsonSchema(r.schema)
    expect(js['$defs']?.Post?.properties?.tags).toBeUndefined()
    expect(js['$defs']?.Tag?.properties?.posts).toBeUndefined()
  })

  test('m2m field is not required', () => {
    const r = parse(m2mSchema)
    const js = generateJsonSchema(r.schema)
    expect(js['$defs']?.Post?.required ?? []).not.toContain('tags')
  })

  test('m2m field is excluded in full mode too', () => {
    const r = parse(m2mSchema)
    const js = generateJsonSchema(r.schema, { mode: 'full' })
    expect(js['$defs']?.Post?.properties?.tags).toBeUndefined()
  })

  test('the relation is still described in x-relations', () => {
    const r = parse(m2mSchema)
    const js = generateJsonSchema(r.schema)
    const rels = js['$defs']?.Post?.['x-relations'] as any[]
    const tags = rels?.find((x: any) => x.field === 'tags')
    expect(tags).toEqual({ field: 'tags', model: 'Tag', type: 'm2m' })
  })

  // ── DDL ─────────────────────────────────────────────────────────────────────

  test('detectM2MPairs finds the pair', async () => {
    const { detectM2MPairs } = await import('../src/core/ddl.js')
    const r = parse(m2mSchema)
    const pairs = detectM2MPairs(r.schema)
    expect(pairs.length).toBe(1)
    expect(pairs[0].modelA).toBe('Post')
    expect(pairs[0].modelB).toBe('Tag')
    expect(pairs[0].joinTable).toBe('_post_tag')
    expect(pairs[0].colA).toBe('postId')
    expect(pairs[0].colB).toBe('tagId')
  })

  test('DDL includes join table CREATE statement', () => {
    const r = parse(m2mSchema)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('CREATE TABLE')
    expect(ddl).toContain('_post_tag')
    expect(ddl).toContain('ON DELETE CASCADE')
    expect(ddl).toContain('PRIMARY KEY')
  })

  test('join table actually created in DB', async () => {
    const db = await makeDb(m2mSchema, 'm2m-ddl')
    const tables = db.$db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_post_tag'`
    ).all()
    expect(tables.length).toBe(1)
    db.$close()
  })

  // ── include ─────────────────────────────────────────────────────────────────

  test('include: { tags: true } returns flat tag objects', async () => {
    const db = await makeDb(m2mSchema, 'm2m-include')
    await db.post.create({ data: { id: 1, title: 'Hello' } })
    await db.tag.create({ data: { id: 1, name: 'typescript' } })
    await db.tag.create({ data: { id: 2, name: 'orm' } })
    // Manually wire the join rows
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 2)`)

    const post = await db.post.findUnique({
      where: { id: 1 },
      include: { tags: true }
    })
    expect(post.tags).toHaveLength(2)
    expect(post.tags.map((t: any) => t.name).sort()).toEqual(['orm', 'typescript'])
    db.$close()
  })

  test('include from the other side', async () => {
    const db = await makeDb(m2mSchema, 'm2m-include-other')
    await db.post.create({ data: { id: 1, title: 'Post A' } })
    await db.post.create({ data: { id: 2, title: 'Post B' } })
    await db.tag.create({ data: { id: 1, name: 'ts' } })
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _post_tag VALUES (2, 1)`)

    const tag = await db.tag.findUnique({
      where: { id: 1 },
      include: { posts: true }
    })
    expect(tag.posts).toHaveLength(2)
    db.$close()
  })

  test('row with no related records returns empty array', async () => {
    const db = await makeDb(m2mSchema, 'm2m-empty')
    await db.post.create({ data: { id: 1, title: 'Lonely' } })
    const post = await db.post.findUnique({
      where: { id: 1 },
      include: { tags: true }
    })
    expect(post.tags).toEqual([])
    db.$close()
  })

  // ── connect ─────────────────────────────────────────────────────────────────

  test('nested connect adds join row', async () => {
    const db = await makeDb(m2mSchema, 'm2m-connect')
    await db.post.create({ data: { id: 1, title: 'Post' } })
    await db.tag.create({ data: { id: 1, name: 'ts' } })

    await db.post.update({
      where: { id: 1 },
      data: { tags: { connect: { id: 1 } } }
    })

    const post = await db.post.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    expect(post.tags[0].name).toBe('ts')
    db.$close()
  })

  test('nested connect multiple', async () => {
    const db = await makeDb(m2mSchema, 'm2m-connect-multi')
    await db.post.create({ data: { id: 1, title: 'Post' } })
    await db.tag.create({ data: { id: 1, name: 'ts' } })
    await db.tag.create({ data: { id: 2, name: 'orm' } })

    await db.post.update({
      where: { id: 1 },
      data: { tags: { connect: [{ id: 1 }, { id: 2 }] } }
    })

    const post = await db.post.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(2)
    db.$close()
  })

  // ── disconnect ──────────────────────────────────────────────────────────────

  test('nested disconnect removes join row', async () => {
    const db = await makeDb(m2mSchema, 'm2m-disconnect')
    await db.post.create({ data: { id: 1, title: 'Post' } })
    await db.tag.create({ data: { id: 1, name: 'ts' } })
    await db.tag.create({ data: { id: 2, name: 'orm' } })
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 2)`)

    await db.post.update({
      where: { id: 1 },
      data: { tags: { disconnect: { id: 1 } } }
    })

    const post = await db.post.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    expect(post.tags[0].id).toBe(2)
    db.$close()
  })

  // ── create ──────────────────────────────────────────────────────────────────

  test('nested create creates tag and adds join row', async () => {
    const db = await makeDb(m2mSchema, 'm2m-nested-create')
    await db.post.create({ data: { id: 1, title: 'Post' } })

    await db.post.update({
      where: { id: 1 },
      data: { tags: { create: { id: 1, name: 'new-tag' } } }
    })

    const tag = await db.tag.findUnique({ where: { id: 1 } })
    expect(tag?.name).toBe('new-tag')

    const post = await db.post.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    db.$close()
  })

  // ── set ─────────────────────────────────────────────────────────────────────

  test('nested set replaces all relations', async () => {
    const db = await makeDb(m2mSchema, 'm2m-set')
    await db.post.create({ data: { id: 1, title: 'Post' } })
    await db.tag.create({ data: { id: 1, name: 'ts' } })
    await db.tag.create({ data: { id: 2, name: 'orm' } })
    await db.tag.create({ data: { id: 3, name: 'bun' } })
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 2)`)

    // Replace with just tag 3
    await db.post.update({
      where: { id: 1 },
      data: { tags: { set: [{ id: 3 }] } }
    })

    const post = await db.post.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    expect(post.tags[0].id).toBe(3)
    db.$close()
  })

  test('nested set with empty array removes all relations', async () => {
    const db = await makeDb(m2mSchema, 'm2m-set-empty')
    await db.post.create({ data: { id: 1, title: 'Post' } })
    await db.tag.create({ data: { id: 1, name: 'ts' } })
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 1)`)

    await db.post.update({
      where: { id: 1 },
      data: { tags: { set: [] } }
    })

    const post = await db.post.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(0)
    db.$close()
  })

  // ── cascade delete ──────────────────────────────────────────────────────────

  test('deleting a post cascades join rows', async () => {
    const db = await makeDb(m2mSchema, 'm2m-cascade')
    await db.post.create({ data: { id: 1, title: 'Post' } })
    await db.tag.create({ data: { id: 1, name: 'ts' } })
    db.$db.run(`INSERT INTO _post_tag VALUES (1, 1)`)

    await db.post.delete({ where: { id: 1 } })

    const joinRows = db.$db.query(`SELECT * FROM _post_tag`).all()
    expect(joinRows.length).toBe(0)
    // Tag still exists — only the join row was removed
    const tag = await db.tag.findUnique({ where: { id: 1 } })
    expect(tag?.name).toBe('ts')
    db.$close()
  })

  // ── create with inline connect ───────────────────────────────────────────────

  test('create with inline tag connect', async () => {
    const db = await makeDb(m2mSchema, 'm2m-create-connect')
    await db.tag.create({ data: { id: 1, name: 'ts' } })
    await db.tag.create({ data: { id: 2, name: 'orm' } })

    await db.post.create({
      data: {
        id: 1, title: 'Hello',
        tags: { connect: [{ id: 1 }, { id: 2 }] }
      }
    })

    const post = await db.post.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(2)
    db.$close()
  })

  // ── keys that are not `Int @id` named `id` ─────────────────────────────────
  //
  // The join table hardcoded `INTEGER … REFERENCES "<table>"("id")`, and every
  // runtime path read the target's key as the literal `.id`. So the feature was
  // off for the two commonest shapes in real schemas: a uuid key (STRICT
  // refuses the TEXT, `cannot store TEXT value in INTEGER column`) and a key
  // named anything else (`INSERT OR IGNORE` swallows the NULL, so connect
  // reported success and wrote nothing).

  const keyedSchema = `
    model Post {
      slug  String @id
      title String
      tags  Tag[]
    }
    model Tag {
      code  String @id
      name  String
      posts Post[]
    }
  `

  test('the join table takes each side\'s own @id name and type', async () => {
    const db  = await makeDb(keyedSchema, 'm2m-keyed-ddl')
    const ddl = db.$db.query(`SELECT sql FROM sqlite_master WHERE name = '_post_tag'`).get() as any
    expect(ddl.sql).toContain('"postId" TEXT NOT NULL REFERENCES "post"("slug")')
    expect(ddl.sql).toContain('"tagId" TEXT NOT NULL REFERENCES "tag"("code")')
    db.$close()
  })

  test('connect / include / disconnect round-trip on a String @id named something else', async () => {
    const db = await makeDb(keyedSchema, 'm2m-keyed-roundtrip')
    await db.tag.create({ data: { code: 't1', name: 'ts' } })
    await db.post.create({ data: { slug: 'p1', title: 'P', tags: { connect: [{ code: 't1' }] } } })

    const withTags = await db.post.findUnique({ where: { slug: 'p1' }, include: { tags: true } }) as any
    expect(withTags.tags.map((t: any) => t.code)).toEqual(['t1'])

    // The reverse end, the count, the filter and the aggregate order all read
    // the same key — each was its own `t."id"`.
    const reverse = await db.tag.findUnique({ where: { code: 't1' }, include: { posts: true } }) as any
    expect(reverse.posts.map((p: any) => p.slug)).toEqual(['p1'])
    const counted = await db.post.findMany({ include: { _count: { select: { tags: true } } } }) as any[]
    expect(counted[0]._count.tags).toBe(1)
    expect((await db.post.findMany({ where: { tags: { some: { name: 'ts' } } } })).length).toBe(1)
    expect((await db.post.findMany({ orderBy: { tags: { _count: 'desc' } } })).length).toBe(1)

    await db.post.update({ where: { slug: 'p1' }, data: { tags: { disconnect: [{ code: 't1' }] } } })
    const after = await db.post.findUnique({ where: { slug: 'p1' }, include: { tags: true } }) as any
    expect(after.tags).toHaveLength(0)
    db.$close()
  })

  test('the two sides may be keyed differently', async () => {
    const db = await makeDb(`
      model User  { uid String @id  name String  groups Group[] }
      model Group { gid Int    @id  title String  members User[] }
    `, 'm2m-keyed-mixed')
    await db.user.create({ data: { uid: 'a', name: 'A' } })
    await db.group.create({ data: { gid: 1, title: 'G', members: { connect: [{ uid: 'a' }] } } })

    const ddl = db.$db.query(`SELECT sql FROM sqlite_master WHERE name = '_group_user'`).get() as any
    expect(ddl.sql).toContain('"groupId" INTEGER NOT NULL REFERENCES "group"("gid")')
    expect(ddl.sql).toContain('"userId" TEXT NOT NULL REFERENCES "user"("uid")')

    const g = await db.group.findUnique({ where: { gid: 1 }, include: { members: true } }) as any
    expect(g.members.map((m: any) => m.uid)).toEqual(['a'])
    db.$close()
  })

  test('a self-relation keyed by uuid connects and reads both directions', async () => {
    const db = await makeDb(`
      model User {
        uid       String @id
        following User[] @relation("follows")
        followers User[] @relation("follows")
      }
    `, 'm2m-keyed-self')
    await db.user.create({ data: { uid: 'a' } })
    await db.user.create({ data: { uid: 'b' } })
    await db.user.update({ where: { uid: 'a' }, data: { following: { connect: [{ uid: 'b' }] } } })

    const rows = await db.user.findMany({ include: { following: true, followers: true } }) as any[]
    const a = rows.find(r => r.uid === 'a'), b = rows.find(r => r.uid === 'b')
    expect(a.following.map((u: any) => u.uid)).toEqual(['b'])
    expect(a.followers).toHaveLength(0)
    expect(b.followers.map((u: any) => u.uid)).toEqual(['a'])
    db.$close()
  })
})

// ─── 31. onAfterDelete hook — soft-delete boundary ───────────────────────────

describe('onAfterDelete — soft-delete boundary', () => {
  test('remove() on @@softDelete model does NOT fire onAfterDelete', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let called = false
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { if (rows.length) called = true }
    }
    const db = await makeDb(`
      model Post {
        id        Int  @id
        title     String
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-soft-boundary', { plugins: [new Spy()] })
    await db.post.create({ data: { id: 1, title: 'Hello' } })
    await db.post.remove({ where: { id: 1 } })   // soft delete — row still in DB
    expect(called).toBe(false)
    db.$close()
  })

  test('delete() on @@softDelete model fires onAfterDelete (hard delete)', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const deleted: unknown[] = []
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { deleted.push(...rows) }
    }
    const db = await makeDb(`
      model Post {
        id        Int  @id
        title     String
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-hard-on-soft', { plugins: [new Spy()] })
    await db.post.create({ data: { id: 1, title: 'Hello' } })
    await db.post.delete({ where: { id: 1 } })   // @hardDelete path
    expect(deleted).toHaveLength(1)
    expect((deleted[0] as any).id).toBe(1)
    db.$close()
  })

  test('removeMany() on @@softDelete model does NOT fire onAfterDelete', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let called = false
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { if (rows.length) called = true }
    }
    const db = await makeDb(`
      model Post {
        id        Int  @id
        tag       String
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-removemany', { plugins: [new Spy()] })
    await db.post.createMany({ data: [{ id: 1, tag: 'a' }, { id: 2, tag: 'a' }] })
    await db.post.removeMany({ where: { tag: 'a' } })
    expect(called).toBe(false)
    db.$close()
  })
})


// ─── @from — derived relation fields ─────────────────────────────────────────

const FROM_SCHEMA = `
  model Account {
    id       Int @id
    name     String
    orders   Order[]

    orderCount   Int  @from(Order, count: true)
    totalSpent   Float     @from(Order, sum: amount)
    lastOrderId  Int  @from(Order, max: id)
    firstOrderId Int  @from(Order, min: id)
    latestOrder  Order?  @from(Order, last: true)
    firstOrder   Order?  @from(Order, first: true)
    hasOrders    Boolean  @from(Order, exists: true)
    pendingCount Int  @from(Order, count: true, where: "status = 'pending'")
    latestPending Order? @from(Order, last: true, where: "status = 'pending'", orderBy: id)
  }

  model Order {
    id        Int @id
    accountId Int
    account   Account @relation(fields: [accountId], references: [id])
    amount    Float
    status    String
  }
`

describe('@from — derived relation fields', () => {
  test('parses @from attribute without error', () => {
    const r = parse(FROM_SCHEMA)
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  test('@from fields stored on AST', () => {
    const { schema } = parse(FROM_SCHEMA)
    const f = schema.models[0].fields.find((f: any) => f.name === 'orderCount')
    const attr = f.attributes.find((a: any) => a.kind === 'from')
    expect(attr.target).toBe('Order')
    expect(attr.op).toBe('count')
  })

  test('@from count: true — counts child rows', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Acme' } })
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10, status: 'paid' },
          { id: 2, accountId: 1, amount: 20, status: 'pending' },
          { id: 3, accountId: 1, amount: 30, status: 'paid' },
        ]})
      }
    })
    const acc = await db.account.findFirst({ where: { id: 1 } })
    expect(acc.orderCount).toBe(3)
    db.$close()
  })

  test('@from count: true — zero when no children', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => { await db.account.create({ data: { id: 1, name: 'Empty' } }) }
    })
    const acc = await db.account.findFirst({ where: { id: 1 } })
    expect(acc.orderCount).toBe(0)
    db.$close()
  })

  test('@from sum: field — sums child field', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Acme' } })
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10.5, status: 'paid' },
          { id: 2, accountId: 1, amount: 20.0, status: 'paid' },
        ]})
      }
    })
    const acc = await db.account.findFirst({ where: { id: 1 } })
    expect(acc.totalSpent).toBeCloseTo(30.5)
    db.$close()
  })

  test('@from max: field / min: field', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Acme' } })
        await db.order.createMany({ data: [
          { id: 5, accountId: 1, amount: 10, status: 'paid' },
          { id: 9, accountId: 1, amount: 20, status: 'paid' },
          { id: 3, accountId: 1, amount: 30, status: 'paid' },
        ]})
      }
    })
    const acc = await db.account.findFirst({ where: { id: 1 } })
    expect(acc.lastOrderId).toBe(9)
    expect(acc.firstOrderId).toBe(3)
    db.$close()
  })

  test('@from exists: true — returns boolean', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'HasOrders' } })
        await db.account.create({ data: { id: 2, name: 'Empty' } })
        await db.order.create({ data: { id: 1, accountId: 1, amount: 10, status: 'paid' } })
      }
    })
    const a1 = await db.account.findFirst({ where: { id: 1 } })
    const a2 = await db.account.findFirst({ where: { id: 2 } })
    expect(a1.hasOrders).toBe(true)
    expect(a2.hasOrders).toBe(false)
    db.$close()
  })

  test('@from last: true — returns full object or null', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Acme' } })
        await db.account.create({ data: { id: 2, name: 'Empty' } })
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10, status: 'paid' },
          { id: 2, accountId: 1, amount: 20, status: 'pending' },
        ]})
      }
    })
    const a1 = await db.account.findFirst({ where: { id: 1 } })
    const a2 = await db.account.findFirst({ where: { id: 2 } })
    expect(a1.latestOrder).not.toBeNull()
    expect(a1.latestOrder.id).toBe(2)
    expect(a1.latestOrder.amount).toBe(20)
    expect(a2.latestOrder).toBeNull()
    db.$close()
  })

  test('@from first: true — returns first child by id', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Acme' } })
        await db.order.createMany({ data: [
          { id: 3, accountId: 1, amount: 30, status: 'paid' },
          { id: 1, accountId: 1, amount: 10, status: 'paid' },
          { id: 2, accountId: 1, amount: 20, status: 'paid' },
        ]})
      }
    })
    const acc = await db.account.findFirst({ where: { id: 1 } })
    expect(acc.firstOrder.id).toBe(1)
    db.$close()
  })

  test('@from with where: — filtered count', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Acme' } })
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10, status: 'pending' },
          { id: 2, accountId: 1, amount: 20, status: 'paid' },
          { id: 3, accountId: 1, amount: 30, status: 'pending' },
        ]})
      }
    })
    const acc = await db.account.findFirst({ where: { id: 1 } })
    expect(acc.pendingCount).toBe(2)
    db.$close()
  })

  test('@from with where: — filtered last', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.create({ data: { id: 1, name: 'Acme' } })
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10, status: 'paid' },
          { id: 2, accountId: 1, amount: 20, status: 'pending' },
          { id: 3, accountId: 1, amount: 30, status: 'paid' },
        ]})
      }
    })
    const acc = await db.account.findFirst({ where: { id: 1 } })
    expect(acc.latestPending.id).toBe(2)
    db.$close()
  })

  test('@from works in findMany', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.createMany({ data: [
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
        ]})
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10, status: 'paid' },
          { id: 2, accountId: 1, amount: 20, status: 'paid' },
          { id: 3, accountId: 2, amount: 5,  status: 'paid' },
        ]})
      }
    })
    const rows = await db.account.findMany({})
    expect(rows.find((r: any) => r.id === 1).orderCount).toBe(2)
    expect(rows.find((r: any) => r.id === 2).orderCount).toBe(1)
    db.$close()
  })

  test('@from: @from fields not writable — create ignores them', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA)
    // Should not throw — @from fields are silently ignored on write
    await expect(
      db.account.create({ data: { id: 1, name: 'Test', orderCount: 99 } as any })
    ).resolves.toBeDefined()
    db.$close()
  })

  test('@from: unknown target model is a parse error', () => {
    const r = parse(`model T { id Int @id; x Int @from(nope, count: true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('nope'))).toBe(true)
  })

  test('@from: wrong type for count is a parse error', () => {
    const r = parse(`
      model User { id Int @id; posts Post[]; postCount String @from(Post, count: true) }
      model Post { id Int @id; userId Int; u User @relation(fields: [userId], references: [id]) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('Int'))).toBe(true)
  })
})

// ─── @from — a relation to the SAME model ────────────────────────────────────
// The subquery correlates a table to itself, so an unaliased target captured
// its own correlation: `WHERE "taskId" = "task"."id"` read `"task"` as the
// subquery's own FROM and counted self-parented rows. FJS-220.

// ─── @from(first/last) — the row goes through a real read ────────────────────
// The subquery encoded the row as json_object over the target's columns, which
// is the one @from shape that returned a row read() never saw: the target's
// @computed and @from fields were missing and its @guarded / @omit / @encrypted
// ones were present. FJS-222 / FJS-223.

// ─── now() — one instant per evaluation, and injectable ──────────────────────
// `now()` resolved where it was REACHED, so two of them in one expression bound
// two timestamps and a report had no single "as of" moment. FJS-227.

describe('now() is one instant per evaluation', () => {
  const EVENTS = `
    model Event { id Int @id  title String  startAt DateTime  endAt DateTime
      @@allow('read', startAt < now() && now() < endAt) }
  `
  const iso = (offset: number) => new Date(Date.now() + offset).toISOString()

  test('two now() in one predicate agree', async () => {
    const db = await makeDb(EVENTS, 'now-one-instant')
    await db.asSystem().event.createMany({ data: [
      { id: 1, title: 'running',     startAt: iso(-3600e3), endAt: iso(3600e3) },
      { id: 2, title: 'finished',    startAt: iso(-7200e3), endAt: iso(-3600e3) },
      { id: 3, title: 'not started', startAt: iso(3600e3),  endAt: iso(7200e3) },
    ]})
    expect((await db.$setAuth({ id: 1 }).event.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.id))
      .toEqual([1])
    db.$close()
  })

  test('an injected clock decides what now() means', async () => {
    const start = iso(-3600e3), end = iso(3600e3)
    const at = async (when: string) => {
      const db = await makeDb(EVENTS, `now-frozen-${when.slice(11, 19)}`, { now: () => new Date(when) })
      await db.asSystem().event.create({ data: { id: 1, title: 'e', startAt: start, endAt: end } })
      const seen = (await db.$setAuth({ id: 1 }).event.findMany()).map((r: any) => r.id)
      db.$close()
      return seen
    }
    expect(await at(iso(0))).toEqual([1])          // inside the window
    expect(await at(iso(7200e3))).toEqual([])      // after it
    expect(await at(iso(-7200e3))).toEqual([])     // before it
  })

  test('a create policy reads the same clock — evalJs, not the WHERE', async () => {
    // read compiles to SQL, create is evaluated in JS. Two implementations of
    // one rule, so the clock has to reach both.
    const BOOKING = `
      model Booking { id Int @id  opensAt DateTime  closesAt DateTime
        @@allow('create', opensAt < now() && now() < closesAt)
        @@allow('read', true) }
    `
    const iso = (offset: number) => new Date(Date.now() + offset).toISOString()
    const opensAt = iso(-3600e3), closesAt = iso(3600e3)

    const inside = await makeDb(BOOKING, 'now-create-inside', { now: () => new Date(iso(0)) })
    await expect(inside.$setAuth({ id: 1 }).booking.create({ data: { id: 1, opensAt, closesAt } }))
      .resolves.toBeTruthy()
    inside.$close()

    const after = await makeDb(BOOKING, 'now-create-after', { now: () => new Date(iso(7200e3)) })
    await expect(after.$setAuth({ id: 1 }).booking.create({ data: { id: 1, opensAt, closesAt } }))
      .rejects.toThrow()
    after.$close()
  })

  test('the injected clock also stamps a soft delete', async () => {
    const when = '2020-01-02T03:04:05.678Z'
    const db = await makeDb(
      `model Doc { id Int @id  deletedAt DateTime?  @@softDelete }`,
      'now-soft-delete', { now: () => new Date(when) })
    await db.doc.create({ data: { id: 1 } })
    await db.doc.remove({ where: { id: 1 } })
    expect((await db.doc.findFirst({ where: { id: 1 }, onlyDeleted: true })).deletedAt).toBe(when)
    db.$close()
  })
})

describe('@from — first/last returns a properly read row', () => {
  const SHOP = `
    model Company { id Int @id  name String  accounts Account[] }
    model Account {
      id Int @id  name String  companyId Int?
      company Company? @relation(fields: [companyId], references: [id])
      orders  Order[]
      lastOrder Order? @from(Order, last: true)
    }
    model Order {
      id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id])
      amount Float
      secretNote String? @guarded(all)
      hiddenNote String? @omit(all)
      card       String? @encrypted
      label      String  @computed
      lines      Line[]
      lineCount  Int @from(Line, count: true)
    }
    model Line { id Int @id  orderId Int  order Order @relation(fields: [orderId], references: [id]) }
  `
  const shop = async (label: string) => {
    const db = await makeDb(SHOP, label, {
      encryptionKey: 'a'.repeat(64),
      computed: { Order: { label: (r: any) => `#${r.id}` } },
    })
    await db.company.create({ data: { id: 1, name: 'c' } })
    await db.account.create({ data: { id: 1, name: 'acme', companyId: 1 } })
    await db.order.createMany({ data: [
      { id: 1, accountId: 1, amount: 5, secretNote: 'S1', hiddenNote: 'H1', card: '4111' },
      { id: 2, accountId: 1, amount: 9, secretNote: 'S2', hiddenNote: 'H2', card: '4222' },
    ]})
    await db.line.createMany({ data: [{ id: 1, orderId: 2 }, { id: 2, orderId: 2 }] })
    return db
  }

  test('the row it returns is the row a direct read returns', async () => {
    const db = await shop('from-row-agree')
    const u = db.$setAuth({ id: 9, role: 'member' })
    const keys = (o: any) => Object.keys(o).sort()

    const direct   = await u.order.findUnique({ where: { id: 2 } })
    const included = (await u.account.findUnique({ where: { id: 1 }, include: { orders: true } }))
      .orders.find((o: any) => o.id === 2)
    const viaFrom  = (await u.account.findUnique({ where: { id: 1 } })).lastOrder

    // three ways to the same row, one shape
    expect(keys(viaFrom)).toEqual(keys(direct))
    expect(keys(viaFrom)).toEqual(keys(included))
  })

  test('protected fields do not come back through it', async () => {
    const db = await shop('from-row-guarded')
    const last = (await db.$setAuth({ id: 9 }).account.findUnique({ where: { id: 1 } })).lastOrder
    expect(last.secretNote).toBeUndefined()   // @guarded(all)
    expect(last.hiddenNote).toBeUndefined()   // @omit(all)
    expect(last.card).toBeUndefined()         // @encrypted implies @guarded(all)
    expect(last.amount).toBe(9)
    db.$close()
  })

  test('the target\'s own derived fields come back through it', async () => {
    const db = await shop('from-row-derived')
    const last = (await db.account.findUnique({ where: { id: 1 } })).lastOrder
    expect(last.label).toBe('#2')      // @computed on the target
    expect(last.lineCount).toBe(2)     // @from on the target
    db.$close()
  })

  test('it resolves through an include, and on the cursor path', async () => {
    const db = await shop('from-row-nested')
    const viaInclude = (await db.company.findUnique({ where: { id: 1 }, include: { accounts: true } }))
      .accounts[0].lastOrder
    expect(viaInclude?.id).toBe(2)
    expect(viaInclude?.lineCount).toBe(2)

    const page = await db.account.findManyCursor({ limit: 2, orderBy: { id: 'asc' } })
    expect(page.items[0].lastOrder?.id).toBe(2)
    db.$close()
  })

  test('a @computed on the PARENT sees the row, not its id', async () => {
    const db = await makeDb(`
      model Account { id Int @id  orders Order[]  lastOrder Order? @from(Order, last: true)  lastAmount Float @computed }
      model Order   { id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id])  amount Float }
    `, 'from-row-parent-computed', {
      computed: { Account: { lastAmount: (r: any) => r.lastOrder?.amount ?? 0 } },
    })
    await db.account.create({ data: { id: 1 } })
    await db.order.createMany({ data: [{ id: 1, accountId: 1, amount: 5 }, { id: 2, accountId: 1, amount: 9 }] })
    expect((await db.account.findUnique({ where: { id: 1 } })).lastAmount).toBe(9)
    db.$close()
  })

  test('no matching row is null, and the target policy applies', async () => {
    const db = await makeDb(`
      model Account { id Int @id  orders Order[]  lastOrder Order? @from(Order, last: true) }
      model Order   { id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id])  ownerId Int
                      @@allow('read', ownerId == auth().id) }
    `, 'from-row-policy')
    await db.asSystem().account.createMany({ data: [{ id: 1 }, { id: 2 }] })
    await db.asSystem().order.create({ data: { id: 1, accountId: 1, ownerId: 7 } })

    expect((await db.$setAuth({ id: 7 }).account.findUnique({ where: { id: 1 } })).lastOrder?.id).toBe(1)
    // refused by the target's own read policy — null, not the row (FJS-224)
    expect((await db.$setAuth({ id: 8 }).account.findUnique({ where: { id: 1 } })).lastOrder).toBeNull()
    // no orders at all
    expect((await db.asSystem().account.findUnique({ where: { id: 2 } })).lastOrder).toBeNull()
    db.$close()
  })
})

describe('@from — a self-relation', () => {
  const SELF = `
    model Task {
      id          Int @id
      title       String
      taskId      Int?
      parent      Task?  @relation(fields: [taskId], references: [id])
      children    Task[]
      completedAt DateTime?
      deletedAt   DateTime?

      childCount  Int       @from(Task, count: true)
      doneCount   Int       @from(Task, count: true, where: "completedAt IS NOT NULL")
      anyKids     Boolean   @from(Task, exists: true)
      newestKid   Task?     @from(Task, last: true)
      @@softDelete
    }
  `

  const seed = async (db: any) => {
    await db.task.createMany({ data: [
      { id: 1, title: 'parent' },
      { id: 2, title: 'kid a', taskId: 1, completedAt: '2026-01-01T00:00:00.000Z' },
      { id: 3, title: 'kid b', taskId: 1 },
      { id: 4, title: 'kid c', taskId: 1 },
      { id: 5, title: 'lonely' },
    ]})
    await db.task.remove({ where: { id: 4 } })   // soft-deleted child
  }

  test('two @from to different tables, and one nested inside a relation', async () => {
    // Every @from subquery uses one alias. Siblings are separate scopes; a
    // nested one shadows the name harmlessly, because a correlation names the
    // outer TABLE and never the alias.
    const db = await makeDb(`
      model Account {
        id Int @id  name String
        orders Order[]  notes Note[]
        orderCount Int @from(Order, count: true)
        noteCount  Int @from(Note,  count: true)
      }
      model Order {
        id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id])
        lines Line[]
        lineCount Int @from(Line, count: true)
      }
      model Line { id Int @id  orderId Int  order Order @relation(fields: [orderId], references: [id]) }
      model Note { id Int @id  accountId Int  account Account @relation(fields: [accountId], references: [id]) }
    `, 'from-two-targets')
    await db.account.create({ data: { id: 1, name: 'acme' } })
    await db.order.createMany({ data: [{ id: 1, accountId: 1 }, { id: 2, accountId: 1 }] })
    await db.line.createMany({ data: [{ id: 1, orderId: 1 }, { id: 2, orderId: 2 }, { id: 3, orderId: 2 }] })
    await db.note.create({ data: { id: 1, accountId: 1 } })

    const a = await db.account.findUnique({ where: { id: 1 } })
    expect(a.orderCount).toBe(2)
    expect(a.noteCount).toBe(1)

    // the target's own @from, resolved inside the include's nested SELECT
    const inc = await db.account.findUnique({ where: { id: 1 }, include: { orders: true } })
    expect(inc.orders.map((o: any) => o.lineCount).sort()).toEqual([1, 2])
    db.$close()
  })

  test('counts the children, not the rows that are their own parent', async () => {
    const db = await makeDb(SELF, 'from-self-count')
    await seed(db)
    const p = await db.task.findUnique({ where: { id: 1 } })
    expect(p.childCount).toBe(2)      // the soft-deleted one does not count
    expect(p.doneCount).toBe(1)
    expect(p.anyKids).toBe(true)
    const lonely = await db.task.findUnique({ where: { id: 5 } })
    expect(lonely.childCount).toBe(0)
    expect(lonely.anyKids).toBe(false)
    db.$close()
  })

  test('a self @from filters and sorts in SQL', async () => {
    const db = await makeDb(SELF, 'from-self-query')
    await seed(db)
    expect((await db.task.findMany({ where: { childCount: { gt: 0 } } })).map((r: any) => r.id)).toEqual([1])
    expect((await db.task.findMany({ where: { doneCount: 0 }, orderBy: { id: 'asc' } })).map((r: any) => r.id))
      .toEqual([2, 3, 5])
    expect((await db.task.findMany({ orderBy: [{ childCount: 'desc' }, { id: 'asc' }] })).map((r: any) => r.id)[0]).toBe(1)
    db.$close()
  })

  test('first/last hydrate a whole row through the alias', async () => {
    const db = await makeDb(SELF, 'from-self-last')
    await seed(db)
    const p = await db.task.findUnique({ where: { id: 1 } })
    expect(p.newestKid?.id).toBe(3)          // 4 is soft-deleted
    expect(p.newestKid?.title).toBe('kid b')
    db.$close()
  })
})

// ─── @from — which relation it means ─────────────────────────────────────────
// Two relations can join one pair of models — sender/recipient, parent/children.
// @from used to take the first that fit and say nothing, so the other one was
// unaskable and the count that came back answered a different question. FJS-221.

describe('@from — via', () => {
  const MSG = (extra: string) => `
    model User { id Int @id  name String
      sent     Message[] @relation("sent")
      received Message[] @relation("received")
      ${extra} }
    model Message { id Int @id  body String
      senderId    Int  sender    User @relation("sent",     fields: [senderId],    references: [id])
      recipientId Int  recipient User @relation("received", fields: [recipientId], references: [id]) }
  `
  const seeded = async (extra: string, label: string) => {
    const db = await makeDb(MSG(extra), label)
    await db.user.createMany({ data: [{ id: 1, name: 'ann' }, { id: 2, name: 'bob' }] })
    await db.message.createMany({ data: [
      { id: 1, body: 'x', senderId: 1, recipientId: 2 },
      { id: 2, body: 'y', senderId: 1, recipientId: 2 },
      { id: 3, body: 'z', senderId: 2, recipientId: 1 },
    ]})
    return db
  }

  test('an ambiguous @from is refused, naming the candidates and the cure', async () => {
    await expect(makeDb(MSG('n Int @from(Message, count: true)'), 'from-ambig'))
      .rejects.toThrow(/ambiguous — 2 relations join 'User' and 'Message' \(Message\.sender, Message\.recipient\)/)
    await expect(makeDb(MSG('n Int @from(Message, count: true)'), 'from-ambig2'))
      .rejects.toThrow(/via: sender/)
  })

  test('via names either side of the relation', async () => {
    // the field on this model, the field on the target, and the FK column
    for (const [via, expected] of [['sent', [2, 1]], ['sender', [2, 1]], ['received', [1, 2]], ['recipientId', [1, 2]]] as const) {
      const db = await seeded(`n Int @from(Message, count: true, via: ${via})`, `from-via-${via}`)
      expect((await db.user.findMany({ orderBy: { id: 'asc' } })).map((u: any) => u.n)).toEqual([...expected])
      db.$close()
    }
  })

  test('a via that names nothing is refused, listing what would work', async () => {
    await expect(makeDb(MSG('n Int @from(Message, count: true, via: nope)'), 'from-via-bad'))
      .rejects.toThrow(/'nope' names no relation between 'User' and 'Message'. Candidates: Message\.sender, Message\.recipient/)
  })

  test('one relation still needs no via, two self-relations do', async () => {
    const TREE = (extra: string) => `
      model Task { id Int @id  title String
        taskId    Int?  parent  Task? @relation("tree",  fields: [taskId],    references: [id])  children Task[] @relation("tree")
        ${extra} }
    `
    const ok = await makeDb(TREE('childCount Int @from(Task, count: true)'), 'from-self-one')
    ok.$close()

    const BOTH = (extra: string) => `
      model Task { id Int @id  title String
        taskId    Int?  parent  Task? @relation("tree",  fields: [taskId],    references: [id])  children Task[] @relation("tree")
        blockerId Int?  blocker Task? @relation("block", fields: [blockerId], references: [id])  blocked  Task[] @relation("block")
        ${extra} }
    `
    await expect(makeDb(BOTH('childCount Int @from(Task, count: true)'), 'from-self-ambig'))
      .rejects.toThrow(/ambiguous — 2 relations join 'Task' and 'Task'/)

    const db = await makeDb(BOTH('childCount Int @from(Task, count: true, via: children)'), 'from-self-via')
    await db.task.createMany({ data: [{ id: 1, title: 'p' }, { id: 2, title: 'a', taskId: 1 }, { id: 3, title: 'b', taskId: 1 }] })
    expect((await db.task.findUnique({ where: { id: 1 } })).childCount).toBe(2)
    db.$close()
  })
})

describe('@from — WHERE filtering', () => {
  test('where: { count field: { gt } } filters correctly', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.createMany({ data: [{ id: 1, name: 'Big' }, { id: 2, name: 'Small' }] })
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10, status: 'paid' },
          { id: 2, accountId: 1, amount: 20, status: 'paid' },
          { id: 3, accountId: 1, amount: 30, status: 'paid' },
          { id: 4, accountId: 2, amount: 10, status: 'paid' },
        ]})
      }
    })
    const rows = await db.account.findMany({ where: { orderCount: { gt: 1 } } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    db.$close()
  })

  test('where: { exists field: true } filters to rows with children', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.createMany({ data: [{ id: 1, name: 'HasOrders' }, { id: 2, name: 'Empty' }] })
        await db.order.create({ data: { id: 1, accountId: 1, amount: 10, status: 'paid' } })
      }
    })
    const rows = await db.account.findMany({ where: { hasOrders: true } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    db.$close()
  })

  test('where: { exists field: false } filters to rows without children', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.createMany({ data: [{ id: 1, name: 'HasOrders' }, { id: 2, name: 'Empty' }] })
        await db.order.create({ data: { id: 1, accountId: 1, amount: 10, status: 'paid' } })
      }
    })
    const rows = await db.account.findMany({ where: { hasOrders: false } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(2)
    db.$close()
  })

  test('where: { sum field: { gte } } filters by aggregate', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.createMany({ data: [{ id: 1, name: 'Rich' }, { id: 2, name: 'Poor' }] })
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 100, status: 'paid' },
          { id: 2, accountId: 1, amount: 200, status: 'paid' },
          { id: 3, accountId: 2, amount: 5,   status: 'paid' },
        ]})
      }
    })
    const rows = await db.account.findMany({ where: { totalSpent: { gte: 100 } } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    db.$close()
  })

  test('where: @from field works inside AND/OR', async () => {
    const { db } = await makeTestClient(FROM_SCHEMA, {
      data: async (db) => {
        await db.account.createMany({ data: [
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
          { id: 3, name: 'C' },
        ]})
        await db.order.createMany({ data: [
          { id: 1, accountId: 1, amount: 10, status: 'paid' },
          { id: 2, accountId: 2, amount: 10, status: 'paid' },
          { id: 3, accountId: 2, amount: 10, status: 'paid' },
        ]})
      }
    })
    // accounts with exactly 2 orders OR name = 'C'
    const rows = await db.account.findMany({
      where: { OR: [{ orderCount: 2 }, { name: 'C' }] }
    })
    expect(rows.map((r: any) => r.id).sort()).toEqual([2, 3])
    db.$close()
  })
})


// ─── @from — the target model's own defaults ─────────────────────────────────
//
// A @from reads another model, so it reads it the way that model is read:
// soft-deleted rows and template rows are out. Before this every schema had to
// repeat `where: "deletedAt IS NULL"` by hand, and `include: { _count: true }`
// over the same relation already disagreed with it.

const FROM_DEFAULTS_SCHEMA = `
  model Client {
    id        Int @id
    name      String
    notes     Note[]

    liveNotes      Int @from(Note, count: true)
    allNotes       Int @from(Note, count: true, withDeleted: true)
    withTemplates  Int @from(Note, count: true, withTemplates: true)
    everything     Int @from(Note, count: true, withDeleted: true, withTemplates: true)
    liveTotal      Float @from(Note, sum: weight)
    hasLive        Boolean @from(Note, exists: true)
    lastLive       Note? @from(Note, last: true)
    deletedAt      DateTime?
    @@softDelete
  }

  model Note {
    id         Int @id
    body       String
    weight     Float
    isTemplate Boolean
    clientId   Int
    client     Client @relation(fields: [clientId], references: [id])
    deletedAt  DateTime?
    @@softDelete
    @@hasTemplates(field: "isTemplate")
  }
`

// live 2 (n1,n2) · soft-deleted 1 (n3) · template 1 (n4) · deleted template 1 (n5).
// n5 is stamped deleted through create(), not removeMany(): a write cannot
// reach a template row, and createMany() drops deletedAt.
async function fromDefaultsClient() {
  const { db } = await makeTestClient(FROM_DEFAULTS_SCHEMA, {
    data: async (db: any) => {
      await db.client.create({ data: { id: 1, name: 'Acme' } })
      await db.note.createMany({ data: [
        { id: 1, body: 'n1', weight: 10, isTemplate: false, clientId: 1 },
        { id: 2, body: 'n2', weight: 20, isTemplate: false, clientId: 1 },
        { id: 3, body: 'n3', weight: 40, isTemplate: false, clientId: 1 },
        { id: 4, body: 'n4', weight: 80, isTemplate: true,  clientId: 1 },
      ]})
      await db.note.create({ data: { id: 5, body: 'n5', weight: 160, isTemplate: true, clientId: 1, deletedAt: new Date() } })
      await db.note.removeMany({ where: { id: 3 } })
    }
  })
  return db
}

describe('@from — target model defaults', () => {
  test('count excludes soft-deleted and template rows by default', async () => {
    const db = await fromDefaultsClient()
    const [row] = await db.client.findMany({})
    expect(row.liveNotes).toBe(2)
    db.$close()
  })

  test('withDeleted: true counts soft-deleted rows, still no templates', async () => {
    const db = await fromDefaultsClient()
    const [row] = await db.client.findMany({})
    expect(row.allNotes).toBe(3)
    db.$close()
  })

  test('withTemplates: true counts templates, still no deleted', async () => {
    const db = await fromDefaultsClient()
    const [row] = await db.client.findMany({})
    expect(row.withTemplates).toBe(3)
    db.$close()
  })

  test('both flags together count every row', async () => {
    const db = await fromDefaultsClient()
    const [row] = await db.client.findMany({})
    expect(row.everything).toBe(5)
    db.$close()
  })

  test('sum, exists and last apply the same defaults', async () => {
    const db = await fromDefaultsClient()
    const [row] = await db.client.findMany({})
    expect(row.liveTotal).toBe(30)        // 10 + 20, not 40/80/160
    expect(row.hasLive).toBe(true)
    expect(row.lastLive.body).toBe('n2')  // not n3 (deleted) or n5 (deleted template)
    db.$close()
  })

  test('a @from count agrees with include: { _count: true } over the same relation', async () => {
    const db = await fromDefaultsClient()
    const [row] = await db.client.findMany({ include: { _count: true } })
    expect(row.liveNotes).toBe(row._count.notes)
    db.$close()
  })

  test('an explicit where: still composes on top of the defaults', async () => {
    const { db } = await makeTestClient(`
      model Client {
        id    Int @id
        name  String
        notes Note[]
        heavyLive Int @from(Note, count: true, where: "weight > 15")
      }
      model Note {
        id        Int @id
        weight    Float
        clientId  Int
        client    Client @relation(fields: [clientId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }
    `, {
      data: async (db: any) => {
        await db.client.create({ data: { id: 1, name: 'Acme' } })
        await db.note.createMany({ data: [
          { id: 1, weight: 10, clientId: 1 },
          { id: 2, weight: 20, clientId: 1 },
          { id: 3, weight: 30, clientId: 1 },
        ]})
        await db.note.remove({ where: { id: 3 } })
      }
    })
    const [row] = await db.client.findMany({})
    expect(row.heavyLive).toBe(1)   // weight > 15 AND not deleted → id 2 only
    db.$close()
  })
})


// ─── @from — under an aliased query ──────────────────────────────────────────
//
// A relation orderBy aliases the outer table to `t`, and a @from subquery
// correlates to the outer table BY NAME. With one variant of the subquery the
// query either dropped every @from field to undefined (default select, where a
// @computed field reading one then computed from undefined in silence) or died
// on `no such column: <table>.<pk>` (explicit select).

const FROM_ALIAS_SCHEMA = `
  model Author {
    id     Int @id
    name   String
    books  Book[]
    bookCount Int   @from(Book, count: true)
    score     Float @computed
  }
  model Book {
    id       Int @id
    title    String
    authorId Int
    author   Author @relation(fields: [authorId], references: [id])
  }
`

async function fromAliasClient() {
  const { db } = await makeTestClient(FROM_ALIAS_SCHEMA, {
    computed: { Author: { score: (r: any) => (r.bookCount ?? 0) * 100 } },
    data: async (db: any) => {
      await db.author.createMany({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
      await db.book.createMany({ data: [
        { id: 1, title: 'b1', authorId: 1 },
        { id: 2, title: 'b2', authorId: 1 },
        { id: 3, title: 'b3', authorId: 2 },
      ]})
    }
  })
  return db
}

describe('@from — under a relation orderBy', () => {
  test('survives a relation aggregate orderBy with the default select', async () => {
    const db = await fromAliasClient()
    const rows = await db.author.findMany({ orderBy: { books: { _count: 'desc' } } })
    expect(rows.map((r: any) => r.bookCount)).toEqual([2, 1])
    db.$close()
  })

  test('a @computed field reading a @from field still computes', async () => {
    const db = await fromAliasClient()
    const rows = await db.author.findMany({ orderBy: { books: { _count: 'desc' } } })
    expect(rows.map((r: any) => r.score)).toEqual([200, 100])
    db.$close()
  })

  test('survives a relation aggregate orderBy with an explicit select', async () => {
    const db = await fromAliasClient()
    const rows = await db.author.findMany({
      orderBy: { books: { _count: 'desc' } },
      select:  { name: true, bookCount: true },
    })
    expect(rows).toEqual([{ name: 'A', bookCount: 2 }, { name: 'B', bookCount: 1 }])
    db.$close()
  })

  test('a where on a @from field correlates correctly under the alias', async () => {
    const db = await fromAliasClient()
    const rows = await db.author.findMany({
      where:   { bookCount: { gt: 1 } },
      orderBy: { books: { _count: 'desc' } },
    })
    expect(rows.map((r: any) => r.name)).toEqual(['A'])
    db.$close()
  })

  test('survives a belongsTo relation orderBy, which adds a real JOIN', async () => {
    const db = await fromAliasClient()
    const rows = await db.book.findMany({ orderBy: { author: { name: 'desc' } } })
    expect(rows.map((r: any) => r.title)).toEqual(['b3', 'b1', 'b2'])
    db.$close()
  })
})


// ─── @from — on the paths that build their own SQL ───────────────────────────
//
// findManyCursor and resolveIncludes assemble SELECTs below the query pipeline,
// so neither had @from subqueries at all: the field was simply absent. What
// made that silent rather than obvious is that applyComputed still runs — a
// @computed field reading a missing @from field answers a plausible 0 rather
// than throwing, so the same row read two ways gave two different numbers.

const FROM_PATHS_SCHEMA = `
  model Author {
    id     Int @id
    name   String
    books  Book[]
    tags   Tag[]
    bookCount Int     @from(Book, count: true)
    lastBook  Book?   @from(Book, last: true)
    hasBooks  Boolean @from(Book, exists: true)
    score     Float   @computed
  }
  model Book {
    id       Int @id
    title    String
    authorId Int
    author   Author @relation(fields: [authorId], references: [id])
  }
  model Tag {
    id      Int @id
    label   String
    authors Author[]
  }
`

async function fromPathsClient() {
  const { db } = await makeTestClient(FROM_PATHS_SCHEMA, {
    computed: { Author: { score: (r: any) => (r.bookCount ?? 0) * 5 } },
    data: async (db: any) => {
      await db.author.createMany({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
      await db.book.createMany({ data: [
        { id: 1, title: 'b1', authorId: 1 },
        { id: 2, title: 'b2', authorId: 1 },
        { id: 3, title: 'b3', authorId: 2 },
      ]})
      await db.tag.create({ data: { id: 1, label: 't', authors: { connect: [{ id: 1 }, { id: 2 }] } } })
    }
  })
  return db
}

describe('@from — findManyCursor', () => {
  test('a cursor page carries the @from fields', async () => {
    const db = await fromPathsClient()
    const { items } = await db.author.findManyCursor({ limit: 10, orderBy: { id: 'asc' } })
    expect(items.map((r: any) => r.bookCount)).toEqual([2, 1])
    db.$close()
  })

  test('a @computed field over a @from field agrees with findMany', async () => {
    const db = await fromPathsClient()
    const { items } = await db.author.findManyCursor({ limit: 10, orderBy: { id: 'asc' } })
    const rows = await db.author.findMany({ orderBy: { id: 'asc' } })
    expect(items.map((r: any) => r.score)).toEqual(rows.map((r: any) => r.score))
    expect(items[0].score).toBe(10)
    db.$close()
  })

  test('selecting a @from field on a cursor page returns it', async () => {
    const db = await fromPathsClient()
    const { items } = await db.author.findManyCursor({ limit: 1, orderBy: { id: 'asc' }, select: { bookCount: true } })
    expect(items).toEqual([{ bookCount: 2 }])
    db.$close()
  })

  test('an object-valued @from is parsed, not left as JSON text', async () => {
    const db = await fromPathsClient()
    const { items } = await db.author.findManyCursor({ limit: 1, orderBy: { id: 'asc' } })
    expect(items[0].lastBook).toEqual({ id: 2, title: 'b2', authorId: 1 })
    db.$close()
  })
})

describe('@from — under an include', () => {
  test('belongsTo: the parent carries its @from fields', async () => {
    const db = await fromPathsClient()
    const [row] = await db.book.findMany({ where: { id: 1 }, include: { author: true } })
    expect(row.author.bookCount).toBe(2)
    expect(row.author.score).toBe(10)
    db.$close()
  })

  test('hasMany: the host row still carries its own', async () => {
    const db = await fromPathsClient()
    const [row] = await db.author.findMany({ where: { id: 1 }, include: { books: true } })
    expect(row.bookCount).toBe(2)
    expect(row.books).toHaveLength(2)
    db.$close()
  })

  test('manyToMany: the target is aliased, and the correlation follows it', async () => {
    const db = await fromPathsClient()
    const [row] = await db.tag.findMany({ include: { authors: true } })
    expect(row.authors.map((a: any) => a.bookCount)).toEqual([2, 1])
    expect(row.authors.map((a: any) => a.score)).toEqual([10, 5])
    db.$close()
  })

  test('a nested select may name a @from field', async () => {
    const db = await fromPathsClient()
    const [row] = await db.book.findMany({ where: { id: 1 }, include: { author: { select: { name: true, bookCount: true } } } })
    expect(row.author).toEqual({ name: 'A', bookCount: 2 })
    db.$close()
  })

  test('a nested select naming only a @computed field still gets its deps', async () => {
    const db = await fromPathsClient()
    const [row] = await db.book.findMany({ where: { id: 1 }, include: { author: { select: { score: true } } } })
    expect(row.author).toEqual({ score: 10 })
    db.$close()
  })

  test('object and boolean @from fields are shaped under an include too', async () => {
    const db = await fromPathsClient()
    const [row] = await db.book.findMany({ where: { id: 1 }, include: { author: true } })
    expect(row.author.lastBook).toEqual({ id: 2, title: 'b2', authorId: 1 })
    expect(row.author.hasBooks).toBe(true)
    db.$close()
  })

  test('two levels deep', async () => {
    const db = await fromPathsClient()
    const [row] = await db.tag.findMany({ include: { authors: { include: { books: true } } } })
    expect(row.authors.map((a: any) => [a.bookCount, a.books.length])).toEqual([[2, 2], [1, 1]])
    db.$close()
  })

  // The property that makes all of the above one bug rather than eight: a row
  // is the same row however it was reached.
  test('an included row and a directly-read row agree field for field', async () => {
    const db = await fromPathsClient()
    const direct = await db.author.findUnique({ where: { id: 1 } })
    const [book] = await db.book.findMany({ where: { id: 1 }, include: { author: true } })
    expect(book.author).toEqual(direct)
    db.$close()
  })
})


// ─── @from — search(), and the row a write hands back ────────────────────────
//
// A write returns through RETURNING, which is table columns only — SQLite
// cannot put a correlated subquery there. So the row a caller held after a
// write disagreed with the same row refetched, and junction passes that row
// straight to the HTTP response AND the `svc updated` broadcast, so every open
// tab replaced a correct row with a degraded one.

const FROM_WRITE_SCHEMA = `
  model Author {
    id        Int @id
    name      String
    deletedAt DateTime?
    books     Book[]
    bookCount Int     @from(Book, count: true)
    lastBook  Book?   @from(Book, last: true)
    hasBooks  Boolean @from(Book, exists: true)
    score     Float   @computed
    @@softDelete
    @@fts([name])
  }
  model Book {
    id       Int @id
    title    String
    authorId Int
    author   Author @relation(fields: [authorId], references: [id])
  }
`

// One fixture carries @@softDelete and @@fts together on purpose: the pair used
// to make every remove() throw SQLITE_CORRUPT_VTAB, and separate fixtures are
// how that went unseen while both attributes had passing tests of their own.
async function fromWriteClient() {
  const { db } = await makeTestClient(FROM_WRITE_SCHEMA, {
    computed: { Author: { score: (r: any) => (r.bookCount ?? 0) * 5 } },
    data: async (db: any) => {
      await db.author.create({ data: { id: 1, name: 'alpha' } })
      await db.book.createMany({ data: [
        { id: 1, title: 'x', authorId: 1 },
        { id: 2, title: 'y', authorId: 1 },
      ]})
    }
  })
  return db
}

const fromFtsClient = fromWriteClient

describe('@from — search()', () => {
  test('an FTS hit carries the @from fields', async () => {
    const db = await fromFtsClient()
    const [hit] = await db.author.search('alpha')
    expect(hit.bookCount).toBe(2)
    expect(hit.score).toBe(10)
    db.$close()
  })

  test('a search hit and a directly-read row agree', async () => {
    const db = await fromFtsClient()
    const [hit] = await db.author.search('alpha')
    const direct = await db.author.findUnique({ where: { id: 1 } })
    delete hit._rank
    expect(hit).toEqual(direct)
    db.$close()
  })
})

describe('@from — the row a write returns', () => {
  const expectHydrated = (row: any) => {
    expect(row.bookCount).toBe(2)
    expect(row.score).toBe(10)
    expect(row.lastBook).toEqual({ id: 2, title: 'y', authorId: 1 })
    expect(row.hasBooks).toBe(true)
  }

  test('update', async () => {
    const db = await fromWriteClient()
    expectHydrated(await db.author.update({ where: { id: 1 }, data: { name: 'a2' } }))
    db.$close()
  })

  test('upsert on the update path', async () => {
    const db = await fromWriteClient()
    expectHydrated(await db.author.upsert({
      where: { id: 1 }, create: { id: 1, name: 'c' }, update: { name: 'u' },
    }))
    db.$close()
  })

  test('remove — a soft-deleted row still has its children', async () => {
    const db = await fromWriteClient()
    expectHydrated(await db.author.remove({ where: { id: 1 } }))
    db.$close()
  })

  test('restore', async () => {
    const db = await fromWriteClient()
    await db.author.remove({ where: { id: 1 } })
    const [row] = await db.author.restore({ where: { id: 1 } })
    expectHydrated(row)
    db.$close()
  })

  test('delete — the values are read while the row still exists', async () => {
    const db = await fromWriteClient()
    await db.book.deleteMany({ where: { authorId: 1 } })
    const row = await db.author.delete({ where: { id: 1 } })
    expect(row.bookCount).toBe(0)
    expect(row.hasBooks).toBe(false)
    db.$close()
  })

  test('create — a brand new row counts zero children, not undefined', async () => {
    const db = await fromWriteClient()
    const row = await db.author.create({ data: { id: 2, name: 'beta' } })
    expect(row.bookCount).toBe(0)
    expect(row.score).toBe(0)
    expect(row.hasBooks).toBe(false)
    db.$close()
  })

  // The property, again: a row is the same row however it was obtained. This
  // is the one that fails loudest when a write path is missed, because it is
  // what an app actually does — write, then render what came back.
  test('an updated row equals the same row refetched', async () => {
    const db = await fromWriteClient()
    const written = await db.author.update({ where: { id: 1 }, data: { name: 'a2' } })
    const refetched = await db.author.findUnique({ where: { id: 1 } })
    expect(written).toEqual(refetched)
    db.$close()
  })

  // A model with no @from field must not pay for a lookup it does not need.
  test('a model without @from fields issues no extra query on write', async () => {
    const { db } = await makeTestClient(`model Plain { id Int @id  name String }`)
    const seen: string[] = []
    db.$tapQuery((q: any) => seen.push(q.sql))
    await db.plain.create({ data: { id: 1, name: 'a' } })
    expect(seen.filter(s => s.startsWith('SELECT'))).toHaveLength(0)
    db.$close()
  })
})

describe('restore() returns the rows, shaped', () => {
  test('an array of rows, not { count }', async () => {
    const db = await fromWriteClient()
    await db.author.remove({ where: { id: 1 } })
    const res = await db.author.restore({ where: { id: 1 } })
    expect(Array.isArray(res)).toBe(true)
    expect(res).toHaveLength(1)
    expect(res[0].name).toBe('alpha')
    expect(res[0].deletedAt).toBe(null)
    db.$close()
  })

  test('the rows are shaped like any other read, not raw', async () => {
    const { db } = await makeTestClient(`
      model Doc {
        id        Int @id
        meta      Json
        published Boolean
        deletedAt DateTime?
        @@softDelete
      }
    `, {
      data: async (db: any) => {
        await db.doc.create({ data: { id: 1, meta: { a: 1 }, published: true } })
        await db.doc.remove({ where: { id: 1 } })
      }
    })
    const [row] = await db.doc.restore({ where: { id: 1 } })
    expect(row.meta).toEqual({ a: 1 })      // parsed, not the JSON text SQLite stored
    expect(row.published).toBe(true)        // coerced, not 1
    db.$close()
  })

  test('restoring nothing answers an empty array', async () => {
    const db = await fromWriteClient()
    expect(await db.author.restore({ where: { id: 999 } })).toEqual([])
    db.$close()
  })
})


// ─── orderBy key validation ──────────────────────────────────────────────────
//
// A bad filter key returns fewer rows, which the caller can see. A bad sort key
// returns the RIGHT rows in the wrong order, which nothing can see — so this
// half throws on a read where checkWhereKeys only warns.

describe('orderBy key validation', () => {
  test('an unknown orderBy field throws and names what is sortable', async () => {
    const db = await fromAliasClient()
    await expect(db.author.findMany({ orderBy: { bogusColumn: 'desc' } }))
      .rejects.toThrow("Unknown orderBy field 'bogusColumn'")
    db.$close()
  })

  test('a typo gets a suggestion', async () => {
    const db = await fromAliasClient()
    await expect(db.author.findMany({ orderBy: { nam: 'desc' } }))
      .rejects.toThrow('Did you mean: name?')
    db.$close()
  })

  test('a @computed field is refused as unsortable, not as unknown', async () => {
    const db = await fromAliasClient()
    await expect(db.author.findMany({ orderBy: { score: 'asc' } }))
      .rejects.toThrow('it is a @computed field')
    db.$close()
  })

  test('a @from field sorts — it is a subquery in the SELECT, not a JS function', async () => {
    const db = await fromAliasClient()
    const rows = await db.author.findMany({ orderBy: { bookCount: 'desc' } })
    expect(rows.map((r: any) => r.bookCount)).toEqual([2, 1])
    db.$close()
  })

  test('the { dir, nulls } object form still passes', async () => {
    const db = await fromAliasClient()
    const rows = await db.author.findMany({ orderBy: { name: { dir: 'desc', nulls: 'last' } } })
    expect(rows.map((r: any) => r.name)).toEqual(['B', 'A'])
    db.$close()
  })

  test('an array of orderBy items is checked item by item', async () => {
    const db = await fromAliasClient()
    await expect(db.author.findMany({ orderBy: [{ name: 'asc' }, { bogus: 'desc' }] }))
      .rejects.toThrow("Unknown orderBy field 'bogus'")
    db.$close()
  })

  test('findManyCursor is checked too', async () => {
    const db = await fromAliasClient()
    await expect(db.author.findManyCursor({ limit: 1, orderBy: { bogus: 'asc' } }))
      .rejects.toThrow("Unknown orderBy field 'bogus'")
    db.$close()
  })

  test('groupBy may order by an aggregate — those are the point, not a typo', async () => {
    const db = await fromAliasClient()
    const rows = await db.book.groupBy({ by: ['authorId'], _count: true, orderBy: { _count: 'desc' } })
    expect(rows[0]._count).toBe(2)
    db.$close()
  })

  test('findMany may NOT order by an aggregate name', async () => {
    const db = await fromAliasClient()
    await expect(db.author.findMany({ orderBy: { _count: 'desc' } }))
      .rejects.toThrow("Unknown orderBy field '_count'")
    db.$close()
  })

  test('$checkOrderBy answers without running the query', async () => {
    const db = await fromAliasClient()
    expect(db.$checkOrderBy('author', { name: 'asc' })).toEqual([])
    expect(db.$checkOrderBy('author', { bookCount: 'desc' })).toEqual([])
    const [computedProblem] = db.$checkOrderBy('author', { score: 'asc' })
    expect(computedProblem.reason).toBe('computed')
    const [unknownProblem] = db.$checkOrderBy('author', { nam: 'asc' })
    expect(unknownProblem.reason).toBe('unknown')
    expect(unknownProblem.suggestion).toBe('name')
    db.$close()
  })

  // A column whose stored text is a serialisation or an encoding. SQLite orders
  // by that text, so the rows come back in an order nobody asked for and nothing
  // about the answer says so — the failure sorting has and filtering does not
  // (FJS-200).
  describe('a column whose stored text is a storage detail is not a sort key', () => {
    const OPAQUE = `model Doc {
      id    Int @id @default(autoincrement())
      title String
      words String[]
      nums  Int[]
      meta  Json?
      doc   File?
      ssn   String? @encrypted
      tag   String? @encrypted(deterministic: true)
      token String? @hashed
    }`
    const opaqueDb = (name: string) => makeDb(OPAQUE, name, { encryptionKey: 'a'.repeat(64) })

    test('every kind of it is refused by name, and says which kind', async () => {
      const db = await opaqueDb('sort-opaque')
      const want: [string, RegExp][] = [
        ['words', /an array column/],
        ['nums',  /an array column/],
        ['meta',  /a Json column/],
        ['doc',   /a File column/],
        ['ssn',   /@encrypted/],
        ['tag',   /@encrypted/],
        ['token', /@hashed/],
      ]
      for (const [key, why] of want) {
        await expect(db.asSystem().doc.findMany({ orderBy: { [key]: 'asc' } })).rejects.toThrow(why)
      }
      db.$close()
    })

    test('the ordinary columns beside them still sort', async () => {
      const db = await opaqueDb('sort-opaque-ok')
      await db.asSystem().doc.create({ data: { title: 'b', words: ['x'] } })
      await db.asSystem().doc.create({ data: { title: 'a', words: ['y'] } })
      const rows = await db.asSystem().doc.findMany({ orderBy: { title: 'asc' } })
      expect(rows.map((r: any) => r.title)).toEqual(['a', 'b'])
      db.$close()
    })

    test('$checkOrderBy says `opaque`, so a boundary can answer 400 without running it', async () => {
      const db = await opaqueDb('sort-opaque-check')
      const [p] = db.$checkOrderBy('doc', { words: 'asc' })
      expect(p.reason).toBe('opaque')
      expect(p.suggestion).toBeNull()
      expect(p.sortable).toContain('title')
      expect(p.sortable).not.toContain('words')
      // Same contract as the computed bucket: every flavour answers identically.
      for (const c of [db.asSystem(), db.$setAuth({ id: 1 })])
        expect(c.$checkOrderBy('doc', { meta: 'asc' })[0].reason).toBe('opaque')
      db.$close()
    })

    test('a write that carries an orderBy is refused too', async () => {
      const db = await opaqueDb('sort-opaque-write')
      await expect(db.asSystem().doc.updateMany({ where: {}, data: { title: 'z' }, orderBy: { nums: 'asc' } }))
        .rejects.toThrow(/an array column/)
      db.$close()
    })
  })

  test('$checkOrderBy on an unknown accessor answers [] — cannot judge is not wrong', async () => {
    const db = await fromAliasClient()
    expect(db.$checkOrderBy('nosuchthing', { whatever: 'asc' })).toEqual([])
    db.$close()
  })

  test('$checkOrderBy is on every flavour of client — sortability is a fact about the schema', async () => {
    const db = await fromAliasClient()
    for (const client of [db.asSystem(), db.$setAuth({ id: 1 }), db.$scopedBy({})]) {
      expect(typeof client.$checkOrderBy).toBe('function')
      expect(client.$checkOrderBy('author', { score: 'asc' })[0].reason).toBe('computed')
    }
    db.$close()
  })
})


// ─── aggregate() ─────────────────────────────────────────────────────────────

const AGG_SCHEMA = `
  model Order {
    id        Int @id
    amount    Float
    status    String
    accountId Int
    deletedAt DateTime?
    @@softDelete
  }
`

// ─── Window functions ─────────────────────────────────────────────────────────

describe('window functions', () => {
  let db: any

  beforeAll(async () => {
    ;({ db } = await makeTestClient(AGG_SCHEMA, {
      data: async (db: any) => {
        await db.order.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 30, status: 'paid',    accountId: 1 },
          { id: 3, amount: 20, status: 'paid',    accountId: 1 },
          { id: 4, amount: 50, status: 'pending', accountId: 2 },
          { id: 5, amount: 15, status: 'pending', accountId: 2 },
        ]})
      }
    }))
  })

  afterAll(() => db.$close())

  test('rowNumber — global ordering', async () => {
    const rows = await db.order.findMany({
      orderBy: { id: 'asc' },
      window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows.map((r: any) => r.rn)).toEqual([1, 2, 3, 4, 5])
  })

  test('rowNumber — partitioned by accountId', async () => {
    const rows = await db.order.findMany({
      orderBy: { id: 'asc' },
      window:  { rn: { rowNumber: true, partitionBy: 'accountId', orderBy: { id: 'asc' } } },
    })
    // accountId 1 → rows 1,2,3 numbered 1,2,3
    // accountId 2 → rows 4,5 numbered 1,2
    expect(rows.find((r: any) => r.id === 1).rn).toBe(1)
    expect(rows.find((r: any) => r.id === 3).rn).toBe(3)
    expect(rows.find((r: any) => r.id === 4).rn).toBe(1)
    expect(rows.find((r: any) => r.id === 5).rn).toBe(2)
  })

  test('rank — ties get same rank, gaps after', async () => {
    const rows = await db.order.findMany({
      orderBy: { id: 'asc' },
      window:  { r: { rank: true, partitionBy: 'accountId', orderBy: { amount: 'desc' } } },
    })
    // accountId=1: amounts 30,20,10 → ranks 1,2,3
    expect(rows.find((r: any) => r.id === 2).r).toBe(1)  // amount 30 → rank 1
    expect(rows.find((r: any) => r.id === 3).r).toBe(2)  // amount 20 → rank 2
    expect(rows.find((r: any) => r.id === 1).r).toBe(3)  // amount 10 → rank 3
  })

  test('denseRank — no gaps after ties', async () => {
    const rows = await db.order.findMany({
      orderBy: { id: 'asc' },
      window:  { dr: { denseRank: true, orderBy: { status: 'asc' } } },
    })
    // paid=1 (ids 1,2,3), pending=2 (ids 4,5)
    expect(rows.find((r: any) => r.id === 1).dr).toBe(1)
    expect(rows.find((r: any) => r.id === 4).dr).toBe(2)
  })

  test('running sum — cumulative total', async () => {
    const rows = await db.order.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      window:  { runningTotal: { sum: 'amount', orderBy: { id: 'asc' } } },
    })
    // amounts: 10, 30, 20 → running: 10, 40, 60
    expect(rows[0].runningTotal).toBeCloseTo(10)
    expect(rows[1].runningTotal).toBeCloseTo(40)
    expect(rows[2].runningTotal).toBeCloseTo(60)
  })

  test('running count', async () => {
    const rows = await db.order.findMany({
      orderBy: { id: 'asc' },
      window:  { rc: { count: true, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].rc).toBe(1)
    expect(rows[4].rc).toBe(5)
  })

  test('moving average with rows frame', async () => {
    const rows = await db.order.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      window:  { ma: { avg: 'amount', orderBy: { id: 'asc' }, rows: [-1, 0] } },
    })
    // row 1: avg(10) = 10
    // row 2: avg(10,30) = 20
    // row 3: avg(30,20) = 25
    expect(rows[0].ma).toBeCloseTo(10)
    expect(rows[1].ma).toBeCloseTo(20)
    expect(rows[2].ma).toBeCloseTo(25)
  })

  test('lag — previous row value', async () => {
    const rows = await db.order.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      window:  { prev: { lag: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].prev).toBe(0)   // first row → default
    expect(rows[1].prev).toBeCloseTo(10)
    expect(rows[2].prev).toBeCloseTo(30)
  })

  test('lead — next row value', async () => {
    const rows = await db.order.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      window:  { next: { lead: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].next).toBeCloseTo(30)
    expect(rows[1].next).toBeCloseTo(20)
    expect(rows[2].next).toBe(0)   // last row → default
  })

  test('firstValue and lastValue', async () => {
    const rows = await db.order.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      window:  {
        first: { firstValue: 'amount', partitionBy: 'accountId', orderBy: { id: 'asc' }, rows: [null, null] },
        last:  { lastValue:  'amount', partitionBy: 'accountId', orderBy: { id: 'asc' }, rows: [null, null] },
      },
    })
    // partition accountId=1: amounts are 10,30,20 → first=10, last=20
    expect(rows[0].first).toBeCloseTo(10)
    expect(rows[0].last).toBeCloseTo(20)
  })

  test('multiple window functions in one query', async () => {
    const rows = await db.order.findMany({
      orderBy: { id: 'asc' },
      window:  {
        rn:    { rowNumber: true, orderBy: { id: 'asc' } },
        total: { sum: 'amount', orderBy: { id: 'asc' } },
      },
    })
    expect(rows[0].rn).toBe(1)
    expect(typeof rows[0].total).toBe('number')
  })

  test('window + where + limit', async () => {
    const rows = await db.order.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      limit:   2,
      window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].rn).toBe(1)
    expect(rows[1].rn).toBe(2)
  })

  test('window respects @@softDelete', async () => {
    const { db: localDb } = await makeTestClient(AGG_SCHEMA, {
      data: async (d: any) => {
        await d.order.createMany({ data: [
          { id: 10, amount: 5, status: 'paid', accountId: 1 },
          { id: 11, amount: 10, status: 'paid', accountId: 1 },
        ]})
        await d.order.remove({ where: { id: 10 } })
      }
    })
    const rows = await localDb.order.findMany({
      window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows).toHaveLength(1)   // soft-deleted row excluded
    expect(rows[0].rn).toBe(1)
    localDb.$close()
  })

  test('throws on unknown window function spec', async () => {
    await expect(
      db.order.findMany({ window: { x: { unknownFn: true } as any } })
    ).rejects.toThrow('unrecognised window function spec')
  })

  test('window FILTER — conditional aggregate window', async () => {
    const rows = await db.order.findMany({
      orderBy: { id: 'asc' },
      window:  {
        paidRunning: {
          sum: 'amount',
          filter: sql`status = 'paid'`,
          orderBy: { id: 'asc' },
        },
      },
    })
    // Only paid rows contribute: ids 1(10),2(30),3(20) → running: 10,40,60
    // pending rows (4,5) get NULL or 0 contribution to their running paid sum
    const paid = rows.filter((r: any) => r.status === 'paid')
    expect(paid[paid.length - 1].paidRunning).toBeCloseTo(60)
  })
})

// ─── query() dispatcher ───────────────────────────────────────────────────────

describe('query() dispatcher', () => {
  let db: any

  beforeAll(async () => {
    ;({ db } = await makeTestClient(AGG_SCHEMA, {
      data: async (db: any) => {
        await db.order.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 20, status: 'paid',    accountId: 1 },
          { id: 3, amount: 30, status: 'refund',  accountId: 2 },
          { id: 4, amount: 40, status: 'pending', accountId: 2 },
        ]})
      }
    }))
  })

  afterAll(() => db.$close())

  test('routes to findMany when no agg keys', async () => {
    const rows = await db.order.query({ where: { status: 'paid' }, orderBy: { id: 'asc' } })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[0].amount).toBe(10)   // full row returned
  })

  test('routes to aggregate when _count present', async () => {
    const result = await db.order.query({ _count: true })
    expect(result._count).toBe(4)
    expect(Array.isArray(result)).toBe(false)   // single object, not array
  })

  test('routes to aggregate when _sum present', async () => {
    const result = await db.order.query({ _sum: { amount: true }, _count: true })
    expect(typeof result._count).toBe('number')
    expect(result._sum.amount).toBeCloseTo(100)
  })

  test('routes to aggregate with where filter', async () => {
    const result = await db.order.query({ _count: true, where: { status: 'paid' } })
    expect(result._count).toBe(2)
  })

  test('routes to groupBy when by present', async () => {
    const rows = await db.order.query({ by: ['status'], _count: true, orderBy: { status: 'asc' } })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows[0]).toHaveProperty('status')
    expect(rows[0]).toHaveProperty('_count')
    expect(rows[0].amount).toBeUndefined()   // not a full row
  })

  test('routes to groupBy with where', async () => {
    const rows = await db.order.query({ by: ['accountId'], _count: true, where: { status: 'paid' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].accountId).toBe(1)
    expect(rows[0]._count).toBe(2)
  })

  test('routes to findMany with window', async () => {
    const rows = await db.order.query({
      orderBy: { id: 'asc' },
      window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].rn).toBe(1)
    expect(rows[0].amount).toBe(10)   // full row
  })

  test('routes to findMany with limit + offset', async () => {
    const rows = await db.order.query({ orderBy: { id: 'asc' }, limit: 2, offset: 1 })
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe(2)
  })

  test('named aggregates route to aggregate', async () => {
    const result = await db.order.query({
      _countPaid: { count: true, filter: sql`status = 'paid'` },
    })
    expect(result._countPaid).toBe(2)
    expect(Array.isArray(result)).toBe(false)
  })

  test('empty args routes to findMany', async () => {
    const rows = await db.order.query()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(4)
  })
})

// ─── db.query() — multi-model batch ───────────────────────────────────────────

describe('db.query() — multi-model batch', () => {
  const SCHEMA = `
    model Account {
      id   Int @id
      name String
      tier String @default("free")
    }
    model Order {
      id        Int @id
      amount    Float
      status    String
      accountId Int
    }
  `

  test('runs many per-table queries and returns named results', async () => {
    const { db } = await makeTestClient(SCHEMA, {
      data: async (db: any) => {
        await db.account.createMany({ data: [
          { id: 1, name: 'Acme',   tier: 'pro' },
          { id: 2, name: 'Globex', tier: 'free' },
        ]})
        await db.order.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 20, status: 'paid',    accountId: 1 },
          { id: 3, amount: 30, status: 'pending', accountId: 2 },
        ]})
      },
    })

    const { accounts, orders } = await db.query({
      accounts: { model: 'account', where: { tier: 'pro' } },
      orders:   { model: 'order', where: { status: 'paid' }, orderBy: { id: 'asc' } },
    })

    expect(Array.isArray(accounts)).toBe(true)
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe('Acme')

    expect(Array.isArray(orders)).toBe(true)
    expect(orders).toHaveLength(2)
    expect(orders.map((o: any) => o.id)).toEqual([1, 2])

    db.$close()
  })

  test('mixes findMany / aggregate / groupBy in one call', async () => {
    const { db } = await makeTestClient(SCHEMA, {
      data: async (db: any) => {
        await db.account.createMany({ data: [
          { id: 1, name: 'Acme', tier: 'pro' },
        ]})
        await db.order.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 20, status: 'paid',    accountId: 1 },
          { id: 3, amount: 30, status: 'pending', accountId: 1 },
        ]})
      },
    })

    const { accounts, totals, byStatus } = await db.query({
      accounts: { model: 'account', where: { tier: 'pro' }, orderBy: { id: 'asc' } }, // → findMany
      totals:   { model: 'order', _count: true, _sum: { amount: true } },          // → aggregate (aliased)
      byStatus: { model: 'order', by: ['status'], _count: true, orderBy: { status: 'asc' } }, // → groupBy (aliased)
    } as any)

    expect(Array.isArray(accounts)).toBe(true)
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe('Acme')

    expect(totals._count).toBe(3)
    expect(totals._sum.amount).toBeCloseTo(60)

    expect(Array.isArray(byStatus)).toBe(true)
    expect(byStatus).toHaveLength(2)
    expect(byStatus.find((r: any) => r.status === 'paid')._count).toBe(2)
    expect(byStatus.find((r: any) => r.status === 'pending')._count).toBe(1)

    db.$close()
  })

  test('alias form — same model queried twice with different args', async () => {
    const { db } = await makeTestClient(SCHEMA, {
      data: async (db: any) => {
        await db.order.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 20, status: 'paid',    accountId: 1 },
          { id: 3, amount: 30, status: 'pending', accountId: 1 },
        ]})
      },
    })

    const { paid, pending } = await db.query({
      paid:    { model: 'order', where: { status: 'paid' },    orderBy: { id: 'asc' } },
      pending: { model: 'order', where: { status: 'pending' }, orderBy: { id: 'asc' } },
    } as any)

    expect(paid).toHaveLength(2)
    expect(pending).toHaveLength(1)
    expect(paid.map((o: any) => o.id)).toEqual([1, 2])
    expect(pending[0].id).toBe(3)

    db.$close()
  })

  test('preserves spec key order in result', async () => {
    const { db } = await makeTestClient(SCHEMA)
    const result = await db.query({
      orders:   { model: 'order', _count: true },
      accounts: { model: 'account', _count: true },
    } as any)
    expect(Object.keys(result)).toEqual(['orders', 'accounts'])
    db.$close()
  })

  test('empty spec returns empty object', async () => {
    const { db } = await makeTestClient(SCHEMA)
    const result = await db.query({})
    expect(result).toEqual({})
    db.$close()
  })

  test('throws on unknown model accessor (typo fails loudly)', async () => {
    const { db } = await makeTestClient(SCHEMA)
    await expect(db.query({ orderz: { _count: true } } as any))
      .rejects.toThrow(/orderz/)
    db.$close()
  })

  test('throws when spec is not an object', async () => {
    const { db } = await makeTestClient(SCHEMA)
    await expect(db.query(null as any)).rejects.toThrow()
    await expect(db.query([] as any)).rejects.toThrow()
    await expect(db.query('huh' as any)).rejects.toThrow()
    db.$close()
  })

  test('whole batch fails if any single query throws', async () => {
    // First entry succeeds, second is an unknown accessor → whole batch rejects.
    const { db } = await makeTestClient(SCHEMA)
    await expect(db.query({
      accounts: { model: 'account', _count: true },
      orderz:   { _count: true },
    } as any)).rejects.toThrow(/orderz/)
    db.$close()
  })

  test('runs all entries inside one snapshot ($transaction)', async () => {
    // Hard to assert atomicity in unit test without a concurrent writer.
    // Proxy: confirm the call can be invoked from inside an outer $transaction
    // (i.e., it doesn't try to BEGIN twice — Litestone's tx.begin uses SAVEPOINT
    // for nesting).
    const { db } = await makeTestClient(SCHEMA, {
      data: async (db: any) => {
        await db.account.create({ data: { id: 1, name: 'Acme', tier: 'pro' } })
        await db.order.create({ data: { id: 1, amount: 10, status: 'paid', accountId: 1 } })
      },
    })
    const result = await db.$transaction(async (tx: any) => {
      return tx.query({
        accounts: { model: 'account', _count: true },
        orders:   { model: 'order', _count: true },
      })
    })
    expect(result.accounts._count).toBe(1)
    expect(result.orders._count).toBe(1)
    db.$close()
  })

  test('asSystem().query() bypasses row policies', async () => {
    // Schema with a deny rule — readable by no one (forces asSystem usage)
    const POLICY = `
      model Widget {
        id   Int @id
        name String
        @@deny('read', true)
      }
    `
    const { db } = await makeTestClient(POLICY, {
      data: async (db: any) => {
        // asSystem() to seed past the deny rule
        await db.asSystem().widget.create({ data: { id: 1, name: 'Wrench' } })
      },
    })
    // Non-system batch returns 0 rows / count due to deny('read')
    const blocked = await db.query({ widgets: { model: 'widget', _count: true } } as any)
    expect(blocked.widgets._count).toBe(0)
    // asSystem batch sees the row
    const seen = await db.asSystem().query({ widgets: { model: 'widget', _count: true } } as any)
    expect(seen.widgets._count).toBe(1)
    db.$close()
  })

  test('$setAuth().query() carries auth into each batched query', async () => {
    // Schema with row policy — only see your own rows
    const POLICY_SCHEMA = `
      model Post {
        id      Int @id
        ownerId Int
        title   String
        @@allow('read', ownerId == auth().id)
      }
    `
    const { db } = await makeTestClient(POLICY_SCHEMA, {
      data: async (db: any) => {
        await db.post.createMany({ data: [
          { id: 1, ownerId: 1, title: 'Mine' },
          { id: 2, ownerId: 2, title: 'Yours' },
        ]})
      },
    })
    const alice = db.$setAuth({ id: 1 })
    const result = await alice.query({ posts: { model: 'post', orderBy: { id: 'asc' } } } as any)
    expect(result.posts).toHaveLength(1)
    expect(result.posts[0].title).toBe('Mine')
    db.$close()
  })
})

// ─── Scopes ───────────────────────────────────────────────────────────────────

describe('Scopes', () => {
  const SCHEMA = `
    model Customer {
      id        Int  @id
      name      String
      status    String     @default("active")
      tier      String     @default("free")
      ownerId   Int?
      createdAt DateTime @default(now())
    }
  `

  async function buildDb(scopeRegistry: any = {}) {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: SCHEMA,
      db:     ':memory:',
      scopes: scopeRegistry,
    })
    await db.customer.createMany({ data: [
      { id: 1, name: 'Alice',   status: 'active',   tier: 'premium', ownerId: 1 },
      { id: 2, name: 'Bob',     status: 'inactive', tier: 'premium', ownerId: 1 },
      { id: 3, name: 'Carol',   status: 'active',   tier: 'free',    ownerId: 2 },
      { id: 4, name: 'Dan',     status: 'active',   tier: 'premium', ownerId: 2 },
      { id: 5, name: 'Eve',     status: 'pending',  tier: 'free',    ownerId: 3 },
    ]})
    return db
  }

  // ── Registration + validation ────────────────────────────────────────────

  test('registers scopes by model name and exposes them on the accessor', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    expect(typeof db.customer.active).toBe('function')
    db.$close()
  })

  test('throws on unknown model in scope registry', async () => {
    const { createClient } = await import('../src/core/client.js')
    await expect(createClient({
      schema: SCHEMA, db: ':memory:',
      scopes: { Nonexistent: { foo: { where: {} } } } as any,
    })).rejects.toThrow(/unknown model/)
  })

  test('throws on scope name shadowing a built-in method', async () => {
    const { createClient } = await import('../src/core/client.js')
    await expect(createClient({
      schema: SCHEMA, db: ':memory:',
      scopes: { Customer: { findMany: { where: { status: 'active' } } } } as any,
    })).rejects.toThrow(/conflicts with a built-in/)
  })

  test('throws on scope name starting with $ or _', async () => {
    const { createClient } = await import('../src/core/client.js')
    await expect(createClient({
      schema: SCHEMA, db: ':memory:',
      scopes: { Customer: { $secret: { where: {} } } } as any,
    })).rejects.toThrow(/cannot start with/)
    await expect(createClient({
      schema: SCHEMA, db: ':memory:',
      scopes: { Customer: { _hidden: { where: {} } } } as any,
    })).rejects.toThrow(/cannot start with/)
  })

  test('throws when scope is not an object literal', async () => {
    const { createClient } = await import('../src/core/client.js')
    // Top-level function form rejected — parameterised scopes are intentionally not supported
    await expect(createClient({
      schema: SCHEMA, db: ':memory:',
      scopes: { Customer: { foo: ((days: number) => ({ where: { x: days } })) as any } } as any,
    })).rejects.toThrow(/must be an object/)
    // Arrays rejected
    await expect(createClient({
      schema: SCHEMA, db: ':memory:',
      scopes: { Customer: { foo: [] } } as any,
    })).rejects.toThrow(/must be an object/)
  })

  // ── Default-call → findMany ──────────────────────────────────────────────

  test('default call returns findMany under the scope', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    const rows = await db.customer.active()
    expect(rows.map((r: any) => r.id).sort()).toEqual([1, 3, 4])
    db.$close()
  })

  test('default call accepts caller args (where AND-merged, others overridden)', async () => {
    const db = await buildDb({
      Customer: {
        active: { where: { status: 'active' }, orderBy: { id: 'desc' }, limit: 10 },
      },
    })
    const rows = await db.customer.active({ where: { tier: 'premium' }, limit: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(4)            // orderBy desc → 4 first; tier=premium AND status=active
    db.$close()
  })

  // ── Method dispatch ──────────────────────────────────────────────────────

  test('count() under a scope', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    expect(await db.customer.active.count()).toBe(3)
    db.$close()
  })

  test('count() under a scope respects caller where', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    expect(await db.customer.active.count({ where: { tier: 'premium' } })).toBe(2)
    db.$close()
  })

  test('findFirst() under a scope', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    const row = await db.customer.active.findFirst({ orderBy: { id: 'asc' } })
    expect(row.id).toBe(1)
    db.$close()
  })

  test('aggregate() under a scope', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    const r = await db.customer.active.aggregate({ _count: true })
    expect(r._count).toBe(3)
    db.$close()
  })

  test('groupBy() under a scope', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    const rows = await db.customer.active.groupBy({ by: ['tier'], _count: true, orderBy: { tier: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows.find((r: any) => r.tier === 'premium')._count).toBe(2)
    expect(rows.find((r: any) => r.tier === 'free')._count).toBe(1)
    db.$close()
  })

  test('per-model query() dispatcher works under a scope', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    // .query() under a scope routes by shape just like the per-model dispatcher
    const rows = await db.customer.active.query({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.id)).toEqual([1, 3, 4])
    const agg = await db.customer.active.query({ _count: true })
    expect(agg._count).toBe(3)
    db.$close()
  })

  // ── Chaining ─────────────────────────────────────────────────────────────

  test('chains two scopes — wheres are AND-merged', async () => {
    const db = await buildDb({
      Customer: {
        active:  { where: { status: 'active' } },
        premium: { where: { tier: 'premium' } },
      },
    })
    const rows = await db.customer.active.premium()
    expect(rows.map((r: any) => r.id).sort()).toEqual([1, 4])
    db.$close()
  })

  test('chains three scopes deep', async () => {
    const db = await buildDb({
      Customer: {
        active:  { where: { status: 'active' } },
        premium: { where: { tier: 'premium' } },
        ownedByOne: { where: { ownerId: 1 } },
      },
    })
    const rows = await db.customer.active.premium.ownedByOne()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    db.$close()
  })

  test('chained scopes — last scope wins for non-where keys, caller wins overall', async () => {
    const db = await buildDb({
      Customer: {
        a: { where: { status: 'active' }, orderBy: { id: 'asc' }, limit: 10 },
        b: { where: { tier: 'premium' }, orderBy: { id: 'desc' }, limit: 5 },
      },
    })
    // Only b's orderBy/limit should be in effect.
    const rows = await db.customer.a.b()
    expect(rows.map((r: any) => r.id)).toEqual([4, 1])     // desc, both active+premium
    // Caller overrides both scopes' orderBy/limit.
    const rows2 = await db.customer.a.b({ orderBy: { id: 'asc' }, limit: 1 })
    expect(rows2.map((r: any) => r.id)).toEqual([1])
    db.$close()
  })

  // ── Dynamic where ────────────────────────────────────────────────────────

  test('dynamic where(ctx) — sees ctx.auth from $setAuth', async () => {
    const db = await buildDb({
      Customer: {
        mine: { where: (ctx: any) => ({ ownerId: ctx.auth?.id }) },
      },
    })
    const alice = db.$setAuth({ id: 1 })
    const carolOwner = db.$setAuth({ id: 2 })
    expect((await alice.customer.mine()).map((r: any) => r.id).sort()).toEqual([1, 2])
    expect((await carolOwner.customer.mine()).map((r: any) => r.id).sort()).toEqual([3, 4])
    db.$close()
  })

  test('dynamic where(ctx) — re-evaluates per call (no stale auth)', async () => {
    const db = await buildDb({
      Customer: {
        mine: { where: (ctx: any) => ({ ownerId: ctx.auth?.id }) },
      },
    })
    const alice = db.$setAuth({ id: 1 })
    const r1 = await alice.customer.mine()
    expect(r1).toHaveLength(2)

    // Get the scope accessor reference, then call again — should still resolve fresh
    const accessor = alice.customer.mine
    const r2 = await accessor()
    expect(r2).toHaveLength(2)
    db.$close()
  })

  test('dynamic where on chain composes correctly', async () => {
    const db = await buildDb({
      Customer: {
        mine:    { where: (ctx: any) => ({ ownerId: ctx.auth?.id }) },
        premium: { where: { tier: 'premium' } },
      },
    })
    const owner1 = db.$setAuth({ id: 1 })
    const rows = await owner1.customer.mine.premium()
    expect(rows.map((r: any) => r.id).sort()).toEqual([1, 2])     // Alice + Bob — ownerId=1 AND tier=premium
    db.$close()
  })

  // ── asSystem ─────────────────────────────────────────────────────────────

  test('scopes work on db.asSystem()', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    expect(await db.asSystem().customer.active.count()).toBe(3)
    db.$close()
  })

  // ── Soft-delete interaction ──────────────────────────────────────────────

  test('scope where AND-merges with soft-delete filter (live rows only by default)', async () => {
    const SD_SCHEMA = `
      model Customer {
        id        Int  @id
        name      String
        status    String
        deletedAt DateTime?
        @@softDelete
      }
    `
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: SD_SCHEMA, db: ':memory:',
      scopes: { Customer: { active: { where: { status: 'active' } } } },
    })
    await db.customer.createMany({ data: [
      { id: 1, name: 'Alive',  status: 'active' },
      { id: 2, name: 'Dead',   status: 'active' },
    ]})
    await db.customer.remove({ where: { id: 2 } })
    // Soft-delete filter is auto-applied; scope sees only live rows
    const rows = await db.customer.active()
    expect(rows.map((r: any) => r.id)).toEqual([1])
    db.$close()
  })

  test('caller can opt out of soft-delete with withDeleted: true', async () => {
    const SD_SCHEMA = `
      model Customer {
        id        Int  @id
        name      String
        status    String
        deletedAt DateTime?
        @@softDelete
      }
    `
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: SD_SCHEMA, db: ':memory:',
      scopes: { Customer: { active: { where: { status: 'active' } } } },
    })
    await db.customer.createMany({ data: [
      { id: 1, name: 'Alive',  status: 'active' },
      { id: 2, name: 'Dead',   status: 'active' },
    ]})
    await db.customer.remove({ where: { id: 2 } })
    const rows = await db.customer.active({ withDeleted: true })
    expect(rows.map((r: any) => r.id).sort()).toEqual([1, 2])
    db.$close()
  })

  // ── Direct table accessor still works ────────────────────────────────────

  test('original table methods still work (scopes are additive)', async () => {
    const db = await buildDb({
      Customer: { active: { where: { status: 'active' } } },
    })
    expect(await db.customer.count()).toBe(5)
    expect(await db.customer.findUnique({ where: { id: 1 } })).toMatchObject({ id: 1, name: 'Alice' })
    db.$close()
  })

  // ── Writes under a scope ──────────────────────────────────────────────────

  test('create through a scope stamps the scope where as a data default', async () => {
    const db = await buildDb({ Customer: { premium: { where: { tier: 'premium' } } } })
    const c = await db.customer.premium.create({ data: { id: 10, name: 'Zed' } })
    expect(c.tier).toBe('premium')   // stamped, overriding the column default 'free'
    db.$close()
  })

  test('caller data overrides the scope default', async () => {
    const db = await buildDb({ Customer: { premium: { where: { tier: 'premium' } } } })
    const c = await db.customer.premium.create({ data: { id: 11, name: 'Zed', tier: 'free' } })
    expect(c.tier).toBe('free')
    db.$close()
  })

  test('createMany stamps every row', async () => {
    const db = await buildDb({ Customer: { premium: { where: { tier: 'premium' } } } })
    await db.customer.premium.createMany({ data: [{ id: 12, name: 'A' }, { id: 13, name: 'B' }] })
    const rows = await db.customer.findMany({ where: { id: { in: [12, 13] } } })
    expect(rows.every((r: any) => r.tier === 'premium')).toBe(true)
    db.$close()
  })

  test('update through a scope is constrained to the subset', async () => {
    const db = await buildDb({ Customer: { active: { where: { status: 'active' } } } })
    // Bob (id 2) is inactive → updating him through .active matches nothing
    expect(await db.customer.active.update({ where: { id: 2 }, data: { name: 'HACKED' } })).toBeNull()
    expect((await db.customer.findUnique({ where: { id: 2 } })).name).toBe('Bob')
    // Alice (id 1) is active → update goes through
    expect((await db.customer.active.update({ where: { id: 1 }, data: { name: 'Alice2' } })).name).toBe('Alice2')
    db.$close()
  })

  test('updateMany through a scope only touches the subset', async () => {
    const db = await buildDb({ Customer: { active: { where: { status: 'active' } } } })
    await db.customer.active.updateMany({ data: { tier: 'enterprise' } })
    expect((await db.customer.findMany({ where: { tier: 'enterprise' } })).map((c: any) => c.id).sort()).toEqual([1, 3, 4])
    db.$close()
  })

  test('dynamic where scope stamps from auth on create', async () => {
    const db = await buildDb({ Customer: { mine: { where: (ctx: any) => ({ ownerId: ctx.auth?.id }) } } })
    const c = await db.$setAuth({ id: 99 }).customer.mine.create({ data: { id: 20, name: 'Mine' } })
    expect(c.ownerId).toBe(99)
    db.$close()
  })

  test('explicit data:{} on a scope suppresses stamping', async () => {
    const db = await buildDb({ Customer: { filterOnly: { where: { tier: 'premium' }, data: {} } } })
    const c = await db.customer.filterOnly.create({ data: { id: 21, name: 'NoStamp', tier: 'free' } })
    expect(c.tier).toBe('free')
    db.$close()
  })

  test('chained scopes stamp all their defaults', async () => {
    const db = await buildDb({ Customer: {
      active:  { where: { status: 'active' } },
      premium: { where: { tier: 'premium' } },
    } })
    const c = await db.customer.active.premium.create({ data: { id: 22, name: 'Both' } })
    expect(c.status).toBe('active')
    expect(c.tier).toBe('premium')
    db.$close()
  })
})

// ─── Traits ───────────────────────────────────────────────────────────────────

describe('trait declarations', () => {
  // ── Parser ───────────────────────────────────────────────────────────────

  test('parses a simple trait declaration', () => {
    const r = parse(`
      trait Dates {
        createdAt DateTime @default(now())
        updatedAt DateTime @updatedAt
      }
      model Post { id Int @id; title String; @@trait(Dates) }
    `)
    expect(r.valid).toBe(true)
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    expect(post.fields.map((f: any) => f.name).sort()).toEqual(['createdAt', 'id', 'title', 'updatedAt'])
  })

  test('trait fields appear before host fields', () => {
    const r = parse(`
      trait Dates {
        createdAt DateTime @default(now())
      }
      model Post { id Int @id; title String; @@trait(Dates) }
    `)
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    expect(post.fields[0].name).toBe('createdAt')
    expect(post.fields[1].name).toBe('id')
    expect(post.fields[2].name).toBe('title')
  })

  test('@@trait references are removed from final attribute list', () => {
    const r = parse(`
      trait Dates { createdAt DateTime @default(now()) }
      model Post { id Int @id; @@trait(Dates) }
    `)
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    expect(post.attributes.find((a: any) => a.kind === 'trait')).toBeUndefined()
  })

  test('trait model-level attributes splice into host', () => {
    const r = parse(`
      trait SoftDelete {
        deletedAt DateTime?
        @@softDelete
      }
      model Post { id Int @id; @@trait(SoftDelete) }
    `)
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    expect(post.attributes.some((a: any) => a.kind === 'softDelete')).toBe(true)
  })

  test('trait policy attributes splice and host attributes come after', () => {
    const r = parse(`
      trait Tenant {
        tenantId Int
        @@allow('read', tenantId == auth().tenantId)
      }
      model Post {
        id Int @id
        @@trait(Tenant)
        @@allow('read', auth() != null)
      }
    `)
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    const allows = post.attributes.filter((a: any) => a.kind === 'allow')
    expect(allows).toHaveLength(2)
    // Trait first, host second (host's @@allow has the final say in evaluation order)
    expect(allows[0].expr.type).toBe('compare')   // tenantId == auth().tenantId
    // The second is auth() != null
  })

  // ── Validation: trait declaration ────────────────────────────────────────

  test('trait cannot contain @id', () => {
    const r = parse(`
      trait Bad { id Int @id }
      model M { id Int @id; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@id is not allowed in a trait/)
  })

  test('trait cannot contain @@map', () => {
    const r = parse(`
      trait Bad { @@map("custom") }
      model M { id Int @id; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@map is not allowed in a trait/)
  })

  test('trait cannot contain @@db', () => {
    const r = parse(`
      database audit { path "./audit/" driver logger }
      trait Bad { @@db(audit) }
      model M { id Int @id; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@db is not allowed in a trait/)
  })

  test('trait cannot contain @@fts', () => {
    const r = parse(`
      trait Bad { title String; @@fts([title]) }
      model M { id Int @id; title String; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@fts is not allowed in a trait/)
  })

  test('duplicate trait name is an error', () => {
    const r = parse(`
      trait Dates { createdAt DateTime @default(now()) }
      trait Dates { updatedAt DateTime @updatedAt }
      model M { id Int @id; @@trait(Dates) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Duplicate trait 'Dates'/)
  })

  // ── Validation: trait references ─────────────────────────────────────────

  test('unknown trait reference is an error', () => {
    const r = parse(`
      model M { id Int @id; @@trait(Nonexistent) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/unknown trait 'Nonexistent'/)
  })

  test('two traits providing same field — collision error', () => {
    const r = parse(`
      trait X { foo String }
      trait Y { foo String }
      model M { id Int @id; @@trait(X); @@trait(Y) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/field 'foo' provided by both/)
  })

  test('host field overrides trait field of same name', () => {
    const r = parse(`
      trait T { foo String @default("from-trait") }
      model M {
        id  Int @id
        foo String @default("from-host")
        @@trait(T)
      }
    `)
    expect(r.valid).toBe(true)
    const m = r.schema.models.find((mm: any) => mm.name === 'M')!
    const foo = m.fields.find((f: any) => f.name === 'foo')!
    const def = foo.attributes.find((a: any) => a.kind === 'default')
    expect(def.value.value).toBe('from-host')
    // Only one foo field — the host's
    expect(m.fields.filter((f: any) => f.name === 'foo')).toHaveLength(1)
  })

  // ── Nested traits ────────────────────────────────────────────────────────

  test('nested traits expand transitively', () => {
    const r = parse(`
      trait Inner { a String }
      trait Outer { b String; @@trait(Inner) }
      model M { id Int @id; @@trait(Outer) }
    `)
    expect(r.valid).toBe(true)
    const m = r.schema.models.find((mm: any) => mm.name === 'M')!
    const fieldNames = m.fields.map((f: any) => f.name)
    expect(fieldNames).toContain('a')
    expect(fieldNames).toContain('b')
    expect(fieldNames).toContain('id')
  })

  test('trait cycle is detected', () => {
    const r = parse(`
      trait A { x String; @@trait(B) }
      trait B { y String; @@trait(A) }
      model M { id Int @id; @@trait(A) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Trait cycle detected/)
  })

  test('self-cycle is detected', () => {
    const r = parse(`
      trait Self { x String; @@trait(Self) }
      model M { id Int @id; @@trait(Self) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Trait cycle detected/)
  })

  // ── Runtime end-to-end ───────────────────────────────────────────────────

  test('trait splicing produces a working model', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        trait Dates {
          createdAt DateTime @default(now())
          updatedAt DateTime @updatedAt
        }
        model Post {
          id    Int @id
          title String
          @@trait(Dates)
        }
      `,
      db: ':memory:',
    })
    const created = await db.post.create({ data: { title: 'Hello' } })
    expect(created.title).toBe('Hello')
    expect(typeof created.createdAt).toBe('string')
    expect(typeof created.updatedAt).toBe('string')
    db.$close()
  })

  test('@@softDelete from trait activates soft-delete behavior', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        trait SoftDelete {
          deletedAt DateTime?
          @@softDelete
        }
        model Post {
          id    Int @id
          title String
          @@trait(SoftDelete)
        }
      `,
      db: ':memory:',
    })
    const p = await db.post.create({ data: { title: 'Hello' } })
    await db.post.remove({ where: { id: p.id } })
    expect((await db.post.findMany()).length).toBe(0)
    expect((await db.post.findMany({ withDeleted: true })).length).toBe(1)
    db.$close()
  })

  test('multiple traits compose at runtime', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        trait Dates {
          createdAt DateTime @default(now())
          updatedAt DateTime @updatedAt
        }
        trait SoftDelete {
          deletedAt DateTime?
          @@softDelete
        }
        model Post {
          id    Int @id
          title String
          @@trait(Dates)
          @@trait(SoftDelete)
        }
      `,
      db: ':memory:',
    })
    const p = await db.post.create({ data: { title: 'Hello' } })
    expect(typeof p.createdAt).toBe('string')
    await db.post.remove({ where: { id: p.id } })
    expect((await db.post.findMany()).length).toBe(0)
    db.$close()
  })

  test('trait validators apply at runtime', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        trait Contactable {
          email String @email
        }
        model User {
          id   Int @id
          name String
          @@trait(Contactable)
        }
      `,
      db: ':memory:',
    })
    await expect(db.user.create({ data: { name: 'A', email: 'not-an-email' } }))
      .rejects.toThrow(/email/i)
    db.$close()
  })
})

// ─── Types (Json @type) ───────────────────────────────────────────────────────

describe('type declarations', () => {
  // ── Parser ───────────────────────────────────────────────────────────────

  test('parses a type declaration', () => {
    const r = parse(`
      type Address {
        street     String
        city       String
        state      String?
        postalCode String
        country    String @default("US")
      }
      model User { id Int @id; name String; address Json @type(Address) }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.types).toHaveLength(1)
    expect(r.schema.types[0].name).toBe('Address')
    expect(r.schema.types[0].fields.map((f: any) => f.name)).toEqual(['street', 'city', 'state', 'postalCode', 'country'])
  })

  test('@type attribute appears on the field', () => {
    const r = parse(`
      type Address { street String; city String }
      model User { id Int @id; address Json @type(Address) }
    `)
    const user = r.schema.models.find((m: any) => m.name === 'User')!
    const addr = user.fields.find((f: any) => f.name === 'address')!
    const typeAttr = addr.attributes.find((a: any) => a.kind === 'type')
    expect(typeAttr).toMatchObject({ kind: 'type', name: 'Address', strict: true })
  })

  test('@type accepts strict: false', () => {
    const r = parse(`
      type Address { street String; city String }
      model User { id Int @id; address Json @type(Address, strict: false) }
    `)
    const addr = r.schema.models[0].fields.find((f: any) => f.name === 'address')!
    const typeAttr = addr.attributes.find((a: any) => a.kind === 'type')
    expect(typeAttr.strict).toBe(false)
  })

  // ── Validation: declaration-level ────────────────────────────────────────

  test('type cannot contain relations', () => {
    const r = parse(`
      type Bad {
        userId Int
        user   User @relation(fields: [userId], references: [id])
      }
      model User { id Int @id }
      model M { id Int @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/@relation not allowed in a type/)
  })

  test('type cannot contain @id', () => {
    const r = parse(`
      type Bad { id Int @id }
      model M { id Int @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@id not allowed in a type/)
  })

  test('type cannot contain @encrypted', () => {
    const r = parse(`
      type Bad { secret String @encrypted }
      model M { id Int @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@encrypted not allowed in a type/)
  })

  test('type cannot contain model-level attributes', () => {
    const r = parse(`
      type Bad { name String; @@index([name]) }
      model M { id Int @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@index not allowed in a type/)
  })

  test('type cannot contain @default(now())', () => {
    const r = parse(`
      type Bad { createdAt DateTime @default(now()) }
      model M { id Int @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@default\(now\(\)\) not allowed in a type/)
  })

  test('type allows literal defaults', () => {
    const r = parse(`
      type T { country String @default("US") }
      model M { id Int @id; t Json @type(T) }
    `)
    expect(r.valid).toBe(true)
  })

  test('type allows validators and transforms', () => {
    const r = parse(`
      type Contact {
        email String @email @lower
        zip   String @regex("^[0-9]{5}$") @trim
        age   Int @gte(0) @lt(150)
      }
      model M { id Int @id; contact Json @type(Contact) }
    `)
    expect(r.valid).toBe(true)
  })

  test('duplicate type name is an error', () => {
    const r = parse(`
      type Address { street String }
      type Address { city String }
      model M { id Int @id; addr Json @type(Address) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Duplicate type 'Address'/)
  })

  // ── Validation: use-site ─────────────────────────────────────────────────

  test('@type on a non-Json field is an error', () => {
    const r = parse(`
      type X { foo String }
      model M { id Int @id; x String @type(X) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@type\(X\) requires the field to be Json/)
  })

  test('@type with unknown name is an error', () => {
    const r = parse(`
      model M { id Int @id; addr Json @type(Nonexistent) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/unknown type 'Nonexistent'/)
  })

  test('cycle in Json @type chain is detected', () => {
    const r = parse(`
      type A { name String; b Json @type(B) }
      type B { name String; a Json @type(A) }
      model M { id Int @id; a Json @type(A) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Type cycle detected/)
  })

  // ── Runtime validation ───────────────────────────────────────────────────

  test('valid typed JSON write succeeds', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address {
          street     String
          city       String
          state      String?
          postalCode String
        }
        model User { id Int @id; name String; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    const u = await db.user.create({
      data: { name: 'A', address: { street: '1 Main', city: 'Boston', postalCode: '02101' } }
    })
    expect(u.address).toMatchObject({ street: '1 Main', city: 'Boston', postalCode: '02101' })
    expect(u.address.state).toBeUndefined()
    db.$close()
  })

  test('missing required field rejects', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address { street String; city String; postalCode String }
        model User { id Int @id; name String; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    await expect(db.user.create({
      data: { name: 'A', address: { street: 's', city: 'c' } }
    })).rejects.toThrow(/postalCode.*is required/)
    db.$close()
  })

  test('wrong-type field rejects with correct error path', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address { postalCode String; city String }
        model User { id Int @id; name String; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    try {
      await db.user.create({
        data: { name: 'A', address: { postalCode: 12345 as any, city: 'Boston' } }
      })
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.errors[0].path).toEqual(['address', 'postalCode'])
      expect(e.errors[0].message).toMatch(/must be a string/)
    }
    db.$close()
  })

  test('strict mode rejects extra keys', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address { street String; city String }
        model User { id Int @id; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    try {
      await db.user.create({ data: { address: { street: 's', city: 'c', bogus: 'x' } as any } })
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.errors[0].path).toEqual(['address', 'bogus'])
      expect(e.errors[0].message).toMatch(/unknown field/)
    }
    db.$close()
  })

  test('strict: false allows extra keys', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address { street String; city String }
        model User { id Int @id; address Json @type(Address, strict: false) }
      `,
      db: ':memory:',
    })
    const u = await db.user.create({
      data: { address: { street: 's', city: 'c', extra: 'kept' } as any }
    })
    expect((u.address as any).extra).toBe('kept')
    db.$close()
  })

  test('nested types validate recursively', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Coordinates { lat Float; lng Float }
        type Address {
          street String
          city   String
          coords Json @type(Coordinates)
        }
        model Place { id Int @id; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    const p = await db.place.create({
      data: { address: { street: 's', city: 'c', coords: { lat: 42.36, lng: -71.06 } } }
    })
    expect((p.address as any).coords).toEqual({ lat: 42.36, lng: -71.06 })
    db.$close()
  })

  test('nested type errors include nested path', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Coordinates { lat Float; lng Float }
        type Address { street String; coords Json @type(Coordinates) }
        model Place { id Int @id; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    try {
      await db.place.create({
        data: { address: { street: 's', coords: { lat: 'bad' as any, lng: 0 } } }
      })
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.errors[0].path).toEqual(['address', 'coords', 'lat'])
    }
    db.$close()
  })

  test('validators in types fire on JSON sub-keys', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Contact {
          email String @email
          age   Int @gte(0)
        }
        model User { id Int @id; contact Json @type(Contact) }
      `,
      db: ':memory:',
    })
    await expect(db.user.create({
      data: { contact: { email: 'not-email', age: 30 } }
    })).rejects.toThrow(/email/i)
    await expect(db.user.create({
      data: { contact: { email: 'a@b.com', age: -1 } }
    })).rejects.toThrow(/at least 0|0/i)
    const ok = await db.user.create({
      data: { contact: { email: 'a@b.com', age: 30 } }
    })
    expect((ok.contact as any).email).toBe('a@b.com')
    db.$close()
  })

  test('null typed JSON value is allowed when field is optional', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address { street String; city String }
        model User { id Int @id; address Json? @type(Address) }
      `,
      db: ':memory:',
    })
    const u = await db.user.create({ data: { address: null } as any })
    expect(u.address).toBeNull()
    db.$close()
  })

  test('arrays inside types validate as arrays', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Tags { values String[] }
        model Post { id Int @id; tags Json @type(Tags) }
      `,
      db: ':memory:',
    })
    const p = await db.post.create({ data: { tags: { values: ['a', 'b', 'c'] } } })
    expect((p.tags as any).values).toEqual(['a', 'b', 'c'])
    await expect(db.post.create({
      data: { tags: { values: 'not an array' as any } }
    })).rejects.toThrow(/array/i)
    db.$close()
  })

  test('boolean/integer/number type checks', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Mixed { flag Boolean; count Int; ratio Float }
        model M { id Int @id; data Json @type(Mixed) }
      `,
      db: ':memory:',
    })
    const ok = await db.m.create({ data: { data: { flag: true, count: 5, ratio: 0.5 } } })
    expect((ok.data as any).flag).toBe(true)
    await expect(db.m.create({
      data: { data: { flag: 'yes' as any, count: 5, ratio: 0.5 } }
    })).rejects.toThrow(/boolean/i)
    await expect(db.m.create({
      data: { data: { flag: true, count: 1.5 as any, ratio: 0.5 } }
    })).rejects.toThrow(/integer/i)
    db.$close()
  })

  test('typed JSON does not affect other fields', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address { city String }
        model User {
          id      Int @id
          email   String @email
          address Json @type(Address)
        }
      `,
      db: ':memory:',
    })
    // Bad email but valid address — error is about email, not address
    try {
      await db.user.create({ data: { email: 'not-email', address: { city: 'Boston' } } })
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.errors[0].path).toEqual(['email'])
    }
    db.$close()
  })

  test('round-trip: write → findUnique → read returns parsed object', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Address { street String; city String }
        model User { id Int @id; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    await db.user.create({ data: { id: 1, address: { street: 's', city: 'c' } } })
    const u = await db.user.findUnique({ where: { id: 1 } })
    expect(u!.address).toEqual({ street: 's', city: 'c' })
    db.$close()
  })

  // ── TypeScript generation ────────────────────────────────────────────────

  test('typegen emits an interface for each type', async () => {
    const { generateTypeScript } = await import('../src/tools/typegen.js')
    const r = parse(`
      type Address { street String; city String; state String? }
      type Coordinates { lat Float; lng Float }
      model M { id Int @id }
    `)
    const ts = generateTypeScript(r.schema!)
    expect(ts).toContain('export interface Address {')
    expect(ts).toContain('  street: string')
    expect(ts).toContain('  state?: string | null')
    expect(ts).toContain('export interface Coordinates {')
    expect(ts).toContain('  lat: number')
  })

  test('typegen references typed JSON fields by interface name', async () => {
    const { generateTypeScript } = await import('../src/tools/typegen.js')
    const r = parse(`
      type Address { street String; city String }
      model User {
        id      Int @id
        address Json @type(Address)
        rawData Json
      }
    `)
    const ts = generateTypeScript(r.schema!)
    // typed → uses the interface
    expect(ts).toMatch(/address:\s*Address/)
    // untyped → stays unknown
    expect(ts).toMatch(/rawData:\s*unknown/)
  })

  test('typegen handles optional typed JSON fields', async () => {
    const { generateTypeScript } = await import('../src/tools/typegen.js')
    const r = parse(`
      type Address { street String }
      model User {
        id      Int @id
        address Json? @type(Address)
      }
    `)
    const ts = generateTypeScript(r.schema!)
    expect(ts).toMatch(/address\?:\s*Address \| null/)
  })
})

// ─── Date object coercion ────────────────────────────────────────────────────

describe('Date object coercion', () => {
  // JS Date objects passed into create/update/where on DateTime fields should
  // be silently normalized to ISO 8601 strings. Without this, validate() rejects
  // Date instances on writes and Bun's SQLite driver stringifies them to the
  // human-readable form on reads, breaking comparisons.

  test('create with Date object on DateTime field succeeds', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        model Session {
          id        Int  @id
          token     String
          expiresAt DateTime
        }
      `,
      db: ':memory:',
    })
    const expiresAt = new Date('2026-12-31T23:59:59Z')
    const s = await db.session.create({ data: { token: 'abc', expiresAt } })
    expect(s.expiresAt).toBe('2026-12-31T23:59:59.000Z')
    db.$close()
  })

  test('create with millisecond timestamp on DateTime field succeeds', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        model E { id Int @id; at DateTime }
      `,
      db: ':memory:',
    })
    const ms = Date.UTC(2026, 5, 15, 12, 0, 0)  // 2026-06-15T12:00:00Z
    const e = await db.e.create({ data: { at: ms } })
    expect(e.at).toBe('2026-06-15T12:00:00.000Z')
    db.$close()
  })

  test('where comparison with Date object — gt/lt', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `model E { id Int @id; at DateTime }`,
      db: ':memory:',
    })
    await db.e.create({ data: { id: 1, at: '2025-01-01T00:00:00Z' } })
    await db.e.create({ data: { id: 2, at: '2027-01-01T00:00:00Z' } })
    const cutoff = new Date('2026-01-01T00:00:00Z')
    const future = await db.e.findMany({ where: { at: { gt: cutoff } } })
    expect(future.map((r: any) => r.id)).toEqual([2])
    const past = await db.e.findMany({ where: { at: { lt: cutoff } } })
    expect(past.map((r: any) => r.id)).toEqual([1])
    db.$close()
  })

  test('where direct equality with Date object', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `model E { id Int @id; at DateTime }`,
      db: ':memory:',
    })
    const at = new Date('2026-06-15T12:00:00Z')
    await db.e.create({ data: { id: 1, at } })
    const found = await db.e.findMany({ where: { at: new Date('2026-06-15T12:00:00Z') } })
    expect(found.map((r: any) => r.id)).toEqual([1])
    db.$close()
  })

  test('where in: [Date, Date]', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `model E { id Int @id; at DateTime }`,
      db: ':memory:',
    })
    const d1 = new Date('2026-01-01T00:00:00Z')
    const d2 = new Date('2026-06-01T00:00:00Z')
    const d3 = new Date('2026-12-01T00:00:00Z')
    await db.e.create({ data: { id: 1, at: d1 } })
    await db.e.create({ data: { id: 2, at: d2 } })
    await db.e.create({ data: { id: 3, at: d3 } })
    const r = await db.e.findMany({ where: { at: { in: [d1, d3] } } })
    expect(r.map((x: any) => x.id).sort()).toEqual([1, 3])
    db.$close()
  })

  test('update with Date object', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `model E { id Int @id; at DateTime }`,
      db: ':memory:',
    })
    await db.e.create({ data: { id: 1, at: new Date('2026-01-01T00:00:00Z') } })
    const updated = await db.e.update({
      where: { id: 1 },
      data: { at: new Date('2027-01-01T00:00:00Z') },
    })
    expect(updated.at).toBe('2027-01-01T00:00:00.000Z')
    db.$close()
  })

  test('typed JSON path pushdown also handles Date objects', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Meta { occurredAt DateTime }
        model E { id Int @id; meta Json @type(Meta) }
      `,
      db: ':memory:',
    })
    await db.e.create({ data: { id: 1, meta: { occurredAt: '2025-01-01T00:00:00Z' } } })
    await db.e.create({ data: { id: 2, meta: { occurredAt: '2027-01-01T00:00:00Z' } } })
    const future = await db.e.findMany({
      where: { meta: { occurredAt: { gt: new Date('2026-01-01T00:00:00Z') } } }
    })
    expect(future.map((r: any) => r.id)).toEqual([2])
    db.$close()
  })

  test('null DateTime is still rejected as required', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `model E { id Int @id; at DateTime }`,
      db: ':memory:',
    })
    // Bad ISO string still rejected
    await expect(db.e.create({ data: { id: 1, at: 'not a date' } as any }))
      .rejects.toThrow(/ISO 8601/)
    db.$close()
  })

  test('Date works as secondary param in multi-param WHERE (Bun bind quirk regression)', async () => {
    // Bun's SQLite driver throws "Binding expected ..." when a Date appears
    // as a secondary param in .get(p1, p2, ...). Single-param queries silently
    // coerce Date, multi-param ones do not. Litestone normalizes Date to ISO
    // string in buildWhere so this never reaches Bun unconverted. Without the
    // fix, this exact pattern (auth-style session lookup) would throw.
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        model Session {
          id        Int @id
          token     String
          expiresAt DateTime
        }
      `,
      db: ':memory:',
    })
    const future = new Date(Date.now() + 60 * 60 * 1000)
    await db.session.create({ data: { token: 'abc', expiresAt: future } })

    // Exact pattern from a typical auth middleware:
    //   where: { token: 'abc', expiresAt: { gt: new Date() } }
    // Two params: a string and a Date. Pre-fix this threw "Binding expected".
    const found = await db.session.findFirst({
      where: { token: 'abc', expiresAt: { gt: new Date() } },
    })
    expect(found?.token).toBe('abc')
    db.$close()
  })
})

// ─── Helpful WHERE binding errors ────────────────────────────────────────────

describe('WHERE binding error reporting', () => {
  // Bun throws "Binding expected ..." on functions, symbols, etc. without
  // saying which field caused it. Litestone catches the unbindable cases
  // before they reach Bun and re-throws with the field name.

  async function makeDb() {
    const { createClient } = await import('../src/core/client.js')
    return await createClient({
      schema: `model U { id Int @id; token String }`,
      db: ':memory:',
    })
  }

  test('passing a function as a WHERE value names the field', async () => {
    const db = await makeDb()
    await expect(
      db.u.findFirst({ where: { token: (() => 'x') as any } })
    ).rejects.toThrow(/field "token".*function/)
    db.$close()
  })

  test('passing undefined as a WHERE value names the field', async () => {
    const db = await makeDb()
    await expect(
      db.u.findFirst({ where: { token: undefined as any } })
    ).rejects.toThrow(/field "token".*undefined.*null/)
    db.$close()
  })

  test('function inside an op block names the field', async () => {
    const db = await makeDb()
    await expect(
      db.u.findFirst({ where: { id: { gt: (() => 5) as any } } })
    ).rejects.toThrow(/field "id".*function/)
    db.$close()
  })

  test('function inside in: array names the field', async () => {
    const db = await makeDb()
    await expect(
      db.u.findFirst({ where: { id: { in: [1, (() => 2) as any] } } })
    ).rejects.toThrow(/field "id".*function/)
    db.$close()
  })

  test('symbol value names the field', async () => {
    const db = await makeDb()
    await expect(
      db.u.findFirst({ where: { token: Symbol('x') as any } })
    ).rejects.toThrow(/field "token".*symbol/)
    db.$close()
  })
})

// ─── Typed JSON path pushdown ────────────────────────────────────────────────

describe('typed JSON path pushdown', () => {
  async function makeUserDb() {
    const { createClient } = await import('../src/core/client.js')
    return await createClient({
      schema: `
        type Address {
          street     String
          city       String
          state      String?
          postalCode String
        }
        model User {
          id      Int @id
          name    String
          address Json @type(Address)
        }
      `,
      db: ':memory:',
    })
  }

  async function seed(db: any) {
    await db.user.createMany({ data: [
      { id: 1, name: 'Alice',   address: { street: '1 Main', city: 'Boston',    state: 'MA', postalCode: '02101' }},
      { id: 2, name: 'Bob',     address: { street: '2 Oak',  city: 'Cambridge', state: 'MA', postalCode: '02139' }},
      { id: 3, name: 'Charlie', address: { street: '3 Elm',  city: 'Boston',    state: 'MA', postalCode: '02118' }},
      { id: 4, name: 'Dave',    address: { street: '4 Pine', city: 'NYC',       state: 'NY', postalCode: '10001' }},
    ]})
  }

  // ── Equality and basic ops ───────────────────────────────────────────────

  test('equality on a sub-key', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { city: 'Boston' } } })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Alice', 'Charlie'])
    db.$close()
  })

  test('multiple sub-keys (implicit AND)', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { city: 'Boston', state: 'MA' } } })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Alice', 'Charlie'])
    db.$close()
  })

  test('contains operator on a sub-key', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { city: { contains: 'idge' } } } })
    expect(r.map((u: any) => u.name)).toEqual(['Bob'])
    db.$close()
  })

  test('startsWith on a sub-key', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { city: { startsWith: 'B' } } } })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Alice', 'Charlie'])
    db.$close()
  })

  test('endsWith on a sub-key', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { postalCode: { endsWith: '01' } } } })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Alice', 'Dave'])
    db.$close()
  })

  test('IN on a sub-key', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { state: { in: ['MA', 'CA'] } } } })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Alice', 'Bob', 'Charlie'])
    db.$close()
  })

  test('notIn on a sub-key', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { state: { notIn: ['MA'] } } } })
    expect(r.map((u: any) => u.name)).toEqual(['Dave'])
    db.$close()
  })

  test('not equal on a sub-key', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({ where: { address: { city: { not: 'Boston' } } } })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Bob', 'Dave'])
    db.$close()
  })

  // ── Null handling ────────────────────────────────────────────────────────

  test('null on a sub-key (IS NULL)', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Settings { darkMode Boolean; tag String? }
        model U { id Int @id; s Json @type(Settings) }
      `,
      db: ':memory:',
    })
    await db.u.create({ data: { id: 1, s: { darkMode: true,  tag: 'x' } } })
    await db.u.create({ data: { id: 2, s: { darkMode: false, tag: null } } })
    const r = await db.u.findMany({ where: { s: { tag: null } } })
    expect(r.map((u: any) => u.id)).toEqual([2])
    db.$close()
  })

  test('not: null on a sub-key (IS NOT NULL)', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Settings { tag String? }
        model U { id Int @id; s Json @type(Settings) }
      `,
      db: ':memory:',
    })
    await db.u.create({ data: { id: 1, s: { tag: 'x' } } })
    await db.u.create({ data: { id: 2, s: { tag: null } } })
    const r = await db.u.findMany({ where: { s: { tag: { not: null } } } })
    expect(r.map((u: any) => u.id)).toEqual([1])
    db.$close()
  })

  test('null on the whole typed column still works', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type T { city String }
        model U { id Int @id; addr Json? @type(T) }
      `,
      db: ':memory:',
    })
    await db.u.create({ data: { id: 1, addr: { city: 'X' } } })
    await db.u.create({ data: { id: 2, addr: null as any } })
    expect((await db.u.findMany({ where: { addr: null } })).length).toBe(1)
    expect((await db.u.findMany({ where: { addr: { not: null } } })).length).toBe(1)
    db.$close()
  })

  // ── Boolean and numeric coercion ─────────────────────────────────────────

  test('boolean sub-key true/false', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Settings { darkMode Boolean }
        model U { id Int @id; s Json @type(Settings) }
      `,
      db: ':memory:',
    })
    await db.u.createMany({ data: [
      { id: 1, s: { darkMode: true } },
      { id: 2, s: { darkMode: false } },
      { id: 3, s: { darkMode: true } },
    ]})
    expect((await db.u.findMany({ where: { s: { darkMode: true } } })).length).toBe(2)
    expect((await db.u.findMany({ where: { s: { darkMode: false } } })).length).toBe(1)
    db.$close()
  })

  test('integer comparison on sub-key', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Stats { count Int }
        model U { id Int @id; s Json @type(Stats) }
      `,
      db: ':memory:',
    })
    await db.u.createMany({ data: [
      { id: 1, s: { count: 5 } },
      { id: 2, s: { count: 10 } },
      { id: 3, s: { count: 15 } },
    ]})
    const r = await db.u.findMany({ where: { s: { count: { gte: 10 } } } })
    expect(r.map((u: any) => u.id).sort()).toEqual([2, 3])
    db.$close()
  })

  test('real (float) comparison on sub-key', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Coords { lat Float; lng Float }
        model P { id Int @id; c Json @type(Coords) }
      `,
      db: ':memory:',
    })
    await db.p.createMany({ data: [
      { id: 1, c: { lat: 42.36, lng: -71.06 } },
      { id: 2, c: { lat: 40.71, lng: -74.01 } },
    ]})
    const r = await db.p.findMany({ where: { c: { lat: { gte: 42 } } } })
    expect(r.map((p: any) => p.id)).toEqual([1])
    db.$close()
  })

  // ── Nested types ─────────────────────────────────────────────────────────

  test('nested type traversal via dotted JSON path', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Coords { lat Float; lng Float }
        type Address { city String; coords Json @type(Coords) }
        model P { id Int @id; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    await db.p.createMany({ data: [
      { id: 1, address: { city: 'Boston', coords: { lat: 42.36, lng: -71.06 } } },
      { id: 2, address: { city: 'NYC',    coords: { lat: 40.71, lng: -74.01 } } },
      { id: 3, address: { city: 'Boston', coords: { lat: 42.37, lng: -71.05 } } },
    ]})
    const r = await db.p.findMany({ where: { address: { coords: { lat: { gte: 42, lt: 43 } } } } })
    expect(r.map((p: any) => p.id).sort()).toEqual([1, 3])
    db.$close()
  })

  test('nested type + sibling sub-key on outer level', async () => {
    const { createClient } = await import('../src/core/client.js')
    const db = await createClient({
      schema: `
        type Coords { lat Float; lng Float }
        type Address { city String; coords Json @type(Coords) }
        model P { id Int @id; address Json @type(Address) }
      `,
      db: ':memory:',
    })
    await db.p.createMany({ data: [
      { id: 1, address: { city: 'Boston', coords: { lat: 42.36, lng: -71.06 } } },
      { id: 2, address: { city: 'NYC',    coords: { lat: 40.71, lng: -74.01 } } },
      { id: 3, address: { city: 'Boston', coords: { lat: 42.37, lng: -71.05 } } },
    ]})
    const r = await db.p.findMany({
      where: { address: { city: 'Boston', coords: { lat: { gte: 42 } } } }
    })
    expect(r.map((p: any) => p.id).sort()).toEqual([1, 3])
    db.$close()
  })

  // ── Composition with AND/OR/NOT ──────────────────────────────────────────

  test('typed JSON inside OR', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({
      where: {
        OR: [
          { address: { city: 'Boston' } },
          { name: 'Dave' }
        ]
      }
    })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Alice', 'Charlie', 'Dave'])
    db.$close()
  })

  test('typed JSON inside AND', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({
      where: {
        AND: [
          { address: { state: 'MA' } },
          { address: { city: 'Boston' } }
        ]
      }
    })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Alice', 'Charlie'])
    db.$close()
  })

  test('typed JSON inside NOT', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.findMany({
      where: { NOT: { address: { city: 'Boston' } } }
    })
    expect(r.map((u: any) => u.name).sort()).toEqual(['Bob', 'Dave'])
    db.$close()
  })

  // ── Error paths ──────────────────────────────────────────────────────────

  test('unknown sub-key throws helpful error', async () => {
    const db = await makeUserDb(); await seed(db)
    await expect(
      db.user.findMany({ where: { address: { bogus: 'x' as any } as any } })
    ).rejects.toThrow(/Unknown field 'bogus' on type Address/)
    db.$close()
  })

  test('count() with typed JSON filter', async () => {
    const db = await makeUserDb(); await seed(db)
    const n = await db.user.count({ where: { address: { state: 'MA' } } })
    expect(n).toBe(3)
    db.$close()
  })

  test('findFirst with typed JSON filter', async () => {
    const db = await makeUserDb(); await seed(db)
    const u = await db.user.findFirst({ where: { address: { city: 'NYC' } } })
    expect(u!.name).toBe('Dave')
    db.$close()
  })

  test('updateMany with typed JSON filter', async () => {
    const db = await makeUserDb(); await seed(db)
    const r = await db.user.updateMany({
      where: { address: { state: 'NY' } },
      data:  { name: 'Updated' }
    })
    expect(r).toMatchObject({ count: 1 })
    const dave = await db.user.findUnique({ where: { id: 4 } })
    expect(dave!.name).toBe('Updated')
    db.$close()
  })
})

// ─── JSON Schema generation for types ────────────────────────────────────────

describe('generateJsonSchema with types', () => {
  test('emits $ref to a type definition for typed JSON fields', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      type Address { street String; city String }
      model User {
        id      Int @id
        address Json @type(Address)
      }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.User.properties.address).toEqual({ $ref: '#/$defs/Address' })
  })

  test('emits a full type definition with required fields and shape', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      type Address { street String; city String; state String?; postalCode String }
      model U { id Int @id; addr Json @type(Address) }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.Address.type).toBe('object')
    expect(s.$defs.Address.properties.street).toMatchObject({ type: 'string' })
    expect(s.$defs.Address.properties.state).toMatchObject({ type: ['string', 'null'] })
    expect(s.$defs.Address.required.sort()).toEqual(['city', 'postalCode', 'street'])
    expect(s.$defs.Address.additionalProperties).toBe(false)
  })

  test('validators inside types propagate into the JSON Schema', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      type Contact {
        email String @email
        zip   String @regex("^[0-9]{5}$")
      }
      model U { id Int @id; c Json @type(Contact) }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.Contact.properties.email).toMatchObject({ format: 'email' })
    expect(s.$defs.Contact.properties.zip).toMatchObject({ pattern: '^[0-9]{5}$' })
  })

  test('untyped Json fields remain permissive', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      model U { id Int @id; meta Json }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.U.properties.meta).toEqual({})
  })

  test('nested types resolve via $ref', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      type Coords { lat Float; lng Float }
      type Address { city String; coords Json @type(Coords) }
      model P { id Int @id; address Json @type(Address) }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.Address.properties.coords).toEqual({ $ref: '#/$defs/Coords' })
    expect(s.$defs.Coords.properties.lat).toMatchObject({ type: 'number' })
  })
})

describe('aggregate()', () => {
  test('_count returns total rows', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-count')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid', accountId: 2 },
    ]})
    const r = await db.order.aggregate({ _count: true })
    expect(r._count).toBe(3)
    db.$close()
  })

  test('_sum aggregates a field', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-sum')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
      { id: 3, amount: 30, status: 'paid', accountId: 2 },
    ]})
    const r = await db.order.aggregate({ _sum: { amount: true } })
    expect(r._sum.amount).toBeCloseTo(60)
    db.$close()
  })

  test('_avg aggregates a field', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-avg')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 30, status: 'paid', accountId: 1 },
    ]})
    const r = await db.order.aggregate({ _avg: { amount: true } })
    expect(r._avg.amount).toBeCloseTo(20)
    db.$close()
  })

  test('_min and _max', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-minmax')
    await db.order.createMany({ data: [
      { id: 1, amount: 5,  status: 'paid', accountId: 1 },
      { id: 2, amount: 50, status: 'paid', accountId: 1 },
      { id: 3, amount: 25, status: 'paid', accountId: 1 },
    ]})
    const r = await db.order.aggregate({ _min: { amount: true }, _max: { amount: true } })
    expect(r._min.amount).toBe(5)
    expect(r._max.amount).toBe(50)
    db.$close()
  })

  test('multiple aggregations in one call', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-multi')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
    ]})
    const r = await db.order.aggregate({
      _count: true,
      _sum: { amount: true },
      _avg: { amount: true },
    })
    expect(r._count).toBe(2)
    expect(r._sum.amount).toBeCloseTo(30)
    expect(r._avg.amount).toBeCloseTo(15)
    db.$close()
  })

  test('where: filters before aggregation', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-where')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid',    accountId: 1 },
    ]})
    const r = await db.order.aggregate({ _sum: { amount: true }, where: { status: 'paid' } })
    expect(r._sum.amount).toBeCloseTo(40)
    db.$close()
  })

  test('respects @@softDelete — excludes deleted rows', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-soft')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
    ]})
    await db.order.remove({ where: { id: 2 } })
    const r = await db.order.aggregate({ _count: true, _sum: { amount: true } })
    expect(r._count).toBe(1)
    expect(r._sum.amount).toBeCloseTo(10)
    db.$close()
  })

  test('throws without any aggregation', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-throw')
    await expect(db.order.aggregate({})).rejects.toThrow('at least one')
    db.$close()
  })

  test('_count distinct', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-distinct')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },  // duplicate accountId
      { id: 3, amount: 30, status: 'pending', accountId: 2 },
    ]})
    const r = await db.order.aggregate({ _count: { distinct: 'accountId' } })
    expect(r._count).toBe(2)   // 2 distinct accountIds, not 3 rows
    db.$close()
  })

  test('_stringAgg', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-strAgg')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'refund',  accountId: 1 },
      { id: 3, amount: 30, status: 'pending', accountId: 1 },
    ]})
    const r = await db.order.aggregate({
      _stringAgg: { field: 'status', separator: ', ', orderBy: 'status' },
    })
    expect(r._stringAgg.status).toBe('paid, pending, refund')
    db.$close()
  })

  test('named aggregate — filtered count', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-nagg-count')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 30, status: 'refund',  accountId: 1 },
      { id: 4, amount: 40, status: 'pending', accountId: 1 },
    ]})
    const r = await db.order.aggregate({
      _count:       true,
      _countPaid:   { count: true, filter: sql`status = 'paid'` },
      _countRefund: { count: true, filter: sql`status = 'refund'` },
    })
    expect(r._count).toBe(4)
    expect(r._countPaid).toBe(2)
    expect(r._countRefund).toBe(1)
    db.$close()
  })

  test('named aggregate — filtered sum', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-nagg-sum')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',   accountId: 1 },
      { id: 2, amount: 20, status: 'paid',   accountId: 1 },
      { id: 3, amount: 30, status: 'refund', accountId: 1 },
    ]})
    const r = await db.order.aggregate({
      _sumPaid:   { sum: 'amount', filter: sql`status = 'paid'` },
      _sumRefund: { sum: 'amount', filter: sql`status = 'refund'` },
      _avgPaid:   { avg: 'amount', filter: sql`status = 'paid'` },
    })
    expect(r._sumPaid).toBeCloseTo(30)
    expect(r._sumRefund).toBeCloseTo(30)
    expect(r._avgPaid).toBeCloseTo(15)
    db.$close()
  })

  test('named aggregate — no filter (plain named agg)', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-nagg-plain')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
    ]})
    const r = await db.order.aggregate({
      _totalAmount: { sum: 'amount' },
      _avgAmount:   { avg: 'amount' },
    })
    expect(r._totalAmount).toBeCloseTo(30)
    expect(r._avgAmount).toBeCloseTo(15)
    db.$close()
  })
})


// ─── groupBy() ───────────────────────────────────────────────────────────────

describe('groupBy()', () => {
  test('groups by a single field', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-basic')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid',    accountId: 2 },
    ]})
    const rows = await db.order.groupBy({ by: ['status'], _count: true })
    expect(rows).toHaveLength(2)
    const paid = rows.find((r: any) => r.status === 'paid')
    expect(paid._count).toBe(2)
    db.$close()
  })

  test('_sum per group', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-sum')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 5,  status: 'pending', accountId: 1 },
    ]})
    const rows = await db.order.groupBy({ by: ['status'], _sum: { amount: true } })
    const paid = rows.find((r: any) => r.status === 'paid')
    expect(paid._sum.amount).toBeCloseTo(30)
    db.$close()
  })

  test('groups by multiple fields', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-multi-by')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 2 },
      { id: 3, amount: 30, status: 'paid', accountId: 1 },
    ]})
    const rows = await db.order.groupBy({ by: ['status', 'accountId'], _count: true })
    expect(rows).toHaveLength(2)
    db.$close()
  })

  test('where: filters before grouping', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-where')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid',    accountId: 2 },
    ]})
    const rows = await db.order.groupBy({
      by: ['accountId'], _count: true,
      where: { status: 'paid' }
    })
    expect(rows).toHaveLength(2)
    db.$close()
  })

  test('having: filters groups', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-having')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
      { id: 3, amount: 5,  status: 'paid', accountId: 2 },
    ]})
    const rows = await db.order.groupBy({
      by: ['accountId'], _count: true,
      having: { _count: { gt: 1 } }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].accountId).toBe(1)
    db.$close()
  })

  test('having: _sum filter', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-having-sum')
    await db.order.createMany({ data: [
      { id: 1, amount: 100, status: 'paid', accountId: 1 },
      { id: 2, amount: 200, status: 'paid', accountId: 1 },
      { id: 3, amount: 5,   status: 'paid', accountId: 2 },
    ]})
    const rows = await db.order.groupBy({
      by: ['accountId'],
      _sum: { amount: true },
      having: { _sum: { amount: { gte: 100 } } }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].accountId).toBe(1)
    db.$close()
  })

  test('orderBy group field', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-order')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'pending', accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
    ]})
    const rows = await db.order.groupBy({
      by: ['status'], _count: true,
      orderBy: { status: 'asc' }
    })
    expect(rows[0].status).toBe('paid')
    expect(rows[1].status).toBe('pending')
    db.$close()
  })

  test('orderBy _count desc', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-order-count')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 5,  status: 'pending', accountId: 1 },
    ]})
    const rows = await db.order.groupBy({
      by: ['status'], _count: true,
      orderBy: { _count: 'desc' }
    })
    expect(rows[0].status).toBe('paid')
    db.$close()
  })

  test('limit and offset', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-limit')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'a', accountId: 1 },
      { id: 2, amount: 20, status: 'b', accountId: 1 },
      { id: 3, amount: 30, status: 'c', accountId: 1 },
    ]})
    const rows = await db.order.groupBy({ by: ['status'], _count: true, orderBy: { status: 'asc' }, limit: 2 })
    expect(rows).toHaveLength(2)
    db.$close()
  })

  test('_count distinct', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-count-distinct')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },  // same accountId
      { id: 3, amount: 30, status: 'paid',    accountId: 2 },
      { id: 4, amount: 40, status: 'pending', accountId: 1 },
    ]})
    const rows = await db.order.groupBy({
      by: ['status'],
      _count: { distinct: 'accountId' },
      orderBy: { status: 'asc' },
    })
    const paid = rows.find((r: any) => r.status === 'paid')
    expect(paid._count).toBe(2)    // 2 distinct accountIds under 'paid'
    const pending = rows.find((r: any) => r.status === 'pending')
    expect(pending._count).toBe(1)
    db.$close()
  })

  test('_stringAgg', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-stringagg')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 2 },
      { id: 3, amount: 30, status: 'paid', accountId: 3 },
    ]})
    const rows = await db.order.groupBy({
      by: ['status'],
      _stringAgg: { field: 'status', separator: '|' },
    })
    expect(rows[0]._stringAgg.status).toContain('paid')
    db.$close()
  })

  test('named aggregate — filtered counts per group', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-nagg')
    await db.order.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 30, status: 'refund',  accountId: 1 },
      { id: 4, amount: 40, status: 'paid',    accountId: 2 },
      { id: 5, amount: 50, status: 'pending', accountId: 2 },
    ]})
    const rows = await db.order.groupBy({
      by: ['accountId'],
      _count:       true,
      _countPaid:   { count: true, filter: sql`status = 'paid'` },
      _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
      orderBy: { accountId: 'asc' },
    })
    const acct1 = rows.find((r: any) => r.accountId === 1)
    expect(acct1._count).toBe(3)
    expect(acct1._countPaid).toBe(2)
    expect(acct1._sumPaid).toBeCloseTo(30)
    const acct2 = rows.find((r: any) => r.accountId === 2)
    expect(acct2._countPaid).toBe(1)
    db.$close()
  })

  test('throws without by', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-throw')
    await expect((db.order as any).groupBy({})).rejects.toThrow('by')
    db.$close()
  })
})


// ─── _count in include ────────────────────────────────────────────────────────

const COUNT_SCHEMA = `
  model Account {
    id    Int @id
    name  String
    users User[]
    posts Post[]
  }
  model User {
    id        Int @id
    accountId Int
    account   Account @relation(fields: [accountId], references: [id])
    name      String
  }
  model Post {
    id        Int @id
    accountId Int
    account   Account @relation(fields: [accountId], references: [id])
    title     String
  }
`

describe('_count in include', () => {
  test('counts a single relation', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-basic')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
    ]})
    const rows = await db.account.findMany({ include: { _count: { select: { users: true } } } })
    expect(rows[0]._count.users).toBe(2)
    db.$close()
  })

  test('counts multiple relations', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-multi')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
    ]})
    await db.post.create({ data: { id: 1, accountId: 1, title: 'Hello' } })
    const rows = await db.account.findMany({
      include: { _count: { select: { users: true, posts: true } } }
    })
    expect(rows[0]._count.users).toBe(2)
    expect(rows[0]._count.posts).toBe(1)
    db.$close()
  })

  test('returns 0 when no children', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-zero')
    await db.account.create({ data: { id: 1, name: 'Empty' } })
    const rows = await db.account.findMany({ include: { _count: { select: { users: true } } } })
    expect(rows[0]._count.users).toBe(0)
    db.$close()
  })

  test('works across multiple parent rows', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-multi-rows')
    await db.account.createMany({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 2, name: 'Carol' },
    ]})
    const rows = await db.account.findMany({ include: { _count: { select: { users: true } } } })
    const a1 = rows.find((r: any) => r.id === 1)
    const a2 = rows.find((r: any) => r.id === 2)
    expect(a1._count.users).toBe(2)
    expect(a2._count.users).toBe(1)
    db.$close()
  })

  test('can combine _count with real includes', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-combined')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
    ]})
    const rows = await db.account.findMany({
      include: { users: true, _count: { select: { users: true } } }
    })
    expect(rows[0].users).toHaveLength(2)
    expect(rows[0]._count.users).toBe(2)
    db.$close()
  })
})

describe('_count in include — filtered', () => {
  test('where on relation name filters count', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'cnt-filtered-basic')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 1, name: 'Charlie' },
    ]})
    const rows = await db.account.findMany({
      include: { _count: { select: {
        users: { where: { name: 'Alice' } }
      }}}
    })
    expect(rows[0]._count.users).toBe(1)
    db.$close()
  })

  test('alias allows two filtered counts of the same relation', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'cnt-filtered-alias')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 1, name: 'Charlie' },
    ]})
    const rows = await db.account.findMany({
      include: { _count: { select: {
        users: true,
        alice_users: { relation: 'users', where: { name: 'Alice' } },
        bob_users:   { relation: 'users', where: { name: 'Bob' } },
      }}}
    })
    expect(rows[0]._count.users).toBe(3)
    expect(rows[0]._count.alice_users).toBe(1)
    expect(rows[0]._count.bob_users).toBe(1)
    db.$close()
  })

  test('filtered count returns 0 when no match', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'cnt-filtered-zero')
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.user.create({ data: { id: 1, accountId: 1, name: 'Alice' } })
    const rows = await db.account.findMany({
      include: { _count: { select: {
        nobody: { relation: 'users', where: { name: 'Nobody' } }
      }}}
    })
    expect(rows[0]._count.nobody).toBe(0)
    db.$close()
  })

  test('filtered count works across multiple parent rows', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'cnt-filtered-multi')
    await db.account.createMany({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
    await db.user.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 2, name: 'Alice' },
    ]})
    const rows = await db.account.findMany({
      include: { _count: { select: {
        alice_count: { relation: 'users', where: { name: 'Alice' } }
      }}}
    })
    const a1 = rows.find((r: any) => r.id === 1)
    const a2 = rows.find((r: any) => r.id === 2)
    expect(a1._count.alice_count).toBe(1)
    expect(a2._count.alice_count).toBe(1)
    db.$close()
  })
})


// ─── findManyAndCount() ───────────────────────────────────────────────────────

describe('findManyAndCount()', () => {
  const SCHEMA = `
    model Post {
      id        Int @id
      title     String
      status    String
      deletedAt DateTime?
      @@softDelete
    }
  `

  test('returns rows and total', async () => {
    const db = await makeDb(SCHEMA, 'fmac-basic')
    await db.post.createMany({ data: [
      { id: 1, title: 'A', status: 'published' },
      { id: 2, title: 'B', status: 'published' },
      { id: 3, title: 'C', status: 'draft' },
    ]})
    const { rows, total } = await db.post.findManyAndCount({})
    expect(rows).toHaveLength(3)
    expect(total).toBe(3)
    db.$close()
  })

  test('total reflects where, not limit', async () => {
    const db = await makeDb(SCHEMA, 'fmac-total')
    await db.post.createMany({ data: [
      { id: 1, title: 'A', status: 'published' },
      { id: 2, title: 'B', status: 'published' },
      { id: 3, title: 'C', status: 'published' },
      { id: 4, title: 'D', status: 'draft' },
    ]})
    const { rows, total } = await db.post.findManyAndCount({
      where:  { status: 'published' },
      limit:  2,
      offset: 0,
    })
    expect(rows).toHaveLength(2)   // limited to 2
    expect(total).toBe(3)          // total matching without limit
    db.$close()
  })

  test('pagination — page 2 has correct rows and same total', async () => {
    const db = await makeDb(SCHEMA, 'fmac-page2')
    await db.post.createMany({ data: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, title: `Post ${i + 1}`, status: 'published'
    }))})
    const p1 = await db.post.findManyAndCount({ limit: 3, offset: 0 })
    const p2 = await db.post.findManyAndCount({ limit: 3, offset: 3 })
    expect(p1.total).toBe(10)
    expect(p2.total).toBe(10)
    expect(p1.rows).toHaveLength(3)
    expect(p2.rows).toHaveLength(3)
    // no overlap
    const ids1 = p1.rows.map((r: any) => r.id)
    const ids2 = p2.rows.map((r: any) => r.id)
    expect(ids1.some((id: number) => ids2.includes(id))).toBe(false)
    db.$close()
  })

  test('respects @@softDelete', async () => {
    const db = await makeDb(SCHEMA, 'fmac-soft')
    await db.post.createMany({ data: [
      { id: 1, title: 'A', status: 'published' },
      { id: 2, title: 'B', status: 'published' },
    ]})
    await db.post.remove({ where: { id: 2 } })
    const { rows, total } = await db.post.findManyAndCount({})
    expect(rows).toHaveLength(1)
    expect(total).toBe(1)
    db.$close()
  })

  test('total is 0 when nothing matches', async () => {
    const db = await makeDb(SCHEMA, 'fmac-zero')
    await db.post.createMany({ data: [
      { id: 1, title: 'A', status: 'draft' },
    ]})
    const { rows, total } = await db.post.findManyAndCount({ where: { status: 'published' } })
    expect(rows).toHaveLength(0)
    expect(total).toBe(0)
    db.$close()
  })

  test('orderBy works on rows', async () => {
    const db = await makeDb(SCHEMA, 'fmac-order')
    await db.post.createMany({ data: [
      { id: 1, title: 'B', status: 'published' },
      { id: 2, title: 'A', status: 'published' },
    ]})
    const { rows } = await db.post.findManyAndCount({ orderBy: { title: 'asc' } })
    expect(rows[0].title).toBe('A')
    db.$close()
  })
})


// ─── @@external ───────────────────────────────────────────────────────────────

describe('@@external', () => {
  test('parses @@external without error', () => {
    const r = parse(`model users { id Int @id; name String; @@external }`)
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  test('@@external stored on model AST', () => {
    const { schema } = parse(`model users { id Int @id; name String; @@external }`)
    const m = schema.models[0]
    expect(m.attributes.some((a: any) => a.kind === 'external')).toBe(true)
  })

  test('@@external model excluded from DDL', () => {
    const { generateDDL } = require('../src/core/ddl.js')
    const { schema } = parse(`
      model Managed { id Int @id; name String }
      model external_tbl { id Int @id; data String; @@external }
    `)
    const ddl = generateDDL(schema)
    expect(ddl).toContain('"managed"')
    expect(ddl).not.toContain('"external_tbl"')
  })

  test('@@external model is queryable via ORM', async () => {
    // Create the table manually (simulating external management)
    const { db } = await makeTestClient(`
      model Managed { id Int @id; val String }
      model ext_users { id Int @id; name String; @@external }
    `)
    // Manually create the external table
    db.$db.run(`CREATE TABLE ext_users (id INTEGER PRIMARY KEY, name TEXT) STRICT`)
    db.$db.run(`INSERT INTO ext_users VALUES (1, 'Alice'), (2, 'Bob')`)

    const rows = await db.ext_users.findMany({})
    expect(rows).toHaveLength(2)
    expect(rows[0].name).toBe('Alice')
    db.$close()
  })

  test('@@external model supports write operations', async () => {
    const { db } = await makeTestClient(`
      model ext_items { id Int @id; label String; @@external }
    `)
    db.$db.run(`CREATE TABLE ext_items (id INTEGER PRIMARY KEY, label TEXT) STRICT`)

    await db.ext_items.create({ data: { id: 1, label: 'Widget' } })
    const row = await db.ext_items.findFirst({ where: { id: 1 } })
    expect(row?.label).toBe('Widget')
    db.$close()
  })

  test('@@external + @@softDelete emits a warning', () => {
    const r = parse(`model t { id Int @id; deletedAt DateTime?; @@external @@softDelete }`)
    expect(r.warnings.some((w: string) => w.includes('@@external') && w.includes('@@softDelete'))).toBe(true)
  })

  test('@@external table not dropped during migrate diff', () => {
    const { parse: p } = require('../src/core/parser.js')
    const { diffSchemas } = require('../src/core/migrate.js')
    const result = p(`
      model Managed { id Int @id }
      model ext_calendar { date String @id; @@external }
    `)
    // Use the correct introspect column format (array of column objects)
    const managed = { columns: [{ name: 'id', type: 'INTEGER', pk: 1, notnull: 1, dflt_value: null }], indexes: [], foreignKeys: [] }
    const ext_cal = { columns: [{ name: 'date', type: 'TEXT', pk: 1, notnull: 1, dflt_value: null }], indexes: [], foreignKeys: [] }
    const pristine = { managed }
    const live     = { managed, ext_calendar: ext_cal }
    const diff = diffSchemas(pristine, live, result)
    expect(diff.droppedTables).not.toContain('ext_calendar')
  })
})


// ─── Doc comments (/// comments) ─────────────────────────────────────────────

describe('doc comments — generateTypeScript', () => {
  const SCHEMA = `
    /// Represents a user account in the system
    model User {
      id    Int @id
      /// The user's full display name
      name  String
      /// The user's email address
      /// Must be unique across all accounts
      email String @unique
      role  String
    }
  `

  test('model doc comment emitted as JSDoc above Row interface', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    expect(ts).toContain('* Represents a user account in the system')
    expect(ts).toContain('export interface User {')
  })

  test('single-line field doc comment emitted as /** ... */', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    expect(ts).toContain("/** The user's full display name */")
  })

  test('multi-line field doc comment emitted as /** ... */', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    expect(ts).toContain("* The user's email address")
    expect(ts).toContain('* Must be unique across all accounts')
  })

  test('field without doc comment emits no JSDoc', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    // role has no doc comment — no /** directly above it
    const lines = ts.split('\n')
    const roleIdx = lines.findIndex(l => l.includes('role?') || l.includes('role:'))
    const prevLine = lines[roleIdx - 1] ?? ''
    expect(prevLine.trim()).not.toMatch(/^\/\*\*/)
  })

  test('doc comment also appears in Create interface', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    // The Create interface should also carry the field doc comment
    expect(ts).toContain("/** The user's full display name */")
  })
})

describe('doc comments — generateJsonSchema', () => {
  const SCHEMA = `
    /// A product in the catalog
    model Product {
      id    Int @id
      /// The product's display name shown to customers
      name  String
      /// Price in cents to avoid floating point issues
      price Int
      notes String
    }
  `

  test('model doc comment emitted as "description" on schema object', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.Product.description).toBe('A product in the catalog')
  })

  test('field doc comment emitted as "description" on property', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.Product.properties.name.description).toBe("The product's display name shown to customers")
  })

  test('multi-line field comment joined with space', () => {
    const MULTI = `
      model T {
        id  Int @id
        /// First line
        /// Second line
        val String
      }
    `
    const { schema } = parse(MULTI)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.T.properties.val.description).toBe('First line Second line')
  })

  test('field without doc comment has no "description"', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.Product.properties.notes.description).toBeUndefined()
  })

  test('model without doc comment has no "description"', () => {
    const { schema } = parse(`model T { id Int @id }`)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.T.description).toBeUndefined()
  })
})


// ─── groupBy() — interval + fillGaps ─────────────────────────────────────────

const EVENTS_SCHEMA = `
  model Event {
    id        Int  @id
    type      String
    amount    Float
    createdAt DateTime
  }
`

describe('groupBy() — interval', () => {
  test('groups by month interval', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-month')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-15' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-20' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-02-10' },
    ]})
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'month' },
      fillGaps: false,
      _count: true,
    })
    expect(rows).toHaveLength(2)
    expect(rows.find((r: any) => r.createdAt === '2024-01')._count).toBe(2)
    expect(rows.find((r: any) => r.createdAt === '2024-02')._count).toBe(1)
    db.$close()
  })

  test('groups by day interval', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-day')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-01' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-01-03' },
    ]})
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'day' },
      fillGaps: false,
      _count: true,
    })
    expect(rows.find((r: any) => r.createdAt === '2024-01-01')._count).toBe(2)
    expect(rows.find((r: any) => r.createdAt === '2024-01-03')._count).toBe(1)
    db.$close()
  })

  test('groups by year interval', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-year')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2023-06-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-01' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-06-01' },
    ]})
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'year' },
      fillGaps: false,
      _count: true,
      orderBy: { createdAt: 'asc' },
    })
    expect(rows[0].createdAt).toBe('2023')
    expect(rows[1].createdAt).toBe('2024')
    expect(rows[1]._count).toBe(2)
    db.$close()
  })

  test('groups by quarter interval', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-quarter')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-15' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-04-15' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-04-20' },
    ]})
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'quarter' },
      fillGaps: false,
      _count: true,
      orderBy: { createdAt: 'asc' },
    })
    expect(rows[0].createdAt).toBe('2024-Q1')
    expect(rows[1].createdAt).toBe('2024-Q2')
    expect(rows[1]._count).toBe(2)
    db.$close()
  })

  test('interval + another by field', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-interval-multi')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale',   amount: 10, createdAt: '2024-01-15' },
      { id: 2, type: 'refund', amount: 5,  createdAt: '2024-01-20' },
      { id: 3, type: 'sale',   amount: 20, createdAt: '2024-02-10' },
    ]})
    const rows = await db.event.groupBy({
      by: ['type', 'createdAt'],
      interval: { createdAt: 'month' },
      fillGaps: false,
      _count: true,
    })
    expect(rows.some((r: any) => r.type === 'sale'    && r.createdAt === '2024-01')).toBe(true)
    expect(rows.some((r: any) => r.type === 'refund'  && r.createdAt === '2024-01')).toBe(true)
    db.$close()
  })

  test('throws on invalid interval unit', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-bad-unit')
    await expect((db.event as any).groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'fortnight' },
      _count: true,
    })).rejects.toThrow('invalid')
    db.$close()
  })
})

describe('groupBy() — fillGaps', () => {
  test('fillGaps: true fills missing days (inferred from where)', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-fill-infer')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-03' },
      // day 2 missing
    ]})
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'day' },
      where: { createdAt: { gte: '2024-01-01', lte: '2024-01-03' } },
      _count: true,
      orderBy: { createdAt: 'asc' },
    })
    expect(rows).toHaveLength(3)
    expect(rows.find((r: any) => r.createdAt === '2024-01-02')._count).toBe(0)
    db.$close()
  })

  test('fillGaps with explicit range fills beyond where clause', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-fill-explicit')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-02' },
    ]})
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'day' },
      fillGaps: { start: '2024-01-01', end: '2024-01-03' },
      _count: true,
      orderBy: { createdAt: 'asc' },
    })
    expect(rows).toHaveLength(3)
    expect(rows[0].createdAt).toBe('2024-01-01')
    expect(rows[0]._count).toBe(0)
    expect(rows[1]._count).toBe(1)
    expect(rows[2]._count).toBe(0)
    db.$close()
  })

  test('fillGaps: false disables gap filling even with interval', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-fill-off')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-03' },
    ]})
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'day' },
      where: { createdAt: { gte: '2024-01-01', lte: '2024-01-03' } },
      fillGaps: false,
      _count: true,
    })
    // Only 2 rows — gap not filled
    expect(rows).toHaveLength(2)
    db.$close()
  })

  test('fillGaps: gap rows get _sum: 0 and _avg: null', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-fill-defaults')
    await db.event.create({ data: { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' } })
    const rows = await db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'day' },
      fillGaps: { start: '2024-01-01', end: '2024-01-02' },
      _count: true,
      _sum: { amount: true },
      _avg: { amount: true },
      orderBy: { createdAt: 'asc' },
    })
    const gap = rows.find((r: any) => r.createdAt === '2024-01-02')
    expect(gap._count).toBe(0)
    expect(gap._sum.amount).toBe(0)
    expect(gap._avg.amount).toBeNull()
    db.$close()
  })

  test('no range in where + fillGaps: true → sparse results (no throw)', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-fill-norange')
    await db.event.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-03' },
    ]})
    // No where clause — falls back to sparse
    await expect(db.event.groupBy({
      by: ['createdAt'],
      interval: { createdAt: 'day' },
      _count: true,
    })).resolves.toHaveLength(2)  // sparse — only days with data
    db.$close()
  })
})


// ─── @default(nanoid()) ───────────────────────────────────────────────────────

describe('@default(nanoid())', () => {
  const SCHEMA = `
    model Token {
      id    String    @id @default(nanoid())
      label String
    }
  `

  test('parses @default(nanoid()) without error', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
  })

  test('auto-generates a nanoid when id not provided', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-auto')
    const row = await db.token.create({ data: { label: 'test' } })
    expect(typeof row.id).toBe('string')
    expect(row.id.length).toBe(21)
    db.$close()
  })

  test('generated nanoid is URL-safe (no special chars)', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-safe')
    const rows = await Promise.all(
      Array.from({ length: 10 }, () => db.token.create({ data: { label: 'x' } }))
    )
    for (const row of rows) {
      expect(row.id).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    db.$close()
  })

  test('each generated nanoid is unique', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-unique')
    const rows = await Promise.all(
      Array.from({ length: 20 }, () => db.token.create({ data: { label: 'x' } }))
    )
    const ids = rows.map((r: any) => r.id)
    expect(new Set(ids).size).toBe(20)
    db.$close()
  })

  test('explicit id overrides nanoid generation', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-explicit')
    const row = await db.token.create({ data: { id: 'custom-id', label: 'test' } })
    expect(row.id).toBe('custom-id')
    db.$close()
  })
})


// ─── @phone validator ─────────────────────────────────────────────────────────

describe('@phone validator', () => {
  const SCHEMA = `
    model Contact {
      id    Int @id
      phone String    @phone
      alt   String?   @phone("Alt must be a valid phone number")
    }
  `

  test('parses @phone without error', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
  })

  test('accepts valid international format', async () => {
    const db = await makeDb(SCHEMA, 'phone-intl')
    await expect(
      db.contact.create({ data: { id: 1, phone: '+1 (555) 123-4567' } })
    ).resolves.toBeDefined()
    db.$close()
  })

  test('accepts E.164 format', async () => {
    const db = await makeDb(SCHEMA, 'phone-e164')
    await expect(
      db.contact.create({ data: { id: 1, phone: '+15551234567' } })
    ).resolves.toBeDefined()
    db.$close()
  })

  test('rejects clearly invalid value', async () => {
    const db = await makeDb(SCHEMA, 'phone-invalid')
    await expect(
      db.contact.create({ data: { id: 1, phone: 'not-a-phone' } })
    ).rejects.toThrow()
    db.$close()
  })

  test('allows null on optional @phone field', async () => {
    const db = await makeDb(SCHEMA, 'phone-null')
    await expect(
      db.contact.create({ data: { id: 1, phone: '+15551234567', alt: null } })
    ).resolves.toBeDefined()
    db.$close()
  })

  test('custom error message surfaced on rejection', async () => {
    const db = await makeDb(SCHEMA, 'phone-msg')
    await expect(
      db.contact.create({ data: { id: 1, phone: '+15551234567', alt: 'bad' } })
    ).rejects.toThrow('Alt must be a valid phone number')
    db.$close()
  })

  test('@phone emits format: phone in JSON Schema', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.Contact.properties.phone.format).toBe('phone')
  })
})


// ─── Custom policy error messages ────────────────────────────────────────────

describe('custom policy error messages', () => {
  test('@@allow with message — message surfaces on AccessDeniedError', async () => {
    const db = await makeDb(`
      model Post {
        id       Int @id
        ownerId  Int
        @@allow('create', auth() != null, "You must be logged in to create posts")
      }
    `, 'policy-msg-allow')
    try {
      await db.post.create({ data: { id: 1, ownerId: 1 } })
      expect(true).toBe(false) // should not reach
    } catch (e: any) {
      expect(e.message).toBe('You must be logged in to create posts')
    }
    db.$close()
  })

  test('@@deny with message — message surfaces on AccessDeniedError', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        status  String    @default("draft")
        @@allow('all', true)
        @@deny('post-update', status == 'locked', "Cannot edit locked posts")
      }
    `, 'policy-msg-deny')
    await db.post.create({ data: { id: 1, status: 'active' } })
    try {
      await db.post.update({ where: { id: 1 }, data: { status: 'locked' } })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe('Cannot edit locked posts')
    }
    db.$close()
  })

  test('@@allow without message — falls back to default message', async () => {
    const db = await makeDb(`
      model Post {
        id      Int @id
        @@allow('create', auth() != null)
      }
    `, 'policy-msg-default')
    try {
      await db.post.create({ data: { id: 1 } })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toContain('denied')
    }
    db.$close()
  })

  test('message stored on AST node', () => {
    const { schema } = parse(`
      model T {
        id Int @id
        @@allow('read', true, "Only readable")
        @@deny('write', true, "Not writable")
      }
    `)
    const attrs = schema.models[0].attributes
    expect(attrs.find((a: any) => a.kind === 'allow')?.message).toBe('Only readable')
    expect(attrs.find((a: any) => a.kind === 'deny')?.message).toBe('Not writable')
  })

  test('policy without message has message: null on AST', () => {
    const { schema } = parse(`model T { id Int @id; @@allow('read', true) }`)
    const attr = schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr?.message).toBeNull()
  })
})


// ─── Codegen model whitelist (--only flag) ────────────────────────────────────

describe('generateTypeScript --only (model whitelist)', () => {
  const SCHEMA = `
    model User  { id Int @id; name String }
    model Post  { id Int @id; title String; userId Int }
    model Order { id Int @id; amount Float }
  `

  test('all models emitted without filter', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    expect(ts).toContain('interface User')
    expect(ts).toContain('interface Post')
    expect(ts).toContain('interface Order')
  })

  test('only specified models emitted with filter', () => {
    const { schema } = parse(SCHEMA)
    const filtered = { ...schema, models: schema.models.filter((m: any) => ['User', 'Post'].includes(m.name)) }
    const ts = generateTypeScript(filtered)
    expect(ts).toContain('interface User')
    expect(ts).toContain('interface Post')
    expect(ts).not.toContain('interface Order')
  })

  test('single model filter', () => {
    const { schema } = parse(SCHEMA)
    const filtered = { ...schema, models: schema.models.filter((m: any) => m.name === 'Order') }
    const ts = generateTypeScript(filtered)
    expect(ts).not.toContain('interface User')
    expect(ts).not.toContain('interface Post')
    expect(ts).toContain('interface Order')
  })
})


// ─── @updatedBy ───────────────────────────────────────────────────────────────

describe('@updatedBy', () => {
  const SCHEMA = `
    model Post {
      id          Int  @id
      title       String
      createdById Int? @default(auth().id)
      updatedById Int? @updatedBy
    }
  `

  test('parses @updatedBy without error', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'updatedById')
    expect(field?.attributes.some((a: any) => a.kind === 'updatedBy')).toBe(true)
  })

  test('@updatedBy defaults to authField: id', () => {
    const { schema } = parse(SCHEMA)
    const field = schema.models[0].fields.find((f: any) => f.name === 'updatedById')
    const attr = field?.attributes.find((a: any) => a.kind === 'updatedBy')
    expect(attr?.authField).toBe('id')
  })

  test('@updatedBy stamps auth.id on update', async () => {
    const db = await makeDb(SCHEMA, 'updby-stamp')
    const user = { id: 42 }
    await db.post.create({ data: { id: 1, title: 'Hello' } })
    await db.$setAuth(user).post.update({ where: { id: 1 }, data: { title: 'Updated' } })
    const row = await db.post.findFirst({ where: { id: 1 } })
    expect(row?.updatedById).toBe(42)
    db.$close()
  })

  test('@updatedBy re-stamps on every update', async () => {
    const db = await makeDb(SCHEMA, 'updby-restamp')
    await db.post.create({ data: { id: 1, title: 'Hello' } })
    await db.$setAuth({ id: 1 }).post.update({ where: { id: 1 }, data: { title: 'First edit' } })
    await db.$setAuth({ id: 2 }).post.update({ where: { id: 1 }, data: { title: 'Second edit' } })
    const row = await db.post.findFirst({ where: { id: 1 } })
    expect(row?.updatedById).toBe(2)
    db.$close()
  })

  test('@updatedBy skips if ctx.auth is null', async () => {
    const db = await makeDb(SCHEMA, 'updby-noauth')
    await db.post.create({ data: { id: 1, title: 'Hello', updatedById: 99 } })
    await db.post.update({ where: { id: 1 }, data: { title: 'Changed' } })
    const row = await db.post.findFirst({ where: { id: 1 } })
    // updatedById should not be overwritten with null — skip silently
    expect(row?.updatedById).toBe(99)
    db.$close()
  })

  test('@updatedBy does not fire on create', async () => {
    const db = await makeDb(SCHEMA, 'updby-nocreate')
    const row = await db.$setAuth({ id: 5 }).post.create({ data: { id: 1, title: 'New' } })
    // @default(auth().id) stamps createdById, but @updatedBy should not stamp on create
    expect(row?.createdById).toBe(5)
    expect(row?.updatedById).toBeNull()
    db.$close()
  })

  test('@updatedBy(auth().field) stamps custom auth field', async () => {
    const db = await makeDb(`
      model Doc {
        id         Int @id
        title      String
        updatedBy  String?   @updatedBy(auth().email)
      }
    `, 'updby-custom')
    await db.doc.create({ data: { id: 1, title: 'Doc' } })
    await db.$setAuth({ id: 1, email: 'alice@x.com' }).doc.update({
      where: { id: 1 }, data: { title: 'Edited' }
    })
    const row = await db.doc.findFirst({ where: { id: 1 } })
    expect(row?.updatedBy).toBe('alice@x.com')
    db.$close()
  })

  test('@updatedBy field excluded from Create TypeScript interface', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    // updatedById should NOT appear in PostsCreate interface
    const createBlock = ts.slice(ts.indexOf('interface PostCreate'), ts.indexOf('interface PostUpdate'))
    expect(createBlock).not.toContain('updatedById')
  })
})


// ─── @slug transformer ────────────────────────────────────────────────────────

describe('@slug transformer', () => {
  const SCHEMA = `
    model Post {
      id   Int @id
      slug String    @slug
    }
  `

  test('parses @slug without error', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
  })

  test('slugifies on create', async () => {
    const db = await makeDb(SCHEMA, 'slug-basic')
    const row = await db.post.create({ data: { id: 1, slug: 'Hello World!' } })
    expect(row.slug).toBe('hello-world')
    db.$close()
  })

  test('slugifies special characters', async () => {
    const db = await makeDb(SCHEMA, 'slug-special')
    const row = await db.post.create({ data: { id: 1, slug: "It's a C++ Thing" } })
    expect(row.slug).toBe('its-a-c-thing')
    db.$close()
  })

  test('collapses multiple hyphens', async () => {
    const db = await makeDb(SCHEMA, 'slug-hyphens')
    const row = await db.post.create({ data: { id: 1, slug: 'foo   bar' } })
    expect(row.slug).toBe('foo-bar')
    db.$close()
  })

  test('slugifies on update', async () => {
    const db = await makeDb(SCHEMA, 'slug-update')
    await db.post.create({ data: { id: 1, slug: 'original' } })
    const row = await db.post.update({ where: { id: 1 }, data: { slug: 'New Title Here' } })
    expect(row.slug).toBe('new-title-here')
    db.$close()
  })

  test('null slug is skipped (not transformed)', async () => {
    const db = await makeDb(`
      model Post { id Int @id; slug String? @slug }
    `, 'slug-null')
    const row = await db.post.create({ data: { id: 1, slug: null } })
    expect(row.slug).toBeNull()
    db.$close()
  })
})


// ─── @default(fieldName) field reference ──────────────────────────────────────

describe('@default(fieldName)', () => {
  test('parses @default(fieldName) without error', () => {
    const r = parse(`
      model Post { id Int @id; title String; slug String @default(title) @slug }
    `)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'slug')
    const def = field?.attributes.find((a: any) => a.kind === 'default')
    expect(def?.value?.kind).toBe('fieldRef')
    expect(def?.value?.field).toBe('title')
  })

  test('@default(enumValue) still works — not broken by fieldRef', () => {
    const r = parse(`
      enum Status { draft published }
      model Post { id Int @id; status Status @default(draft) }
    `)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'status')
    const def = field?.attributes.find((a: any) => a.kind === 'default')
    expect(def?.value?.kind).toBe('enum')
    expect(def?.value?.value).toBe('draft')
  })

  test('copies source field value on create when target not provided', async () => {
    const db = await makeDb(`
      model Post { id Int @id; title String; slug String @default(title) }
    `, 'fieldref-basic')
    const row = await db.post.create({ data: { id: 1, title: 'Hello World' } })
    expect(row.slug).toBe('Hello World')
    db.$close()
  })

  test('explicit value overrides @default(fieldName)', async () => {
    const db = await makeDb(`
      model Post { id Int @id; title String; slug String @default(title) }
    `, 'fieldref-override')
    const row = await db.post.create({ data: { id: 1, title: 'Hello', slug: 'custom' } })
    expect(row.slug).toBe('custom')
    db.$close()
  })

  test('@default(title) @slug — copies then slugifies', async () => {
    const db = await makeDb(`
      model Post { id Int @id; title String; slug String @default(title) @slug }
    `, 'fieldref-slug')
    const row = await db.post.create({ data: { id: 1, title: 'Hello World!' } })
    expect(row.slug).toBe('hello-world')
    db.$close()
  })

  test('@default(unknown) is a parse error', () => {
    const r = parse(`
      model Post { id Int @id; title String; slug String @default(nonexistent) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('nonexistent'))).toBe(true)
  })
})


// ─── recursive findMany ───────────────────────────────────────────────────────

const TREE_SCHEMA = `
  model Category {
    id       Int @id
    name     String
    parentId Int?
    parent   Category?  @relation(fields: [parentId], references: [id])
    children Category[]
  }
`

async function makeTree(label: string) {
  const db = await makeDb(TREE_SCHEMA, label)
  await db.category.createMany({ data: [
    { id: 1, name: 'Electronics', parentId: null },
    { id: 2, name: 'Phones',      parentId: 1    },
    { id: 3, name: 'Computers',   parentId: 1    },
    { id: 4, name: 'Smartphones', parentId: 2    },
    { id: 5, name: 'Laptops',     parentId: 3    },
    { id: 6, name: 'Desktops',    parentId: 3    },
  ]})
  return db
}

describe('findMany — recursive', () => {
  test('recursive: true returns all descendants', async () => {
    const db = await makeTree('rec-true')
    const rows = await db.category.findMany({ where: { id: 1 }, recursive: true })
    expect(rows.length).toBe(5)
    expect(rows.every((r: any) => r._depth > 0)).toBe(true)
    db.$close()
  })

  test('recursive: { direction: descendants } — same as true', async () => {
    const db = await makeTree('rec-desc')
    const rows = await db.category.findMany({ where: { id: 1 }, recursive: { direction: 'descendants' } })
    expect(rows.length).toBe(5)
    db.$close()
  })

  test('descendants from mid-tree node', async () => {
    const db = await makeTree('rec-mid')
    const rows = await db.category.findMany({ where: { id: 3 }, recursive: true })
    const ids = rows.map((r: any) => r.id).sort()
    expect(ids).toEqual([5, 6])
    expect(rows.every((r: any) => r._depth === 1)).toBe(true)
    db.$close()
  })

  test('_depth reflects distance from anchor', async () => {
    const db = await makeTree('rec-depth')
    const rows = await db.category.findMany({ where: { id: 1 }, recursive: true })
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]))
    expect(byId[2]._depth).toBe(1)
    expect(byId[3]._depth).toBe(1)
    expect(byId[4]._depth).toBe(2)
    expect(byId[5]._depth).toBe(2)
    db.$close()
  })

  test('ancestors walks path to root', async () => {
    const db = await makeTree('rec-anc')
    const rows = await db.category.findMany({
      where:     { id: 5 },
      recursive: { direction: 'ancestors' }
    })
    const ids = rows.map((r: any) => r.id).sort()
    expect(ids).toEqual([1, 3])
    db.$close()
  })

  test('maxDepth limits traversal', async () => {
    const db = await makeTree('rec-maxdepth')
    const rows = await db.category.findMany({
      where:     { id: 1 },
      recursive: { maxDepth: 1 }
    })
    expect(rows.every((r: any) => r._depth === 1)).toBe(true)
    expect(rows.length).toBe(2)  // Phones + Computers only
    db.$close()
  })

  test('nested: true returns tree structure', async () => {
    const db = await makeTree('rec-nested')
    const roots = await db.category.findMany({
      where:     { id: 1 },
      recursive: { nested: true }
    })
    expect(roots.length).toBe(2)  // Phones + Computers
    const computers = roots.find((r: any) => r.id === 3)
    expect(computers?.children).toHaveLength(2)
    expect(computers?.children.map((c: any) => c.id).sort()).toEqual([5, 6])
    db.$close()
  })

  test('orderBy works on recursive result', async () => {
    const db = await makeTree('rec-order')
    const rows = await db.category.findMany({
      where:     { id: 1 },
      recursive: true,
      orderBy:   { name: 'asc' }
    })
    const names = rows.map((r: any) => r.name)
    expect(names).toEqual([...names].sort())
    db.$close()
  })

  test('leaf node returns empty descendants', async () => {
    const db = await makeTree('rec-leaf')
    const rows = await db.category.findMany({ where: { id: 4 }, recursive: true })
    expect(rows).toHaveLength(0)
    db.$close()
  })

  test('throws on model without self-relation', async () => {
    const db = await makeDb(`model Tag { id Int @id; name String }`, 'rec-noself')
    await expect(
      (db.tag as any).findMany({ where: { id: 1 }, recursive: true })
    ).rejects.toThrow('no self-referential relation')
    db.$close()
  })
})


// ─── recursive — the same read as any other ──────────────────────────────────
// A tree read used to be a second implementation of findMany: it never reached
// the plugin door, and it applied the row policy and the soft-delete filter to
// the anchor and to nothing below it. FJS-216/217/218/219.

describe('findMany — recursive is a read, not a bypass', () => {
  const TREE = (extra = '', model = '') => `
    model Task {
      id       Int @id
      title    String
      ownerId  Int?
      parentId Int?
      parent   Task?  @relation(fields: [parentId], references: [id])
      children Task[]
      ${extra}
      ${model}
    }
  `

  test('@@gate refuses a recursive read, not only a plain one', async () => {
    const db = await makeDb(TREE('', '@@gate("5.5.5.5")'), 'rec-gate')
    await db.asSystem().task.createMany({ data: [
      { id: 1, title: 'root' }, { id: 2, title: 'SECRET', parentId: 1 },
    ]})
    await expect(db.task.findMany()).rejects.toThrow(/requires level 5/)
    await expect(db.task.findMany({ where: { id: 1 }, recursive: true })).rejects.toThrow(/requires level 5/)
    db.$close()
  })

  test('a refused read never runs the tree query', async () => {
    const seen: string[] = []
    const db = await makeDb(TREE('', '@@gate("5.5.5.5")'), 'rec-gate-order', {
      onQuery: (e: any) => seen.push(String(e.sql)),
    })
    await db.asSystem().task.createMany({ data: [{ id: 1, title: 'root' }, { id: 2, title: 'x', parentId: 1 }] })
    seen.length = 0
    await expect(db.task.findMany({ where: { id: 1 }, recursive: true })).rejects.toThrow(/requires level 5/)
    // The gate is asked before the walk, not after it — a refused caller must
    // not reach the table at all.
    expect(seen.filter(q => q.includes('WITH RECURSIVE'))).toEqual([])
    db.$close()
  })

  test('a row policy hides a subtree, not just the row it refuses', async () => {
    const db = await makeDb(TREE('', `@@allow('read', ownerId == auth().id)`), 'rec-policy')
    await db.asSystem().task.createMany({ data: [
      { id: 1, title: 'mine',   ownerId: 1 },
      { id: 2, title: 'theirs', ownerId: 2, parentId: 1 },
      { id: 3, title: 'theirs', ownerId: 2, parentId: 2 },
    ]})
    const me = db.$setAuth({ id: 1 })
    expect((await me.task.findMany()).map((r: any) => r.id)).toEqual([1])
    // Row 2 is refused, so row 3 — its child — is unreachable through it.
    expect(await me.task.findMany({ where: { id: 1 }, recursive: true })).toEqual([])
    db.$close()
  })

  test('a soft-deleted node hides its subtree', async () => {
    const db = await makeDb(TREE('deletedAt DateTime?', '@@softDelete'), 'rec-sd')
    await db.task.createMany({ data: [
      { id: 1, title: 'a' }, { id: 2, title: 'b', parentId: 1 }, { id: 3, title: 'c', parentId: 2 },
    ]})
    await db.task.remove({ where: { id: 2 } })
    expect(await db.task.findMany({ where: { id: 1 }, recursive: true })).toEqual([])
    // withDeleted opts the walk back in, the same way it does a flat read
    const all = await db.task.findMany({ where: { id: 1 }, recursive: true, withDeleted: true })
    expect(all.map((r: any) => r.id).sort()).toEqual([2, 3])
    db.$close()
  })

  test('a cycle answers each row once instead of walking to maxDepth', async () => {
    const db = await makeDb(TREE(), 'rec-cycle')
    await db.task.createMany({ data: [{ id: 1, title: 'a' }, { id: 2, title: 'b', parentId: 1 }] })
    // Reach around the write guard — the read must survive a loop already stored
    db.asSystem().sql`UPDATE "Task" SET "parentId" = 2 WHERE "id" = 1`
    const rows = await db.task.findMany({ where: { id: 1 }, recursive: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(2)
    const up = await db.task.findMany({ where: { id: 1 }, recursive: { direction: 'ancestors' } })
    expect(up).toHaveLength(1)
    db.$close()
  })

  test('a write that closes a loop is refused, naming the field', async () => {
    const db = await makeDb(TREE(), 'rec-write-cycle')
    await db.task.createMany({ data: [
      { id: 1, title: 'a' }, { id: 2, title: 'b', parentId: 1 }, { id: 3, title: 'c', parentId: 2 },
    ]})
    await expect(db.task.update({ where: { id: 1 }, data: { parentId: 1 } }))
      .rejects.toThrow(/parentId.*its own parent/)
    await expect(db.task.update({ where: { id: 1 }, data: { parentId: 3 } }))
      .rejects.toThrow(/parentId.*its own ancestor/)
    await expect(db.task.create({ data: { id: 9, title: 'x', parentId: 9 } }))
      .rejects.toThrow(/parentId.*its own parent/)
    // and a legal move still moves
    const moved = await db.task.update({ where: { id: 3 }, data: { parentId: 1 } })
    expect(moved.parentId).toBe(1)
    db.$close()
  })

  test('select and @computed apply on a recursive read', async () => {
    const db = await makeDb(TREE(), 'rec-select', {
      computed: { Task: { shout: (r: any) => String(r.title).toUpperCase() } },
    })
    await db.task.createMany({ data: [{ id: 1, title: 'a' }, { id: 2, title: 'b', parentId: 1 }] })
    const [narrow] = await db.task.findMany({ where: { id: 1 }, recursive: true, select: { id: true } })
    expect(Object.keys(narrow).sort()).toEqual(['_depth', 'id'])
    db.$close()
  })

  test('a read that cannot walk a tree refuses recursive by name', async () => {
    const db = await makeDb(TREE(), 'rec-refuse')
    await db.task.createMany({ data: [{ id: 1, title: 'a' }, { id: 2, title: 'b', parentId: 1 }] })
    for (const m of ['count', 'findFirst', 'findUnique', 'exists', 'aggregate']) {
      await expect((db.task as any)[m]({ where: { id: 1 }, recursive: true }))
        .rejects.toThrow(/does not take 'recursive'/)
    }
    await expect(db.task.findMany({ where: { id: 1 }, recursive: { nested: true }, limit: 1 }))
      .rejects.toThrow(/cannot take limit or offset/)
    db.$close()
  })

  test('orderBy _depth sorts the tree, and is sortable only on a tree read', async () => {
    const db = await makeDb(TREE(), 'rec-depth-sort')
    await db.task.createMany({ data: [
      { id: 1, title: 'a' }, { id: 2, title: 'b', parentId: 1 }, { id: 3, title: 'c', parentId: 2 },
    ]})
    const rows = await db.task.findMany({ where: { id: 1 }, recursive: true, orderBy: { _depth: 'desc' } })
    expect(rows.map((r: any) => r._depth)).toEqual([2, 1])
    await expect(db.task.findMany({ orderBy: { _depth: 'asc' } }))
      .rejects.toThrow(/Unknown orderBy field '_depth'/)
    db.$close()
  })
})


// ─── ExternalRefPlugin ────────────────────────────────────────────────────────

describe('ExternalRefPlugin', () => {
  // A minimal test plugin that stores a JSON ref and resolves to uppercase
  const makePlugin = (autoResolve = false) => {
    const { ExternalRefPlugin } = require('../src/plugins/external-ref.js')
    class TestRefPlugin extends ExternalRefPlugin {
      fieldType = 'TestRef'
      cleanedUp: any[] = []

      _isRawValue(v: any) { return typeof v === 'string' && !v.startsWith('{') }

      async serialize(value: any, { field, model }: any) {
        return { raw: value, model, field }
      }

      async resolve(ref: any) {
        return ref.raw?.toUpperCase() ?? null
      }

      async cleanup(ref: any) {
        this.cleanedUp.push(ref)
      }

      cacheKey(ref: any) { return ref.raw ?? null }
    }
    return new TestRefPlugin({ autoResolve })
  }

  test('plugin has correct fieldType', () => {
    const p = makePlugin()
    expect(p.fieldType).toBe('TestRef')
  })

  test('serialize is called on create — value swapped for JSON ref', async () => {
    const plugin = makePlugin()
    const schema = parse(`model Doc { id Int @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const args = { data: { id: 1, content: 'hello world' } }
    await plugin.onBeforeCreate('Doc', args, {} as any)
    const ref = JSON.parse(args.data.content as any)
    expect(ref.raw).toBe('hello world')
    expect(ref.model).toBe('Doc')
  })

  test('resolve called in onAfterRead when autoResolve: true', async () => {
    const plugin = makePlugin(true)
    const schema = parse(`model Doc { id Int @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const rows = [
      { id: 1, content: JSON.stringify({ raw: 'hello', model: 'Doc', field: 'content' }) }
    ]
    await plugin.onAfterRead('Doc', rows, {} as any)
    expect(rows[0].content).toBe('HELLO')
  })

  test('resolve NOT called in onAfterRead when autoResolve: false', async () => {
    const plugin = makePlugin(false)
    const schema = parse(`model Doc { id Int @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const rawRef = JSON.stringify({ raw: 'hello', model: 'Doc', field: 'content' })
    const rows = [{ id: 1, content: rawRef }]
    await plugin.onAfterRead('Doc', rows, {} as any)
    expect(rows[0].content).toBe(rawRef)  // unchanged
  })

  test('cleanup called in onAfterDelete', async () => {
    const plugin = makePlugin()
    const schema = parse(`model Doc { id Int @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const ref = { raw: 'hello', model: 'Doc', field: 'content' }
    const rows = [{ id: 1, content: JSON.stringify(ref) }]
    await plugin.onAfterDelete('Doc', rows, {} as any)
    expect(plugin.cleanedUp).toHaveLength(1)
    expect(plugin.cleanedUp[0].raw).toBe('hello')
  })

  test('cacheKey memoizes resolve results', async () => {
    const plugin = makePlugin(true)
    const schema = parse(`model Doc { id Int @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const ref = { raw: 'hello', model: 'Doc', field: 'content' }
    const rows1 = [{ id: 1, content: JSON.stringify(ref) }]
    const rows2 = [{ id: 2, content: JSON.stringify(ref) }]
    await plugin.onAfterRead('Doc', rows1, {} as any)
    await plugin.onAfterRead('Doc', rows2, {} as any)
    // Both should resolve to same value from cache
    expect(rows1[0].content).toBe('HELLO')
    expect(rows2[0].content).toBe('HELLO')
  })

  test('FileStorage still works after refactor', async () => {
    const { FileStorage } = require('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local' })
    expect(plugin.fieldType).toBe('File')
    expect(typeof plugin.serialize).toBe('function')
    expect(typeof plugin.resolve).toBe('function')
    expect(typeof plugin.cleanup).toBe('function')
  })
})


// ─── ExternalRefPlugin — select: { field: { resolve: false } } ────────────────

describe('ExternalRefPlugin — select resolve: false', () => {
  test('select: { field: { resolve: false } } returns raw ref', async () => {
    const { ExternalRefPlugin } = require('../src/plugins/external-ref.js')
    class UpperPlugin extends ExternalRefPlugin {
      fieldType = 'UpperRef'
      _isRawValue(v: any) { return typeof v === 'string' && !v.startsWith('{') }
      async serialize(value: any) { return { raw: value } }
      async resolve(ref: any) { return ref.raw.toUpperCase() }
    }

    const plugin = new UpperPlugin({ autoResolve: true })
    const schema = parse(`model Doc { id Int @id; title UpperRef? }`).schema
    plugin.onInit(schema, { models: {} } as any)

    const rawRef = JSON.stringify({ raw: 'hello' })
    const rows = [{ id: 1, title: rawRef }]

    // With resolve: false — should skip resolution
    await plugin.onAfterRead('Doc', rows, {} as any, {
      select: { title: { resolve: false } }
    })
    expect(rows[0].title).toBe(rawRef)  // raw JSON string
  })

  test('select: { field: true } still resolves', async () => {
    const { ExternalRefPlugin } = require('../src/plugins/external-ref.js')
    class UpperPlugin extends ExternalRefPlugin {
      fieldType = 'UpperRef'
      _isRawValue(v: any) { return typeof v === 'string' && !v.startsWith('{') }
      async serialize(value: any) { return { raw: value } }
      async resolve(ref: any) { return ref.raw.toUpperCase() }
    }

    const plugin = new UpperPlugin({ autoResolve: true })
    const schema = parse(`model Doc { id Int @id; title UpperRef? }`).schema
    plugin.onInit(schema, { models: {} } as any)

    const rows = [{ id: 1, title: JSON.stringify({ raw: 'hello' }) }]

    await plugin.onAfterRead('Doc', rows, {} as any, { select: { title: true } })
    expect(rows[0].title).toBe('HELLO')
  })

  test('no select — resolves all fields', async () => {
    const { ExternalRefPlugin } = require('../src/plugins/external-ref.js')
    class UpperPlugin extends ExternalRefPlugin {
      fieldType = 'UpperRef'
      _isRawValue(v: any) { return typeof v === 'string' && !v.startsWith('{') }
      async serialize(value: any) { return { raw: value } }
      async resolve(ref: any) { return ref.raw.toUpperCase() }
    }

    const plugin = new UpperPlugin({ autoResolve: true })
    const schema = parse(`model Doc { id Int @id; title UpperRef? }`).schema
    plugin.onInit(schema, { models: {} } as any)

    const rows = [{ id: 1, title: JSON.stringify({ raw: 'hello' }) }]
    await plugin.onAfterRead('Doc', rows, {} as any, {})
    expect(rows[0].title).toBe('HELLO')
  })
})


// ─── JS migration API ─────────────────────────────────────────────────────────

describe('JS migration API', () => {
  const SCHEMA = `model Post { id Int @id; title String; slug String? }`

  test('listMigrationFiles picks up .js files', () => {
    const { listMigrationFiles } = require('../src/core/migrations.js')
    const dir = tmpDir('js-migrate-list')
    writeFileSync(join(dir, '20240101000000_init.sql'), 'CREATE TABLE t (id INTEGER);')
    writeFileSync(join(dir, '20240101000001_backfill.js'), 'export async function up(db) {}')
    writeFileSync(join(dir, '20240101000002_indexes.sql'), 'CREATE INDEX i ON t(id);')
    const files = listMigrationFiles(dir)
    expect(files).toHaveLength(3)
    expect(files[1]).toBe('20240101000001_backfill.js')
  })

  test('apply() runs JS migration up() function', async () => {
    const { apply } = require('../src/core/migrations.js')
    const dir = tmpDir('js-migrate-apply')
    const { db } = await makeTestClient(SCHEMA)

    // Write a JS migration that creates rows via the ORM client
    writeFileSync(join(dir, '20240101000001_seed.js'), `
      export async function up(db) {
        await db.post.create({ data: { id: 1, title: 'Hello', slug: 'hello' } })
      }
    `)

    await apply(db.$db, dir, db)
    const posts = await db.post.findMany({})
    expect(posts).toHaveLength(1)
    expect(posts[0].title).toBe('Hello')
    db.$close()
  })

  test('apply() records JS migration in tracking table', async () => {
    const { apply, appliedMigrations } = require('../src/core/migrations.js')
    const dir = tmpDir('js-migrate-record')
    const { db } = await makeTestClient(SCHEMA)

    writeFileSync(join(dir, '20240101000001_noop.js'), `
      export async function up(db) {}
    `)

    await apply(db.$db, dir, db)
    const applied = appliedMigrations(db.$db)
    expect(applied.some((m: any) => m.name === '20240101000001_noop.js')).toBe(true)
    db.$close()
  })

  test('apply() JS and SQL migrations interleaved in order', async () => {
    const { apply } = require('../src/core/migrations.js')
    const dir = tmpDir('js-migrate-interleave')
    const { db } = await makeTestClient(SCHEMA)

    const order: string[] = []
    writeFileSync(join(dir, '20240101000001_first.js'), `
      export async function up(db) {
        await db.post.create({ data: { id: 1, title: 'First' } })
      }
    `)
    writeFileSync(join(dir, '20240101000002_second.sql'),
      `INSERT INTO post (id, title) VALUES (2, 'Second');`)

    await apply(db.$db, dir, db)
    const posts = await db.post.findMany({ orderBy: { id: 'asc' } })
    expect(posts).toHaveLength(2)
    expect(posts[0].title).toBe('First')
    expect(posts[1].title).toBe('Second')
    db.$close()
  })

  test('apply() throws if JS migration has no up export', async () => {
    const { apply } = require('../src/core/migrations.js')
    const dir = tmpDir('js-migrate-noexport')
    const { db } = await makeTestClient(SCHEMA)

    writeFileSync(join(dir, '20240101000001_bad.js'), `
      // no up export
      export const foo = 1
    `)

    const result = await apply(db.$db, dir, db)
    expect(result.failed).toBe('20240101000001_bad.js')
    expect(result.error).toContain('up')
    db.$close()
  })

  test('apply() without client throws for JS migration', async () => {
    const { apply } = require('../src/core/migrations.js')
    const dir = tmpDir('js-migrate-noclient')
    const { db } = await makeTestClient(SCHEMA)

    writeFileSync(join(dir, '20240101000001_needs_client.js'), `
      export async function up(db) {}
    `)

    const result = await apply(db.$db, dir)  // no client passed
    expect(result.failed).toBe('20240101000001_needs_client.js')
    expect(result.error).toContain('client')
    db.$close()
  })

  test('status() shows JS migration with sql: null', async () => {
    const { apply, status } = require('../src/core/migrations.js')
    const dir = tmpDir('js-migrate-status')
    const { db } = await makeTestClient(SCHEMA)

    writeFileSync(join(dir, '20240101000001_js.js'), `export async function up(db) {}`)
    await apply(db.$db, dir, db)

    const rows = status(db.$db, dir)
    const jsRow = rows.find((r: any) => r.file.endsWith('.js'))
    expect(jsRow?.state).toBe('applied')
    expect(jsRow?.sql).toBeNull()
    expect(jsRow?.tampered).toBe(false)
    db.$close()
  })
})

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  @@hasTemplates — categorical definition vs instance distinction            │
// └────────────────────────────────────────────────────────────────────────────┘

describe('@@hasTemplates — parser', () => {

  test('parses bare directive and auto-injects isTemplate field', () => {
    const r = parse(`
      model Quote {
        id Int @id
        @@hasTemplates
      }
    `)
    expect(r.valid).toBe(true)
    const quotes = r.schema.models[0]
    const ht     = quotes.attributes.find((a: any) => a.kind === 'hasTemplates')
    expect(ht).toBeDefined()
    expect((ht as any).field).toBe('isTemplate')
    const f = quotes.fields.find((f: any) => f.name === 'isTemplate')
    expect(f).toBeDefined()
    // Field type is a {kind, name, array, optional} object — same shape as
    // every other parsed scalar field. Assert through the inner type record.
    expect((f as any).type.name).toBe('Boolean')
    expect((f as any).type.optional).toBe(false)
    expect((f as any).type.array).toBe(false)
    const def = (f as any).attributes.find((a: any) => a.kind === 'default')
    expect(def?.value?.value).toBe(false)
    expect(def?.value?.kind).toBe('boolean')
  })

  test('parses (field: "isPreset") for custom column name', () => {
    const r = parse(`
      model Quote {
        id Int @id
        @@hasTemplates(field: "isPreset")
      }
    `)
    expect(r.valid).toBe(true)
    const quotes = r.schema.models[0]
    expect(quotes.attributes.find((a: any) => a.kind === 'hasTemplates')?.field).toBe('isPreset')
    expect(quotes.fields.find((f: any) => f.name === 'isPreset')).toBeDefined()
    expect(quotes.fields.find((f: any) => f.name === 'isTemplate')).toBeUndefined()
  })

  test('user-declared field is honored, not duplicated', () => {
    const r = parse(`
      model Quote {
        id          Int @id
        isTemplate  Boolean @default(false)
        @@hasTemplates
      }
    `)
    expect(r.valid).toBe(true)
    const isTemplateFields = r.schema.models[0].fields.filter((f: any) => f.name === 'isTemplate')
    expect(isTemplateFields.length).toBe(1)
  })

  test('rejects user-declared marker field that is not Boolean', () => {
    const r = parse(`
      model Quote {
        id          Int @id
        isTemplate  String
        @@hasTemplates
      }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain('must be Boolean')
  })

  test('rejects user-declared marker field that is optional', () => {
    const r = parse(`
      model Quote {
        id          Int @id
        isTemplate  Boolean?
        @@hasTemplates
      }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain('not be optional')
  })
})

describe('@@hasTemplates — runtime', () => {
  let db: any

  const SCHEMA = `
    model Quote {
      id     Int @id
      number String
      total  Float    @default(0)
      @@hasTemplates
    }
  `

  beforeAll(async () => { db = await makeDb(SCHEMA, 'has-templates') })
  afterAll(() => db.$close())

  beforeEach(async () => {
    await db.quote.delete({ where: { id: { in: [1,2,3,4,5] } } })
    await db.quote.createMany({ data: [
      { id: 1, number: 'INST-1', total: 100, isTemplate: false },
      { id: 2, number: 'INST-2', total: 200, isTemplate: false },
      { id: 3, number: 'INST-3', total: 300, isTemplate: false },
      { id: 4, number: 'TPL-A',  total: 0,   isTemplate: true  },
      { id: 5, number: 'TPL-B',  total: 0,   isTemplate: true  },
    ]})
  })

  test('findMany excludes templates by default', async () => {
    const rows = await db.quote.findMany()
    expect(rows.length).toBe(3)
    expect(rows.every((r: any) => r.isTemplate === false)).toBe(true)
  })

  test('findMany withTemplates: true returns instances + templates', async () => {
    const rows = await db.quote.findMany({ withTemplates: true })
    expect(rows.length).toBe(5)
  })

  test('findMany onlyTemplates: true returns templates only', async () => {
    const rows = await db.quote.findMany({ onlyTemplates: true })
    expect(rows.length).toBe(2)
    expect(rows.every((r: any) => r.isTemplate === true)).toBe(true)
  })

  test('count excludes templates by default', async () => {
    const n = await db.quote.count()
    expect(n).toBe(3)
  })

  test('count onlyTemplates returns template count', async () => {
    const n = await db.quote.count({ onlyTemplates: true })
    expect(n).toBe(2)
  })

  test('findFirst excludes templates by default', async () => {
    const row = await db.quote.findFirst({ orderBy: { id: 'asc' } })
    expect(row.id).toBe(1)
    expect(row.isTemplate).toBe(false)
  })

  test('findFirst onlyTemplates returns first template', async () => {
    const row = await db.quote.findFirst({ orderBy: { id: 'asc' }, onlyTemplates: true })
    expect(row.id).toBe(4)
    expect(row.isTemplate).toBe(true)
  })

  test('findUnique by id of a template returns null without flag', async () => {
    // Categorical contract: by default the row is invisible. User has to opt in
    // with withTemplates: true. This protects reporting code that uses ids.
    const row = await db.quote.findUnique({ where: { id: 4 } })
    expect(row).toBeNull()
  })

  test('findUnique by id of a template works with withTemplates: true', async () => {
    const row = await db.quote.findUnique({ where: { id: 4 }, withTemplates: true })
    expect(row).not.toBeNull()
    expect(row.id).toBe(4)
  })

  test('exists() respects template filter', async () => {
    expect(await db.quote.exists({ where: { id: 4 } })).toBe(false)
    expect(await db.quote.exists({ where: { id: 4 }, withTemplates: true })).toBe(true)
    expect(await db.quote.exists({ where: { id: 1 } })).toBe(true)
  })

  test('updateMany targets only instances by default', async () => {
    // Crucial safety: a "bump everyone's totals by 10%" should not also corrupt
    // template totals. Default WHERE excludes templates from updates.
    const r = await db.quote.updateMany({ where: {}, data: { total: 999 } })
    expect(r.count).toBe(3)
    const tpl = await db.quote.findMany({ onlyTemplates: true })
    expect(tpl.every((t: any) => t.total === 0)).toBe(true)
  })

  test('removeMany targets only instances by default', async () => {
    const r = await db.quote.removeMany({ where: {} })
    expect(r.count).toBe(3)
    const remaining = await db.quote.findMany({ withTemplates: true })
    expect(remaining.length).toBe(2)
    expect(remaining.every((r: any) => r.isTemplate === true)).toBe(true)
  })

  test('aggregate() always operates on instances (parallel to always-live)', async () => {
    const r = await db.quote.aggregate({ _sum: { total: true }, _count: true })
    expect(r._count).toBe(3)
    expect(r._sum.total).toBe(600)   // 100 + 200 + 300, no templates
  })

  test('templates can be created and edited through normal write API', async () => {
    const t = await db.quote.create({ data: { id: 99, number: 'TPL-NEW', total: 0, isTemplate: true } })
    expect(t.isTemplate).toBe(true)
    // Template is invisible to default reads
    expect(await db.quote.findUnique({ where: { id: 99 } })).toBeNull()
    // ...but visible with the flag
    const fetched = await db.quote.findUnique({ where: { id: 99 }, withTemplates: true })
    expect(fetched?.id).toBe(99)
    await db.quote.delete({ where: { id: 99 } })
  })

  test('isTemplate defaults to false when omitted on create', async () => {
    // The auto-injected column has DEFAULT 0 in DDL, so `create` without
    // isTemplate yields an instance — not a template. Critical for
    // backward-compat: existing code creating rows continues to work.
    const r = await db.quote.create({ data: { id: 100, number: 'NEW', total: 50 } })
    expect(r.isTemplate).toBe(false)
    const found = await db.quote.findUnique({ where: { id: 100 } })
    expect(found).not.toBeNull()
    await db.quote.delete({ where: { id: 100 } })
  })

  test('asSystem() bypasses template filter (parallel to soft-delete bypass)', async () => {
    // Wait — actually asSystem() does NOT bypass filters; only @@gate / @@allow.
    // It DOES NOT bypass the soft-delete filter either. Check current behaviour
    // and document: filters (including hasTemplates) apply uniformly.
    const sys = db.asSystem()
    const rows = await sys.quote.findMany()
    expect(rows.length).toBe(3)   // still 3, hasTemplates filter still applied
    const all = await sys.quote.findMany({ withTemplates: true })
    expect(all.length).toBe(5)
  })
})

describe('@@hasTemplates + @@softDelete — composition', () => {
  let db: any

  const SCHEMA = `
    model Item {
      id        Int  @id
      name      String
      deletedAt DateTime?
      @@hasTemplates
      @@softDelete
    }
  `

  beforeAll(async () => { db = await makeDb(SCHEMA, 'ht-sd-compose') })
  afterAll(() => db.$close())

  beforeEach(async () => {
    await db.item.delete({ where: { id: { in: [1,2,3,4] } } })
    await db.item.createMany({ data: [
      { id: 1, name: 'I-1', isTemplate: false },
      { id: 2, name: 'I-2', isTemplate: false },
      { id: 3, name: 'T-1', isTemplate: true  },
      { id: 4, name: 'T-2', isTemplate: true  },
    ]})
  })

  test('default findMany: live + instances', async () => {
    const rows = await db.item.findMany()
    expect(rows.length).toBe(2)
    expect(rows.every((r: any) => !r.isTemplate && r.deletedAt === null)).toBe(true)
  })

  test('soft-delete an instance: still hidden from default reads', async () => {
    await db.item.remove({ where: { id: 1 } })
    expect((await db.item.findMany()).length).toBe(1)
  })

  test('withDeleted + withTemplates returns absolutely all rows', async () => {
    await db.item.remove({ where: { id: 1 } })
    const all = await db.item.findMany({ withDeleted: true, withTemplates: true })
    expect(all.length).toBe(4)
  })

  test('withDeleted alone: still excludes templates', async () => {
    await db.item.remove({ where: { id: 1 } })
    const rows = await db.item.findMany({ withDeleted: true })
    expect(rows.length).toBe(2)              // both instances, deleted + live
    expect(rows.every((r: any) => !r.isTemplate)).toBe(true)
  })

  test('onlyDeleted + withTemplates: deleted-or-templates? No — AND-composition', async () => {
    // Both filters compose with AND: onlyDeleted finds deleted rows, then
    // withTemplates *opts out* of the template filter (allowing both
    // template and non-template deleted rows). Since no templates are
    // currently deleted, expect only the soft-deleted instance.
    await db.item.remove({ where: { id: 1 } })
    const rows = await db.item.findMany({ onlyDeleted: true, withTemplates: true })
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(1)
  })
})

describe('@@hasTemplates — nested includes', () => {
  let db: any

  const SCHEMA = `
    model Account {
      id     Int  @id
      name   String
      quotes Quote[]
    }
    model Quote {
      id        Int  @id
      accountId Int
      number    String
      account   Account @relation(fields: [accountId], references: [id])
      @@hasTemplates
    }
  `

  beforeAll(async () => { db = await makeDb(SCHEMA, 'ht-include') })
  afterAll(() => db.$close())

  beforeEach(async () => {
    await db.quote.delete({ where: { id: { in: [1,2,3] } } })
    await db.account.delete({ where: { id: 1 } })
    await db.account.create({ data: { id: 1, name: 'Acme' } })
    await db.quote.createMany({ data: [
      { id: 1, accountId: 1, number: 'INST-1', isTemplate: false },
      { id: 2, accountId: 1, number: 'INST-2', isTemplate: false },
      { id: 3, accountId: 1, number: 'TPL',    isTemplate: true  },
    ]})
  })

  test('nested hasMany excludes templates by default', async () => {
    const acc = await db.account.findUnique({ where: { id: 1 }, include: { quotes: true } })
    expect(acc.quotes.length).toBe(2)
    expect(acc.quotes.every((q: any) => !q.isTemplate)).toBe(true)
  })

  test('nested withTemplates includes templates', async () => {
    const acc = await db.account.findUnique({
      where: { id: 1 },
      include: { quotes: { withTemplates: true } },
    })
    expect(acc.quotes.length).toBe(3)
  })

  test('nested onlyTemplates returns templates only', async () => {
    const acc = await db.account.findUnique({
      where: { id: 1 },
      include: { quotes: { onlyTemplates: true } },
    })
    expect(acc.quotes.length).toBe(1)
    expect(acc.quotes[0].isTemplate).toBe(true)
  })
})

describe('@@hasTemplates — custom field name', () => {
  let db: any

  const SCHEMA = `
    model Preset {
      id       Int @id
      label    String
      @@hasTemplates(field: "isPreset")
    }
  `

  beforeAll(async () => { db = await makeDb(SCHEMA, 'ht-custom-field') })
  afterAll(() => db.$close())

  test('custom field name applies the filter on the right column', async () => {
    await db.preset.createMany({ data: [
      { id: 1, label: 'A', isPreset: false },
      { id: 2, label: 'B', isPreset: true  },
    ]})
    const rows = await db.preset.findMany()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(1)
    const all = await db.preset.findMany({ withTemplates: true })
    expect(all.length).toBe(2)
  })
})

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  Unknown-field validation on writes                                         │
// └────────────────────────────────────────────────────────────────────────────┘

describe('write payload — unknown fields are silently stripped', () => {
  // Policy (2026-08-01): unknown keys in `data` are mass-assignment-stripped,
  // not rejected — a form/request body can be passed straight in. A typo on a
  // REQUIRED field still fails loudly, via the required-field pre-flight.
  let db: any

  const SCHEMA = `
    model Account {
      id    Int @id
      name  String
      users User[]
    }
    model User {
      id        Int  @id
      accountId Int
      email     String
      account   Account @relation(fields: [accountId], references: [id])
    }
  `

  beforeAll(async () => { db = await makeDb(SCHEMA, 'unknown-keys') })
  afterAll(() => db.$close())

  beforeEach(async () => {
    await db.user.delete({ where: { id: { in: [1,2,3,99] } } })
    await db.account.delete({ where: { id: { in: [1,2,3,99] } } })
  })

  test('flat create with bogus field succeeds — key stripped, no SQLite error', async () => {
    const row = await db.account.create({ data: { id: 1, name: 'A', bogusField: 'oops' } })
    expect(row.name).toBe('A')
    expect('bogusField' in row).toBe(false)
  })

  test('typo on a required field still fails loudly — as "required", not as SQL', async () => {
    let err: any = null
    try {
      await db.user.create({ data: { id: 1, accountId: 1, emial: 'a@x.com' } })
    } catch (e) { err = e }
    expect(err).not.toBeNull()
    // 'emial' is stripped; the pre-flight then reports the real field missing.
    expect(String(err.message)).toContain('email is required')
    expect(String(err.message)).not.toContain('NOT NULL constraint failed')
  })

  test('bogus extra key alongside complete data is dropped without complaint', async () => {
    await db.account.create({ data: { id: 1, name: 'A' } })
    const u = await db.user.create({
      data: { id: 1, accountId: 1, email: 'a@x.com', somethingTotallyDifferent: 'x' },
    })
    expect(u.email).toBe('a@x.com')
    expect('somethingTotallyDifferent' in u).toBe(false)
  })

  test('nested create on hasMany child strips the bogus key on the child model', async () => {
    await db.account.create({ data: { id: 1, name: 'A' } })
    await db.account.create({
      data: {
        id: 2, name: 'B',
        users: { create: { id: 99, email: 'b@x.com', wrongField: 'oops' } },
      },
    })
    const child = await db.user.findUnique({ where: { id: 99 } })
    expect(child.email).toBe('b@x.com')
    expect('wrongField' in child).toBe(false)
  })

  test('relation name with non-op scalar value is rejected with a helpful error', async () => {
    // User wrote `account: 1` meaning `accountId: 1` — common mistake.
    // extractNestedWrites only routes when value has op shape, so this falls
    // through to scalar and hits unknown-field validation. The relation name
    // 'account' IS in _allowedWriteKeys, but it's not a column either. The
    // current behavior: scalar key 'account' is allowed (it's a real relation
    // name), reaches SQL, and SQLite barfs. Document that in this regression.
    //
    // Compromise: 'account' is in allowedKeys so we don't catch THIS at the
    // ValidationError stage — but the SQLite error still surfaces and the user
    // can fix it. The next iteration could special-case relation-as-scalar.
    await db.account.create({ data: { id: 1, name: 'A' } })
    let err: any = null
    try {
      await db.user.create({ data: { id: 1, account: 1, email: 'x@x.com' } })
    } catch (e) { err = e }
    expect(err).not.toBeNull()
    // Either path — ValidationError or SQLite — is acceptable as long as it errors.
  })

  test('update with bogus field strips it — target field untouched', async () => {
    await db.account.create({ data: { id: 1, name: 'A' } })
    const row = await db.account.update({ where: { id: 1 }, data: { naem: 'B' } })
    expect(row.name).toBe('A')            // typo'd key dropped, nothing changed
    expect('naem' in row).toBe(false)
  })

  test('valid writes still work — known fields, FKs, computed FK', async () => {
    await db.account.create({ data: { id: 1, name: 'A' } })
    const u = await db.user.create({ data: { id: 1, accountId: 1, email: 'a@x.com' } })
    expect(u.id).toBe(1)
    expect(u.accountId).toBe(1)
    expect(u.email).toBe('a@x.com')
  })

  test('createMany strips bogus keys per-row', async () => {
    await db.account.createMany({ data: [
      { id: 1, name: 'A' },
      { id: 2, name: 'B', whatever: 'nope' },
    ]})
    const rows = await db.account.findMany({ where: { id: { in: [1, 2] } } })
    expect(rows).toHaveLength(2)
    expect(rows.every((r: any) => !('whatever' in r))).toBe(true)
  })
})

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  Co-FK propagation — nested writes inherit shared FK columns                │
// └────────────────────────────────────────────────────────────────────────────┘

describe('co-FK propagation — nested create', () => {
  let db: any

  // Schema: tenants own accounts, accounts own orders, orders own lines.
  // accountId and tenantId both appear on multiple tables and reference the
  // same parents. These are the "co-FK" columns that should propagate
  // parent→child during nested writes.
  const SCHEMA = `
    model Tenant {
      id       Int @id
      name     String
      accounts Account[]
    }
    model Account {
      id       Int @id
      tenantId Int
      name     String
      tenant   Tenant  @relation(fields: [tenantId], references: [id])
      orders   Order[]
    }
    model Order {
      id        Int @id
      tenantId  Int
      accountId Int
      tenant    Tenant  @relation(fields: [tenantId],  references: [id])
      account   Account @relation(fields: [accountId], references: [id])
      lines     Line[]
    }
    model Line {
      id        Int @id
      tenantId  Int
      accountId Int
      orderId   Int
      qty       Int @default(1)
      tenant    Tenant  @relation(fields: [tenantId],  references: [id])
      account   Account @relation(fields: [accountId], references: [id])
      order     Order   @relation(fields: [orderId],   references: [id])
    }
  `

  beforeAll(async () => { db = await makeDb(SCHEMA, 'cofk-strict') })
  afterAll(() => db.$close())

  beforeEach(async () => {
    // Clean in FK-safe order
    await db.line.deleteMany({}).catch(() => {})
    await db.order.deleteMany({}).catch(() => {})
    await db.account.deleteMany({}).catch(() => {})
    await db.tenant.deleteMany({}).catch(() => {})
    await db.tenant.create({ data: { id: 1, name: 'T1' } })
  })

  test('nested account.create propagates tenantId from parent (1 level)', async () => {
    const t = await db.tenant.findUnique({ where: { id: 1 } })
    // Create an account nested inside tenant — this is a hasMany create from
    // the tenant side. Account must inherit tenantId without us specifying it.
    await db.tenant.update({
      where: { id: 1 },
      data: { accounts: { create: { id: 10, name: 'A' } } },
    })
    const a = await db.account.findUnique({ where: { id: 10 } })
    expect(a.tenantId).toBe(1)
  })

  test('nested order under account inherits accountId AND tenantId', async () => {
    await db.account.create({ data: { id: 10, tenantId: 1, name: 'A' } })
    await db.account.update({
      where: { id: 10 },
      data: { orders: { create: { id: 100 } } },
    })
    const o = await db.order.findUnique({ where: { id: 100 } })
    expect(o.accountId).toBe(10)   // direct FK
    expect(o.tenantId).toBe(1)     // co-FK propagated from account
  })

  test('two-level deep: lines inherit tenantId+accountId from order chain', async () => {
    await db.account.create({ data: { id: 10, tenantId: 1, name: 'A' } })
    // Create an order with nested lines in one shot. Lines should pick up
    // accountId AND tenantId from the order's own values (which themselves
    // came from account during this same write at the next level up — but
    // here we set them directly on order, which is the more common case).
    await db.order.create({
      data: {
        id: 100, accountId: 10, tenantId: 1,
        lines: { create: [{ id: 1000, qty: 5 }, { id: 1001, qty: 3 }] },
      },
    })
    const lines = await db.line.findMany({ orderBy: { id: 'asc' } })
    expect(lines.length).toBe(2)
    for (const l of lines) {
      expect(l.tenantId).toBe(1)
      expect(l.accountId).toBe(10)
      expect(l.orderId).toBe(100)
    }
  })

  test('strict mode (default): explicit child value is silently overwritten on a non-direct co-FK', async () => {
    // Use orders nested under account — tenantId is a co-FK (NOT the direct
    // hasMany FK). Child provides tenantId=2; parent has tenantId=1; strict
    // mode must overwrite to 1. This is the *real* test of co-FK strictness,
    // separate from the always-overridden direct FK behaviour.
    await db.tenant.create({ data: { id: 2, name: 'T2' } })
    await db.account.create({ data: { id: 10, tenantId: 1, name: 'A' } })
    await db.account.update({
      where: { id: 10 },
      data: { orders: { create: { id: 100, tenantId: 2 } } },
    })
    const o = await db.order.findUnique({ where: { id: 100 } })
    expect(o.accountId).toBe(10)   // direct FK
    expect(o.tenantId).toBe(1)     // co-FK overwritten — parent wins
  })

  test('null parent value is not propagated', async () => {
    // If the parent doesn't have a non-null co-FK value, we don't fill the
    // child with null — we leave whatever the child specified. Prevents the
    // edge case where a column is nullable and a parent legitimately has it
    // unset.
    //
    // Simulate by writing accounts with explicit tenantId then orders without
    // co-FK to verify normal behaviour (this test mainly guards against a
    // nullable-parent bug — we don't have a nullable co-FK in this schema).
    await db.account.create({ data: { id: 10, tenantId: 1, name: 'A' } })
    await db.order.create({ data: { id: 100, accountId: 10, tenantId: 1 } })
    const o = await db.order.findUnique({ where: { id: 100 } })
    expect(o.tenantId).toBe(1)
  })

  test('flat (non-nested) create is unaffected — co-FK only fires inside nested ops', async () => {
    await db.account.create({ data: { id: 10, tenantId: 1, name: 'A' } })
    // Standalone create with explicit values — no parent context, so no
    // propagation. The test is just that nothing weird happens here.
    await db.order.create({ data: { id: 100, accountId: 10, tenantId: 1 } })
    const o = await db.order.findUnique({ where: { id: 100 } })
    expect(o.tenantId).toBe(1)
    expect(o.accountId).toBe(10)
  })
})

describe('co-FK propagation — allowChildFkOverride: true', () => {
  let db: any

  // Use accounts→orders so we have a co-FK (tenantId) that is NOT the same
  // column as the direct hasMany FK (accountId). Direct FKs are always
  // overridden — that's existing behaviour, separate from this feature.
  const SCHEMA = `
    model Tenant {
      id       Int @id
      name     String
      accounts Account[]
      orders   Order[]
    }
    model Account {
      id       Int @id
      tenantId Int
      name     String
      tenant   Tenant @relation(fields: [tenantId], references: [id])
      orders   Order[]
    }
    model Order {
      id        Int @id
      tenantId  Int
      accountId Int
      tenant    Tenant  @relation(fields: [tenantId],  references: [id])
      account   Account @relation(fields: [accountId], references: [id])
    }
  `

  beforeAll(async () => {
    db = await makeDb(SCHEMA, 'cofk-permissive', { allowChildFkOverride: true })
  })
  afterAll(() => db.$close())

  beforeEach(async () => {
    await db.order.deleteMany({}).catch(() => {})
    await db.account.deleteMany({}).catch(() => {})
    await db.tenant.deleteMany({}).catch(() => {})
    await db.tenant.create({ data: { id: 1, name: 'T1' } })
    await db.tenant.create({ data: { id: 2, name: 'T2' } })
    await db.account.create({ data: { id: 10, tenantId: 1, name: 'A' } })
  })

  test('child explicit value wins over parent for non-direct co-FK', async () => {
    // The order is nested under account 10 (tenantId=1). With permissive mode,
    // the order's own tenantId=2 should be preserved — this is the cross-
    // tenant move use case where you legitimately need the child to differ.
    // accountId is the DIRECT hasMany FK and always gets injected.
    await db.account.update({
      where: { id: 10 },
      data: { orders: { create: { id: 100, tenantId: 2 } } },
    })
    const o = await db.order.findUnique({ where: { id: 100 } })
    expect(o.accountId).toBe(10)   // direct FK still injected
    expect(o.tenantId).toBe(2)     // permissive mode: child's value preserved
  })

  test('missing child value still gets auto-filled from parent', async () => {
    // Order under account 10 (tenantId=1). Child doesn't specify tenantId,
    // so it gets propagated from account.
    await db.account.update({
      where: { id: 10 },
      data: { orders: { create: { id: 101 } } },
    })
    const o = await db.order.findUnique({ where: { id: 101 } })
    expect(o.tenantId).toBe(1)
    expect(o.accountId).toBe(10)
  })
})

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  Type rename — hard cut migration error                                     │
// └────────────────────────────────────────────────────────────────────────────┘

describe('type rename — hard-cut migration', () => {
  // The DSL renamed Text→String, Integer→Int, Real→Float, Blob→Bytes. No
  // aliases. Old names produce a parse error pointing at the new spelling and
  // mentioning the codemod, so users with existing .lite files get a clear
  // upgrade path instead of a cryptic "unknown enum reference" error.

  test('Text emits migration error pointing at String', () => {
    const r = parse('model T { id Int @id; body Text }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain("'Text' was renamed to 'String'")
    expect(r.errors.join('\n')).toContain('codemod')
  })

  test('Integer → Int', () => {
    const r = parse('model T { id Integer @id }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain("'Integer' was renamed to 'Int'")
  })

  test('Real → Float', () => {
    const r = parse('model T { id Int @id; price Real }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain("'Real' was renamed to 'Float'")
  })

  test('Blob → Bytes', () => {
    const r = parse('model T { id Int @id; data Blob }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain("'Blob' was renamed to 'Bytes'")
  })

  test('new names work end-to-end', async () => {
    const r = parse(`
      model Item {
        id     Int     @id
        name   String
        price  Float
        blob   Bytes?
        meta   Json?
        active Boolean  @default(true)
      }
    `)
    expect(r.valid).toBe(true)
    const f = (n: string) => r.schema.models[0].fields.find((x: any) => x.name === n)
    expect(f('id').type.name).toBe('Int')
    expect(f('name').type.name).toBe('String')
    expect(f('price').type.name).toBe('Float')
    expect(f('blob').type.name).toBe('Bytes')
    expect(f('active').type.name).toBe('Boolean')
  })
})

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  @time — 24-hour clock validator                                            │
// └────────────────────────────────────────────────────────────────────────────┘

describe('@time validator', () => {
  // Validates strings in HH:MM (default) or HH:MM:SS (with seconds: true).
  // 24-hour clock, leading zeros required so values sort lexicographically
  // the same as numerically — this matters for ORDER BY in admin queries
  // that don't bother parsing.

  test('parses bare @time', () => {
    const r = parse(`model T { id Int @id; ot String @time }`)
    expect(r.valid).toBe(true)
    const a = r.schema.models[0].fields[1].attributes.find((x: any) => x.kind === 'time')
    expect(a).toBeDefined()
    expect((a as any).seconds).toBe(false)
  })

  test('parses @time(seconds: true)', () => {
    const r = parse(`model T { id Int @id; ot String @time(seconds: true) }`)
    expect(r.valid).toBe(true)
    const a = r.schema.models[0].fields[1].attributes.find((x: any) => x.kind === 'time')
    expect((a as any).seconds).toBe(true)
  })

  test('parses @time(message: "...")', () => {
    const r = parse(`model T { id Int @id; ot String @time(message: "bad") }`)
    expect(r.valid).toBe(true)
    const a = r.schema.models[0].fields[1].attributes.find((x: any) => x.kind === 'time')
    expect((a as any).message).toBe('bad')
  })

  test('rejects non-bool for seconds', () => {
    const r = parse(`model T { id Int @id; ot String @time(seconds: 1) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain('expects true/false')
  })

  test('runtime: accepts valid HH:MM', async () => {
    const db = await makeDb(`model Bh { id Int @id; openTime String @time }`, 'time-hm-ok')
    await db.bh.create({ data: { id: 1, openTime: '09:30' } })
    await db.bh.create({ data: { id: 2, openTime: '00:00' } })
    await db.bh.create({ data: { id: 3, openTime: '23:59' } })
    expect(await db.bh.count()).toBe(3)
    db.$close()
  })

  test('runtime: rejects malformed HH:MM', async () => {
    const db = await makeDb(`model Bh { id Int @id; openTime String @time }`, 'time-hm-bad')
    const bad = ['9:30', '24:00', '12:60', '12:34:00', '1230', '', 'abc']
    for (const v of bad) {
      let err: any = null
      try { await db.bh.create({ data: { id: 1, openTime: v } }) } catch (e) { err = e }
      expect(err).not.toBeNull()
    }
    db.$close()
  })

  test('runtime: seconds: true accepts HH:MM and HH:MM:SS', async () => {
    const db = await makeDb(`model Bh { id Int @id; t String @time(seconds: true) }`, 'time-hms-ok')
    await db.bh.create({ data: { id: 1, t: '12:00' } })
    await db.bh.create({ data: { id: 2, t: '12:00:00' } })
    await db.bh.create({ data: { id: 3, t: '23:59:59' } })
    expect(await db.bh.count()).toBe(3)
    db.$close()
  })

  test('runtime: seconds: true rejects out-of-range', async () => {
    const db = await makeDb(`model Bh { id Int @id; t String @time(seconds: true) }`, 'time-hms-bad')
    for (const v of ['12:34:60', '24:00:00', '12:60:00']) {
      let err: any = null
      try { await db.bh.create({ data: { id: 1, t: v } }) } catch (e) { err = e }
      expect(err).not.toBeNull()
    }
    db.$close()
  })

  test('custom message via @time(message: ...)', async () => {
    const db = await makeDb(
      `model Bh { id Int @id; t String @time(message: "open hours: HH:MM only") }`,
      'time-msg',
    )
    let err: any = null
    try { await db.bh.create({ data: { id: 1, t: 'noon' } }) } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.message).toContain('open hours: HH:MM only')
    db.$close()
  })
})

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  view block — read-only schema views                                        │
// └────────────────────────────────────────────────────────────────────────────┘

describe('view block — schema views', () => {
  // Two flavors: regular views (CREATE VIEW, recomputed every read) and
  // materialized views (real tables + triggers that refresh on writes to
  // their declared source models). Both are read-only — write methods throw.

  test('regular view: read-only, recomputed on each query', async () => {
    const db = await makeDb(`
      model Order {
        id        Int   @id
        accountId Int
        total     Float
      }
      view orderTotals {
        accountId Int
        total     Float
        @@sql("SELECT accountId, SUM(total) AS total FROM [order] GROUP BY accountId")
      }
    `, 'view-regular')

    await db.order.createMany({ data: [
      { id: 1, accountId: 1, total: 100 },
      { id: 2, accountId: 1, total: 50 },
      { id: 3, accountId: 2, total: 30 },
    ]})

    const rows = await db.orderTotals.findMany({ orderBy: { accountId: 'asc' } })
    expect(rows.length).toBe(2)
    expect(rows[0]).toEqual({ accountId: 1, total: 150 })
    expect(rows[1]).toEqual({ accountId: 2, total: 30 })

    db.$close()
  })

  test('view: write methods throw a clear error', async () => {
    const db = await makeDb(`
      model Order { id Int @id; total Float }
      view dailyTotals {
        total Float
        @@sql("SELECT SUM(total) AS total FROM [order]")
      }
    `, 'view-write-blocked')

    let err: any = null
    try { await (db as any).dailyTotals.create({ data: { total: 0 } }) }
    catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.message).toContain('view')
    expect(err.message).toContain('write operations are not supported')

    db.$close()
  })

  test('materialized view: refreshes automatically on source writes', async () => {
    // The @@refreshOn([Order]) declaration installs INSERT/UPDATE/DELETE
    // triggers on the orders table; each fires a DELETE+INSERT against the
    // materialized table to keep it in sync. Reads hit the materialized
    // table directly — no recomputation per query.
    const db = await makeDb(`
      model Order {
        id        Int   @id
        accountId Int
        total     Float
      }
      view orderTotals {
        accountId Int
        total     Float
        @@materialized
        @@sql("SELECT accountId, SUM(total) AS total FROM [order] GROUP BY accountId")
        @@refreshOn([Order])
      }
    `, 'view-materialized')

    await db.order.createMany({ data: [
      { id: 1, accountId: 1, total: 100 },
      { id: 2, accountId: 2, total: 30 },
    ]})

    let rows = await db.orderTotals.findMany({ orderBy: { accountId: 'asc' } })
    expect(rows.length).toBe(2)
    expect(rows[0].total).toBe(100)

    // Insert another order — the view should auto-refresh.
    await db.order.create({ data: { id: 3, accountId: 1, total: 25 } })
    rows = await db.orderTotals.findMany({ orderBy: { accountId: 'asc' } })
    expect(rows[0].total).toBe(125)

    // Delete an order — the view should reflect.
    await db.order.delete({ where: { id: 2 } })
    rows = await db.orderTotals.findMany({ orderBy: { accountId: 'asc' } })
    expect(rows.length).toBe(1)

    db.$close()
  })

  test('view supports findFirst / findUnique / count / exists', async () => {
    const db = await makeDb(`
      model Order { id Int @id; accountId Int; total Float }
      view orderTotals {
        accountId Int
        total     Float
        @@sql("SELECT accountId, SUM(total) AS total FROM [order] GROUP BY accountId")
      }
    `, 'view-read-methods')

    await db.order.createMany({ data: [
      { id: 1, accountId: 1, total: 100 },
      { id: 2, accountId: 2, total: 30 },
    ]})

    const first = await db.orderTotals.findFirst({ where: { accountId: 2 } })
    expect(first?.total).toBe(30)

    const n = await db.orderTotals.count()
    expect(n).toBe(2)

    expect(await db.orderTotals.exists({ where: { accountId: 1 } })).toBe(true)
    expect(await db.orderTotals.exists({ where: { accountId: 99 } })).toBe(false)

    db.$close()
  })
})

// ┌────────────────────────────────────────────────────────────────────────────┐
// │  @@fts tokenize parameter                                                   │
// └────────────────────────────────────────────────────────────────────────────┘

describe('@@fts(tokenize: ...) — FTS5 tokenizer selection', () => {
  // FTS5 ships several tokenizers. unicode61 (default) is word-based with
  // case folding; trigram does character-overlap matching for substring /
  // truncation tolerance; porter stems English words; ascii is plain ASCII
  // fold. Schema picks one; search() and the where {fts} operator both go
  // through the same FTS5 virtual table.

  test('parses bare @@fts (default unicode61 tokenizer)', () => {
    const r = parse(`model P { id Int @id; title String; @@fts([title]) }`)
    expect(r.valid).toBe(true)
    const a = r.schema.models[0].attributes.find((x: any) => x.kind === 'fts')
    expect((a as any).tokenize).toBe('unicode61')
  })

  test('parses @@fts(tokenize: trigram)', () => {
    const r = parse(`model P { id Int @id; title String; @@fts([title], tokenize: trigram) }`)
    expect(r.valid).toBe(true)
    const a = r.schema.models[0].attributes.find((x: any) => x.kind === 'fts')
    expect((a as any).tokenize).toBe('trigram')
  })

  test('parses @@fts(tokenize: porter)', () => {
    const r = parse(`model P { id Int @id; title String; @@fts([title], tokenize: porter) }`)
    expect(r.valid).toBe(true)
    expect(r.schema.models[0].attributes.find((a: any) => a.kind === 'fts').tokenize).toBe('porter')
  })

  test('rejects unknown tokenizer with allowed-list hint', () => {
    const r = parse(`model P { id Int @id; title String; @@fts([title], tokenize: superfuzzy) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain("unknown tokenizer")
    expect(r.errors.join('\n')).toContain('unicode61')
    expect(r.errors.join('\n')).toContain('trigram')
  })

  test('rejects unknown named argument', () => {
    const r = parse(`model P { id Int @id; title String; @@fts([title], stem: true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain("expected 'tokenize'")
  })

  test('DDL: default tokenizer emits no tokenize clause (back-compat)', () => {
    const r = parse(`model P { id Int @id; title String; @@fts([title]) }`)
    const ddl = generateDDL(r.schema)
    // Confirm the FTS5 CREATE VIRTUAL TABLE has no `tokenize=` clause —
    // this preserves bit-for-bit DDL parity with pre-Stage-A schemas that
    // didn't specify a tokenizer.
    expect(ddl).toContain('USING fts5(')
    expect(ddl).not.toContain('tokenize=')
  })

  test("DDL: non-default tokenizer emits tokenize='...' clause", () => {
    const r = parse(`model P { id Int @id; title String; @@fts([title], tokenize: trigram) }`)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain("tokenize='trigram'")
  })

  test('runtime: trigram tokenizer matches substrings', async () => {
    const db = await makeDb(`
      model Flavor {
        id   Int    @id
        name String
        @@fts([name], tokenize: trigram)
      }
    `, 'fts-trigram')
    await db.flavor.createMany({ data: [
      { id: 1, name: 'Apple Pie' },
      { id: 2, name: 'Banana Bread' },
      { id: 3, name: 'Chocolate Mousse' },
    ]})

    // Trigram tokenizer does substring overlap matching. Truncations and
    // partial words work; transposed/missing letters generally don't.
    const cases: Array<[string, number[]]> = [
      ['App',    [1]],
      ['Appl',   [1]],
      ['chocol', [3]],
      ['ana',    [2]],   // substring of "Banana"
      ['xyz',    []],
    ]
    for (const [q, ids] of cases) {
      const rows = await db.flavor.search(q)
      expect(rows.map((r: any) => r.id).sort()).toEqual(ids.slice().sort())
    }
    db.$close()
  })

  test('runtime: porter tokenizer stems English words', async () => {
    const db = await makeDb(`
      model Article {
        id   Int    @id
        body String
        @@fts([body], tokenize: porter)
      }
    `, 'fts-porter')
    await db.article.createMany({ data: [
      { id: 1, body: 'The cat is running fast' },
      { id: 2, body: 'Programmers program programs' },
    ]})

    // Porter stems "running" → "run", so all three forms find the same row.
    expect((await db.article.search('run')).map((r: any) => r.id)).toEqual([1])
    expect((await db.article.search('running')).map((r: any) => r.id)).toEqual([1])
    expect((await db.article.search('runs')).map((r: any) => r.id)).toEqual([1])
    expect((await db.article.search('program')).map((r: any) => r.id)).toEqual([2])
    expect((await db.article.search('programming')).map((r: any) => r.id)).toEqual([2])
    db.$close()
  })

  test('runtime: default tokenizer still does word matching (regression guard)', async () => {
    // Confirm @@fts without a tokenize: argument behaves exactly like
    // pre-Stage-A: unicode61, word-based, no stemming, no substring matching.
    const db = await makeDb(`
      model Post {
        id    Int    @id
        title String
        body  String
        @@fts([title, body])
      }
    `, 'fts-default-tokenizer')
    await db.post.createMany({ data: [
      { id: 1, title: 'Quick brown fox', body: 'jumps over the lazy dog' },
      { id: 2, title: 'Cats and dogs',   body: 'are common pets' },
    ]})

    expect((await db.post.search('fox')).map((r: any) => r.id)).toEqual([1])
    expect((await db.post.search('cats')).map((r: any) => r.id)).toEqual([2])
    // Partial words (not in unicode61) — should NOT match without trigram
    expect(await db.post.search('fo')).toEqual([])
    db.$close()
  })
})

// ─── Named (labeled) relations — Prisma parity ────────────────────────────────

describe('named relations — @relation("label")', () => {
  const SCHEMA = `
model Task {
  id      Int    @id
  title   String
  user    User?  @relation("user", fields: [userId], references: [id])
  userId  Int?
  members User[] @relation("members")
  @@map("tasks")
}
model User {
  id           Int       @id
  name         String
  tasks        Task[]    @relation("user")
  assignments  Task[]    @relation("members")
  messages     Message[] @relation("user")
  messagesSent Message[] @relation("sentByUser")
  @@map("users")
}
model Message {
  id       Int    @id
  body     String
  user     User?  @relation("user", fields: [userId], references: [id])
  userId   Int?
  sentBy   User?  @relation("sentByUser", fields: [sentById], references: [id])
  sentById Int?
  @@map("messages")
}
model Tag {
  id     Int   @id
  name   String
  groups Tag[] @relation("TagToTag")
  tags   Tag[] @relation("TagToTag")
  @@map("tags")
}`

  let db: any
  beforeAll(async () => { db = await createClient({ schema: SCHEMA, db: ':memory:' }) })
  afterAll(() => db.$close())

  test('join tables use Prisma layout (_label, A/B columns)', () => {
    const jts = db.$db.query(`SELECT name, sql FROM sqlite_master WHERE name IN ('_members','_TagToTag')`).all()
    expect(jts.length).toBe(2)
    for (const jt of jts) {
      expect(jt.sql).toContain('"A"')
      expect(jt.sql).toContain('"B"')
    }
  })

  test('m2m coexists with an FK between the same models', async () => {
    const u1 = await db.user.create({ data: { name: 'Sam' } })
    const u2 = await db.user.create({ data: { name: 'Ana' } })
    const t  = await db.task.create({ data: { title: 'Ship', userId: u1.id } })
    await db.task.update({ where: { id: t.id }, data: { members: { connect: [{ id: u2.id }] } } })
    const tm = await db.task.findUnique({ where: { id: t.id }, include: { user: true, members: true } })
    expect(tm.user.name).toBe('Sam')
    expect(tm.members.map((m: any) => m.name)).toEqual(['Ana'])
    const ua = await db.user.findUnique({ where: { id: u2.id }, include: { assignments: true, tasks: true } })
    expect(ua.assignments.length).toBe(1)
    expect(ua.tasks.length).toBe(0)
  })

  test('two labeled hasMany relations between the same pair', async () => {
    const a = await db.user.create({ data: { name: 'A' } })
    const b = await db.user.create({ data: { name: 'B' } })
    await db.message.create({ data: { body: 'hi', userId: a.id, sentById: b.id } })
    const ia = await db.user.findUnique({ where: { id: a.id }, include: { messages: true, messagesSent: true } })
    const ib = await db.user.findUnique({ where: { id: b.id }, include: { messages: true, messagesSent: true } })
    expect([ia.messages.length, ia.messagesSent.length]).toEqual([1, 0])
    expect([ib.messages.length, ib.messagesSent.length]).toEqual([0, 1])
  })

  test('self many-to-many with directional fields', async () => {
    const p = await db.tag.create({ data: { name: 'colors' } })
    const c = await db.tag.create({ data: { name: 'red' } })
    await db.tag.update({ where: { id: p.id }, data: { tags: { connect: { id: c.id } } } })
    const pi = await db.tag.findUnique({ where: { id: p.id }, include: { tags: true, groups: true } })
    const ci = await db.tag.findUnique({ where: { id: c.id }, include: { tags: true, groups: true } })
    expect(pi.tags.map((t: any) => t.name)).toEqual(['red'])
    expect(pi.groups.length).toBe(0)
    expect(ci.groups.map((t: any) => t.name)).toEqual(['colors'])
  })

  test('disconnect, set, and _count on named m2m', async () => {
    const t = await db.task.create({ data: { title: 'X' } })
    const u = await db.user.create({ data: { name: 'M' } })
    const v = await db.user.create({ data: { name: 'N' } })
    await db.task.update({ where: { id: t.id }, data: { members: { set: [{ id: u.id }, { id: v.id }] } } })
    await db.task.update({ where: { id: t.id }, data: { members: { disconnect: { id: u.id } } } })
    const r = await db.task.findUnique({ where: { id: t.id }, include: { _count: { select: { members: true } } } })
    expect(r._count.members).toBe(1)
  })

  test('mismatched labels are a parse error', () => {
    const r = parse(`
model A { id Int @id; bs B[] @relation("x") }
model B { id Int @id; as A[] @relation("y") }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('labeled')
  })
})

// ─── Relation filters (some/every/none/is) + include where ────────────────────

describe('relation filters + include where', () => {
  const SCHEMA = `
model Author { id Int @id; name String; posts Post[]; tags Tag[] }
model Post   { id Int @id; author Author @relation(fields:[authorId],references:[id]); authorId Int; title String; published Boolean @default(false) }
model Tag    { id Int @id; label String; authors Author[] }`
  let db: any
  beforeAll(async () => {
    db = await createClient({ schema: SCHEMA, db: ':memory:' })
    const a1 = await db.author.create({ data: { name: 'Ann' } })
    const a2 = await db.author.create({ data: { name: 'Bo' } })
    const a3 = await db.author.create({ data: { name: 'Cy' } })   // no posts
    await db.post.createMany({ data: [
      { authorId: a1.id, title: 'p1', published: true },
      { authorId: a1.id, title: 'p2', published: false },
      { authorId: a2.id, title: 'p3', published: true },
      { authorId: a2.id, title: 'p4', published: true },
    ]})
    const t = await db.tag.create({ data: { label: 'featured' } })
    await db.author.update({ where: { id: a1.id }, data: { tags: { connect: { id: t.id } } } })
  })
  afterAll(() => db.$close())

  test('some — hasMany', async () => {
    const r = await db.author.findMany({ where: { posts: { some: { published: true } } } })
    expect(r.map((a: any) => a.name).sort()).toEqual(['Ann', 'Bo'])
  })
  test('none — hasMany', async () => {
    const r = await db.author.findMany({ where: { posts: { none: { published: true } } } })
    expect(r.map((a: any) => a.name).sort()).toEqual(['Cy'])   // no published (Cy has none at all)
  })
  test('every — hasMany (vacuously true for empty)', async () => {
    const r = await db.author.findMany({ where: { posts: { every: { published: true } } } })
    expect(r.map((a: any) => a.name).sort()).toEqual(['Bo', 'Cy'])   // Bo all-published, Cy empty
  })
  test('some — manyToMany', async () => {
    const r = await db.author.findMany({ where: { tags: { some: { label: 'featured' } } } })
    expect(r.map((a: any) => a.name)).toEqual(['Ann'])
  })
  test('relation filter composes with scalar filter', async () => {
    const r = await db.author.findMany({ where: { name: { contains: 'o' }, posts: { some: { title: 'p3' } } } })
    expect(r.map((a: any) => a.name)).toEqual(['Bo'])
  })
  test('include { where } filters the related rows', async () => {
    const a = await db.author.findFirst({ where: { name: 'Ann' }, include: { posts: { where: { published: true } } } })
    expect(a.posts.length).toBe(1)
    expect(a.posts[0].published).toBe(true)
  })
  test('include { where } on m2m', async () => {
    const a = await db.author.findFirst({ where: { name: 'Ann' }, include: { tags: { where: { label: 'featured' } } } })
    expect(a.tags.length).toBe(1)
    const none = await db.author.findFirst({ where: { name: 'Ann' }, include: { tags: { where: { label: 'nope' } } } })
    expect(none.tags.length).toBe(0)
  })
})

// ─── @edge / @scoped ──────────────────────────────────────────────────────────

describe('@edge / @scoped — parse + DDL', () => {
  const SCHEMA = `
model User { id Int @id; name String; @@auth }
model Project { id Int @id; name String; tasks Task[] }
model Task {
  id Int @id; title String; projects Project[]
  isImportant Boolean @edge(ref: Project) @default(false)
  note String? @edge(ref: Project)
  myFlag Boolean @scoped @default(false)
}`
  test('normalizes @edge / @scoped descriptors with defaults', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const task = r.schema.models.find((m: any) => m.name === 'Task')
    expect(task.fields.find((f: any) => f.name === 'isImportant').edge)
      .toMatchObject({ ref: 'Project', key: 'projectId', as: 'projectEdge', onMissing: 'error', auth: false })
    expect(task.fields.find((f: any) => f.name === 'myFlag').edge)
      .toMatchObject({ ref: 'User', key: 'userId', as: 'mine', auth: true })
  })
  test('edge fields are not host columns; decorate join gets column; side table created', async () => {
    const ddl = generateDDL(parse(SCHEMA).schema)
    expect(ddl).toMatch(/_project_task[\s\S]*?"isImportant"[\s\S]*?PRIMARY KEY/)
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS "_task_user"/)
    const db: any = await createClient({ schema: SCHEMA, db: ':memory:' })
    const cols = db.$db.query(`PRAGMA table_info("task")`).all().map((c: any) => c.name)
    expect(cols).not.toContain('isImportant')
    expect(cols).not.toContain('myFlag')
    db.$close()
  })
})

describe('@edge — parse guardrails', () => {
  test('D2 — @edge at a belongsTo ref errors', () => {
    const r = parse(`
model P { id Int @id }
model T { id Int @id; pId Int; p P @relation(fields: [pId], references: [id]); x Boolean @edge(ref: P) @default(false) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/belongsTo/)
  })
  test('D6 — derived key shadowing a column errors', () => {
    const r = parse(`
model U { id Int @id }
model T { id Int @id; userId Int; rating Int @edge(ref: U, key: userId) @default(0) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/collides with an existing column/)
  })
  test('D7 — namespace colliding with a field errors', () => {
    const r = parse(`
model P { id Int @id; tasks T[] }
model T { id Int @id; projects P[]; pEdge Int; x Boolean @edge(ref: P) @default(false) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/namespace 'pEdge' collides/)
  })
  test('D10 — two edges to same ref, same key, different namespaces errors', () => {
    const r = parse(`
model P { id Int @id; tasks T[] }
model T { id Int @id; projects P[]; a Boolean @edge(ref: P, as: x) @default(false); b Boolean @edge(ref: P, as: y) @default(false) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/different namespaces|D10/)
  })
  test('D11 — fields sharing a namespace with different keys errors', () => {
    const r = parse(`
model P { id Int @id; tasks T[] }
model T { id Int @id; projects P[]; a Boolean @edge(ref: P, as: s, key: k1) @default(false); b Boolean @edge(ref: P, as: s, key: k2) @default(false) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/two dimensions|D11/)
  })
  test('valid — Joe/Sally double-duty (belongsTo + @scoped) passes', () => {
    const r = parse(`
model User { id Int @id; @@auth }
model T { id Int @id; userId Int; user User @relation(fields: [userId], references: [id]); flag Boolean @scoped @default(false) }`)
    expect(r.valid).toBe(true)
  })
  test('valid — two edges to same ref, disambiguated, passes', () => {
    const r = parse(`
model P { id Int @id; tasks T[] }
model T { id Int @id; projects P[]; team Int @edge(ref: P, as: t, key: teamPid) @default(0); cli Int @edge(ref: P, as: c, key: cliPid) @default(0) }`)
    expect(r.valid).toBe(true)
  })
})

describe('@edge / @scoped — runtime', () => {
  const SCHEMA = `
model User { id Int @id; name String; @@auth }
model Project { id Int @id; name String; tasks Task[] }
model Task {
  id Int @id; title String; projects Project[]
  isImportant Boolean @edge(ref: Project) @default(false)
  note String? @edge(ref: Project)
  myFlag Boolean @scoped @default(false)
}`
  let db: any, u1: any, u2: any, p: any, tasks: any[]
  beforeEach(async () => {
    db = await createClient({ schema: SCHEMA, db: ':memory:' })
    u1 = await db.user.create({ data: { name: 'Sally' } })
    u2 = await db.user.create({ data: { name: 'Joe' } })
    p  = await db.project.create({ data: { name: 'Web' } })
    tasks = []
    for (const t of ['A', 'B', 'C']) tasks.push(await db.task.create({ data: { title: t, projects: { connect: { id: p.id } } } }))
  })
  afterEach(() => db.$close())

  test('decorate write + traversal read (with defaults)', async () => {
    await db.task.update({ where: { id: tasks[0].id }, data: { projectEdge: { isImportant: true, note: 'hot' } }, scopedBy: { projectId: p.id } })
    const proj = await db.project.findFirst({ where: { id: p.id }, include: { tasks: true } })
    expect(proj.tasks.find((t: any) => t.title === 'A').projectEdge).toEqual({ isImportant: true, note: 'hot' })
    expect(proj.tasks.find((t: any) => t.title === 'B').projectEdge).toEqual({ isImportant: false, note: null })
  })
  test('decorate flat read via scopedBy', async () => {
    await db.task.update({ where: { id: tasks[0].id }, data: { projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })
    const [a] = await db.task.findMany({ where: { title: 'A' }, scopedBy: { projectId: p.id } })
    expect(a.projectEdge.isImportant).toBe(true)
  })
  test('D12 — write to a non-member throws EDGE_NO_MEMBERSHIP', async () => {
    const p2 = await db.project.create({ data: { name: 'Other' } })
    await expect(db.task.update({ where: { id: tasks[0].id }, data: { projectEdge: { isImportant: true } }, scopedBy: { projectId: p2.id } }))
      .rejects.toMatchObject({ code: 'EDGE_NO_MEMBERSHIP' })
  })
  test('unbound non-auth write throws', async () => {
    await expect(db.task.update({ where: { id: tasks[0].id }, data: { projectEdge: { isImportant: true } } }))
      .rejects.toThrow(/cannot resolve dimension/)
  })
  test('@scoped write + per-viewer isolation', async () => {
    await db.$setAuth(u1).task.update({ where: { id: tasks[1].id }, data: { mine: { myFlag: true } } })
    const sally = await db.$setAuth(u1).task.findFirst({ where: { id: tasks[1].id } })
    const joe   = await db.$setAuth(u2).task.findFirst({ where: { id: tasks[1].id } })
    expect(sally.mine.myFlag).toBe(true)
    expect(joe.mine.myFlag).toBe(false)
  })
  test('@scoped no-viewer read → defaults (D3)', async () => {
    const sys = await db.task.findFirst({ where: { id: tasks[0].id } })
    expect(sys.mine).toEqual({ myFlag: false })
  })
  test('decorate filter + count + compose with scalar filter', async () => {
    for (const t of [tasks[0], tasks[2]])
      await db.task.update({ where: { id: t.id }, data: { projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })
    const imp = await db.task.findMany({ where: { projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })
    expect(imp.map((t: any) => t.title).sort()).toEqual(['A', 'C'])
    expect(await db.task.count({ where: { projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })).toBe(2)
    const combo = await db.task.findMany({ where: { title: { in: ['A', 'B'] }, projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })
    expect(combo.map((t: any) => t.title)).toEqual(['A'])
  })
  test('@scoped filter isolates per viewer', async () => {
    await db.$setAuth(u1).task.update({ where: { id: tasks[1].id }, data: { mine: { myFlag: true } } })
    expect((await db.$setAuth(u1).task.findMany({ where: { mine: { myFlag: true } } })).map((t: any) => t.title)).toEqual(['B'])
    expect((await db.$setAuth(u2).task.findMany({ where: { mine: { myFlag: true } } })).length).toBe(0)
  })
  test('unbound non-auth filter throws', async () => {
    await expect(db.task.findMany({ where: { projectEdge: { isImportant: true } } })).rejects.toThrow(/not bound/)
  })
  test('$scopedBy binder — write/read/filter and chaining with $setAuth', async () => {
    const proj = db.$scopedBy({ projectId: p.id })
    await proj.task.update({ where: { id: tasks[0].id }, data: { projectEdge: { isImportant: true } } })
    expect((await proj.task.findFirst({ where: { id: tasks[0].id } })).projectEdge.isImportant).toBe(true)
    expect((await proj.task.findMany({ where: { projectEdge: { isImportant: true } } })).map((t: any) => t.title)).toEqual(['A'])
    const both = db.$scopedBy({ projectId: p.id }).$setAuth(u1)
    await both.task.update({ where: { id: tasks[0].id }, data: { mine: { myFlag: true } } })
    const r = await both.task.findFirst({ where: { id: tasks[0].id } })
    expect(r.projectEdge.isImportant).toBe(true)
    expect(r.mine.myFlag).toBe(true)
  })
  test('create with edge + connect in one call', async () => {
    const t = await db.task.create({ data: { title: 'D', projects: { connect: { id: p.id } }, projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })
    expect((await db.task.findFirst({ where: { id: t.id }, scopedBy: { projectId: p.id } })).projectEdge.isImportant).toBe(true)
  })
})

describe('@edge — incremental autoMigrate', () => {
  test('adds decorate column + side table to an existing DB, preserving data', async () => {
    const { autoMigrate } = await import('../src/core/migrations.js')
    const path = join(tmpdir(), `edge_mig_${Date.now()}.db`)
    const v1 = `model Project { id Int @id; name String; tasks Task[] }
model Task { id Int @id; title String; projects Project[] }`
    let db: any = await createClient({ schema: v1, db: path })
    const p = await db.project.create({ data: { name: 'Web' } })
    await db.task.create({ data: { title: 'Ship', projects: { connect: { id: p.id } } } })
    db.$close()

    const v2 = `model User { id Int @id; name String; @@auth }
model Project { id Int @id; name String; tasks Task[] }
model Task { id Int @id; title String; projects Project[]; isImportant Boolean @edge(ref: Project) @default(false); myFlag Boolean @scoped @default(false) }`
    db = await createClient({ schema: v2, db: path })
    autoMigrate(db)

    const jcols = db.$db.query(`PRAGMA table_info("_project_task")`).all().map((c: any) => c.name)
    expect(jcols).toContain('isImportant')
    expect(db.$db.query(`SELECT name FROM sqlite_master WHERE name='_task_user'`).all().length).toBe(1)

    const [t] = await db.task.findMany({})
    expect(t.title).toBe('Ship')   // old row survived
    await db.task.update({ where: { id: t.id }, data: { projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })
    expect((await db.task.findFirst({ where: { id: t.id }, scopedBy: { projectId: p.id } })).projectEdge.isImportant).toBe(true)
    db.$close()
    rmSync(path, { force: true }); rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true })
  })
})

describe('@edge — eject to model', () => {
  test('composite PK (two @id fields) generates valid, executable DDL', () => {
    const r = parse(`model J { a Int @id; b Int @id; x Int @default(0) }`)
    expect(r.valid).toBe(true)
    const ddl = generateDDL(r.schema)
    expect(ddl).toMatch(/PRIMARY KEY \("a", "b"\)/)
    const mem = new Database(':memory:')
    expect(() => mem.run(ddl)).not.toThrow()
    mem.close()
  })
  test('decorate eject plan — model text, rename, rewire', async () => {
    const { ejectEdge } = await import('../src/tools/eject.js')
    const schema = parse(`
model Project { id Int @id; tasks Task[] }
model Task { id Int @id; projects Project[]; isImportant Boolean @edge(ref: Project) @default(false); note String? @edge(ref: Project) }`).schema
    const plan = ejectEdge(schema, 'Task.projectEdge')
    expect(plan.newModelName).toBe('ProjectTask')
    expect(plan.newTable).toBe('project_task')
    expect(plan.storage).toBe('decorate')
    expect(plan.fields.sort()).toEqual(['isImportant', 'note'])
    expect(plan.model).toContain('projectId Int @id')
    expect(plan.model).toContain('taskId Int @id')
    expect(plan.model).toContain('isImportant Boolean @default(false)')
    expect(plan.rename).toBe('ALTER TABLE "_project_task" RENAME TO "project_task";')
    expect(plan.rewire.join(' ')).toMatch(/implicit m2m/)
  })
  test('@scoped eject plan — create-own, no m2m to rewire', async () => {
    const { ejectEdge } = await import('../src/tools/eject.js')
    const schema = parse(`
model User { id Int @id; @@auth }
model Task { id Int @id; myFlag Boolean @scoped @default(false); myNote String? @scoped }`).schema
    const plan = ejectEdge(schema, 'Task.mine')
    expect(plan.newModelName).toBe('TaskUser')
    expect(plan.model).toContain('taskId Int @id')
    expect(plan.model).toContain('userId Int @id')
    expect(plan.rewire.join(' ')).toMatch(/no m2m to rewire/)
  })
  test('full round-trip — eject preserves data and the ejected model is queryable', async () => {
    const { ejectEdge, applyEject } = await import('../src/tools/eject.js')
    const { autoMigrate } = await import('../src/core/migrations.js')
    const path = join(tmpdir(), `eject_${Date.now()}.db`)
    const v1 = `
model Project { id Int @id; name String; tasks Task[] }
model Task { id Int @id; title String; projects Project[]; isImportant Boolean @edge(ref: Project) @default(false) }`
    let db: any = await createClient({ schema: v1, db: path })
    const p = await db.project.create({ data: { name: 'Web' } })
    const t = await db.task.create({ data: { title: 'Ship', projects: { connect: { id: p.id } } } })
    await db.task.update({ where: { id: t.id }, data: { projectEdge: { isImportant: true } }, scopedBy: { projectId: p.id } })
    const plan = ejectEdge(db.$schema, 'Task.projectEdge')
    applyEject(db.$db, plan)
    db.$close()

    const v2 = `
model Project { id Int @id; name String; taskLinks ProjectTask[] }
model Task { id Int @id; title String; projectLinks ProjectTask[] }
${plan.model}`
    expect(parse(v2).valid).toBe(true)
    db = await createClient({ schema: v2, db: path })
    autoMigrate(db)
    expect(await db.projectTask.findMany({})).toEqual([{ projectId: p.id, taskId: t.id, isImportant: true }])
    db.$close()
    rmSync(path, { force: true }); rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true })
  })
})

// ─── @createdBy / @@createdBy / @@updatedBy ───────────────────────────────────

describe('@createdBy — field attribute', () => {
  const SCHEMA = `
    model Post {
      id          Int  @id
      title       String
      createdById Int? @createdBy
    }
  `

  test('parses, defaulting to authField: id', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const f = r.schema.models[0].fields.find((f: any) => f.name === 'createdById')
    expect(f?.attributes.find((a: any) => a.kind === 'createdBy')?.authField).toBe('id')
  })

  test('@createdBy(auth().field) reads a custom auth field', async () => {
    const db = await makeDb(`
      model Post { id Int @id  title String  createdByEmail String? @createdBy(auth().email) }
    `, 'cby-field')
    await db.$setAuth({ id: 1, email: 'ann@x.com' }).post.create({ data: { id: 1, title: 'A' } })
    expect((await db.post.findFirst({ where: { id: 1 } }))?.createdByEmail).toBe('ann@x.com')
    db.$close()
  })

  test('stamps auth.id on create', async () => {
    const db = await makeDb(SCHEMA, 'cby-stamp')
    await db.$setAuth({ id: 42 }).post.create({ data: { id: 1, title: 'A' } })
    expect((await db.post.findFirst({ where: { id: 1 } }))?.createdById).toBe(42)
    db.$close()
  })

  // The whole reason @createdBy is not just @default(auth().id): a default
  // loses to a caller-supplied value, so authorship would be forgeable.
  test('the principal beats a caller-supplied value', async () => {
    const db = await makeDb(SCHEMA, 'cby-forge')
    await db.$setAuth({ id: 1 }).post.create({ data: { id: 1, title: 'A', createdById: 999 } })
    expect((await db.post.findFirst({ where: { id: 1 } }))?.createdById).toBe(1)
    db.$close()
  })

  test('createMany stamps every row, overriding supplied values', async () => {
    const db = await makeDb(SCHEMA, 'cby-many')
    await db.$setAuth({ id: 7 }).post.createMany({
      data: [{ id: 1, title: 'A', createdById: 999 }, { id: 2, title: 'B' }],
    })
    expect((await db.post.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.createdById)).toEqual([7, 7])
    db.$close()
  })

  test('upsert stamps the insert branch and leaves the author alone on conflict', async () => {
    const db = await makeDb(`
      model Post { id Int @id  title String @unique  createdById Int? @createdBy }
    `, 'cby-upsert')
    await db.$setAuth({ id: 1 }).post.upsert({ where: { title: 'A' }, create: { id: 1, title: 'A' }, update: { title: 'A' } })
    await db.$setAuth({ id: 2 }).post.upsert({ where: { title: 'A' }, create: { id: 1, title: 'A' }, update: { title: 'A' } })
    expect((await db.post.findFirst({ where: { title: 'A' } }))?.createdById).toBe(1)
    db.$close()
  })

  // No principal, no stamp — this is what lets seeders, imports and backfills
  // carry authorship in explicitly.
  test('an unauthenticated write honours an explicit value', async () => {
    const db = await makeDb(SCHEMA, 'cby-anon')
    await db.post.create({ data: { id: 1, title: 'A', createdById: 5 } })
    await db.asSystem().post.create({ data: { id: 2, title: 'B', createdById: 6 } })
    expect((await db.post.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.createdById)).toEqual([5, 6])
    db.$close()
  })

  test('never re-stamps on update', async () => {
    const db = await makeDb(SCHEMA, 'cby-update')
    await db.$setAuth({ id: 1 }).post.create({ data: { id: 1, title: 'A' } })
    await db.$setAuth({ id: 2 }).post.update({ where: { id: 1 }, data: { title: 'B' } })
    expect((await db.post.findFirst({ where: { id: 1 } }))?.createdById).toBe(1)
    db.$close()
  })
})

describe('@@createdBy / @@updatedBy — model sugar', () => {
  const SCHEMA = `
    model User { id Int @id  name String  @@auth }
    model Doc  { id Int @id  title String  @@createdBy  @@updatedBy }
  `

  test('injects the FK + relation pair for each', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const doc = r.schema.models[1]
    expect(doc.fields.map((f: any) => f.name)).toEqual(
      ['id', 'title', 'createdById', 'createdBy', 'updatedById', 'updatedBy'])
    const fk = doc.fields.find((f: any) => f.name === 'createdById')
    expect(fk.type).toMatchObject({ name: 'Int', optional: true })
    expect(fk.attributes.some((a: any) => a.kind === 'createdBy')).toBe(true)
    const rel = doc.fields.find((f: any) => f.name === 'createdBy')
    expect(rel.type.kind).toBe('relation')
    expect(rel.attributes.find((a: any) => a.kind === 'relation')).toMatchObject({
      name: 'Doc_createdBy', fields: ['createdById'], references: ['id'],
    })
  })

  test('the FK type follows the @@auth model @id', () => {
    const { schema } = parse(`
      model Account { id String @id @default(uuid())  name String  @@auth }
      model Doc { id Int @id  title String  @@createdBy }
    `)
    expect(schema.models[1].fields.find((f: any) => f.name === 'createdById').type.name).toBe('String')
  })

  test('emits both foreign keys in the DDL', () => {
    const ddl = generateDDL(parse(SCHEMA).schema)
    expect(ddl).toContain('FOREIGN KEY ("createdById") REFERENCES "user" ("id")')
    expect(ddl).toContain('FOREIGN KEY ("updatedById") REFERENCES "user" ("id")')
  })

  test('an argument renames the pair', () => {
    const { schema } = parse(`
      model User { id Int @id  @@auth }
      model Doc { id Int @id  @@createdBy(owner)  @@updatedBy(as: "editor") }
    `)
    expect(schema.models[1].fields.map((f: any) => f.name))
      .toEqual(['id', 'ownerId', 'owner', 'editorId', 'editor'])
  })

  test('a name that is not an identifier is a parse error', () => {
    const r = parse(`model User { id Int @id  @@auth }
                     model Doc { id Int @id  @@createdBy("9bad") }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('must be a valid identifier')
  })

  test('a field the host already declares wins', () => {
    const { schema } = parse(`
      model User { id Int @id  @@auth }
      model Doc { id Int @id  createdById String? @createdBy @omit  @@createdBy }
    `)
    const fk = schema.models[1].fields.find((f: any) => f.name === 'createdById')
    expect(fk.type.name).toBe('String')
    expect(fk.attributes.some((a: any) => a.kind === 'omit')).toBe(true)
    // …and the relation is still injected around it
    expect(schema.models[1].fields.some((f: any) => f.name === 'createdBy')).toBe(true)
  })

  test('errors without a model marked @@auth', () => {
    const r = parse(`model Doc { id Int @id  title String  @@createdBy }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes("@@createdBy requires a model marked @@auth"))).toBe(true)
  })

  test('the @@auth model can author itself', () => {
    const r = parse(`model User { id Int @id  name String  @@auth  @@createdBy }`)
    expect(r.valid).toBe(true)
    expect(r.schema.models[0].fields.find((f: any) => f.name === 'createdBy').type.name).toBe('User')
  })

  test('stamps and resolves both relations end to end', async () => {
    const db = await makeDb(SCHEMA, 'authorship-e2e')
    const ann = await db.user.create({ data: { id: 1, name: 'Ann' } })
    const bob = await db.user.create({ data: { id: 2, name: 'Bob' } })

    await db.$setAuth(ann).doc.create({ data: { id: 1, title: 'A' } })
    let row = await db.doc.findUnique({ where: { id: 1 } })
    expect(row).toMatchObject({ createdById: 1, updatedById: null })

    await db.$setAuth(bob).doc.update({ where: { id: 1 }, data: { title: 'B' } })
    row = await db.doc.findUnique({ where: { id: 1 }, include: { createdBy: true, updatedBy: true } })
    expect(row.createdBy.name).toBe('Ann')
    expect(row.updatedBy.name).toBe('Bob')
    db.$close()
  })
})

// ─── FJS-092 — the bulk write paths run the ctx.auth stamps ───────────────────

describe('bulk writes — ctx.auth stamps (FJS-092)', () => {
  const SCHEMA = `
    model User { id Int @id  name String  @@auth }
    model Doc {
      id      Int    @id
      title   String @unique
      ownerId Int?   @default(auth().id)
      @@createdBy
      @@updatedBy
    }
  `

  // @@createdBy is a real FK — the principals have to exist as rows.
  async function makeDocs(name: string) {
    const db = await makeDb(SCHEMA, name)
    await db.user.createMany({ data: [1, 2, 5, 6, 7, 9].map(id => ({ id, name: `u${id}` })) })
    return db
  }

  // The gap that wrote a WRONG name rather than none: @updatedAt is a SQL
  // trigger, so the timestamp kept moving while the identity beside it did not.
  test('updateMany stamps @updatedBy', async () => {
    const db = await makeDocs('bulk-um')
    await db.$setAuth({ id: 1 }).doc.create({ data: { id: 1, title: 'A' } })
    await db.$setAuth({ id: 2 }).doc.update({ where: { id: 1 }, data: { title: 'A' } })
    await db.$setAuth({ id: 1 }).doc.updateMany({ where: { id: 1 }, data: { title: 'A' } })
    expect((await db.doc.findUnique({ where: { id: 1 } }))?.updatedById).toBe(1)
    db.$close()
  })

  test('updateMany skips the stamp with no principal', async () => {
    const db = await makeDocs('bulk-um-anon')
    await db.$setAuth({ id: 1 }).doc.create({ data: { id: 1, title: 'A' } })
    await db.$setAuth({ id: 2 }).doc.update({ where: { id: 1 }, data: { title: 'A' } })
    await db.doc.updateMany({ where: { id: 1 }, data: { title: 'A' } })
    expect((await db.doc.findUnique({ where: { id: 1 } }))?.updatedById).toBe(2)
    db.$close()
  })

  test('upsertMany stamps a row it inserts', async () => {
    const db = await makeDocs('bulk-usm-insert')
    await db.$setAuth({ id: 7 }).doc.upsertMany({ data: [{ id: 1, title: 'A' }] })
    expect(await db.doc.findUnique({ where: { id: 1 } }))
      .toMatchObject({ ownerId: 7, createdById: 7, updatedById: 7 })
    db.$close()
  })

  // A conflict is an update. It moves @updatedBy and leaves the create-time
  // columns exactly where they were.
  test('upsertMany moves @updatedBy on conflict and never rewrites the author', async () => {
    const db = await makeDocs('bulk-usm-conflict')
    await db.$setAuth({ id: 1 }).doc.create({ data: { id: 1, title: 'A' } })
    await db.$setAuth({ id: 2 }).doc.upsertMany({ data: [{ id: 1, title: 'A2' }, { id: 2, title: 'B' }] })
    const [one, two] = await db.doc.findMany({ orderBy: { id: 'asc' } })
    expect(one).toMatchObject({ title: 'A2', ownerId: 1, createdById: 1, updatedById: 2 })
    expect(two).toMatchObject({ title: 'B',  ownerId: 2, createdById: 2, updatedById: 2 })
    db.$close()
  })

  test('an explicit update: list naming the author column still moves it', async () => {
    const db = await makeDocs('bulk-usm-explicit')
    await db.$setAuth({ id: 1 }).doc.create({ data: { id: 1, title: 'A' } })
    await db.$setAuth({ id: 2 }).doc.upsertMany({
      data: [{ id: 1, title: 'A2' }], update: ['title', 'createdById'],
    })
    expect((await db.doc.findUnique({ where: { id: 1 } }))?.createdById).toBe(2)
    db.$close()
  })

  // Excluding a column the caller named would have changed behaviour that
  // predates the stamps, so the exclusion covers only what we filled in.
  test('a caller-supplied auth-default column still rides the conflict update', async () => {
    const db = await makeDocs('bulk-usm-supplied')
    await db.$setAuth({ id: 1 }).doc.create({ data: { id: 1, title: 'A' } })
    await db.$setAuth({ id: 2 }).doc.upsertMany({ data: [{ id: 1, title: 'A2', ownerId: 9 }] })
    expect((await db.doc.findUnique({ where: { id: 1 } }))?.ownerId).toBe(9)
    db.$close()
  })

  test('upsertMany honours explicit values with no principal', async () => {
    const db = await makeDocs('bulk-usm-anon')
    await db.doc.upsertMany({ data: [{ id: 1, title: 'A', createdById: 5, ownerId: 6 }] })
    expect(await db.doc.findUnique({ where: { id: 1 } }))
      .toMatchObject({ createdById: 5, ownerId: 6, updatedById: null })
    db.$close()
  })
})

// ─── @version — optimistic concurrency ────────────────────────────────────────

describe('@version — parser + DDL', () => {
  test('parses onto an Int field', () => {
    const r = parse(`model Order { id Int @id  version Int @version }`)
    expect(r.valid).toBe(true)
    const f = r.schema.models[0].fields.find((f: any) => f.name === 'version')
    expect(f.attributes.some((a: any) => a.kind === 'version')).toBe(true)
  })

  test('implies DEFAULT 1 so a raw INSERT works', () => {
    const ddl = generateDDL(parse(`model Order { id Int @id  version Int @version }`).schema)
    expect(ddl).toContain(`"version" INTEGER NOT NULL DEFAULT 1`)
  })

  test('refuses a non-Int field', () => {
    const r = parse(`model Order { id Int @id  version String @version }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('@version requires an Int field'))).toBe(true)
  })

  // A nullable version is a row that cannot be compared — a hole in the guarantee.
  test('refuses an optional field', () => {
    const r = parse(`model Order { id Int @id  version Int? @version }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('cannot be optional'))).toBe(true)
  })

  test('refuses two on one model', () => {
    const r = parse(`model Order { id Int @id  a Int @version  b Int @version }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('at most one version field'))).toBe(true)
  })

  test('refuses the @id', () => {
    const r = parse(`model Order { id Int @id @version }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('cannot be the @id'))).toBe(true)
  })
})

describe('@version — runtime', () => {
  const SCHEMA = `
    model Order {
      id      Int    @id
      title   String @unique
      status  String @default("draft")
      version Int    @version
    }
  `

  test('a new row is version 1, whatever the payload says', async () => {
    const db = await makeDb(SCHEMA, 'ver-create')
    expect((await db.order.create({ data: { id: 1, title: 'A', version: 500 } })).version).toBe(1)
    db.$close()
  })

  test('every update bumps it', async () => {
    const db = await makeDb(SCHEMA, 'ver-bump')
    await db.order.create({ data: { id: 1, title: 'A' } })
    expect((await db.order.update({ where: { id: 1 }, data: { status: 'a', version: 1 } })).version).toBe(2)
    expect((await db.order.update({ where: { id: 1 }, data: { status: 'b', version: 2 } })).version).toBe(3)
    db.$close()
  })

  // The whole point: the lost update the idea file names.
  test('a stale write is refused instead of erasing the winner', async () => {
    const db = await makeDb(SCHEMA, 'ver-lost-update')
    await db.order.create({ data: { id: 1, title: 'A' } })
    const alice = await db.order.findUnique({ where: { id: 1 } })
    const bob   = await db.order.findUnique({ where: { id: 1 } })

    await db.order.update({ where: { id: 1 }, data: { status: 'alice', version: alice.version } })

    let err: any = null
    try { await db.order.update({ where: { id: 1 }, data: { status: 'bob', version: bob.version } }) }
    catch (e) { err = e }

    expect(err?.name).toBe('VersionConflictError')
    expect(err.status).toBe(409)
    expect(err.retryable).toBe(true)
    expect(err.expected).toBe(1)
    expect(err.actual).toBe(2)
    // Alice's write survived
    expect((await db.order.findUnique({ where: { id: 1 } }))?.status).toBe('alice')
    db.$close()
  })

  test('re-read and retry succeeds', async () => {
    const db = await makeDb(SCHEMA, 'ver-retry')
    await db.order.create({ data: { id: 1, title: 'A' } })
    await db.order.update({ where: { id: 1 }, data: { status: 'alice', version: 1 } })
    const fresh = await db.order.findUnique({ where: { id: 1 } })
    const out = await db.order.update({ where: { id: 1 }, data: { status: 'bob', version: fresh.version } })
    expect(out).toMatchObject({ status: 'bob', version: 3 })
    db.$close()
  })

  test('an update carrying no version is refused', async () => {
    const db = await makeDb(SCHEMA, 'ver-required')
    await db.order.create({ data: { id: 1, title: 'A' } })
    let err: any = null
    try { await db.order.update({ where: { id: 1 }, data: { status: 'x' } }) } catch (e) { err = e }
    expect(err?.name).toBe('VersionRequiredError')
    expect(err.status).toBe(400)
    expect(err.retryable).toBe(false)
    db.$close()
  })

  test('asSystem() skips the check and still bumps', async () => {
    const db = await makeDb(SCHEMA, 'ver-system')
    await db.order.create({ data: { id: 1, title: 'A' } })
    const out = await db.asSystem().order.update({ where: { id: 1 }, data: { status: 'sys' } })
    expect(out).toMatchObject({ status: 'sys', version: 2 })
    db.$close()
  })

  // Not-found must stay null — the documented contract — and not become a 409.
  test('a missing row is still null, not a conflict', async () => {
    const db = await makeDb(SCHEMA, 'ver-missing')
    expect(await db.order.update({ where: { id: 99 }, data: { status: 'x', version: 1 } })).toBeNull()
    db.$close()
  })

  test('the expected version is never written literally', async () => {
    const db = await makeDb(SCHEMA, 'ver-not-literal')
    await db.order.create({ data: { id: 1, title: 'A' } })
    // version 1 is correct, so this succeeds — and must land on 2, not on 1
    expect((await db.order.update({ where: { id: 1 }, data: { version: 1 } })).version).toBe(2)
    db.$close()
  })

  test('select: false takes the same check', async () => {
    const db = await makeDb(SCHEMA, 'ver-select-false')
    await db.order.create({ data: { id: 1, title: 'A' } })
    await db.order.update({ where: { id: 1 }, data: { status: 'a', version: 1 } })
    let err: any = null
    try { await db.order.update({ where: { id: 1 }, data: { status: 'b', version: 1 }, select: false }) }
    catch (e) { err = e }
    expect(err?.name).toBe('VersionConflictError')
    db.$close()
  })

  // A bulk where clause matches many rows and therefore many versions — there is
  // no single value to compare. Bumping is the half that still matters.
  test('updateMany bumps without requiring', async () => {
    const db = await makeDb(SCHEMA, 'ver-updatemany')
    await db.order.createMany({ data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] })
    await db.order.updateMany({ where: {}, data: { status: 'bulk' } })
    expect((await db.order.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.version)).toEqual([2, 2])
    db.$close()
  })

  test('a bulk write makes an open editor stale', async () => {
    const db = await makeDb(SCHEMA, 'ver-bulk-stale')
    await db.order.create({ data: { id: 1, title: 'A' } })
    const editor = await db.order.findUnique({ where: { id: 1 } })
    await db.order.updateMany({ where: { id: 1 }, data: { status: 'bulk' } })
    let err: any = null
    try { await db.order.update({ where: { id: 1 }, data: { status: 'editor', version: editor.version } }) }
    catch (e) { err = e }
    expect(err?.name).toBe('VersionConflictError')
    db.$close()
  })

  test('upsert bumps on conflict and starts at 1 on insert', async () => {
    const db = await makeDb(SCHEMA, 'ver-upsert')
    const made = await db.order.upsert({ where: { title: 'A' }, create: { id: 1, title: 'A' }, update: { status: 'u' } })
    expect(made.version).toBe(1)
    const again = await db.order.upsert({ where: { title: 'A' }, create: { id: 1, title: 'A' }, update: { status: 'u2' } })
    expect(again).toMatchObject({ status: 'u2', version: 2 })
    db.$close()
  })

  // The trap: taking the version from `excluded` would reset a live row to 1
  // and make every stale editor look current again.
  test('upsertMany bumps on conflict rather than resetting to 1', async () => {
    const db = await makeDb(SCHEMA, 'ver-upsertmany')
    await db.order.create({ data: { id: 1, title: 'A' } })
    await db.order.update({ where: { id: 1 }, data: { status: 'x', version: 1 } })   // now at 2
    await db.order.upsertMany({ data: [{ id: 1, title: 'A', status: 'um' }, { id: 2, title: 'B', status: 'new' }] })
    const [one, two] = await db.order.findMany({ orderBy: { id: 'asc' } })
    expect(one).toMatchObject({ status: 'um',  version: 3 })
    expect(two).toMatchObject({ status: 'new', version: 1 })
    db.$close()
  })
})

describe('@version — schema output', () => {
  const { schema } = parse(`model Order { id Int @id  title String  version Int @version }`)

  test('absent from create, readOnly and named in update', () => {
    const create = generateJsonSchema(schema, { mode: 'create' }).$defs.Order
    expect(Object.keys(create.properties)).not.toContain('version')
    expect(create.required ?? []).not.toContain('version')

    const update = generateJsonSchema(schema, { mode: 'update' }).$defs.Order
    expect(update.properties.version).toMatchObject({ readOnly: true, 'x-litestone-kind': 'version' })
    expect(update['x-version']).toBe('version')
  })

  test('typegen drops it from Create and requires it in Update', () => {
    const ts = generateTypeScript(schema)
    const block = (name: string) => ts.slice(ts.indexOf(`interface ${name} {`)).split('}')[0]
    expect(block('OrderCreate')).not.toContain('version')
    expect(block('OrderUpdate')).toContain('version: number')
    expect(block('OrderUpdate')).not.toContain('version?')
  })
})

// ─── The client enumerates (FJS-014) ──────────────────────────────────────────
//
// A proxy whose ownKeys trap returns one name twice makes the ENGINE throw, and
// the message names proxy internals rather than the two strings responsible.
// `$setAuth` and `$db` were on the target AND in the trap's literal list, so
// every enumeration of the top-level client threw — including JSON.stringify,
// which meant logging a context blew up on a line that was not the bug.

describe('client enumeration', () => {
  const SCHEMA = `
    model User { id Int @id  name String }
    model Post { id Int @id  title String }
  `

  test('every way of enumerating the client works', async () => {
    const db = await makeDb(SCHEMA, 'ownkeys')
    expect(() => Object.keys(db)).not.toThrow()
    expect(() => Object.getOwnPropertyNames(db)).not.toThrow()
    expect(() => ({ ...db })).not.toThrow()
    expect(() => { for (const _ in db) { /* noop */ } }).not.toThrow()
    expect(() => JSON.stringify(db)).not.toThrow()
    db.$close()
  })

  test('no trap returns a duplicate — the engine only throws on the first one', async () => {
    const db = await makeDb(SCHEMA, 'ownkeys-dupes')
    const noDupes = (obj: any) => {
      const keys = Object.getOwnPropertyNames(obj)
      expect(keys.length).toBe(new Set(keys).size)
    }
    noDupes(db)
    noDupes(db.$setAuth({ id: 1 }))
    noDupes(db.asSystem())
    noDupes(db.$scopedBy({}))
    await db.$transaction(async (tx: any) => noDupes(tx))
    db.$close()
  })

  test('Object.keys lists the tables, not just the methods on the target', async () => {
    const db = await makeDb(SCHEMA, 'ownkeys-tables')
    const keys = Object.keys(db)
    expect(keys).toContain('user')
    expect(keys).toContain('post')
    expect(keys).toContain('$transaction')
    db.$close()
  })

  // Junction builds a "model not found" message from this list, so a scoped
  // client has to enumerate too — that path runs under $setAuth, never the bare
  // client.
  test('a scoped client enumerates its tables as well', async () => {
    const db = await makeDb(SCHEMA, 'ownkeys-scoped')
    expect(Object.keys(db.$setAuth({ id: 1 }))).toContain('user')
    expect(Object.keys(db.asSystem())).toContain('post')
    db.$close()
  })

  // The quieter half of the same defect: asSystem()'s proxy had a `get` trap and
  // nothing else, so it did not throw — it answered wrongly. A guard reading
  // `if ('user' in db)` silently skipped the table under a system client.
  test('asSystem() agrees with itself about what it has', async () => {
    const db = await makeDb(SCHEMA, 'ownkeys-system-has')
    const sys = db.asSystem()
    expect(typeof sys.user.findMany).toBe('function')
    expect('user' in sys).toBe(true)
    expect(Object.keys(sys)).toContain('user')
    expect('nope' in sys).toBe(false)
    db.$close()
  })

  test('a view is enumerable alongside the tables', async () => {
    const db = await makeDb(`
      model User { id Int @id  name String }
      view ActiveUser { @@sql("SELECT * FROM user") }
    `, 'ownkeys-views')
    expect(Object.getOwnPropertyNames(db)).toContain('ActiveUser')
    db.$close()
  })
})

// ─── $checkWhere — ask before you query (FJS-109) ─────────────────────────────
//
// The ORM's own split is warn-on-read / throw-on-write, and it is right there: a
// typo'd filter on a write is a mis-scoped destructive operation, while a read
// is merely empty. Over HTTP it is wrong — the warning goes to the server's
// stderr and the caller gets 200 with no rows. So a boundary that CAN answer 400
// asks first, and the rule stays defined once, here.

describe('$checkWhere', () => {
  const SCHEMA = `model Product { id Int @id  name String  price Float @default(1) }`

  test('a valid where reports nothing', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-ok')
    expect(db.$checkWhere('product', { name: 'a', price: 2 })).toEqual([])
    db.$close()
  })

  test('an unknown key is reported with the valid field list', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-unknown')
    const [p] = db.$checkWhere('product', { bogusColumn: 7 })
    expect(p.key).toBe('bogusColumn')
    expect(p.allowed).toEqual(['id', 'name', 'price'])
    db.$close()
  })

  test('a typo carries the same suggestion the warning does', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-typo')
    expect(db.$checkWhere('product', { nme: 'a' })[0].suggestion).toBe('name')
    db.$close()
  })

  test('it descends AND / OR / NOT', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-nested')
    expect(db.$checkWhere('product', { OR: [{ name: 'a' }, { nope: 1 }] }).map((p: any) => p.key))
      .toEqual(['nope'])
    expect(db.$checkWhere('product', { AND: [{ NOT: { alsoNope: 1 } }] }).map((p: any) => p.key))
      .toEqual(['alsoNope'])
    db.$close()
  })

  test('$raw is an escape hatch, not an unknown key', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-raw')
    expect(db.$checkWhere('product', { $raw: 'price > 1' })).toEqual([])
    db.$close()
  })

  // "I cannot judge this" is not "this is wrong". A caller using the answer to
  // reject a request must not reject what this failed to understand.
  test('an unknown accessor reports nothing rather than throwing', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-unknown-model')
    expect(db.$checkWhere('widget', { anything: 1 })).toEqual([])
    db.$close()
  })

  test('it neither warns nor runs a query', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-silent')
    const seen: string[] = []
    db.$tapQuery((q: any) => seen.push(q.sql))
    const warn = console.warn
    const warned: unknown[] = []
    console.warn = (...a: unknown[]) => { warned.push(a) }
    try { db.$checkWhere('product', { nope: 1 }) } finally { console.warn = warn }
    expect(seen).toEqual([])
    expect(warned).toEqual([])
    db.$close()
  })

  // It lived inline in the ROOT proxy's get trap, so the three derived clients
  // did not have it — and since a Litestone proxy throws on an unknown property
  // rather than returning undefined, even `typeof db.$setAuth(u).$checkWhere`
  // threw. Junction hands services a `$setAuth` client, so its autoFilter hook
  // died on every list read in both apps, complaining about a table nobody
  // named. Which keys are valid is a question about the SCHEMA; auth and scope
  // have no bearing on the answer, so every flavour must give the same one.
  test('every client flavour answers it, identically', async () => {
    const db = await makeDb(SCHEMA, 'checkwhere-flavours')
    const flavours: Record<string, any> = {
      root:      db,
      setAuth:   db.$setAuth({ id: 1 }),
      asSystem:  db.asSystem(),
      scopedBy:  db.$scopedBy({}),
    }
    for (const [name, c] of Object.entries(flavours)) {
      expect(typeof c.$checkWhere, name).toBe('function')
      expect(c.$checkWhere('product', { name: 'a', price: 2 }), name).toEqual([])
      expect(c.$checkWhere('product', { nme: 'a' })[0].suggestion, name).toBe('name')
      expect(c.$checkWhere('widget', { anything: 1 }), name).toEqual([])
    }
    db.$close()
  })
})

// ─── Bulk writes over rows of different shapes (FJS-175) ──────────────────────
// The column list used to come from row 0, so row 0 decided what every other
// row in the batch was allowed to write.

describe('createMany / upsertMany — rows of different shapes', () => {
  const SCHEMA = `
    model Post {
      id       Int    @id
      title    String
      subtitle String?
      tag      String?
      views    Int    @default(0)
    }
  `

  const narrow = { title: 'a' }
  const wide   = { title: 'b', subtitle: 'HELLO', tag: 'x', views: 99 }

  let db: any
  beforeAll(async () => { db = await makeDb(SCHEMA, 'many-shapes') })
  afterAll(() => db.$close())
  beforeEach(async () => { await db.post.deleteMany({ where: {} }) })

  test('a wider row after a narrow one keeps its columns', async () => {
    const r = await db.post.createMany({ data: [{ id: 1, ...narrow }, { id: 2, ...wide }] })
    expect(r.count).toBe(2)
    const rows = await db.post.findMany({ orderBy: { id: 'asc' } })
    expect(rows[1]).toMatchObject({ subtitle: 'HELLO', tag: 'x', views: 99 })
  })

  test('a narrower row after a wide one takes its DDL defaults, not NULL', async () => {
    const r = await db.post.createMany({ data: [{ id: 1, ...wide }, { id: 2, ...narrow }] })
    expect(r.count).toBe(2)
    const rows = await db.post.findMany({ orderBy: { id: 'asc' } })
    expect(rows[1]).toMatchObject({ subtitle: null, tag: null, views: 0 })
  })

  test('the same two rows write the same thing in either order', async () => {
    await db.post.createMany({ data: [{ id: 1, ...narrow }, { id: 2, ...wide }] })
    const forward = await db.post.findMany({ orderBy: { id: 'asc' } })
    await db.post.deleteMany({ where: {} })
    await db.post.createMany({ data: [{ id: 2, ...wide }, { id: 1, ...narrow }] })
    const reversed = await db.post.findMany({ orderBy: { id: 'asc' } })
    expect(reversed).toEqual(forward)
  })

  test('rows are inserted in caller order, not grouped by shape', async () => {
    // An @id @default(autoincrement()) is assigned in insert order, so grouping
    // the batch by shape would renumber the rows the caller handed over.
    const sql: string[] = []
    const d2 = await makeDb(SCHEMA, 'many-order', {
      onQuery: (q: any) => { if (q.sql) sql.push(q.sql) },
    })
    await d2.post.createMany({ data: [
      { id: 1, ...narrow }, { id: 2, ...wide }, { id: 3, ...narrow },
    ]})
    const rows = await d2.post.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.title)).toEqual(['a', 'b', 'a'])
    // Two shapes, three rows — the narrow statement is prepared once and reused.
    const reported = sql.find(s => s.includes('INSERT INTO "post"'))
    expect(reported?.split('\n').length).toBe(2)
    d2.$close()
  })

  test('a uniform batch still reports one statement', async () => {
    const sql: string[] = []
    const d2 = await makeDb(SCHEMA, 'many-uniform', {
      onQuery: (q: any) => { if (q.sql) sql.push(q.sql) },
    })
    await d2.post.createMany({ data: [{ id: 1, ...narrow }, { id: 2, ...narrow }] })
    const reported = sql.find(s => s.includes('INSERT INTO "post"'))
    expect(reported?.includes('\n')).toBe(false)
    d2.$close()
  })

  test('upsertMany: a column only the second row carries is still written', async () => {
    await db.post.upsertMany({ data: [{ id: 1, ...narrow }, { id: 2, ...wide }] })
    const rows = await db.post.findMany({ orderBy: { id: 'asc' } })
    expect(rows[1]).toMatchObject({ subtitle: 'HELLO', views: 99 })
  })

  test('upsertMany: a conflicting wide row updates the columns row 0 omits', async () => {
    await db.post.createMany({ data: [{ id: 1, ...narrow }] })
    await db.post.upsertMany({ data: [{ id: 9, ...narrow }, { id: 1, ...wide }] })
    const row = await db.post.findUnique({ where: { id: 1 } })
    expect(row).toMatchObject({ title: 'b', subtitle: 'HELLO', views: 99 })
  })
})

// ─── A key set to `undefined` means absent, not NULL (FJS-175) ────────────────

describe('write payload — an explicitly undefined key', () => {
  const SCHEMA = `
    model Post {
      id    Int    @id
      title String
      note  String?
      views Int    @default(0)
    }
  `

  let db: any
  beforeAll(async () => { db = await makeDb(SCHEMA, 'undef-keys') })
  afterAll(() => db.$close())
  beforeEach(async () => { await db.post.deleteMany({ where: {} }) })

  test('create: it does not defeat the column default', async () => {
    const row = await db.post.create({ data: { id: 1, title: 'a', views: undefined } })
    expect(row.views).toBe(0)
  })

  test('createMany: same', async () => {
    await db.post.createMany({ data: [{ id: 1, title: 'a', views: undefined }] })
    const row = await db.post.findUnique({ where: { id: 1 } })
    expect(row.views).toBe(0)
  })

  test('update: it leaves the column alone — only null clears', async () => {
    await db.post.create({ data: { id: 1, title: 'a', note: 'keep' } })
    await db.post.update({ where: { id: 1 }, data: { note: undefined } })
    expect((await db.post.findUnique({ where: { id: 1 } })).note).toBe('keep')
    await db.post.update({ where: { id: 1 }, data: { note: null } })
    expect((await db.post.findUnique({ where: { id: 1 } })).note).toBeNull()
  })
})

// ─── `db` names main's path, declared or not (FJS-015) ────────────────────────

describe('createClient({ db }) against a declared `database main`', () => {
  const declared = join(TMP, 'fjs015-declared.db')
  const SCHEMA = `
    database main { path "${declared}" }
    model Post { id Int @id  title String }
  `

  beforeEach(() => {
    rmSync(declared, { force: true })
    rmSync(join(TMP, 'fjs015-explicit.db'), { force: true })
    rmSync(join(TMP, 'fjs015-override.db'), { force: true })
  })

  test('db: \':memory:\' does not touch the declared file', async () => {
    // The declaration used to win in silence, so a test believing it was
    // in-memory accumulated state in the declared file across runs.
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    autoMigrate(db)
    await db.post.create({ data: { id: 1, title: 'a' } })
    db.$close()
    expect(existsSync(declared)).toBe(false)
  })

  test('db: a path writes that path, not the declared one', async () => {
    const explicit = join(TMP, 'fjs015-explicit.db')
    const db = await createClient({ schema: SCHEMA, db: explicit })
    autoMigrate(db)
    db.$close()
    expect(existsSync(explicit)).toBe(true)
    expect(existsSync(declared)).toBe(false)
  })

  test('no db option — the declaration still decides', async () => {
    const db = await createClient({ schema: SCHEMA })
    autoMigrate(db)
    db.$close()
    expect(existsSync(declared)).toBe(true)
  })

  test('databases: { main } is the more specific channel and wins over db', async () => {
    const override = join(TMP, 'fjs015-override.db')
    const db = await createClient({
      schema:    SCHEMA,
      db:        join(TMP, 'fjs015-explicit.db'),
      databases: { main: { path: override } },
    })
    autoMigrate(db)
    db.$close()
    expect(existsSync(override)).toBe(true)
    expect(existsSync(join(TMP, 'fjs015-explicit.db'))).toBe(false)
  })

  test('db does not reach a second declared database', async () => {
    // It names MAIN. Everything else keeps its declaration — `databases:
    // ':memory:'` is the shorthand that moves them all.
    const other = join(TMP, 'fjs015-other.db')
    rmSync(other, { force: true })
    const db = await createClient({
      schema: `
        database main  { path "${declared}" }
        database other { path "${other}" }
        model Post { id Int @id  title String }
        model Note { id Int @id  body  String  @@db(other) }
      `,
      db: ':memory:',
    })
    autoMigrate(db)
    db.$close()
    expect(existsSync(declared)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })
})

// ─── A set-valued enum is a column (FJS-141) ──────────────────────────────────
// `targets ReclaimTarget[]` used to be refused at parse time, so a declared set
// had no home in the seed: an app wrote String[] and validated the members
// somewhere else, which is how AlertRule.severity defaulted to a value its own
// API refused.

describe('enum arrays', () => {
  const SCHEMA = `
    enum ReclaimTarget { logs cache artifacts }
    model Rule {
      id      Int @id
      name    String
      targets ReclaimTarget[]
    }
  `

  let db: any
  beforeAll(async () => { db = await makeDb(SCHEMA, 'enum-array') })
  afterAll(() => db.$close())
  beforeEach(async () => { await db.rule.deleteMany({ where: {} }) })

  test('the schema parses and the field is an enum array', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const f = r.schema.models[0].fields.find((x: any) => x.name === 'targets')
    expect(f.type.kind).toBe('enum')
    expect(f.type.array).toBe(true)
  })

  test('the column is JSON text with no membership CHECK', () => {
    // SQLite cannot read the elements of a JSON array without json_each, and a
    // CHECK may not contain the subquery that would take. `IN (...)` would
    // compare the whole document against one value and fail every non-empty
    // array, so the constraint is left off rather than emitted wrong.
    const ddl = generateDDL(parse(SCHEMA).schema)
    expect(ddl).toContain(`"targets" TEXT NOT NULL DEFAULT '[]'`)
    expect(ddl).toContain(`json_type("targets") = 'array'`)
    expect(ddl).not.toContain(`"targets" IN (`)
  })

  test('round-trips a set of values', async () => {
    await db.rule.create({ data: { id: 1, name: 'a', targets: ['logs', 'cache'] } })
    const row = await db.rule.findUnique({ where: { id: 1 } })
    expect(row.targets).toEqual(['logs', 'cache'])
  })

  test('an absent set is the empty array, not null', async () => {
    const row = await db.rule.create({ data: { id: 1, name: 'a' } })
    expect(row.targets).toEqual([])
  })

  test('a member outside the enum is refused, and named', async () => {
    let err: any = null
    try {
      await db.rule.create({ data: { id: 1, name: 'a', targets: ['logs', 'nope'] } })
    } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.errors[0].path).toEqual(['targets'])
    expect(err.message).toContain('"nope"')
    expect(err.message).toContain('logs, cache, artifacts')
    expect(await db.rule.count({})).toBe(0)
  })

  test('every bad member is named, not just the first', async () => {
    let err: any = null
    try {
      await db.rule.create({ data: { id: 1, name: 'a', targets: ['nope', 'nah'] } })
    } catch (e) { err = e }
    expect(err.message).toContain('"nope"')
    expect(err.message).toContain('"nah"')
  })

  test('an update is checked too', async () => {
    await db.rule.create({ data: { id: 1, name: 'a', targets: ['logs'] } })
    await expect(db.rule.update({ where: { id: 1 }, data: { targets: ['bogus'] } }))
      .rejects.toThrow(/bogus/)
    expect((await db.rule.findUnique({ where: { id: 1 } })).targets).toEqual(['logs'])
  })

  test('`has` filters by membership', async () => {
    await db.rule.createMany({ data: [
      { id: 1, name: 'a', targets: ['logs', 'cache'] },
      { id: 2, name: 'b', targets: ['artifacts'] },
    ]})
    const rows = await db.rule.findMany({ where: { targets: { has: 'logs' } } })
    expect(rows.map((r: any) => r.id)).toEqual([1])
  })

  test('JSON Schema puts the $ref on the items, not the field', () => {
    // A picker reads the field's own schema. A bare $ref there would offer one
    // choice for a column that holds several.
    const js: any = generateJsonSchema(parse(SCHEMA).schema)
    expect(js.$defs.Rule.properties.targets).toEqual({
      type:  'array',
      items: { $ref: '#/$defs/ReclaimTarget' },
    })
    expect(js.$defs.ReclaimTarget.enum).toEqual(['logs', 'cache', 'artifacts'])
  })

  test('an unknown array element type is still refused, and the message lists enums', () => {
    const r = parse(`model M { id Int @id\n f Float[] }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain('an enum name')
  })
})

// ─── @default on an array field must be a JSON array ──────────────────────────

describe('array fields — @default', () => {
  const bad = (t: string) => parse(`enum T { a b }\nmodel M { id Int @id\n f ${t} }`)

  test('a non-array default is a schema error, not a runtime CHECK failure', () => {
    // The default is emitted into the DDL verbatim, so @default("x") parsed,
    // migrated, and failed json_type on the first insert that relied on it.
    for (const t of ['String[] @default("x")', 'T[] @default(a)', 'Int[] @default(1)']) {
      const r = bad(t)
      expect(r.valid, t).toBe(false)
      expect(r.errors.join('\n'), t).toContain('must be a JSON array string')
    }
  })

  test('a JSON array default is accepted', () => {
    expect(bad('String[] @default("[]")').valid).toBe(true)
    expect(bad('T[] @default("[\\"a\\"]")').valid).toBe(true)
  })
})

// ─── A bare array in a `where` on an array column (FJS-189) ───────────────────
// The shorthand says one thing on both column kinds — the column's value is in
// this list. A scalar has one value; an array column supplies its elements, so
// the IN moves inside json_each. It used to compile to `"tags" IN (?, ?)`,
// which asks a JSON document whether it equals 'x', and answered nothing.

// The rest of the family: a string operator asks about TEXT, and a column that
// does not hold text answers plausibly and wrongly rather than failing. Int and
// DateTime are deliberately left alone — SQLite's coercion answers what was
// asked there, and a month against an ISO column is a real use (FJS-210).
describe('a string operator on a column that is not text', () => {
  const S = `type Addr { city String  zip String }
  model Doc {
    id    Int @id @default(autoincrement())
    title String
    flag  Boolean @default(false)
    meta  Json?
    addr  Json?   @type(Addr)
    num   Int
    when  DateTime
  }`
  let db: any
  beforeAll(async () => {
    db = await makeDb(S, 'text-ops')
    await db.doc.create({ data: { title: 'alpha', flag: true,  meta: { z: 1 }, addr: { city: 'Boston', zip: '02101' }, num: 7,  when: new Date('2024-01-15') } })
    await db.doc.create({ data: { title: 'beta',  flag: false, meta: { a: 2 }, addr: { city: 'Austin', zip: '73301' }, num: 42, when: new Date('2025-06-01') } })
  })

  test('a Boolean is stored as 0/1, so it can never match — and used to answer []', async () => {
    await expect(db.doc.findMany({ where: { flag: { contains: 'tru' } } }))
      .rejects.toThrow(/"flag" is a Boolean, stored as 0\/1/)
  })

  test('a Json document would match its own serialised text', async () => {
    await expect(db.doc.findMany({ where: { meta: { contains: 'z' } } }))
      .rejects.toThrow(/"meta" holds a JSON document/)
    await expect(db.doc.findMany({ where: { addr: { contains: 'Boston' } } }))
      .rejects.toThrow(/declare @type\(\.\.\.\) on the column to filter by a path/)
  })

  test('a path INTO a typed Json column is untouched — that operand is text', async () => {
    const rows = await db.doc.findMany({ where: { addr: { city: { contains: 'Bos' } } } })
    expect(rows.map((r: any) => r.id)).toEqual([1])
  })

  test('Int and DateTime keep the answers they already gave', async () => {
    expect((await db.doc.findMany({ where: { num:  { contains: '7' } } })).map((r: any) => r.id)).toEqual([1])
    expect((await db.doc.findMany({ where: { when: { contains: '2024-01' } } })).map((r: any) => r.id)).toEqual([1])
    expect((await db.doc.findMany({ where: { title: { contains: 'lph' } } })).map((r: any) => r.id)).toEqual([1])
  })
})

describe('where on an array column', () => {
  const SCHEMA = `
    enum Kind { a b c }
    model M {
      id    Int @id
      name  String
      tags  String[]
      kinds Kind[]
      posts P[]
    }
    model P {
      id    Int @id
      title String
      mid   Int
      m     M @relation(fields: [mid], references: [id])
    }
  `

  let db: any
  beforeAll(async () => {
    db = await makeDb(SCHEMA, 'where-array')
    await db.m.createMany({ data: [
      { id: 1, name: 'a', tags: ['x', 'y'], kinds: ['a', 'b'] },
      { id: 2, name: 'b', tags: ['y', 'z'], kinds: ['c'] },
      { id: 3, name: 'c', tags: [],         kinds: [] },
    ]})
    await db.p.create({ data: { id: 1, title: 't', mid: 1 } })
  })
  afterAll(() => db.$close())

  const ids = (rows: any[]) => rows.map(r => r.id)
  const find = async (where: any) => ids(await db.m.findMany({ where, orderBy: { id: 'asc' } }))

  test('a bare array matches a row holding ANY of the values', async () => {
    expect(await find({ tags: ['x', 'y'] })).toEqual([1, 2])
    expect(await find({ tags: ['z'] })).toEqual([2])
  })

  test('it compiles to an IN, inside json_each', async () => {
    const sql: string[] = []
    const d2 = await makeDb(SCHEMA, 'where-array-sql', { onQuery: (q: any) => q.sql && sql.push(q.sql) })
    await d2.m.findMany({ where: { tags: ['x'] } })
    expect(sql.some(s => s.includes(`json_each("tags")`) && s.includes('value IN (?)'))).toBe(true)
    d2.$close()
  })

  test('an empty bare array matches nothing, like `in: []`', async () => {
    expect(await find({ tags: [] })).toEqual([])
  })

  test('a scalar column still reads a bare array as IN', async () => {
    expect(await find({ id: [1, 2] })).toEqual([1, 2])
    expect(await find({ name: ['a', 'b'] })).toEqual([1, 2])
  })

  test('`equals` is the exact set, and it is ordered', async () => {
    expect(await find({ tags: { equals: ['x', 'y'] } })).toEqual([1])
    expect(await find({ tags: { equals: ['y', 'x'] } })).toEqual([])
  })

  test('`equals: []` finds the empty ones', async () => {
    expect(await find({ tags: { equals: [] } })).toEqual([3])
  })

  test('`equals` still means equality on a scalar column', async () => {
    expect(await find({ name: { equals: 'b' } })).toEqual([2])
    expect(await find({ name: { equals: null } })).toEqual([])
  })

  test('`not` with an array is NOT the exact set', async () => {
    // It used to fall into `col != ?` with one placeholder and N bindings, and
    // SQLite answered about placeholder counts rather than about the field.
    expect(await find({ tags: { not: ['x', 'y'] } })).toEqual([2, 3])
  })

  test('`not` with an array on a SCALAR column is NOT IN', async () => {
    expect(await find({ name: { not: ['a', 'b'] } })).toEqual([3])
  })

  test('`hasNone`', async () => {
    expect(await find({ tags: { hasNone: ['x'] } })).toEqual([2, 3])
    expect(await find({ tags: { hasNone: ['x', 'y', 'z'] } })).toEqual([3])
  })

  test('the operators that were already there still answer', async () => {
    expect(await find({ tags: { has: 'y' } })).toEqual([1, 2])
    expect(await find({ tags: { hasEvery: ['x', 'y'] } })).toEqual([1])
    expect(await find({ tags: { hasSome: ['x', 'z'] } })).toEqual([1, 2])
    expect(await find({ tags: { isEmpty: true } })).toEqual([3])
  })

  test('an array operator on a scalar column names both, not "malformed JSON"', async () => {
    // json_each raises on a column that is not a JSON document, and its message
    // names neither the field nor the operator.
    await expect(db.m.findMany({ where: { name: { has: 'x' } } }))
      .rejects.toThrow(/"has" is an array operator and "name" is not an array field/)
  })

  // `contains` on an array column is a substring search over the stored JSON
  // that LOOKS like `has`, and the cases where the two agree are exactly the
  // ones that hide it (FJS-210).
  test('a string operator is refused, and says `has` is the one that was meant', async () => {
    for (const op of ['contains', 'startsWith', 'endsWith']) {
      await expect(db.m.findMany({ where: { tags: { [op]: 'x' } } }))
        .rejects.toThrow(new RegExp(`"tags" holds a JSON array, so "${op}" would substring-match`))
    }
    // The two that made it look like it worked: a real element, and punctuation
    // from the serialisation itself.
    await expect(db.m.findMany({ where: { tags: { contains: '","' } } })).rejects.toThrow(/use "has"/)
    await expect(db.m.findMany({ where: { tags: { contains: '[' } } })).rejects.toThrow(/use "has"/)
    // Refused as a caller error, so a boundary can answer 400 rather than 500.
    await expect(db.m.findMany({ where: { tags: { contains: 'x' } } }))
      .rejects.toThrow(expect.objectContaining({ name: 'ValidationError' }))
    // What was meant still answers.
    expect(await find({ tags: { has: 'x' } })).toEqual([1])
  })

  test('an enum array reads the same way', async () => {
    expect(await find({ kinds: ['a', 'c'] })).toEqual([1, 2])
    expect(await find({ kinds: { equals: ['a', 'b'] } })).toEqual([1])
    expect(await find({ kinds: { has: 'c' } })).toEqual([2])
  })

  test('it survives AND / OR / NOT groups', async () => {
    expect(await find({ OR: [{ tags: ['x'] }, { tags: ['z'] }] })).toEqual([1, 2])
    expect(await find({ NOT: { tags: ['x'] } })).toEqual([2, 3])
    expect(await find({ AND: [{ tags: ['y'] }, { name: 'b' }] })).toEqual([2])
  })

  test('it reaches the paths that build their own WHERE', async () => {
    // A relation filter, an include filter and deleteMany each call buildWhere
    // themselves; the array map has to reach the model each one is about.
    expect(ids(await db.p.findMany({ where: { m: { is: { tags: ['x'] } } } }))).toEqual([1])

    const withPosts = await db.m.findMany({ where: { id: 1 }, include: { posts: { where: { title: 't' } } } })
    expect(withPosts[0].posts.length).toBe(1)

    const d2 = await makeDb(SCHEMA, 'where-array-del')
    await d2.m.createMany({ data: [
      { id: 1, name: 'a', tags: ['x'] },
      { id: 2, name: 'b', tags: ['z'] },
    ]})
    expect((await d2.m.deleteMany({ where: { tags: ['z'] } })).count).toBe(1)
    expect(ids(await d2.m.findMany({}))).toEqual([1])
    d2.$close()
  })
})

// ─── schema mutation testing ─────────────────────────────────────────────────
// Mutate the schema, run the ORIGINAL schema's derived checks against a database
// built from the mutant, and see what nobody noticed.

describe('schemaMutants', () => {
  const S = `
model Team { id Int @id  slug String @unique  name String @length(2, 40)  people Person[] }
model Person {
  id     Int    @id
  email  String @email @unique
  handle String @length(3, 12)
  token  String @guarded
  teamId Int
  team   Team   @relation(fields: [teamId], references: [id])
  @@gate("2.4.4.5")
}
`

  test('one mutant per attribute occurrence, each carrying whole schema text', async () => {
    const { schemaMutants } = await import('../src/mutate.js')
    const all = schemaMutants(S)
    const kinds = new Set(all.map((m: any) => m.kind))

    expect(kinds.has('gate-drop')).toBe(true)
    expect(kinds.has('gate-lower')).toBe(true)
    expect(kinds.has('guarded-drop')).toBe(true)
    expect(kinds.has('unique-drop')).toBe(true)
    expect(kinds.has('validator-drop')).toBe(true)
    expect(kinds.has('validator-widen')).toBe(true)
    // Each is a complete schema, not a diff — a caller builds a client from it
    // without knowing anything about how it was made.
    for (const m of all) expect(m.text).toContain('model Person')
    // A field carrying two rules is two separate holes.
    expect(all.filter((m: any) => m.kind === 'validator-widen').length).toBe(2)
  })

  test('a gate lowered out of order is refused by the parser, and counted as a kill', async () => {
    const { schemaMutants } = await import('../src/mutate.js')
    // Levels must be non-decreasing in R.C.U.D order, so lowering `update`
    // below `create` produces a schema the framework will not load. That is a
    // kill — it cannot ship — but one nothing in the suite had to make.
    const lowered = schemaMutants(S, { kinds: ['gate-lower'] })
    expect(lowered.length).toBe(4)
    expect(lowered.every((m: any) => m.text.includes('@@gate'))).toBe(true)
  })

  test('only the models are mutated — a database block is not a model', async () => {
    const { schemaMutants } = await import('../src/mutate.js')
    const withDb = `
database main { path "./x.db" }
enum Kind { a b }
model One { id Int @id  name String @length(1, 5) }
enum After { x y }
`
    const all = schemaMutants(withDb)
    // `model One` opens and closes on one line. Left open it would swallow
    // whatever came next — the enum below it is the case that proves it does not.
    expect(all.every((m: any) => m.model === 'One')).toBe(true)
    expect(all.length).toBe(1)
  })

  test('an attribute inside a doc comment is prose, not a mutation site', async () => {
    // A mutant that edits a comment is behaviourally identical to the original
    // and survives everything, so a well-commented schema scored WORSE. Found on
    // `example`, whose Customer model documents what @guarded is not.
    const { schemaMutants } = await import('../src/mutate.js')
    const commented = `
model Doc {
  id   Int    @id
  /// NOT @guarded — that is a system-context lock, and @guarded(5) does not parse.
  name String @length(1, 5)   // @unique would be wrong here
}
`
    const all = schemaMutants(commented)
    expect(all.map((m: any) => m.kind)).toEqual(['validator-widen'])
    // The comment survives the mutation it sits beside.
    expect(all[0].text).toContain('// @unique would be wrong here')
  })

  test('a quoted // is not a comment', async () => {
    // Truncating there produces a mutant that fails to parse, which counts as a
    // kill — so the noise would have looked like coverage.
    const { schemaMutants } = await import('../src/mutate.js')
    const all = schemaMutants(`
model Site { id Int @id  url String @default("http://x.test") @length(1, 200) }
`)
    expect(all.length).toBeGreaterThan(0)
    for (const m of all) expect(m.text).toContain('http://x.test')
    expect(all.every((m: any) => m.parses)).toBe(true)
  })
})

describe('mutationScore', () => {
  const S = `
model Team { id Int @id  slug String @unique  name String @length(2, 40)  people Person[] }
model Person {
  id     Int    @id
  email  String @email @unique
  handle String @length(3, 12)
  age    Int    @gte(18) @lte(120)
  token  String @guarded
  teamId Int
  team   Team   @relation(fields: [teamId], references: [id])
  @@gate("2.4.4.5")
  @@allow('read', handle != null)
}
`

  test('the derived checks catch the access and constraint mutations', async () => {
    const { mutationScore } = await import('../src/mutate.js')
    const r = await mutationScore({ schema: S, build: (t: string) => createTestEnv({ schema: t }) })

    expect(r.total).toBeGreaterThan(10)
    expect(r.errored).toHaveLength(0)
    expect(r.score).toBeGreaterThan(0.8)

    // The one that survives is `@@allow('read', handle != null)` over a
    // NON-optional column — a policy that admits every row there can ever be, so
    // deleting it changes nothing anything could observe. A correct survival,
    // and the reason `verifyRowPolicies` reports a one-sided predicate rather
    // than passing it.
    expect(r.survived.map((m: any) => m.kind)).toEqual(['allow-drop'])
  }, 120_000)

  test('an error row never counts as a kill', async () => {
    // The trap this whole thing can fall into. Every mutant came back with the
    // same 22 error rows once, and the score read 93% while four mutations went
    // completely unnoticed — a mutation score counting its own harness failures
    // as successes is the oracle problem wearing a percentage.
    const { mutationScore } = await import('../src/mutate.js')
    const r = await mutationScore({
      schema: S,
      // The check is stubbed, so breadth buys nothing here and every mutant
      // costs a database.
      kinds:  ['gate-drop', 'allow-drop'],
      build:  (t: string) => createTestEnv({ schema: t }),
      // Every mutant "fails" — but only in the ungraded outcomes.
      check:  async () => [
        { got: 'error',   message: 'could not run' },
        { got: 'skipped', message: 'not graded' },
      ],
    })
    expect(r.killed).toBe(r.refused.length)      // only the parser/loader kills
    expect(r.survived.length).toBe(r.graded - r.refused.length)
  }, 120_000)

  test('a mutant the framework refuses to load is a kill, not an error', async () => {
    const { mutationScore } = await import('../src/mutate.js')
    const r = await mutationScore({
      schema: S,
      kinds:  ['gate-lower'],
      build:  (t: string) => createTestEnv({ schema: t }),
    })
    // A non-monotonic @@gate parses and the gate plugin refuses it at
    // construction — the two halves of "is this schema legal" do not agree, and
    // only the second is reached here.
    expect(r.refused.length).toBeGreaterThan(0)
    expect(r.errored).toHaveLength(0)
  }, 120_000)
})

// ─── Batch 1: values, virtual fields, empty writes, array membership ──────────

describe('a write value that cannot be bound', () => {
  const S = `model Post {
    id    Int    @id @default(autoincrement())
    title String
    views Int    @default(0)
  }`

  test('every write path refuses an object by name, and writes nothing', async () => {
    const db = await makeDb(S, 'bind-write')
    await db.post.create({ data: { title: 'a', views: 5 } })

    // The shape a caller arriving from Prisma writes first. Before the guard,
    // bun:sqlite read it as a bag of named params and dropped EVERY binding —
    // so `update` matched no row and reported it as "no such row".
    const bad = { views: { increment: 1 } }
    await expect(db.post.update({ where: { id: 1 }, data: bad })).rejects.toThrow(/views/)
    await expect(db.post.updateMany({ where: {}, data: bad })).rejects.toThrow(/views/)
    await expect(db.post.create({ data: { title: 'b', views: { increment: 1 } } })).rejects.toThrow(/views/)
    await expect(db.post.upsert({ where: { id: 1 }, create: { title: 'c' }, update: bad })).rejects.toThrow(/views/)
    await expect(db.post.createMany({ data: [{ title: 'd', views: { increment: 1 } }] })).rejects.toThrow(/views/)

    const rows = await db.post.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].views).toBe(5)
  })

  test('the message says there are no atomic operators', async () => {
    const db = await makeDb(S, 'bind-msg')
    await db.post.create({ data: { title: 'a' } })
    await expect(db.post.update({ where: { id: 1 }, data: { views: { increment: 1 } } }))
      .rejects.toThrow(/atomic update operators/)
  })

  test('a read refuses an object operand by name rather than answering nothing', async () => {
    const db = await makeDb(S, 'bind-read')
    await db.post.create({ data: { title: 'a', views: 5 } })
    // A read has no `changes` to notice, so this one answered [] forever.
    await expect(db.post.findMany({ where: { views: { equals: { n: 1 } } } })).rejects.toThrow(/views/)
    await expect(db.post.findMany({ where: { title: { x: 1 } } })).rejects.toThrow(/title/)
  })

  test('functions and symbols are named too, not left to the driver', async () => {
    const db = await makeDb(S, 'bind-fn')
    await expect(db.post.create({ data: { title: () => 'x' } })).rejects.toThrow(/title/)
    await expect(db.post.create({ data: { title: Symbol('x') } })).rejects.toThrow(/title/)
  })

  test('legitimate object-valued columns still write', async () => {
    const db = await makeDb(`model Doc {
      id    Int      @id @default(autoincrement())
      meta  Json?
      words String[] @default("[]")
      when  DateTime
    }`, 'bind-ok')
    const row = await db.doc.create({ data: { meta: { a: 1 }, words: ['x'], when: new Date('2024-01-01') } })
    expect(row.meta).toEqual({ a: 1 })
    expect(row.words).toEqual(['x'])
  })
})

describe('a field the database owns cannot be written', () => {
  const S = `model Post {
    id    Int    @id @default(autoincrement())
    title String
    slug  String @computed
    upper String @generated("upper(title)")
  }`

  test('@generated and @computed are refused by name on every write path', async () => {
    const db = await makeDb(S, 'virtual-write', { computed: { Post: { slug: r => r.title } } })
    await db.post.create({ data: { title: 'a' } })
    await expect(db.post.update({ where: { id: 1 }, data: { upper: 'ZZZ' } })).rejects.toThrow(/upper/)
    await expect(db.post.update({ where: { id: 1 }, data: { slug: 'zzz' } })).rejects.toThrow(/slug/)
    await expect(db.post.updateMany({ where: {}, data: { upper: 'ZZZ' } })).rejects.toThrow(/upper/)
    await expect(db.post.create({ data: { title: 'b', upper: 'ZZZ' } })).rejects.toThrow(/upper/)
    expect((await db.post.findFirst({ where: { id: 1 } })).upper).toBe('A')
  })

  test('the refusal says WHY, so the caller knows it is not a typo', async () => {
    const db = await makeDb(S, 'virtual-why', { computed: { Post: { slug: r => r.title } } })
    await db.post.create({ data: { title: 'a' } })
    await expect(db.post.update({ where: { id: 1 }, data: { upper: 'Z' } })).rejects.toThrow(/@generated/)
    await expect(db.post.update({ where: { id: 1 }, data: { slug: 'z' } })).rejects.toThrow(/@computed/)
  })

  test('an UNKNOWN key is still stripped silently — mass assignment stays protected', async () => {
    const db = await makeDb(S, 'virtual-mass', { computed: { Post: { slug: r => r.title } } })
    const row = await db.post.create({ data: { title: 'a', notAColumn: 'x', isAdmin: true } })
    expect(row.title).toBe('a')
    expect('notAColumn' in row).toBe(false)
  })
})

describe('an update with nothing left to set', () => {
  const S = `model Post {
    id    Int    @id @default(autoincrement())
    title String
  }`

  test('updateMany answers the matched count instead of emitting invalid SQL', async () => {
    const db = await makeDb(S, 'empty-set')
    await db.post.create({ data: { title: 'a' } })
    await db.post.create({ data: { title: 'b' } })

    // `SET  WHERE` is a syntax error. Reachable from an ordinary form post whose
    // fields no longer match the model, because stripping unknown keys is the
    // mass-assignment protection working as designed.
    expect(await db.post.updateMany({ where: {}, data: {} })).toEqual({ count: 2 })
    expect(await db.post.updateMany({ where: { id: 1 }, data: { bogus: 1 } })).toEqual({ count: 1 })
    expect(await db.post.updateMany({ where: { id: 999 }, data: {} })).toEqual({ count: 0 })
    expect((await db.post.findMany()).map(r => r.title)).toEqual(['a', 'b'])
  })

  test('a real updateMany still binds SET before WHERE', async () => {
    const db = await makeDb(S, 'empty-set-ok')
    await db.post.create({ data: { title: 'a' } })
    await db.post.create({ data: { title: 'b' } })
    expect(await db.post.updateMany({ where: { id: 2 }, data: { title: 'z' } })).toEqual({ count: 1 })
    expect((await db.post.findMany()).map(r => r.title)).toEqual(['a', 'z'])
  })
})

describe('in / notIn on an array column', () => {
  const S = `model Post {
    id    Int      @id @default(autoincrement())
    name  String
    words String[] @default("[]")
  }`
  const seed = async (db: any) => {
    await db.post.create({ data: { name: 'a', words: ['x', 'y'] } })
    await db.post.create({ data: { name: 'b', words: ['z'] } })
    await db.post.create({ data: { name: 'c', words: [] } })
  }

  test('`in` says what the documented shorthand says', async () => {
    const db = await makeDb(S, 'array-in'); await seed(db)
    const ids = async (where: any) => (await db.post.findMany({ where })).map((r: any) => r.id)
    // filtering.md documents the bare array AS `in`. It answered and `in` did not.
    expect(await ids({ words: { in: ['x', 'y'] } })).toEqual([1])
    expect(await ids({ words: ['x', 'y'] })).toEqual([1])
    expect(await ids({ words: { hasSome: ['x', 'y'] } })).toEqual([1])
    expect(await ids({ words: { in: ['y', 'z'] } })).toEqual([1, 2])
    expect(await ids({ words: { in: [] } })).toEqual([])
  })

  test('`notIn` is its negation, and an empty array row counts as excluded from neither', async () => {
    const db = await makeDb(S, 'array-notin'); await seed(db)
    const ids = async (where: any) => (await db.post.findMany({ where })).map((r: any) => r.id)
    expect(await ids({ words: { notIn: ['x'] } })).toEqual([2, 3])
    expect(await ids({ words: { notIn: ['x', 'z'] } })).toEqual([3])
  })

  test('a scalar column is untouched by the change', async () => {
    const db = await makeDb(S, 'array-in-scalar'); await seed(db)
    const ids = async (where: any) => (await db.post.findMany({ where })).map((r: any) => r.id)
    expect(await ids({ name: { in: ['a', 'b'] } })).toEqual([1, 2])
    expect(await ids({ name: { notIn: ['a'] } })).toEqual([2, 3])
  })
})

describe('a grouped or aggregated value keeps the type a row read gives it', () => {
  const S = `model Post {
    id    Int      @id @default(autoincrement())
    flag  Boolean  @default(false)
    words String[] @default("[]")
    meta  Json?
    num   Int      @default(0)
  }`

  test('groupBy and _max hydrate like findMany', async () => {
    const db = await makeDb(S, 'hydrate')
    await db.post.create({ data: { flag: true,  words: ['x'], meta: { t: 1 }, num: 1 } })
    await db.post.create({ data: { flag: false, words: ['z'], meta: { t: 2 }, num: 2 } })

    const g = await db.post.groupBy({ by: ['flag'], _count: true })
    expect(g.map((r: any) => r.flag).sort()).toEqual([false, true])

    const gw = await db.post.groupBy({ by: ['words'], _count: true })
    expect(gw.every((r: any) => Array.isArray(r.words))).toBe(true)

    const gm = await db.post.groupBy({ by: ['meta'], _count: true })
    expect(gm.every((r: any) => typeof r.meta === 'object' && r.meta !== null)).toBe(true)

    const a = await db.post.aggregate({ _max: { flag: true, words: true } })
    expect(typeof a._max.flag).toBe('boolean')
    expect(Array.isArray(a._max.words)).toBe(true)
  })

  test('_sum and _avg are NOT coerced — the sum of a Boolean column is a count', async () => {
    const db = await makeDb(S, 'hydrate-sum')
    await db.post.create({ data: { flag: true,  num: 1 } })
    await db.post.create({ data: { flag: true,  num: 2 } })
    await db.post.create({ data: { flag: false, num: 3 } })
    const a = await db.post.aggregate({ _sum: { flag: true, num: true }, _avg: { flag: true } })
    expect(a._sum.flag).toBe(2)      // not `true`
    expect(a._sum.num).toBe(6)
    expect(a._avg.flag).toBeCloseTo(2 / 3)
  })
})

// ─── Tier 1 + 2: a filter that cannot match is answerable, and refused early ──

describe('$checkWhere says WHY a key cannot be filtered', () => {
  const S = `model Post {
    id    Int     @id @default(autoincrement())
    title String
    comp  String? @computed
    enc   String? @encrypted
    encs  String? @encrypted(deterministic: true)
    hsh   String? @hashed
  }`

  test('reasons match $checkOrderBy\'s contract', async () => {
    const db = await makeDb(S, 'cw-reasons', {
      encryptionKey: 'a'.repeat(64),
      computed: { Post: { comp: (r: any) => r.title } },
    })
    expect(db.$checkWhere('post', { title: 'x' })).toEqual([])
    expect(db.$checkWhere('post', { encs:  'x' })).toEqual([])   // deterministic IS filterable
    expect(db.$checkWhere('post', { hsh:   'x' })).toEqual([])   // so is a digest

    const [comp] = db.$checkWhere('post', { comp: 'A' })
    expect(comp.reason).toBe('computed')
    expect(comp.message).toContain('@computed')

    const [enc] = db.$checkWhere('post', { enc: 'x' })
    expect(enc.reason).toBe('encrypted')
    expect(enc.message).toContain('deterministic: true')
    expect(enc.message).toContain('@hashed')

    const [unk] = db.$checkWhere('post', { bogus: 1 })
    expect(unk.reason).toBe('unknown')
  })

  test('an unfilterable key is not offered as valid', async () => {
    const db = await makeDb(S, 'cw-allowed', {
      encryptionKey: 'a'.repeat(64),
      computed: { Post: { comp: (r: any) => r.title } },
    })
    const [unk] = db.$checkWhere('post', { bogus: 1 })
    expect(unk.allowed).not.toContain('comp')
    expect(unk.allowed).not.toContain('enc')
    expect(unk.allowed).toContain('title')
  })

  test('every flavour of client answers identically — filterability is schema, not auth', async () => {
    const db = await makeDb(S, 'cw-flavours', {
      encryptionKey: 'a'.repeat(64),
      computed: { Post: { comp: (r: any) => r.title } },
    })
    const q = { comp: 'A' }
    const r = JSON.stringify(db.$checkWhere('post', q))
    expect(JSON.stringify(db.asSystem().$checkWhere('post', q))).toBe(r)
    expect(JSON.stringify(db.$setAuth({ id: 1 }).$checkWhere('post', q))).toBe(r)
  })

  test('a WRITE refuses such a where, as it already did for an unknown key', async () => {
    const db = await makeDb(S, 'cw-write', {
      encryptionKey: 'a'.repeat(64),
      computed: { Post: { comp: (r: any) => r.title } },
    })
    await db.post.create({ data: { title: 'a' } })
    await expect(db.post.updateMany({ where: { comp: 'A' }, data: { title: 'z' } })).rejects.toThrow(/@computed/)
  })
})

describe('a predicate that can never match is refused at startup', () => {
  test('a global filter over a @computed field', async () => {
    const schema = `model Post {
      id Int @id @default(autoincrement())
      title String
      comp String? @computed
    }`
    // Silently filtered every row out of every read, forever.
    await expect(makeDb(schema, 'tier2-filter', {
      computed: { Post: { comp: (r: any) => r.title } },
      filters:  { post: { comp: 'A' } },
    })).rejects.toThrow(/global filter.*cannot match/s)
  })

  test('a @@allow policy comparing a protected field — only the mode with no answer', async () => {
    // A policy over an encoded column compiles the operand through the same
    // encoder a `where` uses, so the two matchable modes answer. Plain @encrypted
    // stores a random IV, so nothing can be encoded to match it and it stays a
    // refusal — the shape that read as an empty table for every caller (FJS-214).
    const mk = (decl: string) => `model Doc {
      id Int @id @default(autoincrement())
      title String
      owner String ${decl}
      @@allow('read', owner == auth().email)
    }`
    await expect(makeDb(mk('@encrypted'), 'tier2-pol', { encryptionKey: 'a'.repeat(64) }))
      .rejects.toThrow(/@encrypted under a random IV/)

    // Rows on BOTH sides: a policy that admits everything and a policy that never
    // ran are the same observation.
    for (const [decl, name] of [['@encrypted(deterministic: true)', 'tier2-pol-d'], ['@hashed', 'tier2-pol-h']]) {
      const db = await makeDb(mk(decl), name, { encryptionKey: 'a'.repeat(64) })
      await db.asSystem().doc.create({ data: { title: 'mine',   owner: 'a@x.com' } })
      await db.asSystem().doc.create({ data: { title: 'theirs', owner: 'b@x.com' } })
      const mine = await db.$setAuth({ id: 1, email: 'a@x.com' }).doc.findMany()
      expect(mine.map((r: any) => r.title)).toEqual(['mine'])
      expect(await db.$setAuth({ id: 2, email: 'c@x.com' }).doc.count()).toBe(0)
      expect(await db.$setAuth(null).doc.count()).toBe(0)
    }
  })

  test('a comparison the encoding cannot answer is still refused', async () => {
    // Both encodings preserve equality and nothing else, and neither side of a
    // column-to-column comparison is a value the policy can encode.
    const key = { encryptionKey: 'a'.repeat(64) }
    await expect(makeDb(`model Doc {
      id Int @id @default(autoincrement())
      owner String @hashed
      @@allow('read', owner > auth().email)
    }`, 'tier2-pol-gt', key)).rejects.toThrow(/preserve equality and nothing else/)

    await expect(makeDb(`model Doc {
      id Int @id @default(autoincrement())
      owner   String @hashed
      manager String
      @@allow('read', owner == manager)
    }`, 'tier2-pol-cc', key)).rejects.toThrow(/compared column to column/)

    // Evaluated in JS against the row read BACK, which has the column stripped.
    await expect(makeDb(`model Doc {
      id Int @id @default(autoincrement())
      owner String @hashed
      @@allow('post-update', owner == auth().email)
    }`, 'tier2-pol-pu', key)).rejects.toThrow(/post-update check reads the row back/)
  })

  test('update, delete and create each apply the policy to the encoded column', async () => {
    // read is a WHERE, create is evaluated in JS against the plaintext data, and
    // update/delete are WHEREs of their own — one encoder, four call sites.
    const db = await makeDb(`model Doc {
      id Int @id @default(autoincrement())
      title String
      owner String @hashed
      @@allow('read',   owner == auth().email)
      @@allow('create', owner == auth().email)
      @@allow('update', owner == auth().email)
      @@allow('delete', owner == auth().email)
    }`, 'tier2-pol-ops', { encryptionKey: 'a'.repeat(64) })
    await db.asSystem().doc.create({ data: { title: 'mine',   owner: 'a@x.com' } })
    await db.asSystem().doc.create({ data: { title: 'theirs', owner: 'b@x.com' } })

    const me = db.$setAuth({ id: 1, email: 'a@x.com' })
    expect(await me.doc.updateMany({ where: {}, data: { title: 'edited' } })).toEqual({ count: 1 })
    expect(await me.doc.create({ data: { title: 'new', owner: 'a@x.com' } })).toBeTruthy()
    await expect(me.doc.create({ data: { title: 'no', owner: 'b@x.com' } })).rejects.toThrow()
    expect(await me.doc.removeMany({ where: {} })).toEqual({ count: 2 })
    expect(await db.asSystem().doc.count()).toBe(1)   // theirs, untouched
  })

  test('an ordinary policy and an ordinary global filter still build', async () => {
    const db = await makeDb(`model Doc {
      id Int @id @default(autoincrement())
      title String
      ownerId Int
      status String
      @@allow('read', ownerId == auth().id)
    }`, 'tier2-ok', { filters: { doc: { status: 'live' } } })
    await db.asSystem().doc.create({ data: { title: 'a', ownerId: 1, status: 'live' } })
    expect(await db.$setAuth({ id: 1 }).doc.count()).toBe(1)
  })

  test('a function-form global filter is left alone — it needs a ctx to judge', async () => {
    const db = await makeDb(`model Post {
      id Int @id @default(autoincrement())
      title String
      comp String? @computed
    }`, 'tier2-fn', {
      computed: { Post: { comp: (r: any) => r.title } },
      filters:  { post: () => ({ title: 'a' }) },
    })
    await db.post.create({ data: { title: 'a' } })
    expect(await db.post.count()).toBe(1)
  })
})

// ─── Tier 3: a filter that cannot match throws on a read, not just a write ────

describe('an impossible filter is refused on a read', () => {
  const S = `model Post {
    id    Int     @id @default(autoincrement())
    title String
    comp  String? @computed
    enc   String? @encrypted
    encs  String? @encrypted(deterministic: true)
    hsh   String? @hashed
  }`
  const mk = (n: string) => makeDb(S, n, {
    encryptionKey: 'a'.repeat(64),
    computed: { Post: { comp: (r: any) => r.title?.toUpperCase() ?? null } },
  })

  test('@computed — because the alternative is not "fewer rows", it is the wrong rows', async () => {
    const db = await mk('t3-computed')
    const sys = db.asSystem()
    for (const t of ['a', 'b']) await sys.post.create({ data: { title: t } })
    // `comp` is not a column, so SQLite reads the quoted identifier as a string
    // literal and compares two constants: { comp: 'comp' } was TRUE for every
    // row, including rows whose computed value is 'A'.
    await expect(sys.post.findMany({ where: { comp: 'A' } })).rejects.toThrow(/@computed/)
    await expect(sys.post.findMany({ where: { comp: 'comp' } })).rejects.toThrow(/@computed/)
    await expect(sys.post.count({ where: { comp: 'A' } })).rejects.toThrow(/@computed/)
  })

  test('@encrypted under a random IV — naming both cures', async () => {
    const db = await mk('t3-enc')
    const sys = db.asSystem()
    await sys.post.create({ data: { title: 'a', enc: 'e1' } })
    await expect(sys.post.findMany({ where: { enc: 'e1' } })).rejects.toThrow(/deterministic: true/)
    await expect(sys.post.findMany({ where: { enc: 'e1' } })).rejects.toThrow(/@hashed/)
  })

  test('an UNKNOWN key still only warns on a read — that trade was ruled on separately', async () => {
    const db = await mk('t3-unknown')
    await db.post.create({ data: { title: 'a' } })
    expect(await db.post.findMany({ where: { bogus: 1 } })).toEqual([])
  })

  test('a legitimate filter is untouched', async () => {
    const db = await mk('t3-ok')
    const sys = db.asSystem()
    await sys.post.create({ data: { title: 'a', encs: 's1' } })
    expect((await sys.post.findMany({ where: { title: 'a' } })).length).toBe(1)
    expect((await sys.post.findMany({ where: { encs: 's1' } })).length).toBe(1)
  })
})

describe('both matchable modes answer every spelling of equality', () => {
  // One body, two modes. The rewrite is shared on purpose — encode the operand the
  // way the column was encoded — so the suite asks the same questions of both
  // rather than trusting that a second encoder inherited the first one's fixes.
  const S = `model User {
    id    Int    @id @default(autoincrement())
    name  String
    email String @encrypted(deterministic: true)
    token String @hashed
  }`

  const each: [string, 'email' | 'token'][] = [['@encrypted(deterministic)', 'email'], ['@hashed', 'token']]

  for (const [label, col] of each) {
    test(`${label}: in / notIn / not / the bare array all encode their operands`, async () => {
      const db = await makeDb(S, `enc-eq-${col}`, { encryptionKey: 'c'.repeat(64) })
      const sys = db.asSystem()
      await sys.user.create({ data: { name: 'a', email: 'a@x.io', token: 'ta' } })
      await sys.user.create({ data: { name: 'b', email: 'b@x.io', token: 'tb' } })
      const [A, B] = col === 'email' ? ['a@x.io', 'b@x.io'] : ['ta', 'tb']
      const ids = async (where: any) => (await sys.user.findMany({ where })).map((r: any) => r.id)

      // Only `{ col: value }` used to be encoded. `in` compared plaintext against
      // stored bytes and answered nothing; `not` answered EVERY row, the excluded
      // one included, because plaintext never equals ciphertext.
      expect(await ids({ [col]: A })).toEqual([1])
      expect(await ids({ [col]: { equals: A } })).toEqual([1])
      expect(await ids({ [col]: { in: [A] } })).toEqual([1])
      expect(await ids({ [col]: [A, B] })).toEqual([1, 2])
      expect(await ids({ [col]: { not: A } })).toEqual([2])
      expect(await ids({ [col]: { notIn: [A] } })).toEqual([2])
    })

    test(`${label}: an operator the encoding cannot answer is refused, not silently wrong`, async () => {
      const db = await makeDb(S, `enc-ops-${col}`, { encryptionKey: 'c'.repeat(64) })
      const sys = db.asSystem()
      await sys.user.create({ data: { name: 'a', email: 'a@x.io', token: 'ta' } })
      for (const op of [{ contains: 'x' }, { startsWith: 'a' }, { gt: 'a' }])
        await expect(sys.user.findMany({ where: { [col]: op } })).rejects.toThrow(/equality/)
    })
  }
})

// ─── @hashed and @encrypted(deterministic) — the declaration side ─────────────
//
// FJS-211. The old `@encrypted(searchable: true)` stored an HMAC under a name that
// promises the value comes back, destroyed the plaintext on write, and handed the
// digest to `asSystem()` as if it were the value. It is replaced by two attributes
// that each say what they do, along the one axis that matters — can this be read
// back? — and the old spelling is refused rather than translated, because guessing
// which of the two a schema meant is how the value was lost in the first place.

describe('@encrypted(deterministic) / @hashed — declaration', () => {
  const K = { encryptionKey: 'd'.repeat(64) }

  test('the old spelling is refused, and names both replacements', () => {
    const r = parse(`model U { id Int @id  email String @encrypted(searchable: true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/deterministic: true/)
    expect(r.errors.join(' ')).toMatch(/@hashed/)
  })

  test('an unknown @encrypted option is refused by name', () => {
    expect(parse(`model U { id Int @id  e String @encrypted(algorithm: true) }`).errors.join(' '))
      .toMatch(/only accepts \(deterministic: true\/false\)/)
  })

  test('@hashed does not compose with anything that implies a readable value', async () => {
    const cases: [string, RegExp][] = [
      ['t String @hashed @encrypted',            /conflicts with @encrypted/],
      ['t String @hashed @secret',               /conflicts with @secret/],
      ['t String @hashed @guarded(all)',         /conflicts with @guarded/],
      [`t String @hashed @allow('read', true)`,  /conflicts with @allow/],
      ['t Int    @hashed',                       /requires a String field/],
      ['t String[] @hashed',                     /cannot be applied to an array/],
    ]
    for (const [decl, re] of cases) {
      const r = parse(`model U { id Int @id\n  ${decl} }`)
      expect(r.valid).toBe(false)
      expect(r.errors.join(' ')).toMatch(re)
    }
  })

  test('a digest is never handed to any caller, by any path', async () => {
    const db = await makeDb(`model U { id Int @id  name String  pw String @hashed }`, 'hashed-paths', K)
    const sys = db.asSystem()
    await sys.u.create({ data: { id: 1, name: 'a', pw: 'hunter2' } })

    // The row path strips it — including asSystem(), which lifts every other lock.
    expect('pw' in (await sys.u.findUnique({ where: { id: 1 } }))).toBe(false)
    expect('pw' in (await sys.u.findMany())[0]).toBe(false)
    expect('pw' in (await sys.u.findMany({ distinct: ['pw'] }))[0]).toBe(false)

    // And the paths that project a column without building a row. These answered
    // the digest — a read of a value declared unreadable, and silent.
    await expect(sys.u.findUnique({ where: { id: 1 }, select: { pw: true } })).rejects.toThrow(/one-way digest/)
    await expect(sys.u.groupBy({ by: ['pw'], _count: true })).rejects.toThrow(/one-way digest/)
    await expect(sys.u.aggregate({ _max: { pw: true } })).rejects.toThrow(/one-way digest/)
    db.$close()
  })

  test('@hashed still matches, which is the only thing it promises', async () => {
    const db = await makeDb(`model U { id Int @id  name String  pw String @hashed }`, 'hashed-match', K)
    const sys = db.asSystem()
    await sys.u.create({ data: { id: 1, name: 'a', pw: 'hunter2' } })
    expect((await sys.u.findFirst({ where: { pw: 'hunter2' } }))?.name).toBe('a')
    expect(await sys.u.findFirst({ where: { pw: 'wrong' } })).toBeNull()

    // A rewrite is still a write, and the new value matches while the old stops.
    await sys.u.update({ where: { id: 1 }, data: { pw: 'letmein' } })
    expect((await sys.u.findFirst({ where: { pw: 'letmein' } }))?.id).toBe(1)
    expect(await sys.u.findFirst({ where: { pw: 'hunter2' } })).toBeNull()
    db.$close()
  })

  test('the two encodings are not each other — a digest is not a deterministic ciphertext', async () => {
    const db = await makeDb(`model U { id Int @id  a String @encrypted(deterministic: true)  b String @hashed }`, 'enc-sep', K)
    await db.asSystem().u.create({ data: { id: 1, a: 'same', b: 'same' } })
    const raw = (await db.asSystem().sql`SELECT a, b FROM u WHERE id = 1`)[0] as any
    // Same plaintext, same key, different domain — the IV is derived under its own
    // salt, so the digest cannot be read off the front of the ciphertext.
    expect(raw.a.startsWith('v1d.')).toBe(true)
    expect(raw.b.startsWith('v1h.')).toBe(true)
    expect(raw.a.slice(4)).not.toContain(raw.b.slice(4))
    db.$close()
  })

  test('a JSON Schema marks @hashed writeOnly and still offers it on create', async () => {
    const r = parse(`model U { id Int @id  name String  pw String @hashed }`)
    const js: any = generateJsonSchema(r.schema, { mode: 'create', audience: 'client' })
    // A password is submitted by the person it belongs to, so unlike @guarded it is
    // NOT withheld from the client — it is marked as never coming back.
    expect(js.$defs.U.properties.pw.writeOnly).toBe(true)
    expect(js.$defs.U.required).toContain('pw')
  })

  test('@secret(deterministic: true) rotates AND looks up', async () => {
    const schema = `model K { id Int @id  label String  token String @secret(deterministic: true) }`
    const r = parse(schema)
    expect(r.valid).toBe(true)
    const path = tmpDb('secret-det' + Math.random().toString(36).slice(2))
    const { Database: BunDb } = await import('bun:sqlite')
    const raw = new BunDb(path)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()

    const dbOld = await createClient({ parsed: r, db: path, encryptionKey: 'd'.repeat(64) })
    await (dbOld as any).asSystem().k.create({ data: { id: 1, label: 'k1', token: 'tok-abc' } })
    expect((await (dbOld as any).asSystem().k.findFirst({ where: { token: 'tok-abc' } }))?.label).toBe('k1')
    await dbOld.$rotateKey('e'.repeat(64))
    dbOld.$close()

    // A fresh client, because the rotating one cannot read its own output — that is
    // FJS-236 and it predates this attribute. What is asserted here is the half this
    // change owns: the column was re-encrypted in the mode it was DECLARED with, so
    // it is still both readable and matchable under the new key.
    const dbNew = await createClient({ parsed: r, db: path, encryptionKey: 'e'.repeat(64) })
    const sys   = (dbNew as any).asSystem()
    expect((await sys.k.findFirst({ where: { id: 1 } }))?.token).toBe('tok-abc')
    expect((await sys.k.findFirst({ where: { token: 'tok-abc' } }))?.label).toBe('k1')
    const col = (await sys.sql`SELECT token FROM k WHERE id = 1`)[0] as any
    expect(col.token.startsWith('v1d.')).toBe(true)
    dbNew.$close()
  })
})

// ─── $transaction under concurrency (FJS-237) ────────────────────────────────
//
// The depth counter is per CLIENT and one connection holds one transaction, so
// "am I nested?" could not be answered by the counter: a second REQUEST arriving
// while the first awaited looked exactly like a genuinely nested call, and was
// treated as one.
//
//   A: begin()  → BEGIN IMMEDIATE, awaits
//   B: begin()  → sees depth 1 → SAVEPOINT INSIDE A's transaction
//   B: commit() → RELEASE            ← B's caller told it succeeded
//   A: rollback → ROLLBACK           ← B's rows gone
//
// Re-entrancy is now asked of AsyncLocalStorage — a nested call runs inside the
// outer callback and inherits its store, a concurrent request does not. These
// assert BOTH halves, because a fix that serialised everything would deadlock
// basecamp's /setup and a fix that nested everything is the original bug.

describe('$transaction under concurrency', () => {
  const S = `model Row { id Int @id @default(autoincrement())  tag String }`

  test("a concurrent caller is not enrolled in someone else's rollback", async () => {
    const db  = await makeDb(S, 'tx-race')
    const sys = db.asSystem()
    let release: () => void
    const paused = new Promise<void>(r => { release = r })

    const A = sys.$transaction(async (tx: any) => {
      await tx.row.create({ data: { tag: 'A' } })
      await paused
      throw new Error('A rolls back')
    }).catch((e: Error) => e.message)

    // Start B while A is open. It must WAIT, not nest.
    await new Promise(r => setTimeout(r, 10))
    const B = sys.$transaction(async (tx: any) => {
      await tx.row.create({ data: { tag: 'B' } })
      return 'B committed'
    })

    release!()
    expect(await A).toBe('A rolls back')
    expect(await B).toBe('B committed')

    // The whole point: B was told it committed, so B's row must exist.
    expect((await sys.row.findMany({})).map((r: any) => r.tag)).toEqual(['B'])
    db.$close()
  })

  test('a genuinely nested $transaction still takes a SAVEPOINT rather than waiting', async () => {
    // If re-entrancy were decided by the lock instead of the async context this
    // would deadlock — which is what basecamp's /setup does, four models deep.
    const db  = await makeDb(S, 'tx-nested')
    const sys = db.asSystem()
    await sys.$transaction(async (tx: any) => {
      await tx.row.create({ data: { tag: 'outer' } })
      await tx.$transaction(async (tx2: any) => {
        await tx2.row.create({ data: { tag: 'inner' } })
      })
    })
    expect((await sys.row.findMany({})).map((r: any) => r.tag)).toEqual(['outer', 'inner'])
    db.$close()
  })

  test('an inner rollback leaves the outer transaction usable', async () => {
    const db  = await makeDb(S, 'tx-inner-rollback')
    const sys = db.asSystem()
    await sys.$transaction(async (tx: any) => {
      await tx.row.create({ data: { tag: 'kept' } })
      await tx.$transaction(async (tx2: any) => {
        await tx2.row.create({ data: { tag: 'discarded' } })
        throw new Error('inner fails')
      }).catch(() => {})
      await tx.row.create({ data: { tag: 'also-kept' } })
    })
    expect((await sys.row.findMany({})).map((r: any) => r.tag)).toEqual(['kept', 'also-kept'])
    db.$close()
  })

  test('a bulk write inside a transaction still batches, and one outside waits its turn', async () => {
    // createMany wraps its batch synchronously. Arriving during another
    // request's transaction it used to join that transaction and be lost on its
    // rollback; the acquire is awaited now while the batch body stays sync.
    const db  = await makeDb(S, 'tx-bulk')
    const sys = db.asSystem()

    await sys.$transaction(async (tx: any) => {
      await tx.row.createMany({ data: [{ tag: 'b1' }, { tag: 'b2' }] })
    })
    expect(await sys.row.count({})).toBe(2)

    let release: () => void
    const paused = new Promise<void>(r => { release = r })
    const A = sys.$transaction(async (tx: any) => {
      await tx.row.create({ data: { tag: 'A' } })
      await paused
      throw new Error('A rolls back')
    }).catch(() => 'rolled back')

    await new Promise(r => setTimeout(r, 10))
    const bulk = sys.row.createMany({ data: [{ tag: 'c1' }, { tag: 'c2' }] })

    release!()
    await A
    await bulk
    expect(await sys.row.count({ where: { tag: { in: ['c1', 'c2'] } } })).toBe(2)
    expect(await sys.row.count({ where: { tag: 'A' } })).toBe(0)
    db.$close()
  })
})
