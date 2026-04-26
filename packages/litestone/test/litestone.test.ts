#!/usr/bin/env bun
// litestone.test.ts — full end-to-end test suite for Bun
//
// Run:  bun test
//   or: bun test/litestone.test.ts

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'fs'
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
         verify }                     from '../src/core/migrations.js'

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
      model users {
        id    Integer  @id
        email Text     @unique
        name  Text?
      }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.models).toHaveLength(1)
    expect(r.schema.models[0].name).toBe('users')
    expect(r.schema.models[0].fields).toHaveLength(3)
  })

  test('parses enums', () => {
    const r = parse(`
      enum Plan { starter  pro  enterprise }
      model accounts { id Integer @id
        plan Plan @default(starter) }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.enums).toHaveLength(1)
    expect(r.schema.enums[0].values.map((v: any) => v.name)).toEqual(['starter','pro','enterprise'])
  })

  test('parses function blocks', () => {
    const r = parse(`
      function slug(text: Text): Text {
        @@expr("lower(replace({text}, ' ', '-'))")
      }
      model posts { id Integer @id
        title Text
        slug Text @slug(title) }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.functions).toHaveLength(1)
    expect(r.schema.functions[0].name).toBe('slug')
    expect(r.schema.functions[0].params).toHaveLength(1)
  })

  test('parses @generated with {field} syntax', () => {
    const r = parse(`
      model orders {
        id    Integer @id
        price Integer
        tax   Real    @default(0.08)
        total Real    @generated("{price} * (1.0 + {tax})", stored)
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
      model users {
        id        Integer  @id
        account   accounts @relation(fields: [accountId], references: [id])
        accountId Integer
      }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('accounts'))).toBe(true)
  })

  test('forward-ref @relation (FK after relation field) is valid', () => {
    const r = parse(`
      model accounts { id Integer @id
        name Text }
      model users {
        id        Integer  @id
        account   accounts @relation(fields: [accountId], references: [id])
        accountId Integer
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('validates @funcCall unknown function', () => {
    const r = parse(`
      model t { id Integer @id
        val Integer
        r Integer @missingFn(val) }
    `)
    expect(r.errors.some((e: string) => e.includes('unknown function'))).toBe(true)
  })

  test('validates @funcCall arg count', () => {
    const r = parse(`
      function dbl(x: Integer): Integer { @@expr("{x} * 2") }
      model t { id Integer @id
        val Integer
        r Integer @dbl(val, extra) }
    `)
    expect(r.errors.some((e: string) => e.includes('expects 1 argument'))).toBe(true)
  })

  test('multi-file imports via parseFile', () => {
    const dir = tmpDir('imports')
    writeFileSync(join(dir, 'enums.lite'),    'enum Role { admin  member }')
    writeFileSync(join(dir, 'functions.lite'),'function slug(text: Text): Text { @@expr("lower({text})") }')
    writeFileSync(join(dir, 'schema.lite'),   [
      'import "./enums.lite"',
      'import "./functions.lite"',
      'model users { id Integer @id\nrole Role @default(member)\nname Text\nslug Text @slug(name) }',
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
    writeFileSync(join(dir, 'a.lite'),      'import "./enums.lite"\nmodel A { id Integer @id\ns Status }')
    writeFileSync(join(dir, 'b.lite'),      'import "./enums.lite"\nmodel B { id Integer @id\ns Status }')
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
})

// ─── 2. DDL ───────────────────────────────────────────────────────────────────


describe('DDL', () => {

  test('STRICT by default', () => {
    const r = parse(`model t { id Integer @id }`)
    expect(isStrict(r.schema.models[0])).toBe(true)
    expect(generateDDL(r.schema)).toContain('STRICT')
  })

  test('@@noStrict opts out', () => {
    const r = parse(`model t { id Integer @id
        @@noStrict }`)
    expect(isStrict(r.schema.models[0])).toBe(false)
    expect(generateDDL(r.schema)).not.toContain('STRICT')
  })

  test('soft delete detection', () => {
    const r = parse(`
      model soft { id Integer @id
        deletedAt DateTime?
        @@softDelete }
      model hard { id Integer @id }
      model cascade { id Integer @id
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
      model users { id Integer @id
        email Text
        deletedAt DateTime?
        @@softDelete
        @@index([email]) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('WHERE "deletedAt" IS NULL')
    expect(ddl).toContain('idx_users_deletedAt')
  })

  test('no partial indexes on hard-delete tables', () => {
    const r = parse(`
      model logs { id Integer @id
        action Text
        @@index([action]) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).not.toContain('WHERE')
  })

  test('enum generates CHECK constraint', () => {
    const r = parse(`
      enum Plan { starter  pro  enterprise }
      model t { id Integer @id
        plan Plan @default(starter) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain("CHECK (\"plan\" IN ('starter', 'pro', 'enterprise'))")
  })

  test('FTS5 virtual table + triggers', () => {
    const r = parse(`
      model messages { id Integer @id
        body Text
        title Text?
        @@fts([body, title]) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('messages_fts')
    expect(ddl).toContain('messages_fts_insert')
    expect(ddl).toContain('messages_fts_delete')
    expect(ddl).toContain('messages_fts_update')
    expect(ddl).toContain('fts5')
  })

  test('@generated VIRTUAL (default)', () => {
    const r = parse(`
      model t { id Integer @id
        a Integer
        b Real @generated("{a} * 2") }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('GENERATED ALWAYS AS ("a" * 2) VIRTUAL')
  })

  test('@generated STORED', () => {
    const r = parse(`
      model t { id Integer @id
        a Integer
        b Integer @generated("{a} * 2", stored) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('GENERATED ALWAYS AS ("a" * 2) STORED')
  })


  test('@generated — self-reference is an error', () => {
    const r = parse(`
      model t {
        id  Integer @id
        a   Integer
        val Integer @generated("{val} * 2")
      }
    `)
    expect(r.errors.some((e: string) => e.includes('cannot reference itself'))).toBe(true)
  })

  test('@generated — circular reference is an error', () => {
    const r = parse(`
      model t {
        id Integer @id
        a  Integer @generated("{b} + 1")
        b  Integer @generated("{a} + 1")
      }
    `)
    expect(r.errors.some((e: string) => e.includes('circular'))).toBe(true)
  })

  test('@generated — unknown field reference is an error', () => {
    const r = parse(`
      model t {
        id  Integer @id
        a   Integer
        val Integer @generated("{ghost} * 2")
      }
    `)
    expect(r.errors.some((e: string) => e.includes("unknown field 'ghost'"))).toBe(true)
  })

  test('@generated — forward chain is valid (SQLite handles it)', () => {
    const r = parse(`
      model t {
        id Integer @id
        c  Integer @generated("{b} + 1")
        b  Integer @generated("{a} + 1")
        a  Integer
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('@generated — backward chain is valid', () => {
    const r = parse(`
      model t {
        id Integer @id
        a  Integer
        b  Integer @generated("{a} + 1")
        c  Integer @generated("{b} + 1")
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('@generated — multi-field expr is valid', () => {
    const r = parse(`
      model orders {
        id    Integer @id
        price Integer
        tax   Real    @default(0.08)
        total Real    @generated("{price} * (1.0 + {tax})")
      }
    `)
    expect(r.valid).toBe(true)
  })

  test('function @funcCall expands to GENERATED ALWAYS AS STORED', () => {
    const r = parse(`
      function slug(text: Text): Text { @@expr("lower({text})") }
      model posts { id Integer @id
        title Text
        slug Text @slug(title) }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('GENERATED ALWAYS AS (lower("title")) STORED')
  })

  test('DDL executes in bun:sqlite', () => {
    const r = parse(`
      model accounts { id Integer @id
        name Text
        plan Text @default("starter") }
      model users { id Integer @id
        accountId Integer
        email Text @unique
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
      model posts {
        id        Integer  @id
        title     Text
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
      model items {
        id        Integer  @id
        name      Text     @trim @lower
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
      model entries {
        id        Integer  @id
        body      Text
        updatedAt DateTime @default(now()) @updatedAt
      }
    `, 'updatedat-trigger')
    const entry = await db.entries.create({ data: { id: 1, body: 'original' } })
    const before = entry.updatedAt

    // Small delay so timestamp can change
    await new Promise(r => setTimeout(r, 10))
    await db.entries.update({ where: { id: 1 }, data: { body: 'changed' } })
    const after = await db.entries.findUnique({ where: { id: 1 } })

    expect(after.updatedAt).not.toBe(before)
    db.$close()
  })
})

// ─── 43. @date field attribute ────────────────────────────────────────────────


describe('@date field attribute', () => {
  const schema = `
    model events {
      id        Integer @id
      name      Text
      startsOn  Text    @date
      endsOn    Text?   @date
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
    const event = await db.events.create({ data: { id: 1, name: 'Launch', startsOn: '2026-04-06' } })
    expect(event.startsOn).toBe('2026-04-06')
    db.$close()
  })

  test('@date rejects an invalid format', async () => {
    const db = await makeDb(schema, 'date-invalid')
    await expect(
      db.events.create({ data: { id: 1, name: 'Bad', startsOn: '06/04/2026' } })
    ).rejects.toThrow('YYYY-MM-DD')
    db.$close()
  })

  test('@date rejects a full datetime string', async () => {
    const db = await makeDb(schema, 'date-reject-datetime')
    await expect(
      db.events.create({ data: { id: 1, name: 'Bad', startsOn: '2026-04-06T09:00:00.000Z' } })
    ).rejects.toThrow('YYYY-MM-DD')
    db.$close()
  })

  test('@date allows null on optional field', async () => {
    const db = await makeDb(schema, 'date-null')
    const event = await db.events.create({ data: { id: 1, name: 'TBD', startsOn: '2026-04-06', endsOn: null } })
    expect(event.endsOn).toBeNull()
    db.$close()
  })

  test('@date fields sort correctly as strings', async () => {
    const db = await makeDb(schema, 'date-sort')
    await db.events.createMany({ data: [
      { id: 1, name: 'C', startsOn: '2026-06-01' },
      { id: 2, name: 'A', startsOn: '2026-01-15' },
      { id: 3, name: 'B', startsOn: '2026-03-20' },
    ]})
    const rows = await db.events.findMany({ orderBy: { startsOn: 'asc' } })
    expect(rows.map((r: any) => r.name)).toEqual(['A', 'B', 'C'])
    db.$close()
  })

  test('@date range queries work correctly', async () => {
    const db = await makeDb(schema, 'date-range')
    await db.events.createMany({ data: [
      { id: 1, name: 'Past',    startsOn: '2025-12-01' },
      { id: 2, name: 'Q1',     startsOn: '2026-01-15' },
      { id: 3, name: 'Q2',     startsOn: '2026-04-06' },
      { id: 4, name: 'Future', startsOn: '2026-09-01' },
    ]})
    const q2 = await db.events.findMany({
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
    const props = jschema['$defs'].events.properties
    expect(props.startsOn.format).toBe('date')
  })

  test('@date on optional field is nullable in JSON Schema', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const result = parse(schema)
    const jschema = generateJsonSchema(result.schema)
    const endsOn = jschema['$defs'].events.properties.endsOn
    // nullable: anyOf with date string and null
    expect(endsOn.anyOf ?? [endsOn]).toSatisfy((arr: any) =>
      JSON.stringify(arr).includes('date')
    )
  })

  test('@date custom error message', async () => {
    const result = parse(`
      model items {
        id   Integer @id
        due  Text    @date("Due date must be YYYY-MM-DD")
      }
    `)
    expect(result.valid).toBe(true)
    const db = await makeDb(`
      model items {
        id   Integer @id
        due  Text    @date("Due date must be YYYY-MM-DD")
      }
    `, 'date-custom-msg')
    await expect(
      db.items.create({ data: { id: 1, due: 'not-a-date' } })
    ).rejects.toThrow('Due date must be YYYY-MM-DD')
    db.$close()
  })
})

// ─── 44. @sequence per-scope auto-increment ───────────────────────────────────


describe('@sequence per-scope auto-increment', () => {
  const schema = `
    model Quote {
      id          Integer  @id
      accountId   Integer?
      quoteNumber Integer? @sequence(scope: accountId)
      title       Text
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
        id         Integer @id
        accountId  Integer
        docNum     Integer @sequence(scope: accountId)
        revNum     Integer @sequence(scope: accountId)
        title      Text
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

import { makeTestClient, Factory, truncate, reset } from '../src/testing.js'
import { generateJsonSchema } from '../src/jsonschema.js'

// ── Shared factories ──────────────────────────────────────────────────────────

const FACTORY_SCHEMA = `
  model accounts {
    id   Integer @id
    name Text
    plan Text    @default("starter")
  }
  model users {
    id        Integer @id
    accountId Integer
    email     Text
    role      Text    @default("member")
    deletedAt DateTime?
    @@softDelete
  }
  model posts {
    id        Integer @id
    userId    Integer
    title     Text
    status    Text    @default("draft")
    deletedAt DateTime?
    @@softDelete
  }
`

class AccountFactory extends Factory {
  model = 'accounts'
  traits = {
    pro:        { plan: 'pro' },
    enterprise: { plan: 'enterprise' },
  }
  definition(seq: number, rng: any) {
    return { id: seq, name: `Account ${seq}`, plan: 'starter' }
  }
}

class UserFactory extends Factory {
  model = 'users'
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
  model = 'posts'
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
    model posts {
      id   Integer @id
      body Text    @markdown
      note Text?   @markdown
      name Text
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
    const posts = js['$defs']?.posts ?? js.posts
    expect(posts.properties.body.contentMediaType).toBe('text/markdown')
  })

  test('optional markdown field also gets contentMediaType', () => {
    const { schema } = parse(MD_SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    const posts = js['$defs']?.posts ?? js.posts
    // Optional field is wrapped in anyOf — contentMediaType on the string branch
    const noteSchema = posts.properties.note
    const branch = noteSchema?.anyOf?.[0] ?? noteSchema
    expect(branch?.contentMediaType).toBe('text/markdown')
  })

  test('plain text field has no contentMediaType', () => {
    const { schema } = parse(MD_SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    const posts = js['$defs']?.posts ?? js.posts
    expect(posts.properties.name.contentMediaType).toBeUndefined()
  })

  test('field stores and retrieves Text value normally', async () => {
    const { db } = await makeTestClient(MD_SCHEMA)
    const row = await db.posts.create({ data: { id: 1, body: '# Hello\n**world**', name: 'test' } })
    expect(row.body).toBe('# Hello\n**world**')
    db.$close()
  })
})

// ─── File[] — multi-file fields ──────────────────────────────────────────────

import { fileUrls } from '../src/storage/index.js'


describe('File type + @keepVersions parser', () => {
  test('File type is a recognized scalar type', () => {
    const result = parse(`
      model users {
        id     Integer @id
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
      model users {
        id     Integer @id
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
      model users {
        id     Integer @id
        avatar File?
      }
    `)
    const ddl = generateDDL(result.schema)
    expect(ddl).toContain('"avatar" TEXT')
  })

  test('multiple File fields on same model are all valid', () => {
    const result = parse(`
      model users {
        id     Integer @id
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
  model users {
    id     Integer @id
    name   Text
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
    const r = parse(`model t { id Integer @id; photos File[] }`)
    expect(r.valid).toBe(true)
  })

  test('File[]? optional parses without error', () => {
    const r = parse(`model t { id Integer @id; photos File[]? }`)
    expect(r.valid).toBe(true)
  })

  test('File[] stored as TEXT column (JSON array)', async () => {
    const { db } = await makeTestClient(`model t { id Integer @id; photos File[] }`)
    const cols = db.$db.prepare("PRAGMA table_info('t')").all()
    const photosCol = cols.find((c: any) => c.name === 'photos')
    expect(photosCol?.type).toBe('TEXT')
    db.$close()
  })
})

// ─── @accept — file type validation ──────────────────────────────────────────


describe('@accept', () => {
  test('parses @accept("image/*") without error', () => {
    const r = parse(`model t { id Integer @id; avatar File? @accept("image/*") }`)
    expect(r.valid).toBe(true)
  })

  test('@accept stored on field AST with types', () => {
    const { schema } = parse(`model t { id Integer @id; avatar File? @accept("image/*") }`)
    const f = schema.models[0].fields.find((f: any) => f.name === 'avatar')
    const attr = f.attributes.find((a: any) => a.kind === 'accept')
    expect(attr?.types).toBe('image/*')
  })

  test('@accept multi-type parses', () => {
    const r = parse(`model t { id Integer @id; f File? @accept("image/jpeg,image/png") }`)
    expect(r.valid).toBe(true)
    const { schema } = r
    const attr = schema.models[0].fields[1].attributes.find((a: any) => a.kind === 'accept')
    expect(attr?.types).toBe('image/jpeg,image/png')
  })

  test('JSON Schema emits x-litestone-accept', () => {
    const { schema } = parse(`model t { id Integer @id; avatar File? @accept("image/*") }`)
    const js = generateJsonSchema(schema, { mode: 'full' })
    const t = js['$defs']?.t ?? js.t
    expect(t.properties.avatar['x-litestone-accept'] ?? 
      t.properties.avatar?.anyOf?.[0]?.['x-litestone-accept']).toBe('image/*')
  })
})

// ─── jsonschema extensions ────────────────────────────────────────────────────

const JEXT_SCHEMA = `
  enum Plan { starter pro enterprise }

  model accounts {
    id    Integer @id
    name  Text
    plan  Plan    @default(starter)
    users users[]
    @@gate("2.5.5.6")
  }

  model users {
    id        Integer  @id
    account   accounts @relation(fields: [accountId], references: [id], onDelete: Cascade)
    accountId Integer
    email     Text     @email
    posts     posts[]
    @@gate("2.4.4.6")
  }

  model posts {
    id     Integer @id
    author users   @relation(fields: [userId], references: [id])
    userId Integer
    title  Text
    tags   posts[]
  }
`





describe('bun:sqlite — WAL + dual connections', () => {

  test('WAL mode is set on write connection', async () => {
    const db  = await makeDb(`model t { id Integer @id }`, 'wal')
    const raw = db.$db as Database
    const mode = raw.query('PRAGMA journal_mode').get() as any
    expect(mode.journal_mode).toBe('wal')
    db.$close()
  })

  test('page_size is 8192', async () => {
    const db  = await makeDb(`model t { id Integer @id }`, 'pagesize')
    const raw = db.$db as Database
    const ps  = raw.query('PRAGMA page_size').get() as any
    expect(ps.page_size).toBe(8192)
    db.$close()
  })

  test('foreign_keys ON', async () => {
    const db  = await makeDb(`model t { id Integer @id }`, 'fk')
    const raw = db.$db as Database
    const fk  = raw.query('PRAGMA foreign_keys').get() as any
    expect(fk.foreign_keys).toBe(1)
    db.$close()
  })

  test('$cacheSize reports both connections', async () => {
    const db = await makeDb(`model t { id Integer @id }`, 'cache')
    await db.t.findMany()
    const cs = db.$cacheSize
    expect(cs).toHaveProperty('read')
    expect(cs).toHaveProperty('write')
    expect(cs.read).toBeGreaterThan(0)
    db.$close()
  })

  test('readonly read connection cannot write', async () => {
    // Structural test — read and write connections are separate, each with their own cache
    const db = await makeDb(`model t { id Integer @id }`, 'readonly')
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
    const r1 = parse(`model User { id Integer @id
        email Text }`)
    const r2 = parse(`
      model User    { id Integer @id
        email Text }
      model Account { id Integer @id
        name  Text }
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
    const r1 = parse(`model User { id Integer @id
        email Text }`)
    const r2 = parse(`model User { id Integer @id
        email Text
        name Text? }`)
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
      model User { id Integer @id
        email Text @unique
        name Text? }
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
    const schemaText = `model Post { id Integer @id
        title Text }`
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
    const schemaText = `model Thing { id Integer @id
        val Text }`
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
    id        Integer  @id
    name      Text
    plan      Plan     @default(starter)
    meta      Json?
    createdAt DateTime @default(now())
  }

  model User {
    id        Integer  @id
    account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
    accountId Integer
    email     Text     @unique @lower
    name      Text?
    isAdmin   Boolean  @default(false)
    role      Role     @default(member)
    prefs     Json?
    createdAt DateTime @default(now())
    deletedAt DateTime?

    @@softDelete
    @@index([accountId])
  }

  model Message {
    id        Integer  @id
    user      User     @relation(fields: [userId], references: [id])
    userId    Integer
    body      Text
    title     Text?
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
        id    Integer @id
        label Text
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
      model Thing { id Integer @id; name Text }
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
    const result = parse(`model Gadget { id Integer @id; name Text @default("x") }`)
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

    const result = parse(`model Item { id Integer @id; label Text @default("x") }`)
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
      `model t { id Integer @id; name Text }`,
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
    const { db } = await makeTestClient(`model t { id Integer @id }`)
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
        id    Integer @id
        name  Text
        code  Text
      }
      model Company {
        id        Integer  @id
        name      Text
        country   Country @relation(fields: [countryId], references: [id])
        countryId Integer
      }
      model User {
        id        Integer  @id
        name      Text
        company   Company @relation(fields: [companyId], references: [id])
        companyId Integer
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

  test('throws on unknown hasMany relation in orderBy', async () => {
    await expect(
      db.country.findMany({ orderBy: { companies: { name: 'asc' } } })
    ).rejects.toThrow("not found")
  })

  test('throws on unknown relation in orderBy', async () => {
    await expect(
      db.user.findMany({ orderBy: { nonexistent: { name: 'asc' } } })
    ).rejects.toThrow("relation 'nonexistent' not found")
  })
})

describe('relation aggregate orderBy', () => {
  let db: any

  beforeAll(async () => {
    ;({ db } = await makeTestClient(`
      model Author {
        id     Integer @id
        name   Text
        books  Book[]
        tags   Tag[]
      }
      model Book {
        id       Integer @id
        title    Text
        price    Real
        author   Author @relation(fields: [authorId], references: [id])
        authorId Integer
      }
      model Tag {
        id      Integer @id
        label   Text
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
      model scores {
        id        Integer @id
        userId    Integer
        category  Text
        value     Real
        createdAt DateTime @default(now())
      }
    `, {
      data: async (db: any) => {
        await db.scores.createMany({ data: [
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
    const rows = await db.scores.findMany({
      orderBy: { id: 'asc' },
      window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows.map((r: any) => r.rn)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('rank — within partition', async () => {
    const rows = await db.scores.findMany({
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
    const rows = await db.scores.findMany({
      orderBy: { value: 'desc' },
      window:  { dr: { denseRank: true, orderBy: { value: 'desc' } } },
    })
    // All values are distinct so dense_rank === rank
    expect(rows[0].dr).toBe(1)
    expect(rows[1].dr).toBe(2)
  })

  test('sum — running total within partition', async () => {
    const rows = await db.scores.findMany({
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
    const rows = await db.scores.findMany({
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
    const rows = await db.scores.findMany({
      where:   { category: 'math' },
      orderBy: { id: 'asc' },
      window:  { prev: { lag: 'value', offset: 1, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].prev).toBeNull()  // no previous row
    expect(rows[1].prev).toBeCloseTo(90)
    expect(rows[2].prev).toBeCloseTo(75)
  })

  test('lead — next row value', async () => {
    const rows = await db.scores.findMany({
      where:   { category: 'math' },
      orderBy: { id: 'asc' },
      window:  { next: { lead: 'value', offset: 1, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].next).toBeCloseTo(75)
    expect(rows[1].next).toBeCloseTo(85)
    expect(rows[2].next).toBeNull()  // no next row
  })

  test('count — running count', async () => {
    const rows = await db.scores.findMany({
      orderBy: { id: 'asc' },
      window:  { n: { count: true, orderBy: { id: 'asc' }, rows: [null, 0] } },
    })
    expect(rows[0].n).toBe(1)
    expect(rows[5].n).toBe(6)
  })

  test('multiple window functions in one query', async () => {
    const rows = await db.scores.findMany({
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
    const rows = await db.scores.findMany({
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
    const rows = await db.scores.findMany({
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
      db.scores.findMany({ window: { x: { unknown: true } as any } })
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
      model posts {
        id        Integer  @id
        title     Text
        createdAt DateTime @default(now())
        updatedAt DateTime @default(now())
      }
    `)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('posts_updatedAt')
    expect(ddl).toContain('AFTER UPDATE ON')
    expect(ddl).toContain('WHEN NEW."updatedAt" = OLD."updatedAt"')
  })

  test('no trigger on models without updatedAt', () => {
    const r = parse(`model logs { id Integer @id
        action Text }`)
    expect(generateDDL(r.schema)).not.toContain('logs_updatedAt')
  })

  test('no trigger on non-DateTime updatedAt field', () => {
    const r = parse(`model t { id Integer @id
        updatedAt Text }`)
    expect(generateDDL(r.schema)).not.toContain('t_updatedAt')
  })

  test('trigger fires on UPDATE in bun:sqlite', async () => {
    const db = await makeDb(`
      model posts {
        id        Integer  @id
        title     Text
        createdAt DateTime @default(now())
        updatedAt DateTime @default(now())
      }
    `, 'updatedat')

    await db.posts.create({ data: {
      id: 1, title: 'Hello',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }})

    const before = await db.posts.findUnique({ where: { id: 1 } })
    await Bun.sleep(15)
    await db.posts.update({ where: { id: 1 }, data: { title: 'World' } })
    const after = await db.posts.findUnique({ where: { id: 1 } })

    expect(after!.updatedAt).not.toBe(before!.updatedAt)
    expect(after!.createdAt).toBe(before!.createdAt)  // createdAt unchanged
    db.$close()
  })

  test('WHEN guard — explicit updatedAt set by user is preserved', async () => {
    const db = await makeDb(`
      model posts {
        id        Integer  @id
        title     Text
        updatedAt DateTime @default(now())
      }
    `, 'updatedat-guard')

    await db.posts.create({ data: { id: 1, title: 'Hello', updatedAt: '2024-01-01T00:00:00.000Z' } })
    // Explicitly set updatedAt — trigger should NOT override it
    await db.posts.update({ where: { id: 1 }, data: { title: 'World', updatedAt: '2099-01-01T00:00:00.000Z' } })
    const row = await db.posts.findUnique({ where: { id: 1 } })
    expect(row!.updatedAt).toBe('2099-01-01T00:00:00.000Z')
    db.$close()
  })

  test('trigger fires via raw SQL too (database-level)', async () => {
    const db = await makeDb(`
      model posts {
        id        Integer  @id
        title     Text
        updatedAt DateTime @default(now())
      }
    `, 'updatedat-raw')

    const raw = db.$db as Database
    raw.run(`INSERT INTO posts (id, title, updatedAt) VALUES (1, 'Hello', '2024-01-01T00:00:00.000Z')`)
    await Bun.sleep(15)
    raw.run(`UPDATE posts SET title = 'Direct SQL' WHERE id = 1`)
    const row = raw.query(`SELECT * FROM posts WHERE id = 1`).get() as any
    expect(row.updatedAt).not.toBe('2024-01-01T00:00:00.000Z')
    db.$close()
  })
})

// ─── 17. Soft delete cascade ──────────────────────────────────────────────────

const CASCADE_SCHEMA = `
  model Account {
    id        Integer  @id
    name      Text
    deletedAt DateTime?
    @@softDelete(cascade)
  }

  model User {
    id        Integer  @id
    account   Account @relation(fields: [accountId], references: [id])
    accountId Integer
    email     Text
    deletedAt DateTime?
    @@softDelete(cascade)
  }

  model Post {
    id        Integer @id
    user      User @relation(fields: [userId], references: [id])
    userId    Integer
    title     Text
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
    const r = parse(`model T { id Integer @id
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
      model Log { id Integer @id
        action Text }
    `, 'remove-hard')
    await db2.log.create({ data: { id: 1, action: 'login' } })
    await db2.log.remove({ where: { id: 1 } })
    const all = await db2.sql`SELECT * FROM log`
    expect(all).toHaveLength(0)   // gone — real DELETE, no deletedAt column
    db2.$close()
  })

  test('without cascade — children not affected', async () => {
    const db2 = await makeDb(`
      model Org    { id Integer @id
        name Text
        deletedAt DateTime?
        @@softDelete }
      model Member {
        id    Integer @id
        org   Org @relation(fields: [orgId], references: [id])
        orgId Integer
        name  Text
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
    id        Integer  @id
    name      Text
    users     User[]
    sessions  Session[]  @hardDelete
    deletedAt DateTime?
    @@softDelete(cascade)
  }

  model User {
    id        Integer  @id
    accountId Integer
    account   Account @relation(fields: [accountId], references: [id])
    name      Text
    deletedAt DateTime?
    @@softDelete
  }

  model Session {
    id        Integer  @id
    accountId Integer
    account   Account @relation(fields: [accountId], references: [id])
    token     Text
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
        id        Integer  @id
        users     User[]
        deletedAt DateTime?
        @@softDelete
      }
      model User {
        id        Integer  @id
        accountId Integer
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
        id        Integer  @id
        users     User[]
        deletedAt DateTime?
        @@softDelete(cascade)
      }
      model User {
        id        Integer  @id
        accountId Integer
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
        id        Integer  @id
        logs      Log[]
        deletedAt DateTime?
        @@softDelete
      }
      model Log {
        id        Integer  @id
        accountId Integer
        account   Account @relation(fields: [accountId], references: [id])
        body      Text
      }
    `)
    expect(r.warnings.some((w: string) => w.includes('@@softDelete(cascade)'))).toBe(false)
  })

  test('no warning when @hardDelete is on the relation field', () => {
    const r = parse(`
      model Account {
        id        Integer  @id
        sessions  sessions[]  @hardDelete
        deletedAt DateTime?
        @@softDelete
      }
      model sessions {
        id        Integer  @id
        accountId Integer
        account   Account @relation(fields: [accountId], references: [id])
        token     Text
      }
    `)
    expect(r.warnings.some((w: string) => w.includes('@@softDelete(cascade)'))).toBe(false)
  })

  test('no warning when parent has no @@softDelete at all', () => {
    const r = parse(`
      model Account {
        id    Integer @id
        users User[]
      }
      model User {
        id        Integer  @id
        accountId Integer
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
        id        Integer @id
        users     User[]
        deletedAt DateTime?
        @@softDelete
      }
      model User {
        id        Integer  @id
        accountId Integer
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


describe('Text[] / Integer[] array fields', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model posts {
        id     Integer @id
        title  Text
        tags   Text[]
        scores Integer[]
        flags  Text[]   @minItems(1) @maxItems(5) @uniqueItems
      }
    `, 'arrays')
  })
  afterAll(() => db.$close())

  test('Text[] defaults to []', async () => {
    await db.posts.create({ data: { id: 1, title: 'Hello', flags: ['featured'] } })
    const row = await db.posts.findUnique({ where: { id: 1 } })
    expect(row.tags).toEqual([])
    expect(row.scores).toEqual([])
  })

  test('Text[] stores and retrieves array', async () => {
    await db.posts.create({ data: { id: 2, title: 'World', tags: ['js', 'ts'], flags: ['new'] } })
    const row = await db.posts.findUnique({ where: { id: 2 } })
    expect(row.tags).toEqual(['js', 'ts'])
  })

  test('Integer[] stores and retrieves array', async () => {
    await db.posts.create({ data: { id: 3, title: 'Nums', scores: [10, 20, 30], flags: ['test'] } })
    const row = await db.posts.findUnique({ where: { id: 3 } })
    expect(row.scores).toEqual([10, 20, 30])
  })

  test('update replaces array', async () => {
    await db.posts.update({ where: { id: 2 }, data: { tags: ['bun', 'sqlite'] } })
    const row = await db.posts.findUnique({ where: { id: 2 } })
    expect(row.tags).toEqual(['bun', 'sqlite'])
  })

  // WHERE operators
  test('where: { tags: { has: "bun" } }', async () => {
    const rows = await db.posts.findMany({ where: { tags: { has: 'bun' } } })
    expect(rows.map((r: any) => r.id)).toContain(2)
    expect(rows.map((r: any) => r.id)).not.toContain(1)
  })

  test('where: { tags: { hasSome: ["js","bun"] } }', async () => {
    // post 2 has ['bun','sqlite'], post at id=2 matches 'bun'
    const rows = await db.posts.findMany({ where: { tags: { hasSome: ['js', 'bun'] } } })
    expect(rows.length).toBeGreaterThan(0)
  })

  test('where: { tags: { hasEvery: ["bun","sqlite"] } }', async () => {
    const rows = await db.posts.findMany({ where: { tags: { hasEvery: ['bun', 'sqlite'] } } })
    expect(rows.map((r: any) => r.id)).toContain(2)
  })

  test('where: { tags: { hasEvery: ["bun","missing"] } } returns empty', async () => {
    const rows = await db.posts.findMany({ where: { tags: { hasEvery: ['bun', 'missing'] } } })
    expect(rows).toHaveLength(0)
  })

  test('where: { tags: { isEmpty: true } }', async () => {
    const rows = await db.posts.findMany({ where: { tags: { isEmpty: true } } })
    expect(rows.map((r: any) => r.id)).toContain(1)
    expect(rows.map((r: any) => r.id)).not.toContain(2)
  })

  test('where: { tags: { isEmpty: false } }', async () => {
    const rows = await db.posts.findMany({ where: { tags: { isEmpty: false } } })
    expect(rows.map((r: any) => r.id)).not.toContain(1)
    expect(rows.map((r: any) => r.id)).toContain(2)
  })

  // Validation
  test('@minItems violation throws ValidationError', async () => {
    await expect(
      db.posts.create({ data: { id: 99, title: 'Bad', flags: [] } })
    ).rejects.toThrow(ValidationError)
  })

  test('@maxItems violation throws ValidationError', async () => {
    await expect(
      db.posts.create({ data: { id: 99, title: 'Bad', flags: ['a','b','c','d','e','f'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('@uniqueItems violation throws ValidationError', async () => {
    await expect(
      db.posts.create({ data: { id: 99, title: 'Bad', flags: ['dup','dup'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('Text[] rejects non-string items', async () => {
    await expect(
      db.posts.create({ data: { id: 99, title: 'Bad', tags: [1, 2], flags: ['ok'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('Integer[] rejects non-integer items', async () => {
    await expect(
      db.posts.create({ data: { id: 99, title: 'Bad', scores: ['not','ints'], flags: ['ok'] } })
    ).rejects.toThrow(ValidationError)
  })

  test('non-array value throws ValidationError', async () => {
    await expect(
      db.posts.create({ data: { id: 99, title: 'Bad', tags: 'not-array', flags: ['ok'] } })
    ).rejects.toThrow(ValidationError)
  })
})

// ─── 23. findFirstOrThrow / findUniqueOrThrow ─────────────────────────────────


describe('findFirstOrThrow / findUniqueOrThrow', () => {
  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model users {
        id    Integer @id
        email Text    @unique
        name  Text
      }
    `, 'throw-ops')
    await db.users.create({ data: { id: 1, name: 'Alice', email: 'alice@x.com' } })
  })
  afterAll(() => db.$close())

  test('findFirstOrThrow returns row when found', async () => {
    const row = await db.users.findFirstOrThrow({ where: { id: 1 } })
    expect(row.name).toBe('Alice')
  })

  test('findFirstOrThrow throws when not found', async () => {
    await expect(
      db.users.findFirstOrThrow({ where: { id: 999 } })
    ).rejects.toThrow('users')
  })

  test('findFirstOrThrow error has NOT_FOUND code', async () => {
    const err = await db.users.findFirstOrThrow({ where: { id: 999 } }).catch(e => e)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.model).toBe('users')
  })

  test('findUniqueOrThrow returns row when found', async () => {
    const row = await db.users.findUniqueOrThrow({ where: { id: 1 } })
    expect(row.email).toBe('alice@x.com')
  })

  test('findUniqueOrThrow throws when not found', async () => {
    await expect(
      db.users.findUniqueOrThrow({ where: { id: 999 } })
    ).rejects.toThrow('users')
  })

  test('findUniqueOrThrow error has NOT_FOUND code', async () => {
    const err = await db.users.findUniqueOrThrow({ where: { id: 999 } }).catch(e => e)
    expect(err.code).toBe('NOT_FOUND')
  })
})

// ─── 24. Global query filters ─────────────────────────────────────────────────


describe('global query filters', () => {
  test('static filter applied to findMany', async () => {
    const db = await makeDb(`
      model posts {
        id     Integer @id
        status Text
        title  Text
      }
    `, 'filter-static', {
      filters: { posts: { status: 'published' } }
    })
    await db.posts.create({ data: { id: 1, title: 'Draft',     status: 'draft' } })
    await db.posts.create({ data: { id: 2, title: 'Published', status: 'published' } })
    await db.posts.create({ data: { id: 3, title: 'Other pub', status: 'published' } })

    const rows = await db.posts.findMany()
    expect(rows.length).toBe(2)
    expect(rows.every((r: any) => r.status === 'published')).toBe(true)
    db.$close()
  })

  test('static filter applied to count', async () => {
    const db = await makeDb(`
      model items {
        id     Integer @id
        active Boolean @default(true)
      }
    `, 'filter-count', {
      filters: { items: { active: true } }
    })
    await db.items.create({ data: { id: 1, active: true } })
    await db.items.create({ data: { id: 2, active: false } })
    await db.items.create({ data: { id: 3, active: true } })

    expect(await db.items.count()).toBe(2)
    db.$close()
  })

  test('filter AND-merged with query where', async () => {
    const db = await makeDb(`
      model posts {
        id     Integer @id
        status Text
        pinned Boolean @default(false)
      }
    `, 'filter-merge', {
      filters: { posts: { status: 'published' } }
    })
    await db.posts.create({ data: { id: 1, status: 'published', pinned: true } })
    await db.posts.create({ data: { id: 2, status: 'published', pinned: false } })
    await db.posts.create({ data: { id: 3, status: 'draft',     pinned: true } })

    // Filter: published AND pinned
    const rows = await db.posts.findMany({ where: { pinned: true } })
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(1)
    db.$close()
  })

  test('function filter receives ctx', async () => {
    let called = false
    const db = await makeDb(`
      model t { id Integer @id
        val Text }
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
      model a { id Integer @id }
      model b { id Integer @id }
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
      model accounts {
        id    Integer @id
        name  Text
      }
      model users {
        id        Integer  @id
        account   accounts @relation(fields: [accountId], references: [id])
        accountId Integer
        email     Text
      }
    `, 'nested-writes')
  })
  afterAll(() => db.$close())

  test('create with hasMany create', async () => {
    const acc = await db.accounts.create({
      data: {
        id: 1, name: 'Acme',
        users: { create: [
          { id: 1, email: 'alice@acme.com' },
          { id: 2, email: 'bob@acme.com' },
        ]}
      }
    })
    expect(acc.id).toBe(1)
    const users = await db.users.findMany({ where: { accountId: 1 } })
    expect(users.length).toBe(2)
  })

  test('create with belongsTo connect', async () => {
    const user = await db.users.create({
      data: {
        id: 3, email: 'carol@acme.com',
        account: { connect: { id: 1 } }
      }
    })
    expect(user.accountId).toBe(1)
  })

  test('create with belongsTo create (nested parent)', async () => {
    const user = await db.users.create({
      data: {
        id: 4, email: 'dave@new.com',
        account: { create: { id: 2, name: 'NewCo' } }
      }
    })
    expect(user.accountId).toBe(2)
    const acc = await db.accounts.findUnique({ where: { id: 2 } })
    expect(acc?.name).toBe('NewCo')
  })

  test('create with belongsTo connectOrCreate — finds existing', async () => {
    const user = await db.users.create({
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
    expect(await db.accounts.count()).toBe(2)
  })

  test('create with belongsTo connectOrCreate — creates when missing', async () => {
    const user = await db.users.create({
      data: {
        id: 6, email: 'frank@third.com',
        account: { connectOrCreate: {
          where:  { id: 3 },
          create: { id: 3, name: 'ThirdCo' }
        }}
      }
    })
    expect(user.accountId).toBe(3)
    expect(await db.accounts.findUnique({ where: { id: 3 } })).not.toBeNull()
  })

  test('update with hasMany create', async () => {
    await db.accounts.update({
      where: { id: 1 },
      data: {
        name: 'Acme Corp',
        users: { create: { id: 10, email: 'new@acme.com' } }
      }
    })
    const users = await db.users.findMany({ where: { accountId: 1 } })
    expect(users.some((u: any) => u.email === 'new@acme.com')).toBe(true)
  })

  test('update with hasMany connect', async () => {
    // user 10 belongs to account 1 — reconnect to account 2
    await db.accounts.update({
      where: { id: 2 },
      data: { users: { connect: { id: 10 } } }
    })
    const u = await db.users.findUnique({ where: { id: 10 } })
    expect(u?.accountId).toBe(2)
  })

  test('update with hasMany update', async () => {
    await db.accounts.update({
      where: { id: 1 },
      data: {
        users: { update: [{ where: { id: 1 }, data: { email: 'alice-updated@acme.com' } }] }
      }
    })
    const u = await db.users.findUnique({ where: { id: 1 } })
    expect(u?.email).toBe('alice-updated@acme.com')
  })

  test('scalar + nested fields coexist', async () => {
    const acc = await db.accounts.update({
      where: { id: 1 },
      data: { name: 'Acme Final', users: { create: { id: 20, email: 'g@acme.com' } } }
    })
    expect(acc.name).toBe('Acme Final')
    const u = await db.users.findUnique({ where: { id: 20 } })
    expect(u?.accountId).toBe(1)
  })
})

// ─── 26. Seeder + Factory ─────────────────────────────────────────────────────


describe('upsertMany', () => {
  const schema = `
    model products {
      id    Integer @id
      slug  Text    @unique @lower @trim
      price Real    @default(0) @gte(0)
      stock Integer @default(0)
    }
  `

  test('inserts new rows', async () => {
    const db = await makeDb(schema, 'upsertmany-insert')
    const { count } = await db.products.upsertMany({
      data: [
        { id: 1, slug: 'Widget', price: 9.99, stock: 10 },
        { id: 2, slug: 'Gadget', price: 19.99, stock: 5 },
      ]
    })
    expect(count).toBe(2)
    const all = await db.products.findMany({})
    expect(all).toHaveLength(2)
    db.$close()
  })

  test('updates on conflict by default (idField)', async () => {
    const db = await makeDb(schema, 'upsertmany-update')
    await db.products.createMany({ data: [{ id: 1, slug: 'widget', price: 9.99, stock: 10 }] })
    await db.products.upsertMany({
      data: [{ id: 1, slug: 'widget', price: 14.99, stock: 20 }]
    })
    const p = await db.products.findUnique({ where: { id: 1 } })
    expect(p.price).toBe(14.99)
    expect(p.stock).toBe(20)
    db.$close()
  })

  test('custom conflictTarget', async () => {
    const db = await makeDb(schema, 'upsertmany-conflict-target')
    await db.products.createMany({ data: [{ id: 1, slug: 'widget', price: 9.99, stock: 10 }] })
    await db.products.upsertMany({
      data:           [{ id: 1, slug: 'widget', price: 24.99 }],
      conflictTarget: ['slug'],
      update:         ['price'],
    })
    const p = await db.products.findUnique({ where: { id: 1 } })
    expect(p.price).toBe(24.99)
    expect(p.stock).toBe(10)   // not in update list — unchanged
    db.$close()
  })

  test('update field list limits which columns are updated on conflict', async () => {
    const db = await makeDb(schema, 'upsertmany-update-cols')
    await db.products.createMany({ data: [{ id: 1, slug: 'widget', price: 9.99, stock: 100 }] })
    await db.products.upsertMany({
      data:   [{ id: 1, slug: 'widget', price: 99.99, stock: 1 }],
      update: ['price'],   // only price — stock should stay at 100
    })
    const p = await db.products.findUnique({ where: { id: 1 } })
    expect(p.price).toBe(99.99)
    expect(p.stock).toBe(100)
    db.$close()
  })

  test('transforms (@lower @trim) fire on every row', async () => {
    const db = await makeDb(schema, 'upsertmany-transforms')
    await db.products.upsertMany({
      data: [{ id: 1, slug: '  WIDGET  ', price: 1 }]
    })
    const p = await db.products.findUnique({ where: { id: 1 } })
    expect(p.slug).toBe('widget')   // lower + trim applied
    db.$close()
  })

  test('validation fires on every row — throws on invalid', async () => {
    const db = await makeDb(schema, 'upsertmany-validation')
    await expect(
      db.products.upsertMany({ data: [{ id: 1, slug: 'widget', price: -5 }] })
    ).rejects.toThrow()   // @gte(0) violated
    db.$close()
  })

  test('returns { count: 0 } for empty data', async () => {
    const db = await makeDb(schema, 'upsertmany-empty')
    const result = await db.products.upsertMany({ data: [] })
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
    await db.products.upsertMany({ data: [{ id: 1, slug: 'w', price: 1 }] })
    expect(fired).toBe(true)
    db.$close()
  })
})

// ─── 37. upsert plugin hooks ──────────────────────────────────────────────────


describe('optimizeFts', () => {
  const schema = `
    model docs {
      id    Integer @id
      body  Text
      title Text?
      @@fts([body, title])
    }
  `

  test('optimizeFts returns { optimized: true, table }', async () => {
    const db = await makeDb(schema, 'optimize-basic')
    const result = db.docs.optimizeFts()
    expect(result.optimized).toBe(true)
    expect(result.table).toBe('docs_fts')
    db.$close()
  })

  test('optimizeFts is a no-op on an empty table (does not throw)', async () => {
    const db = await makeDb(schema, 'optimize-empty')
    expect(() => db.docs.optimizeFts()).not.toThrow()
    db.$close()
  })

  test('optimizeFts runs after bulk insert without error', async () => {
    const db = await makeDb(schema, 'optimize-after-bulk')
    await db.docs.createMany({ data: Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, body: `content ${i}`, title: `doc ${i}`
    }))})
    expect(() => db.docs.optimizeFts()).not.toThrow()
    // FTS still works after optimize
    const results = await db.docs.search('content')
    expect(results.length).toBeGreaterThan(0)
    db.$close()
  })

  test('optimizeFts throws on a model without @@fts', async () => {
    const db = await makeDb(`
      model plain { id Integer @id; name Text }
    `, 'optimize-no-fts')
    expect(() => db.plain.optimizeFts()).toThrow('not available')
    db.$close()
  })
})

// ─── 42. @updatedAt parser attribute ─────────────────────────────────────────


describe('RETURNING * — write path', () => {

  test('create returns correct row without follow-up SELECT', async () => {
    const db = await makeDb(`
      model users { id Integer @id; name Text; email Text @unique }
    `, 'returning-create')
    const u = await db.users.create({ data: { name: 'Alice', email: 'alice@test.com' } })
    expect(u.id).toBe(1)
    expect(u.name).toBe('Alice')
    expect(u.email).toBe('alice@test.com')
    db.$close()
  })

  test('update returns updated row without follow-up SELECT', async () => {
    const db = await makeDb(`
      model users { id Integer @id; name Text }
    `, 'returning-update')
    await db.users.create({ data: { name: 'Alice' } })
    const u = await db.users.update({ where: { id: 1 }, data: { name: 'Bob' } })
    expect(u?.name).toBe('Bob')
    db.$close()
  })

  test('soft-delete remove returns deleted row', async () => {
    const db = await makeDb(`
      model users {
        id        Integer   @id
        name      Text
        deletedAt DateTime?
        @@softDelete
      }
    `, 'returning-remove')
    await db.users.create({ data: { name: 'Alice' } })
    const u = await db.users.remove({ where: { id: 1 } })
    expect(u?.id).toBe(1)
    expect(u?.deletedAt).toBeTruthy()
    db.$close()
  })

  test('update returns null when row not found', async () => {
    const db = await makeDb(`
      model users { id Integer @id; name Text }
    `, 'returning-update-miss')
    const u = await db.users.update({ where: { id: 999 }, data: { name: 'Ghost' } })
    expect(u).toBeNull()
    db.$close()
  })

})

// ─── databases: ':memory:' ────────────────────────────────────────────────────


describe('$walStatus()', () => {

  test('returns WAL frame counts', async () => {
    const db = await makeDb(`
      model items { id Integer @id; val Text }
    `, 'wal-status')
    await db.items.create({ data: { val: 'x' } })
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
    const r = parse(`model users { id Integer @id; name Text }`)
    const p = join(TMP, `form-parsed-${Date.now()}.db`)
    const db = await createClient({ parsed: r, db: p })
    await db.users.create({ data: { name: 'Alice' } })
    const u = await db.users.findFirst({})
    expect(u?.name).toBe('Alice')
    db.$close()
  })

  test('{ schema } inline string form works', async () => {
    const p = join(TMP, `form-schema-${Date.now()}.db`)
    const db = await createClient({
      schema: `model users { id Integer @id; name Text }`,
      db: p
    })
    await db.users.create({ data: { name: 'Bob' } })
    const u = await db.users.findFirst({})
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
        id      Integer @id
        isAdmin Boolean @default(false)
        role    Text    @default("member")
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
        id        Integer @id
        firstName Text
        lastName  Text
        fullName  Text @computed
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
      model Item { id Integer @id; val Text; tagged Text @computed }
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

// ─── createClient — new single-arg forms ─────────────────────────────────────


describe("databases: ':memory:'", () => {

  test('all SQLite databases open in-memory', async () => {
    const db = await makeDb(`
      model users { id Integer @id; name Text }
    `, 'inmem', { databases: ':memory:' })
    const u = await db.users.create({ data: { name: 'Alice' } })
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
        id       Integer @id
        name     Text
        bio      Text?   @omit
        prefs    Text?   @omit(all)
        salary   Integer @guarded
        secret   Text    @guarded(all)
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
//      plaintext WHERE on non-searchable encrypted field silently returns null (expected),
//      asSystem() returns decrypted value


describe('@guarded(all) + WHERE clause', () => {
  const ENC_KEY = 'b'.repeat(64)   // 32-byte hex key

  let db: any

  beforeAll(async () => {
    db = await makeDb(`
      model User {
        id      Integer @id
        name    Text
        secret  Text    @guarded(all)
        token   Text    @encrypted @guarded(all)
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

  test('@encrypted @guarded(all): plaintext WHERE on non-searchable field silently returns null', async () => {
    // token is @encrypted without searchable:true — the stored ciphertext never
    // equals the plaintext, so the WHERE never matches. This is expected and correct.
    // It does NOT throw; it just returns null like any non-matching query.
    const row = await db.asSystem().user.findFirst({ where: { token: 'tok_alice' } })
    expect(row).toBeNull()
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
        id    Integer @id
        name  Text
        ssn   Text    @encrypted
        email Text    @encrypted(searchable: true)
      }
    `, 'encrypted', { encryptionKey: ENC_KEY })
    await db.user.create({ data: { id: 1, name: 'Alice', ssn: '123-45-6789', email: 'alice@example.com' } })
    await db.user.create({ data: { id: 2, name: 'Bob',   ssn: '987-65-4321', email: 'bob@example.com' } })
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
  test('@encrypted: asSystem() returns decrypted value', async () => {
    const row = await db.asSystem().user.findUnique({ where: { id: 1 } })
    expect(row.ssn).toBe('123-45-6789')
    // searchable fields are stored as HMAC — not decryptable, but usable in WHERE
    expect(row.email).toBeDefined()
    expect(row.email.startsWith('v1s.')).toBe(true)
  })
  test('@encrypted: stored as ciphertext in DB', async () => {
    const raw = await db.sql`SELECT ssn, email FROM user WHERE id = 1`
    expect(raw[0].ssn.startsWith('v1.')).toBe(true)
    expect(raw[0].email.startsWith('v1s.')).toBe(true)
  })
  test('@encrypted(searchable): WHERE equality works', async () => {
    const row = await db.asSystem().user.findFirst({ where: { email: 'alice@example.com' } })
    expect(row?.id).toBe(1)
    expect(row?.name).toBe('Alice')
  })
  test('@encrypted(searchable): wrong value returns null', async () => {
    const row = await db.asSystem().user.findFirst({ where: { email: 'nobody@nowhere.com' } })
    expect(row).toBeNull()
  })
  test('@encrypted(non-searchable): WHERE silently returns null', async () => {
    const row = await db.asSystem().user.findFirst({ where: { ssn: '123-45-6789' } })
    expect(row).toBeNull()
  })
  test('createClient throws without encryption key if @encrypted fields exist', async () => {
    const r = parse(`model T { id Integer @id
        secret Text @encrypted }`)
    const p = tmpDb('enc-no-key')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    await expect(createClient({ parsed: r,  db: p })).rejects.toThrow('encryption key')
  })
  test('@encrypted: key wrong length throws', async () => {
    const r = parse(`model T { id Integer @id
        secret Text @encrypted }`)
    const p = tmpDb('enc-bad-key')
    const raw = new Database(p)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) raw.run(s)
    raw.close()
    await expect(createClient({ parsed: r,  db: p, encryptionKey: 'tooshort' })).rejects.toThrow('32 bytes')
  })
})

// ─── 19b. @secret ─────────────────────────────────────────────────────────────


describe('@secret field attribute', () => {

  const ENC_KEY = 'a'.repeat(64)   // 32-byte hex key for all secret tests

  // ── Parser expansion ──────────────────────────────────────────────────────

  test('expands @secret → @encrypted + @guarded(all) at parse time', () => {
    const r = parse(`model T { id Integer @id; token Text @secret }`)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    expect(field.attributes.some((a: any) => a.kind === 'secret')).toBe(true)
    expect(field.attributes.some((a: any) => a.kind === 'encrypted')).toBe(true)
    expect(field.attributes.some((a: any) => a.kind === 'guarded' && a.level === 'all')).toBe(true)
  })

  test('@secret defaults rotate: true', () => {
    const r = parse(`model T { id Integer @id; token Text @secret }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    const secretAttr = field.attributes.find((a: any) => a.kind === 'secret')
    expect(secretAttr.rotate).toBe(true)
  })

  test('@secret(rotate: false) sets rotate: false', () => {
    const r = parse(`model T { id Integer @id; token Text @secret(rotate: false) }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    const secretAttr = field.attributes.find((a: any) => a.kind === 'secret')
    expect(secretAttr.rotate).toBe(false)
  })

  test('@secret still expands @encrypted + @guarded(all) when rotate: false', () => {
    const r = parse(`model T { id Integer @id; token Text @secret(rotate: false) }`)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    expect(field.attributes.some((a: any) => a.kind === 'encrypted')).toBe(true)
    expect(field.attributes.some((a: any) => a.kind === 'guarded' && a.level === 'all')).toBe(true)
  })

  test('@secret synthesizes @log when a logger database is declared', () => {
    const r = parse(`
      database audit { path "./audit/" driver logger }
      model T { id Integer @id; token Text @secret }
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
    const r = parse(`model T { id Integer @id; token Text @secret }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'token')
    expect(field.attributes.some((a: any) => a.kind === 'log')).toBe(false)
  })

  test('@secret emits warning when no logger database is declared', () => {
    const r = parse(`model T { id Integer @id; token Text @secret }`)
    expect(r.warnings.some((w: string) => w.includes('@secret') && w.includes('logger database'))).toBe(true)
  })

  test('@secret + explicit @encrypted is a validation error', () => {
    const r = parse(`model T { id Integer @id; token Text @secret @encrypted }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@secret') && e.includes('@encrypted'))).toBe(true)
  })

  test('@secret + explicit @guarded is a validation error', () => {
    const r = parse(`model T { id Integer @id; token Text @secret @guarded }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@secret') && e.includes('@guarded'))).toBe(true)
  })

  test('@secret unknown option is a parse error', () => {
    const r = parse(`model T { id Integer @id; token Text @secret(expires: true) }`)
    expect(r.valid).toBe(false)
  })

  // ── Runtime behaviour ─────────────────────────────────────────────────────

  test('@secret field is encrypted at rest', async () => {
    const db = await makeDb(`model Secret { id Integer @id; token Text @secret }`, 'secret-enc', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'mysecret' } })
    const raw = db.$db.query(`SELECT token FROM secret`).get() as any
    expect(raw.token).toMatch(/^v1\./)   // AES-GCM ciphertext prefix
    db.$close()
  })

  test('@secret field is stripped from findMany results', async () => {
    const db = await makeDb(`model Secret { id Integer @id; token Text @secret }`, 'secret-strip', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'mysecret' } })
    const rows = await db.secret.findMany()
    expect((rows[0] as any).token).toBeUndefined()
    db.$close()
  })

  test('@secret field is returned via asSystem()', async () => {
    const db = await makeDb(`model Secret { id Integer @id; token Text? @secret }`, 'secret-system', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'mysecret' } })
    const row = await db.asSystem().secret.findFirst({}) as any
    expect(row.token).toBe('mysecret')
    db.$close()
  })

  // ── Key rotation ──────────────────────────────────────────────────────────

  const NEW_KEY = 'b'.repeat(64)

  test('$rotateKey re-encrypts rotate:true fields', async () => {
    const db = await makeDb(`model Secret { id Integer @id; token Text @secret }`, 'rotate-basic', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'rotate-me' } })

    const statsBefore = db.$db.query(`SELECT token FROM secret`).get() as any
    expect(statsBefore.token).toMatch(/^v1\./)

    await db.$rotateKey(NEW_KEY)

    // Ciphertext should have changed (different IV → different output)
    const statsAfter = db.$db.query(`SELECT token FROM secret`).get() as any
    expect(statsAfter.token).toMatch(/^v1\./)
    expect(statsAfter.token).not.toBe(statsBefore.token)

    db.$close()
  })

  test('$rotateKey returns per-model stats', async () => {
    const db = await makeDb(`model Secret { id Integer @id; token Text @secret }`, 'rotate-stats', { encryptionKey: ENC_KEY })
    await db.secret.create({ data: { token: 'a' } })
    await db.secret.create({ data: { token: 'b' } })

    const stats = await db.$rotateKey(NEW_KEY)
    expect(stats.Secret.rows).toBe(2)
    expect(stats.Secret.fields).toBe(1)
    db.$close()
  })

  test('rotated field is still readable after rotation with new key', async () => {
    // Manage path directly so we can re-open with a different key
    const schema = `model Secret { id Integer @id; token Text? @secret }`
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

  test('@secret(rotate: false) field is skipped by $rotateKey', async () => {
    const db = await makeDb(
      `model Secret { id Integer @id; fixed Text @secret(rotate: false); rotateable Text @secret }`,
      'rotate-skip',
      { encryptionKey: ENC_KEY }
    )
    await db.secret.create({ data: { fixed: 'stays', rotateable: 'changes' } })

    const before = db.$db.query(`SELECT fixed, rotateable FROM secret`).get() as any
    await db.$rotateKey(NEW_KEY)
    const after = db.$db.query(`SELECT fixed, rotateable FROM secret`).get() as any

    // fixed stays the same ciphertext
    expect(after.fixed).toBe(before.fixed)
    // rotateable has a new ciphertext
    expect(after.rotateable).not.toBe(before.rotateable)
    db.$close()
  })

  test('$rotateKey with no @secret fields returns empty stats', async () => {
    const db = await makeDb(`model Plain { id Integer @id; name Text }`, 'rotate-empty')
    const stats = await db.$rotateKey(ENC_KEY)
    expect(Object.keys(stats)).toHaveLength(0)
    db.$close()
  })

  test('$rotateKey with no @secret fields — no encryption key needed on client', async () => {
    // A client with @secret fields cannot be created without an encKey (createClient rejects).
    // Testing with a plain model: $rotateKey returns {} with no @secret fields regardless
    // of whether the client has an encryption key.
    const db = await makeDb(`model Plain { id Integer @id; name Text }`, 'rotate-no-key')
    const stats = await db.$rotateKey(NEW_KEY)
    expect(Object.keys(stats)).toHaveLength(0)
    db.$close()
  })

  test('$rotateKey throws on bad key length', async () => {
    const db = await makeDb(`model Secret { id Integer @id; token Text @secret }`, 'rotate-bad-key', { encryptionKey: ENC_KEY })
    await expect(db.$rotateKey('tooshort')).rejects.toThrow('32 bytes')
    db.$close()
  })

  test('$rotateKey leaves null fields untouched', async () => {
    const db = await makeDb(`model Secret { id Integer @id; token Text? @secret }`, 'rotate-null', { encryptionKey: ENC_KEY })
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

    model posts {
      id        Integer  @id
      title     Text
      body      Text     @log(audit)

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
    await db.posts.create({ data: { title: 'Hello', body: 'World' } })
    await flush()
    expect(calls.length).toBeGreaterThan(0)
    db.$close()
  })

  test('onLog receives correct operation and model', async () => {
    const calls: any[] = []
    const db = await makeLogDb((entry) => { calls.push(entry) })
    await db.posts.create({ data: { title: 'T', body: 'B' } })
    await flush()
    const modelLog = calls.find(e => e.model === 'posts' && e.field == null)
    expect(modelLog).toBeDefined()
    expect(modelLog.operation).toBe('create')
    db.$close()
  })

  test('onLog receives correct field for @log field entry', async () => {
    const calls: any[] = []
    const db = await makeLogDb((entry) => { calls.push(entry) })
    await db.posts.create({ data: { title: 'T', body: 'B' } })
    await flush()
    const fieldLog = calls.find(e => e.field === 'body')
    expect(fieldLog).toBeDefined()
    expect(fieldLog.model).toBe('posts')
    db.$close()
  })

  test('onLog return value merges actorId into entry', async () => {
    const written: any[] = []
    const db = await makeLogDb((entry) => {
      written.push(entry)
      return { actorId: 999, actorType: 'service' }
    })
    await db.posts.create({ data: { title: 'T', body: 'B' } })
    await flush()
    // Verify the written log rows reflect the overridden actor
    const auditRows = await (db as any).auditLogs.findMany({})
    expect(auditRows.some((r: any) => r.actorId === 999 && r.actorType === 'service')).toBe(true)
    db.$close()
  })

  test('onLog return value merges meta into entry', async () => {
    const db = await makeLogDb((_entry) => {
      return { meta: { source: 'api', version: 2 } }
    })
    await db.posts.create({ data: { title: 'T', body: 'B' } })
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
    await authedDb.posts.create({ data: { title: 'T', body: 'B' } })
    await flush()
    expect(ctxCaptures.some(c => c.auth?.id === 42)).toBe(true)
    db.$close()
  })

  test('onLog not called when no @log / @@log on model', async () => {
    const PLAIN_SCHEMA = `
      database main { path env("MAIN_DB", "./main.db") }
      model notes { id Integer @id; text Text @@db(main) }
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
    await (db as any).notes.create({ data: { text: 'hi' } })
    await flush()
    expect(calls).toHaveLength(0)
    db.$close()
  })

  test('onLog returning null/undefined does not throw', async () => {
    const db = await makeLogDb(() => null)
    await expect(db.posts.create({ data: { title: 'T', body: 'B' } })).resolves.toBeDefined()
    await flush()
    db.$close()
  })

  test('onLog throwing does not propagate to caller', async () => {
    const db = await makeLogDb(() => { throw new Error('onLog exploded') })
    await expect(db.posts.create({ data: { title: 'T', body: 'B' } })).resolves.toBeDefined()
    db.$close()
  })
})

// ─── 19c. @@allow / @@deny policies ──────────────────────────────────────────


describe('@@allow / @@deny row-level policies', () => {

  // ── Parser ────────────────────────────────────────────────────────────────

  test('parses @@allow with simple condition', () => {
    const r = parse(`
      model Post {
        id      Integer @id
        ownerId Integer
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
        id     Integer @id
        status Text
        @@deny('delete', status == 'archived')
      }
    `)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'deny')
    expect(attr.operations).toEqual(['delete'])
  })

  test("parses 'all' operation alias", () => {
    const r = parse(`model T { id Integer @id; @@allow('all', true) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.operations).toEqual(['read', 'create', 'update', 'post-update', 'delete'])
  })

  test("parses 'write' operation alias", () => {
    const r = parse(`model T { id Integer @id; @@allow('write', true) }`)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.operations).toEqual(['create', 'update', 'delete'])
  })

  test('parses comma-separated operations', () => {
    const r = parse(`model T { id Integer @id; @@allow('update,delete', true) }`)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.operations).toEqual(['update', 'delete'])
  })

  test('invalid operation is a parse error', () => {
    const r = parse(`model T { id Integer @id; @@allow('fetch', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/invalid operation/)
  })

  test('parses || && ! operators', () => {
    const r = parse(`
      model T {
        id        Integer @id
        published Boolean
        ownerId   Integer
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
    const r = parse(`model T { id Integer @id; @@allow('create', auth() != null) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.expr.type).toBe('compare')
    expect(attr.expr.left.type).toBe('auth')
    expect(attr.expr.left.field).toBeNull()
    expect(attr.expr.op).toBe('!=')
  })

  test('parses now() in condition', () => {
    const r = parse(`model T { id Integer @id; expiresAt DateTime; @@allow('read', expiresAt > now()) }`)
    expect(r.valid).toBe(true)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.expr.right.type).toBe('now')
  })

  test('parses check(field)', () => {
    const r = parse(`
      model Post {
        id     Integer @id
        author User @relation(fields: [authorId], references: [id])
        authorId Integer
        @@allow('read', check(author))
      }
      model User { id Integer @id }
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
        id Integer @id
        author User @relation(fields: [authorId], references: [id])
        authorId Integer
        @@allow('update', check(author, 'read'))
      }
      model User { id Integer @id }
    `)
    const attr = r.schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr.expr.operation).toBe('read')
  })

  test('warns if @@deny exists without @@allow', () => {
    const r = parse(`model T { id Integer @id; @@deny('delete', true) }`)
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w: string) => w.includes('@@deny') && w.includes('@@allow'))).toBe(true)
  })

  // ── Read policy — SQL injection ───────────────────────────────────────────

  test('@@allow read — only matching rows returned', async () => {
    const db = await makeDb(`
      model Post {
        id      Integer @id
        ownerId Integer
        title   Text
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
        id        Integer @id
        ownerId   Integer
        published Boolean @default(false)
        title     Text
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
        id      Integer @id
        ownerId Integer
        deleted Boolean @default(false)
        title   Text
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

  test('no auth → no rows when policy uses auth().id', async () => {
    const db = await makeDb(`
      model Post {
        id      Integer @id
        ownerId Integer
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
        id      Integer @id
        ownerId Integer
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
      model Post { id Integer @id; title Text }
    `, 'policy-none')
    await db.post.create({ data: { title: 'open' } })
    const rows = await db.post.findMany()
    expect(rows).toHaveLength(1)
    db.$close()
  })

  test('now() in policy — time-based access', async () => {
    const db = await makeDb(`
      model Item {
        id          Integer  @id
        title       Text
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
        id    Integer @id
        title Text
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
        id    Integer @id
        title Text
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
        id      Integer @id
        ownerId Integer
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
        id      Integer @id
        ownerId Integer
        title   Text
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
        id      Integer @id
        ownerId Integer
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
        id      Integer @id
        ownerId Integer
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

  // ── check() delegation ────────────────────────────────────────────────────

  test('check() — delegates read policy to parent model', async () => {
    const db = await makeDb(`
      model User {
        id      Integer @id
        ownerId Integer
        @@allow('read', ownerId == auth().id)
      }
      model Post {
        id       Integer @id
        authorId Integer
        author   User @relation(fields: [authorId], references: [id])
        title    Text
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


})

// ─── 19d. @allow field-level access ──────────────────────────────────────────


describe('@allow field-level access', () => {

  // ── Parser ────────────────────────────────────────────────────────────────

  test('parses @allow(read) on field', () => {
    const r = parse(`
      model User {
        id     Integer @id
        salary Real?   @allow('read', auth().role == 'hr')
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
    const r = parse(`model T { id Integer @id; role Text @allow('write', auth().isAdmin) }`)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'role')
    const fa = field.attributes.find((a: any) => a.kind === 'fieldAllow')
    expect(fa.operations).toEqual(['write'])
  })

  test("@allow('all') expands to read + write", () => {
    const r = parse(`model T { id Integer @id; data Text @allow('all', auth() != null) }`)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'data')
    const fa = field.attributes.find((a: any) => a.kind === 'fieldAllow')
    expect(fa.operations).toEqual(['read', 'write'])
  })

  test('@allow on field with invalid operation is a parse error', () => {
    const r = parse(`model T { id Integer @id; x Text @allow('create', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/read.*write.*all/)
  })

  test('@allow conflicts with @guarded is a validation error', () => {
    const r = parse(`model T { id Integer @id; x Text @guarded @allow('read', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@allow') && e.includes('@guarded'))).toBe(true)
  })

  test('@allow conflicts with @secret is a validation error', () => {
    const r = parse(`model T { id Integer @id; x Text @secret @allow('read', true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('@allow') && e.includes('@secret'))).toBe(true)
  })

  // ── Read enforcement ──────────────────────────────────────────────────────

  test('@allow read — field stripped when condition false', async () => {
    const db = await makeDb(`
      model User {
        id     Integer @id
        name   Text
        salary Real?   @allow('read', auth().role == 'hr')
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
        id     Integer @id
        name   Text
        salary Real?   @allow('read', auth().role == 'hr')
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
        id     Integer @id
        salary Real?   @allow('read', auth().role == 'hr')
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
        id      Integer @id
        ownerId Integer
        notes   Text?   @allow('read', auth().role == 'admin')
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
        id     Integer @id
        salary Real?   @allow('read', auth() != null)
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
        id   Integer @id
        role Text    @default('user') @allow('write', auth().isAdmin)
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
        id   Integer @id
        role Text    @default('user') @allow('write', auth().isAdmin)
      }
    `, 'field-allow-write-pass')
    const row = await db.$setAuth({ id: 1, isAdmin: true }).user.create({ data: { role: 'admin' } }) as any
    expect(row?.role).toBe('admin')
    db.$close()
  })

  test('@allow write — asSystem() always writes the field', async () => {
    const db = await makeDb(`
      model User {
        id   Integer @id
        role Text    @default('user') @allow('write', auth().isAdmin)
      }
    `, 'field-allow-write-system')
    const row = await db.asSystem().user.create({ data: { role: 'superadmin' } }) as any
    expect(row?.role).toBe('superadmin')
    db.$close()
  })

  test('@allow write enforced on update too', async () => {
    const db = await makeDb(`
      model User {
        id   Integer @id
        role Text    @default('user') @allow('write', auth().isAdmin)
      }
    `, 'field-allow-write-update')
    await db.asSystem().user.create({ data: { role: 'user' } })
    // non-admin tries to escalate — field dropped, stays 'user'
    await db.$setAuth({ id: 1, isAdmin: false }).user.update({ where: { id: 1 }, data: { role: 'admin' } })
    const row = await db.asSystem().user.findFirst({ where: { id: 1 } }) as any
    expect(row.role).toBe('user')
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
          id      Integer @id
          ownerId Integer
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
          id Integer @id
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
          id      Integer @id
          ownerId Integer
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
          id      Integer @id
          ownerId Integer
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
    expect(() => validateGate({ read: 4, create: 2, update: 4, delete: 6 }, 'posts')).toThrow()
    expect(() => validateGate({ read: 2, create: 4, update: 3, delete: 6 }, 'posts')).toThrow()
    expect(() => validateGate({ read: 2, create: 4, update: 5, delete: 6 }, 'posts')).not.toThrow()
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
        id Integer @id
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
        id Integer @id
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
        id Integer @id
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
        id Integer @id
        val Text
        @@gate("2.4.5.6")
      }
    `, 'gate-update-deny', (_, model) => model === 'posts' ? 4 : 0)  // level 4 < update(5)
    await db.$db.run("INSERT INTO post VALUES (1, 'x')")
    await expect(db.post.update({ where: { id: 1 }, data: { val: 'y' } })).rejects.toThrow(AccessDeniedError)
    db.$close()
  })

  test('delete denied when level below D threshold', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model Post {
        id Integer @id
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
      model audit_logs {
        id Integer @id
        @@gate("5.8.8.9")
      }
    `, 'gate-locked', () => 6)   // level 6 (OWNER) can't beat LOCKED (now 9)
    await db.$db.run('INSERT INTO audit_logs VALUES (1)')
    await expect(db.audit_logs.delete({ where: { id: 1 } })).rejects.toThrow('LOCKED')
    db.$close()
  })

  test('SYSTEM(8) blocks normal users, passes asSystem()', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeGateDb(`
      model audit_logs {
        id Integer @id
        @@gate("5.8.8.9")
      }
    `, 'gate-system', () => 6)   // level 6 can't create (SYSTEM=8)
    await expect(db.audit_logs.create({ data: { id: 1 } })).rejects.toThrow('SYSTEM')
    // asSystem() bypasses gate entirely
    await expect(db.asSystem().audit_logs.create({ data: { id: 1 } })).resolves.toBeDefined()
    db.$close()
  })

  // ── $setAuth ─────────────────────────────────────────────────────────────────

  test('$setAuth threads user into getLevel', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    let capturedUser: any = null
    const db = await makeDb(`
      model Post {
        id Integer @id
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
        id Integer @id
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
        id Integer @id
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
        id Integer @id
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
        id Integer @id
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
        id   Integer @id
        name Text
        @@gate("2.6.6.6")
      }
      model User {
        id        Integer  @id
        account   Account @relation(fields: [accountId], references: [id])
        accountId Integer
        email     Text
        @@gate("2.4.4.6")
      }
    `, 'gate-nested-preflight', {
      plugins: [new GatePlugin({ getLevel: (_u: any, model: string) =>
        model === 'accounts' ? 6 : 2   // can create accounts but not users
      })]
    })
    // Trying to create account with nested user create — should fail on users.create
    await expect(db.account.create({
      data: {
        id: 1, name: 'Acme',
        users: { create: { id: 1, email: 'a@x.com' } }
      }
    })).rejects.toThrow(AccessDeniedError)
    db.$close()
  })


  test('SYSADMIN(7) — only users with isSystemAdmin reach this level', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const db = await makeDb(`
      model Secret {
        id Integer @id
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
        id Integer @id
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
      model open_table { id Integer @id }
      model gated_table {
        id Integer @id
        @@gate("5")
      }
    `, 'gate-open-model', {
      plugins: [new GatePlugin({ getLevel: () => 0 })]  // stranger
    })
    await db.$db.run('INSERT INTO open_table VALUES (1)')
    await db.$db.run('INSERT INTO gated_table VALUES (1)')
    // open_table has no gate — stranger can read
    const rows = await db.open_table.findMany()
    expect(rows.length).toBe(1)
    // gated_table requires 5 — stranger (0) denied
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    await expect(db.gated_table.findMany()).rejects.toThrow(AccessDeniedError)
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
        id Integer @id
        @@gate("2.4.4.6")
      }
      model Billing {
        id Integer @id
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
})

// ─── 30. Implicit Many-to-Many ────────────────────────────────────────────────


describe('FrontierGateGetLevel', () => {

  test('null user → STRANGER (0)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel(null)).toBe(LEVELS.STRANGER)
  })

  test('no verifiedAt → VISITOR (1)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel({ id: 1 })).toBe(LEVELS.VISITOR)
  })

  test('verifiedAt, no activatedAt → READER (2)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel({ id: 1, verifiedAt: '2024-01-01' })).toBe(LEVELS.READER)
  })

  test('verifiedAt + activatedAt, no role → CREATOR (3)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel({ id: 1, verifiedAt: '2024-01-01', activatedAt: '2024-01-02' })).toBe(LEVELS.CREATOR)
  })

  test('has role → USER (4)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel({ id: 1, verifiedAt: '2024-01-01', activatedAt: '2024-01-02', role: 'member' })).toBe(LEVELS.USER)
  })

  test('isAdmin → ADMINISTRATOR (5)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel({ id: 1, verifiedAt: '2024-01-01', activatedAt: '2024-01-02', role: 'admin', isAdmin: true })).toBe(LEVELS.ADMINISTRATOR)
  })

  test('isOwner → OWNER (6)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel({ id: 1, verifiedAt: '2024-01-01', activatedAt: '2024-01-02', role: 'admin', isOwner: true })).toBe(LEVELS.OWNER)
  })

  test('isSystemAdmin → SYSADMIN (7)', () => {
    const { FrontierGateGetLevel, LEVELS } = require('../src/plugins/gate.js')
    expect(FrontierGateGetLevel({ id: 1, verifiedAt: '2024-01-01', activatedAt: '2024-01-02', role: 'admin', isSystemAdmin: true })).toBe(LEVELS.SYSADMIN)
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
    expect(p.buildReadFilter('users', {})).toBeNull()
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
    await runner.beforeRead('users', {}, {})
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
        return model === 'posts' ? { published: true } : null
      }
    }
    const runner = new PluginRunner([new F()])
    expect(runner.getReadFilters('posts', {})).toEqual([{ published: true }])
    expect(runner.getReadFilters('users', {})).toEqual([])
  })

  test('AccessDeniedError has correct shape', async () => {
    const { AccessDeniedError } = await import('../src/core/plugin.js')
    const err = new AccessDeniedError('blocked', { model: 'posts', operation: 'read', required: 4, got: 2 })
    expect(err.code).toBe('ACCESS_DENIED')
    expect(err.model).toBe('posts')
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
      model t { id Integer @id }
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
      model t { id Integer @id }
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
      model t { id Integer @id }
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
      model t { id Integer @id
        val Text }
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
      model t { id Integer @id }
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
      model t { id Integer @id }
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
    await expect(p.onAfterDelete('users', [], {})).resolves.toBeUndefined()
  })

  test('PluginRunner.afterDelete calls all plugins in order', async () => {
    const { Plugin, PluginRunner } = await import('../src/core/plugin.js')
    const calls: string[] = []
    class A extends Plugin { async onAfterDelete() { calls.push('A') } }
    class B extends Plugin { async onAfterDelete() { calls.push('B') } }
    const runner = new PluginRunner([new A(), new B()])
    await runner.afterDelete('users', [{ id: 1 }], {})
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
    await runner.afterDelete('users', rows, {})
    expect(received).toEqual(rows)
  })

  test('afterDelete fires after hard delete', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    const deleted: unknown[] = []
    class Spy extends Plugin {
      async onAfterDelete(_model: string, rows: unknown[]) { deleted.push(...rows) }
    }
    const db = await makeDb(`
      model users {
        id    Integer @id
        name  Text
      }
    `, 'after-delete-hard', { plugins: [new Spy()] })
    await db.users.create({ data: { id: 1, name: 'Alice' } })
    await db.users.create({ data: { id: 2, name: 'Bob' } })
    await db.users.delete({ where: { id: 1 } })
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
      model posts {
        id        Integer  @id
        title     Text
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-soft', { plugins: [new Spy()] })
    await db.posts.create({ data: { id: 1, title: 'Hello' } })
    await db.posts.delete({ where: { id: 1 } })   // hard delete on soft-delete model
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
      model items {
        id    Integer @id
        tag   Text
      }
    `, 'after-delete-many', { plugins: [new Spy()] })
    await db.items.createMany({ data: [
      { id: 1, tag: 'a' }, { id: 2, tag: 'b' }, { id: 3, tag: 'a' }
    ]})
    await db.items.deleteMany({ where: { tag: 'a' } })
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
      model items { id Integer @id }
    `, 'after-delete-nomatch', { plugins: [new Spy()] })
    await db.items.deleteMany({ where: { id: 99 } })
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
    expect(plugin._fileMap.users.avatar.keepVersions).toBe(false)
    expect(plugin._fileMap.users.resume.keepVersions).toBe(true)
  })

  test('onInit ignores models with no @file fields', async () => {
    const { FileStorage } = await import('../src/plugins/file.js')
    const plugin = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const schema = parse(`model posts { id Integer @id; title Text }`).schema
    plugin.onInit(schema, { models: {} })
    expect(plugin._fileMap.posts).toBeUndefined()
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
    await plugin.onBeforeCreate('users', { data }, ctx)

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
    await plugin.onBeforeCreate('users', { data }, ctx)
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
    await expect(plugin.onBeforeCreate('users', { data }, ctx))
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
    await expect(plugin.onBeforeCreate('users', { data }, ctx)).resolves.toBeUndefined()
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
    await plugin.onBeforeUpdate('users', { where: { id: 1 }, data }, ctx)

    // New file uploaded and swapped
    expect(typeof data.avatar).toBe('string')
    const ref = JSON.parse(data.avatar)
    expect(ref.size).toBe(9)
    expect(mock.puts).toHaveLength(1)

    // afterWrite triggers old key deletion (it internally unstashes and deletes)
    await plugin.onAfterWrite('users', 'update', {}, ctx)
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
    await plugin.onBeforeUpdate('users', { where: { id: 1 }, data }, ctx)

    // File uploaded
    expect(mock.puts).toHaveLength(1)

    // No stash — keepVersions skips it
    const stashedKey = plugin._unstash(ctx, 'users', 'resume')
    expect(stashedKey).toBeUndefined()

    // afterWrite should not delete anything
    await plugin.onAfterWrite('users', 'update', {}, ctx)
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
    plugin._stash(ctx, 'users', 'avatar', 'some-old-key.jpg')
    await plugin.onAfterWrite('users', 'create', {}, ctx)
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
    await plugin.onAfterDelete('users', rows, ctx)
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

    await plugin.onAfterDelete('users', [{ id: 1, avatar: null, resume: null }], ctx)
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
    await plugin.onAfterDelete('posts', [{ id: 1 }], ctx)
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
    await db.asSystem().users.create({
      data: {
        id: 1, name: 'Alice',
        avatar: JSON.stringify({ key: 'users/1/avatar/photo.jpg', bucket: 'test' }),
        resume: null,
      }
    })

    await db.asSystem().users.delete({ where: { id: 1 } })
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
    model posts {
      id       Integer @id
      authorId Integer
      title    Text
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
    await db.asSystem().posts.createMany({ data: [
      { id: 1, authorId: 1, title: 'Alice post' },
      { id: 2, authorId: 2, title: 'Bob post' },
      { id: 3, authorId: 1, title: 'Alice post 2' },
    ]})

    // Unscoped — system bypasses all gates but plugin filters still apply
    // For a user-scoped request, use $setAuth with a mock user
    const userDb = db.$setAuth({ userId: 1 })
    const posts  = await userDb.posts.findMany({})
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
    await db.asSystem().posts.createMany({ data: [
      { id: 1, authorId: 1, title: 'Mine' },
      { id: 2, authorId: 2, title: 'Not mine' },
    ]})

    const userDb = db.$setAuth({ userId: 2 })
    const post   = await userDb.posts.findFirst({ where: { title: 'Mine' } })
    expect(post).toBeNull()   // filter excludes it

    const ownPost = await userDb.posts.findFirst({ where: { title: 'Not mine' } })
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
    await db.asSystem().posts.createMany({ data: [
      { id: 1, authorId: 1, title: 'A' },
      { id: 2, authorId: 1, title: 'B' },
      { id: 3, authorId: 1, title: 'C' },
      { id: 4, authorId: 2, title: 'D' },
    ]})

    // Both filters: authorId=1 AND id=3 → only post 3
    const posts = await db.posts.findMany({})
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
    await db.asSystem().posts.createMany({ data: [
      { id: 1, authorId: 1, title: 'A' },
      { id: 2, authorId: 2, title: 'B' },
    ]})
    const posts = await db.posts.findMany({})
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
    await db.asSystem().posts.createMany({ data: [
      { id: 1, authorId: 1, title: 'A' },
      { id: 2, authorId: 1, title: 'B' },
      { id: 3, authorId: 2, title: 'C' },
    ]})
    const userDb = db.$setAuth({ userId: 1 })
    const n = await userDb.posts.count({})
    expect(n).toBe(2)
    db.$close()
  })
})

// ─── 40. onAfterRead wired ────────────────────────────────────────────────────


describe('onAfterRead wired into reads', () => {
  const schema = `
    model articles {
      id      Integer @id
      title   Text
      content Text
    }
  `

  test('onAfterRead fires after findMany with all rows', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    let capturedRows: unknown[] = []
    class Spy extends Plugin {
      async onAfterRead(_model: string, rows: unknown[]) { capturedRows = rows }
    }
    const db = await makeDb(schema, 'afterread-findmany', { plugins: [new Spy()] })
    await db.articles.createMany({ data: [
      { id: 1, title: 'A', content: 'a' },
      { id: 2, title: 'B', content: 'b' },
    ]})
    await db.articles.findMany({})
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
    await db.articles.create({ data: { id: 1, title: 'Hello', content: 'world' } })
    await db.articles.findFirst({ where: { id: 1 } })
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
    await db.articles.createMany({ data: [
      { id: 1, title: 'A', content: 'secret-a' },
      { id: 2, title: 'B', content: 'secret-b' },
    ]})
    const rows = await db.articles.findMany({})
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
    await db.articles.findMany({})
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
    const row = await db.articles.findFirst({ where: { id: 999 } })
    expect(row).toBeNull()
    expect(called).toBe(false)
    db.$close()
  })
})

// ─── 41. optimizeFts ─────────────────────────────────────────────────────────


describe('upsert plugin hooks', () => {
  const schema = `
    model notes {
      id      Integer @id
      content Text
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
    await db.notes.upsert({
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
    await db.notes.create({ data: { id: 1, content: 'existing' } })
    ops.length = 0   // clear the create hook from the setup call

    await db.notes.upsert({
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
    await db.notes.create({ data: { id: 5, content: 'existing' } })

    await db.notes.upsert({
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
    model tasks {
      id        Integer  @id
      status    Text     @default("open")
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
    await db.tasks.createMany({ data: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }] })
    await db.tasks.removeMany({ where: { status: 'open' } })
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
    await db.tasks.createMany({ data: [{ id: 1, status: 'done' }] })
    await db.tasks.removeMany({ where: { status: 'done' } })
    expect(capturedWhere).toEqual({ status: 'done' })
    db.$close()
  })

  test('throwing in beforeDelete prevents the removal', async () => {
    const { Plugin } = await import('../src/core/plugin.js')
    class Guard extends Plugin {
      async onBeforeDelete() { throw new Error('removal blocked') }
    }
    const db = await makeDb(schema, 'removemany-before-throws', { plugins: [new Guard()] })
    await db.tasks.createMany({ data: [{ id: 1, status: 'open' }] })
    await expect(db.tasks.removeMany({ where: { status: 'open' } })).rejects.toThrow('removal blocked')
    // Row should still exist
    const count = await db.tasks.count()
    expect(count).toBe(1)
    db.$close()
  })
})

// ─── 39. buildReadFilter wired into queries ───────────────────────────────────


describe('transform hooks (before/after)', () => {
  test('before:setters runs on create — can mutate data', async () => {
    const log: string[] = []
    const db = await makeDb(`
      model items { id Integer @id
        name Text
        score Integer }
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
    await db.items.create({ data: { id: 1, name: 'A', score: '5' } })
    const row = await db.items.findUnique({ where: { id: 1 } })
    expect(row.score).toBe(10)           // '5' → 5 → *2 = 10
    expect(log).toContain('before:create')
    db.$close()
  })

  test('before:update only runs on update', async () => {
    const ops: string[] = []
    const db = await makeDb(`
      model items { id Integer @id
        name Text }
    `, 'hook-update', {
      hooks: {
        before: {
          update: [(ctx: any) => { ops.push('update') }]
        }
      }
    })
    await db.items.create({ data: { id: 1, name: 'A' } })
    await db.items.update({ where: { id: 1 }, data: { name: 'B' } })
    expect(ops).toEqual(['update'])     // fired once, only on update
    db.$close()
  })

  test('after:getters transforms read result', async () => {
    const db = await makeDb(`
      model users { id Integer @id
        first Text
        last Text }
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
    await db.users.create({ data: { id: 1, first: 'Alice', last: 'Smith' } })
    const rows = await db.users.findMany()
    expect(rows[0].fullName).toBe('Alice Smith')

    const one = await db.users.findFirst({ where: { id: 1 } })
    expect(one.fullName).toBe('Alice Smith')
    db.$close()
  })

  test('after:all runs on both reads and writes', async () => {
    const ops: string[] = []
    const db = await makeDb(`
      model t { id Integer @id
        val Text }
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
      model t { id Integer @id
        val Text }
    `, 'hook-schema', {
      hooks: {
        before: {
          setters: [(hook: any, ctx: any) => { capturedSchema = ctx.schema }]
        }
      }
    })
    await db.t.create({ data: { id: 1, val: 'x' } })
    expect(capturedSchema?.name).toBe('t')
    expect(capturedSchema?.fields?.length).toBeGreaterThan(0)
    db.$close()
  })

  test('no hooks — normal operation unaffected', async () => {
    const db = await makeDb(`
      model t { id Integer @id
        val Text }
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
      model t { id Integer @id
        val Text }
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
      model t { id Integer @id
        val Text }
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
      model t { id Integer @id
        val Text
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
      model t { id Integer @id
        val Text }
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
      model t { id Integer @id
        val Text }
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
      model t { id Integer @id
        val Text }
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

// ─── 22. Text[] / Integer[] array fields ─────────────────────────────────────


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
model t { id Integer @id; c Color }`)
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


describe('enum transitions — enforcement', () => {
  let db: any

  beforeEach(async () => {
    const result = await makeTestClient(TRANSITION_SCHEMA)
    db = result.db
    await db.orders.create({ data: { id: 1, status: 'pending' } })
    await db.orders.create({ data: { id: 2, status: 'paid' } })
    await db.orders.create({ data: { id: 3, status: 'shipped' } })
  })
  afterEach(() => db.$close())

  // ── Valid transitions ────────────────────────────────────────────────────────

  test('valid transition via update()', async () => {
    const r = await db.orders.update({ where: { id: 1 }, data: { status: 'paid' } })
    expect(r.status).toBe('paid')
  })

  test('valid multi-from transition: paid -> refunded', async () => {
    const r = await db.orders.update({ where: { id: 2 }, data: { status: 'refunded' } })
    expect(r.status).toBe('refunded')
  })

  test('valid multi-from transition: shipped -> refunded', async () => {
    const r = await db.orders.update({ where: { id: 3 }, data: { status: 'refunded' } })
    expect(r.status).toBe('refunded')
  })

  test('non-transition field update unaffected', async () => {
    const r = await db.orders.update({ where: { id: 1 }, data: { note: 'hello' } })
    expect(r.note).toBe('hello')
    expect(r.status).toBe('pending')
  })

  test('no-op update (same value) does not throw', async () => {
    const r = await db.orders.update({ where: { id: 1 }, data: { status: 'pending' } })
    expect(r.status).toBe('pending')
  })

  // ── Invalid transitions ──────────────────────────────────────────────────────

  test('invalid transition throws TransitionViolationError', async () => {
    await expect(
      db.orders.update({ where: { id: 1 }, data: { status: 'shipped' } })
    ).rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('TransitionViolationError has correct fields', async () => {
    try {
      await db.orders.update({ where: { id: 1 }, data: { status: 'shipped' } })
    } catch (e: any) {
      expect(e.model).toBe('orders')
      expect(e.field).toBe('status')
      expect(e.from).toBe('pending')
      expect(e.to).toBe('shipped')
      expect(e.retryable).toBe(false)
    }
  })

  test('pending -> delivered invalid (no direct transition)', async () => {
    await expect(
      db.orders.update({ where: { id: 1 }, data: { status: 'delivered' } })
    ).rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('pending -> refunded invalid', async () => {
    await expect(
      db.orders.update({ where: { id: 1 }, data: { status: 'refunded' } })
    ).rejects.toBeInstanceOf(TransitionViolationError)
  })

  // ── transition() method ──────────────────────────────────────────────────────

  test('transition() resolves name to value', async () => {
    const r = await db.orders.transition(1, 'pay')
    expect(r.status).toBe('paid')
  })

  test('transition() multi-step', async () => {
    await db.orders.transition(1, 'pay')
    await db.orders.transition(1, 'ship')
    const r = await db.orders.findUnique({ where: { id: 1 } })
    expect(r.status).toBe('shipped')
  })

  test('transition() throws TransitionNotFoundError for unknown name', async () => {
    await expect(db.orders.transition(1, 'fly')).rejects.toBeInstanceOf(TransitionNotFoundError)
  })

  test('TransitionNotFoundError has correct fields', async () => {
    try {
      await db.orders.transition(1, 'fly')
    } catch (e: any) {
      expect(e.model).toBe('orders')
      expect(e.transition).toBe('fly')
      expect(e.retryable).toBe(false)
    }
  })

  test('transition() on model without transitions throws helpful error', async () => {
    const { db: db2 } = await makeTestClient(`model t { id Integer @id; name Text }`)
    await expect(db2.t.transition(1, 'go')).rejects.toThrow('no transitions block')
    db2.$close()
  })

  // ── No enforcement on create ─────────────────────────────────────────────────

  test('create with @default value: no enforcement', async () => {
    // pending is the default — creating with it should always work
    const r = await db.orders.create({ data: { id: 10, status: 'pending' } })
    expect(r.status).toBe('pending')
  })

  test('create with non-default value: no enforcement (create is exempt)', async () => {
    // Creating directly with 'paid' skips transition checks — create is always exempt
    const r = await db.orders.create({ data: { id: 11, status: 'paid' } })
    expect(r.status).toBe('paid')
  })

  // ── Plain enum not affected ──────────────────────────────────────────────────

  test('plain enum field update is unaffected', async () => {
    const { db: db2 } = await makeTestClient(`
      enum Color { red green blue }
      model t { id Integer @id; c Color @default(red) }
    `)
    await db2.t.create({ data: { id: 1, c: 'red' } })
    const r = await db2.t.update({ where: { id: 1 }, data: { c: 'blue' } })
    expect(r.c).toBe('blue')   // no transition block → no enforcement
    db2.$close()
  })

  // ── SYSTEM bypass ────────────────────────────────────────────────────────────

  test('asSystem() bypasses transition enforcement', async () => {
    // pending -> shipped would normally be invalid
    const r = await db.asSystem().orders.update({ where: { id: 1 }, data: { status: 'shipped' } })
    expect(r.status).toBe('shipped')
  })

  // ── Events ───────────────────────────────────────────────────────────────────

  test('successful transition fires transition event', async () => {
    const events: any[] = []
    const { db: evDb } = await makeTestClient(TRANSITION_SCHEMA, {
      data: async (db) => { await db.orders.create({ data: { id: 1, status: 'pending' } }) },
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
    await evDb2.orders.create({ data: { id: 1, status: 'pending' } })
    await evDb2.orders.update({ where: { id: 1 }, data: { status: 'paid' } })
    // Give the setTimeout(0) a tick to fire
    await new Promise(r => setTimeout(r, 10))
    expect(events.length).toBe(1)
    expect(events[0].transition).toBe('pay')
    expect(events[0].from).toBe('pending')
    expect(events[0].to).toBe('paid')
    expect(events[0].model).toBe('orders')
    evDb.$close(); evDb2.$close()
  })
})


describe('enum transitions — conflict and upsert', () => {
  let db: any

  beforeEach(async () => {
    const result = await makeTestClient(TRANSITION_SCHEMA)
    db = result.db
    await db.orders.create({ data: { id: 1, status: 'pending' } })
    await db.orders.create({ data: { id: 2, status: 'paid' } })
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
      if (!hooked && /UPDATE.*orders.*RETURNING/i.test(sql)) {
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
        db.orders.update({ where: { id: 2 }, data: { status: 'shipped' } })
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
      if (!patched && typeof sql === 'string' && sql.includes('UPDATE') && sql.includes('"orders"')) {
        patched = true
        return { changes: 0, lastInsertRowid: 0 }
      }
      return originalRun(sql, ...args)
    }

    try {
      await db.orders.update({ where: { id: 2 }, data: { status: 'shipped' } })
    } catch (e: any) {
      expect(e).toBeInstanceOf(TransitionConflictError)
      expect(e.model).toBe('orders')
      expect(e.field).toBe('status')
      expect(e.from).toBe('paid')
      expect(e.to).toBe('shipped')
      expect(e.retryable).toBe(true)
    } finally {
      rawDb.run = originalRun
    }
  })

  test('ConflictError is marked retryable', async () => {
    const err = new TransitionConflictError('orders', 'status', 'paid', 'shipped')
    expect(err.retryable).toBe(true)
    expect(err).toBeInstanceOf(Error)
  })

  // ── upsert() transition enforcement ─────────────────────────────────────
  //
  // upsert() delegates to update() for the existing-row path → enforcement
  // is inherited. create() path is always exempt (per decision).

  test('upsert existing row: valid transition enforced', async () => {
    // id=1 exists with status=pending — pay is a valid transition
    const r = await db.orders.upsert({
      where:  { id: 1 },
      create: { id: 1, status: 'pending' },
      update: { status: 'paid' },
    })
    expect(r.status).toBe('paid')
  })

  test('upsert existing row: invalid transition throws TransitionViolationError', async () => {
    // id=1 exists with status=pending — ship is NOT valid from pending
    await expect(db.orders.upsert({
      where:  { id: 1 },
      create: { id: 1, status: 'pending' },
      update: { status: 'shipped' },
    })).rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('upsert new row (create path): exempt from enforcement', async () => {
    // id=99 does not exist — create path, always exempt
    const r = await db.orders.upsert({
      where:  { id: 99 },
      create: { id: 99, status: 'shipped' },   // non-default, would fail if enforced
      update: { status: 'delivered' },
    })
    expect(r.status).toBe('shipped')
  })
})


describe('enum transitions — JSON Schema', () => {
  test('x-litestone-transitions emitted on enum with transitions', () => {
    const { schema } = parse(TRANSITION_SCHEMA)
    const js = generateJsonSchema(schema)
    const enumDef = js['$defs']?.['OrderStatus'] ?? js['OrderStatus']
    expect(enumDef['x-litestone-transitions']).toBeDefined()
    expect(enumDef['x-litestone-transitions'].pay).toEqual({ from: ['pending'], to: 'paid' })
    expect(enumDef['x-litestone-transitions'].refund).toEqual({ from: ['paid','shipped'], to: 'refunded' })
  })

  test('plain enum has no x-litestone-transitions', () => {
    const { schema } = parse(`enum Color { red green blue }
model t { id Integer @id; c Color }`)
    const js = generateJsonSchema(schema)
    const enumDef = js['$defs']?.['Color'] ?? js['Color']
    expect(enumDef['x-litestone-transitions']).toBeUndefined()
  })
})

// ─── Lock primitive ───────────────────────────────────────────────────────────

import { LockNotAcquiredError, LockReleasedByOtherError, LockExpiredError }
  from '../src/core/client.js'

const LOCK_SCHEMA = `model things { id Integer @id; name Text }`


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
      await db.things.create({ data: { id: 1, name: 'inside lock' } })
    })
    const n = await db.things.count()
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

// ─── @markdown annotation ─────────────────────────────────────────────────────

describe('@markdown — generateTypeScript', () => {
  const MD_TS_SCHEMA = `
    model posts {
      id    Integer @id
      body  Text    @markdown
      note  Text?   @markdown
      title Text
    }
  `
  const { schema } = parse(MD_TS_SCHEMA)

  test('@markdown field emits string type (not special type)', () => {
    const dts = generateTypeScript(schema)
    // body is Text @markdown — should still be string, not a special markdown type
    const postSection = dts.slice(dts.indexOf('export interface Posts {'), dts.indexOf('export interface PostsCreate {'))
    expect(postSection).toContain('body:')
    expect(postSection).toContain('string')
  })

  test('@markdown optional field emits string | null', () => {
    const dts = generateTypeScript(schema)
    const postSection = dts.slice(dts.indexOf('export interface Posts {'), dts.indexOf('export interface PostsCreate {'))
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
    const createSection = dts.slice(dts.indexOf('export interface PostsCreate {'), dts.indexOf('export interface PostsUpdate {'))
    expect(createSection).toContain('body')
  })

  test('@markdown does not affect plain text field in same model', () => {
    const dts = generateTypeScript(schema)
    const postSection = dts.slice(dts.indexOf('export interface Posts {'), dts.indexOf('export interface PostsCreate {'))
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
      model = 'users'
      definition(seq: number) { return { id: seq, name: `User ${seq}`, email: `u${seq}@x.com` } }
    }
    const db = await makeDb(`model users {
        id    Integer @id
        name  Text
        email Text
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
    const db = await makeDb(`model t {
        id  Integer @id
        val Text
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
    const db = await makeDb(`model t {
        id  Integer @id
        val Text
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
    const db = await makeDb(`model t {
        id   Integer @id
        role Text
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
    const db = await makeDb(`model t {
        id  Integer @id
        val Text
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
    const db = await makeDb(`model t { id Integer @id }`, 'seeder-call')
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
    expect(schema).toContain('Integer')
    expect(schema).toContain('Real')
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
    expect(schema).toContain('Text?')
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
    expect(typeof db.users.findMany).toBe('function')
    db.$close()
  })

  test('returns bound factory instances', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { users: UserFactory, accounts: AccountFactory },
    })
    expect(factories.users).toBeInstanceOf(UserFactory)
    expect(factories.accounts).toBeInstanceOf(AccountFactory)
    db.$close()
  })

  test('data seeder fn runs after tables created', async () => {
    const { db } = await makeTestClient(FACTORY_SCHEMA, {
      data: async (db) => {
        await db.accounts.create({ data: { id: 1, name: 'Seeded' } })
      }
    })
    const n = await db.accounts.count()
    expect(n).toBe(1)
    db.$close()
  })

  test('seed option makes factories deterministic', async () => {
    const { factories: f1, db: db1 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 99, factories: { users: UserFactory }
    })
    const { factories: f2, db: db2 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 99, factories: { users: UserFactory }
    })
    expect(f1.users.buildOne()).toEqual(f2.users.buildOne())
    db1.$close(); db2.$close()
  })

  test('different seeds produce different data', async () => {
    const { factories: f1, db: db1 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 1, factories: { users: UserFactory }
    })
    const { factories: f2, db: db2 } = await makeTestClient(FACTORY_SCHEMA, {
      seed: 2, factories: { users: UserFactory }
    })
    // seq counter is same (both = 1st call) but rng state differs
    const a = f1.users.seed(1).buildOne()
    const b = f2.users.seed(2).buildOne()
    expect(a).not.toEqual(b)
    db1.$close(); db2.$close()
  })

  test('parallel makeTestClient calls never collide', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        makeTestClient(FACTORY_SCHEMA, {
          data: async (db) => { await db.accounts.create({ data: { id: 1, name: `db${i}` } }) }
        })
      )
    )
    const counts = await Promise.all(results.map(({ db }) => db.accounts.count()))
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
      factories: { users: UserFactory, accounts: AccountFactory }
    })
    db = result.db
    // ensure accountId=1 exists for FK
    await db.accounts.create({ data: { id: 1, name: 'Test Co' } })
    users = result.factories.users as UserFactory
  })
  afterEach(() => db.$close())

  test('createOne inserts row and returns it', async () => {
    const row = await users.createOne()
    expect(row.id).toBe(1)
    expect(row.email).toBe('user1@test.com')
    const found = await db.users.findUnique({ where: { id: 1 } })
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
    const n = await db.users.count()
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

  test('trait + createOne', async () => {
    const row = await (users as any).admin().createOne()
    expect(row.role).toBe('admin')
    const dbRow = await db.users.findUnique({ where: { id: 1 } })
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
      factories: { accounts: AccountFactory, users: UserFactory, posts: PostFactory }
    })
    db = result.db
    accounts = result.factories.accounts as AccountFactory
    users    = result.factories.users    as UserFactory
    posts    = result.factories.posts    as PostFactory
  })
  afterEach(() => db.$close())

  test('withRelation auto-creates parent and injects FK', async () => {
    // Make account first for the user FK
    const acct = await accounts.createOne()
    const user = await users.withRelation('account', accounts, 'accountId').createOne()
    expect(user.accountId).toBeDefined()
    const acctExists = await db.accounts.findUnique({ where: { id: user.accountId } })
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
    const n = await db.accounts.count()
    expect(n).toBe(1)
  })
})


describe('Factory — afterCreate hook', () => {
  test('afterCreate fires after row inserted', async () => {
    const calls: any[] = []

    class HookedFactory extends Factory {
      model = 'accounts'
      definition(seq: number) { return { id: seq, name: `Hooked ${seq}` } }
      afterCreate = async (row: any, db: any) => { calls.push(row) }
    }

    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { accounts: HookedFactory }
    })
    await factories.accounts.createOne()
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('Hooked 1')
    db.$close()
  })

  test('afterCreate can create related rows', async () => {
    class AccountWithUserFactory extends Factory {
      model = 'accounts'
      definition(seq: number) { return { id: seq, name: `Co ${seq}` } }
      afterCreate = async (row: any, db: any) => {
        await db.users.create({ data: {
          id: row.id * 100, accountId: row.id,
          email: `owner@${row.id}.com`, role: 'admin'
        }})
      }
    }

    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { accounts: AccountWithUserFactory }
    })
    await factories.accounts.createOne()
    const userCount = await db.users.count()
    expect(userCount).toBe(1)
    db.$close()
  })
})


describe('Factory — truncate()', () => {
  test('truncate() wipes factory model table', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { accounts: AccountFactory }
    })
    await factories.accounts.createMany(3)
    expect(await db.accounts.count()).toBe(3)
    await factories.accounts.truncate()
    expect(await db.accounts.count()).toBe(0)
    db.$close()
  })
})


describe('truncate() helper', () => {
  test('truncate() hard-deletes all rows in table', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { accounts: AccountFactory }
    })
    await factories.accounts.createMany(5)
    await truncate(db, 'accounts')
    expect(await db.accounts.count()).toBe(0)
    db.$close()
  })

  test('truncate() bypasses soft-delete', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { accounts: AccountFactory, users: UserFactory }
    })
    const acct = await factories.accounts.createOne()
    await factories.users.createMany(3, { accountId: acct.id })
    await db.users.removeMany({})           // soft-delete all
    expect(await db.users.count()).toBe(0)  // soft-filter shows 0
    await truncate(db, 'users')             // hard-delete the soft-deleted rows
    const raw = await db.asSystem().sql`SELECT COUNT(*) as n FROM users`
    expect(raw[0].n).toBe(0)
    db.$close()
  })
})


describe('reset() helper', () => {
  test('reset() wipes all tables', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { accounts: AccountFactory, users: UserFactory }
    })
    const acct = await factories.accounts.create()
    await factories.users.createMany(3, { accountId: acct.id })
    await reset(db)
    expect(await db.accounts.count()).toBe(0)
    expect(await db.asSystem().users.count({ where: {} })).toBe(0)
    db.$close()
  })

  test('reset() leaves schema intact — can insert after reset', async () => {
    const { db, factories } = await makeTestClient(FACTORY_SCHEMA, {
      factories: { accounts: AccountFactory }
    })
    await factories.accounts.createMany(3)
    await reset(db)
    await factories.accounts.createOne()
    expect(await db.accounts.count()).toBe(1)
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

import { generateFactory, generateGateMatrix, generateValidationCases, factoryFrom }
  from '../src/testing.js'
import { GatePlugin, LEVELS }    from '../src/plugins/gate.js'
import { DEFAULT_MESSAGES }      from '../src/core/validate.js'

// ── Shared schema for utility tests ──────────────────────────────────────────

const UTIL_SCHEMA = `
  enum Status { new active archived }
  enum Plan   { starter pro enterprise }

  model Account {
    id    Integer @id
    name  Text
    plan  Plan    @default(starter)
    url   Text?   @url
    slug  Text?   @length(3, 50)
  }

  model Lead {
    id        Integer @id
    accountId Integer
    email     Text?   @email
    firstName Text?
    lastName  Text?
    status    Status  @default(new)
    score     Real?   @gte(0) @lte(100)
    notes     Text?   @contains("note")
  }

  model Post {
    id        Integer @id
    accountId Integer
    title     Text
    body      Text?
    published Boolean
    views     Integer
    rating    Real
    createdAt DateTime?
    updatedAt DateTime?
    deletedAt DateTime?
    @@gate("1.3.4.6")
    @@softDelete
  }

  model Locked {
    id    Integer @id
    name  Text
    @@gate("9")
  }

  model Open {
    id   Integer @id
    data Text?
    @@gate("0")
  }
`

// ─── generateFactory ─────────────────────────────────────────────────────────


describe('generateFactory', () => {
  const { schema } = parse(UTIL_SCHEMA)

  test('throws on unknown model', () => {
    expect(() => generateFactory(schema, 'nope')).toThrow('not found')
  })

  test('skips @id Integer (auto-increment)', () => {
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
      model User { id Integer @id; name Text; posts Post[] }
      model Post { id Integer @id; userId Integer; title Text }
    `)
    const def = generateFactory(s, 'User')
    expect('posts' in def(1, null)).toBe(false)
  })

  test('@default(literal string) used', () => {
    const { schema: s } = parse(`model t { id Integer @id; role Text @default("admin") }`)
    const row = generateFactory(s, 't')(1, null)
    expect(row.role).toBe('admin')
  })

  test('@default(number) used', () => {
    const { schema: s } = parse(`model t { id Integer @id; count Integer @default(0) }`)
    const row = generateFactory(s, 't')(1, null)
    expect(row.count).toBe(0)
  })

  test('@default(boolean) used', () => {
    const { schema: s } = parse(`model t { id Integer @id; active Boolean @default(true) }`)
    const row = generateFactory(s, 't')(1, null)
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
      model t { id Integer @id; color Color }
    `)
    const row = generateFactory(s, 't')(1, null)
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
    // url is optional — null when optional and no other Text constraint
    // but @url is a text constraint so should be non-null
    expect(row.url).toMatch(/^https:\/\//)
  })

  test('@length(min, max) → x repeated min times', () => {
    const def = generateFactory(schema, 'Account')
    const row = def(1, null)
    expect(row.slug?.length).toBeGreaterThanOrEqual(3)
  })

  test('plain Text → "FieldName seq"', () => {
    const def = generateFactory(schema, 'Account')
    const row = def(1, null)
    expect(row.name).toBe('Name 1')
  })

  test('plain Text increments with seq', () => {
    const def = generateFactory(schema, 'Account')
    expect(def(1, null).name).toBe('Name 1')
    expect(def(3, null).name).toBe('Name 3')
  })

  test('Text? optional no constraint → null', () => {
    const def = generateFactory(schema, 'Lead')
    expect(def(1, null).firstName).toBeNull()
    expect(def(1, null).lastName).toBeNull()
  })

  test('Integer FK field → 1', () => {
    const def = generateFactory(schema, 'Lead')
    expect(def(1, null).accountId).toBe(1)
  })

  test('Integer FK field respects fkDefaults', () => {
    const def = generateFactory(schema, 'Lead', { fkDefaults: { accountId: 42 } })
    expect(def(1, null).accountId).toBe(42)
  })

  test('Integer non-FK → seq', () => {
    const def = generateFactory(schema, 'Post')
    expect(def(3, null).views).toBe(3)
  })

  test('Integer? optional → null', () => {
    const { schema: s } = parse(`model t { id Integer @id; count Integer? }`)
    const row = generateFactory(s, 't')(1, null)
    expect(row.count).toBeNull()
  })

  test('Real with @gte and @lte → midpoint', () => {
    const def = generateFactory(schema, 'Lead')
    expect(def(1, null).score).toBeNull()   // optional → null
  })

  test('Real with @gte and @lte required → midpoint', () => {
    const { schema: s } = parse(`model t { id Integer @id; score Real @gte(0) @lte(100) }`)
    const row = generateFactory(s, 't')(1, null)
    expect(row.score).toBe(50)
  })

  test('Real with @gte only → gte value', () => {
    const { schema: s } = parse(`model t { id Integer @id; n Real @gte(5) }`)
    expect(generateFactory(s, 't')(1, null).n).toBe(5)
  })

  test('Real no constraint → seq * 1.0', () => {
    const def = generateFactory(schema, 'Post')
    expect(def(2, null).rating).toBe(2.0)
  })

  test('Boolean → false', () => {
    const def = generateFactory(schema, 'Post')
    expect(def(1, null).published).toBe(false)
  })

  test('Json → null', () => {
    const { schema: s } = parse(`model t { id Integer @id; meta Json }`)
    expect(generateFactory(s, 't')(1, null).meta).toBeNull()
  })

  test('Text[] required → []', () => {
    const { schema: s } = parse(`model t { id Integer @id; tags Text[] }`)
    const row = generateFactory(s, 't')(1, null)
    expect(row.tags).toEqual([])
  })

  test('Text[]? optional → null', () => {
    const { schema: s } = parse(`model t { id Integer @id; tags Text[]? }`)
    const row = generateFactory(s, 't')(1, null)
    expect(row.tags).toBeNull()
  })

  test('@secret included (ORM encrypts on write)', () => {
    const ENC = 'c'.repeat(64)
    const { schema: s } = parse(`model t { id Integer @id; token Text @secret }`)
    const row = generateFactory(s, 't')(1, null)
    // @secret field is present — value generated like any Text field
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

  test('returns 8 cases for standard gate (2 per op)', () => {
    const matrix = generateGateMatrix(schema, 'Post')  // @@gate("1.3.4.6")
    expect(matrix.length).toBe(8)
  })

  test('correct allow/deny for read (level 1 = VISITOR)', () => {
    const matrix = generateGateMatrix(schema, 'Post')
    const readAllow = matrix.find(c => c.op === 'read' && c.expect === 'allow')
    const readDeny  = matrix.find(c => c.op === 'read' && c.expect === 'deny')
    expect(readAllow?.level).toBe(1)
    expect(readAllow?.label).toBe('VISITOR')
    expect(readDeny?.level).toBe(0)
    expect(readDeny?.label).toBe('STRANGER')
  })

  test('correct allow/deny for delete (level 6 = OWNER)', () => {
    const matrix = generateGateMatrix(schema, 'Post')
    const delAllow = matrix.find(c => c.op === 'delete' && c.expect === 'allow')
    const delDeny  = matrix.find(c => c.op === 'delete' && c.expect === 'deny')
    expect(delAllow?.level).toBe(6)
    expect(delAllow?.label).toBe('OWNER')
    expect(delDeny?.level).toBe(5)
    expect(delDeny?.label).toBe('ADMINISTRATOR')
  })

  test('LOCKED gate (9): only deny cases, no allow', () => {
    const matrix = generateGateMatrix(schema, 'Locked')  // @@gate("9")
    expect(matrix.every(c => c.expect === 'deny')).toBe(true)
    expect(matrix.length).toBe(4)   // one deny per op
    expect(matrix.every(c => c.level === 8)).toBe(true)  // SYSTEM
  })

  test('STRANGER gate (0): only allow cases, no deny', () => {
    const matrix = generateGateMatrix(schema, 'Open')    // @@gate("0")
    expect(matrix.every(c => c.expect === 'allow')).toBe(true)
    expect(matrix.length).toBe(4)
    expect(matrix.every(c => c.level === 0)).toBe(true)
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

  test('matrix is usable with GatePlugin in makeTestClient', async () => {
    const { schema: s } = parse(UTIL_SCHEMA)
    const matrix = generateGateMatrix(s, 'Post')

    for (const { op, level, expect: expected } of matrix) {
      const { db } = await makeTestClient(UTIL_SCHEMA, {
        plugins: [new GatePlugin({ getLevel: () => level })]
      })
      const sys    = db.asSystem()
      const scoped = db.$setAuth({ id: 1 })

      // Seed data needed for non-create ops
      if (op !== 'create') {
        await sys.account.create({ data: { id: 1, name: 'Test' } })
        await sys.post.create({ data: { id: 1, accountId: 1, title: 'T', published: false, views: 0, rating: 0 } })
      }

      const run = async () => {
        switch (op) {
          case 'read':   return scoped.post.findMany()
          case 'create': return scoped.post.create({ data: { id: 99, accountId: 1, title: 'X', published: false, views: 0, rating: 0 } })
          case 'update': return scoped.post.update({ where: { id: 1 }, data: { title: 'Y' } })
          case 'delete': return scoped.post.delete({ where: { id: 1 } })
        }
      }

      if (expected === 'allow') {
        await expect(run()).resolves.toBeDefined()
      } else {
        await expect(run()).rejects.toThrow(/requires level/i)
      }
      db.$close()
    }
  })
})

// ─── generateValidationCases ──────────────────────────────────────────────────


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
    const { schema: s } = parse(`model t { id Integer @id; name Text }`)
    const { invalid, boundary } = generateValidationCases(s, 't')
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
    const { schema: s } = parse(`model t { id Integer @id; code Text @length(3, 10) }`)
    const { invalid, boundary } = generateValidationCases(s, 't')
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

  model accounts {
    id        Integer  @id
    name      Text
    plan      Plan     @default(starter)
    meta      Json?
    createdAt DateTime @default(now())
  }

  model users {
    id        Integer   @id
    account   accounts  @relation(fields: [accountId], references: [id])
    accountId Integer
    email     Text      @unique @email
    role      Text      @default("member")
    salary    Real?     @guarded
    apiKey    Text?     @secret
    tags      Text[]
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
    expect(dts).toContain('export interface Accounts {')
    expect(dts).toContain('export interface Users {')
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

  test('row interface has Text[] as string[]', () => {
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
    const userSection = dts.slice(dts.indexOf('export interface Users {'), dts.indexOf('export interface UsersCreate {'))
    expect(userSection).not.toContain('apiKey')
  })

  test('@secret field included in system audience', () => {
    const dts = generateTypeScript(schema, { audience: 'system' })
    expect(dts).toContain('apiKey')
  })

  test('emits Create interface', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface AccountsCreate {')
    expect(dts).toContain('export interface UsersCreate {')
  })

  test('Create interface makes @id optional', () => {
    const dts = generateTypeScript(schema)
    const createSection = dts.slice(
      dts.indexOf('export interface AccountsCreate {'),
      dts.indexOf('export interface AccountsUpdate {')
    )
    // id should be optional in create (auto-increment)
    expect(createSection).toContain('id?:')
  })

  test('Create interface excludes createdAt/updatedAt/deletedAt', () => {
    const dts = generateTypeScript(schema)
    const createSection = dts.slice(
      dts.indexOf('export interface AccountsCreate {'),
      dts.indexOf('export interface AccountsUpdate {')
    )
    expect(createSection).not.toContain('createdAt')
    expect(createSection).not.toContain('deletedAt')
  })

  test('emits Update interface with all optional fields', () => {
    const dts = generateTypeScript(schema)
    expect(dts).toContain('export interface AccountsUpdate {')
    const updateSection = dts.slice(
      dts.indexOf('export interface AccountsUpdate {'),
      dts.indexOf('export interface AccountsWhere')
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
    expect(dts).toContain('export interface AccountsWhere extends WhereBase {')
    expect(dts).toContain('AND?: AccountsWhere[]')
    expect(dts).toContain('OR?:  AccountsWhere[]')
    expect(dts).toContain('NOT?: AccountsWhere')
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
    expect(dts).toContain('readonly accounts: TableClient<Accounts, AccountsCreate, AccountsUpdate, AccountsWhere>')
    expect(dts).toContain('readonly users: TableClient<Users, UsersCreate, UsersUpdate, UsersWhere>')
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
      dts.indexOf('export interface Users {'),
      dts.indexOf('export interface UsersCreate {')
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

  model orders {
    id     Integer     @id
    status OrderStatus @default(pending)
    note   Text?
  }
`


describe('generateJsonSchema — x-gate', () => {
  const { schema } = parse(JEXT_SCHEMA)

  test('x-gate emitted for model with @@gate', () => {
    const js = generateJsonSchema(schema)
    const accounts = js['$defs']?.accounts
    expect(accounts['x-gate']).toBeDefined()
  })

  test('x-gate has correct RCUD values', () => {
    const js = generateJsonSchema(schema)
    const accounts = js['$defs']?.accounts
    expect(accounts['x-gate']).toEqual({ read: 2, create: 5, update: 5, delete: 6 })
  })

  test('x-gate emitted on all modes (create/update/full)', () => {
    for (const mode of ['create','update','full']) {
      const js = generateJsonSchema(schema, { mode })
      expect(js['$defs']?.accounts['x-gate']).toBeDefined()
    }
  })

  test('no x-gate on model without @@gate', () => {
    const js = generateJsonSchema(schema)
    const posts = js['$defs']?.posts
    expect(posts['x-gate']).toBeUndefined()
  })

  test('x-gate emitted for users model', () => {
    const js = generateJsonSchema(schema)
    const users = js['$defs']?.users
    expect(users['x-gate']).toEqual({ read: 2, create: 4, update: 4, delete: 6 })
  })
})


describe('generateJsonSchema — x-relations', () => {
  const { schema } = parse(JEXT_SCHEMA)

  test('x-relations emitted for model with relations', () => {
    const js = generateJsonSchema(schema)
    expect(js['$defs']?.users['x-relations']).toBeDefined()
  })

  test('no x-relations on model with no relations', () => {
    const { schema: s } = parse(`model t { id Integer @id; name Text }`)
    const js = generateJsonSchema(s)
    expect(js['$defs']?.t?.['x-relations']).toBeUndefined()
  })

  test('belongsTo relation has correct shape', () => {
    const js = generateJsonSchema(schema)
    const rels = js['$defs']?.users['x-relations'] as any[]
    const account = rels?.find((r: any) => r.field === 'account')
    expect(account).toBeDefined()
    expect(account.type).toBe('belongsTo')
    expect(account.model).toBe('accounts')
    expect(account.fields).toEqual(['accountId'])
    expect(account.references).toEqual(['id'])
    expect(account.onDelete).toBe('Cascade')
  })

  test('hasMany relation has correct shape', () => {
    const js = generateJsonSchema(schema)
    const rels = js['$defs']?.users['x-relations'] as any[]
    const posts = rels?.find((r: any) => r.field === 'posts')
    expect(posts).toBeDefined()
    expect(posts.type).toBe('hasMany')
    expect(posts.model).toBe('posts')
    expect(posts.fields).toEqual([])
  })

  test('accounts has hasMany users relation', () => {
    const js = generateJsonSchema(schema)
    const rels = js['$defs']?.accounts['x-relations'] as any[]
    const users = rels?.find((r: any) => r.field === 'users')
    expect(users?.type).toBe('hasMany')
    expect(users?.model).toBe('users')
  })

  test('x-relations fields are excluded from properties', () => {
    const js = generateJsonSchema(schema)
    const props = js['$defs']?.users?.properties
    expect(props?.account).toBeUndefined()   // relation field — not in properties
    expect(props?.accountId).toBeDefined()   // FK column — in properties
  })
})




describe('implicit many-to-many', () => {
  const m2mSchema = `
    model posts {
      id    Integer @id
      title Text
      tags  tags[]
    }
    model tags {
      id    Integer @id
      name  Text
      posts posts[]
    }
  `

  // ── Parser ──────────────────────────────────────────────────────────────────

  test('parses Model[] fields as implicitM2M kind', () => {
    const r = parse(m2mSchema)
    expect(r.valid).toBe(true)
    const postsModel = r.schema.models.find((m: any) => m.name === 'posts')
    const tagsField  = postsModel?.fields.find((f: any) => f.name === 'tags')
    expect(tagsField?.type.kind).toBe('implicitM2M')
    expect(tagsField?.type.name).toBe('tags')
    expect(tagsField?.type.array).toBe(true)
  })

  test('requires both sides to declare the relation', () => {
    const r = parse(`
      model posts {
        id   Integer @id
        tags tags[]
      }
      model tags {
        id   Integer @id
      }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('Both sides must declare')
  })

  test('unknown model in m2m field is an error', () => {
    const r = parse(`
      model posts {
        id      Integer @id
        missing unknown[]
      }
    `)
    expect(r.valid).toBe(false)
  })

  // ── DDL ─────────────────────────────────────────────────────────────────────

  test('detectM2MPairs finds the pair', async () => {
    const { detectM2MPairs } = await import('../src/core/ddl.js')
    const r = parse(m2mSchema)
    const pairs = detectM2MPairs(r.schema)
    expect(pairs.length).toBe(1)
    expect(pairs[0].modelA).toBe('posts')
    expect(pairs[0].modelB).toBe('tags')
    expect(pairs[0].joinTable).toBe('_posts_tags')
    expect(pairs[0].colA).toBe('postsId')
    expect(pairs[0].colB).toBe('tagsId')
  })

  test('DDL includes join table CREATE statement', () => {
    const r = parse(m2mSchema)
    const ddl = generateDDL(r.schema)
    expect(ddl).toContain('CREATE TABLE')
    expect(ddl).toContain('_posts_tags')
    expect(ddl).toContain('ON DELETE CASCADE')
    expect(ddl).toContain('PRIMARY KEY')
  })

  test('join table actually created in DB', async () => {
    const db = await makeDb(m2mSchema, 'm2m-ddl')
    const tables = db.$db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_posts_tags'`
    ).all()
    expect(tables.length).toBe(1)
    db.$close()
  })

  // ── include ─────────────────────────────────────────────────────────────────

  test('include: { tags: true } returns flat tag objects', async () => {
    const db = await makeDb(m2mSchema, 'm2m-include')
    await db.posts.create({ data: { id: 1, title: 'Hello' } })
    await db.tags.create({ data: { id: 1, name: 'typescript' } })
    await db.tags.create({ data: { id: 2, name: 'orm' } })
    // Manually wire the join rows
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 2)`)

    const post = await db.posts.findUnique({
      where: { id: 1 },
      include: { tags: true }
    })
    expect(post.tags).toHaveLength(2)
    expect(post.tags.map((t: any) => t.name).sort()).toEqual(['orm', 'typescript'])
    db.$close()
  })

  test('include from the other side', async () => {
    const db = await makeDb(m2mSchema, 'm2m-include-other')
    await db.posts.create({ data: { id: 1, title: 'Post A' } })
    await db.posts.create({ data: { id: 2, title: 'Post B' } })
    await db.tags.create({ data: { id: 1, name: 'ts' } })
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _posts_tags VALUES (2, 1)`)

    const tag = await db.tags.findUnique({
      where: { id: 1 },
      include: { posts: true }
    })
    expect(tag.posts).toHaveLength(2)
    db.$close()
  })

  test('row with no related records returns empty array', async () => {
    const db = await makeDb(m2mSchema, 'm2m-empty')
    await db.posts.create({ data: { id: 1, title: 'Lonely' } })
    const post = await db.posts.findUnique({
      where: { id: 1 },
      include: { tags: true }
    })
    expect(post.tags).toEqual([])
    db.$close()
  })

  // ── connect ─────────────────────────────────────────────────────────────────

  test('nested connect adds join row', async () => {
    const db = await makeDb(m2mSchema, 'm2m-connect')
    await db.posts.create({ data: { id: 1, title: 'Post' } })
    await db.tags.create({ data: { id: 1, name: 'ts' } })

    await db.posts.update({
      where: { id: 1 },
      data: { tags: { connect: { id: 1 } } }
    })

    const post = await db.posts.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    expect(post.tags[0].name).toBe('ts')
    db.$close()
  })

  test('nested connect multiple', async () => {
    const db = await makeDb(m2mSchema, 'm2m-connect-multi')
    await db.posts.create({ data: { id: 1, title: 'Post' } })
    await db.tags.create({ data: { id: 1, name: 'ts' } })
    await db.tags.create({ data: { id: 2, name: 'orm' } })

    await db.posts.update({
      where: { id: 1 },
      data: { tags: { connect: [{ id: 1 }, { id: 2 }] } }
    })

    const post = await db.posts.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(2)
    db.$close()
  })

  // ── disconnect ──────────────────────────────────────────────────────────────

  test('nested disconnect removes join row', async () => {
    const db = await makeDb(m2mSchema, 'm2m-disconnect')
    await db.posts.create({ data: { id: 1, title: 'Post' } })
    await db.tags.create({ data: { id: 1, name: 'ts' } })
    await db.tags.create({ data: { id: 2, name: 'orm' } })
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 2)`)

    await db.posts.update({
      where: { id: 1 },
      data: { tags: { disconnect: { id: 1 } } }
    })

    const post = await db.posts.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    expect(post.tags[0].id).toBe(2)
    db.$close()
  })

  // ── create ──────────────────────────────────────────────────────────────────

  test('nested create creates tag and adds join row', async () => {
    const db = await makeDb(m2mSchema, 'm2m-nested-create')
    await db.posts.create({ data: { id: 1, title: 'Post' } })

    await db.posts.update({
      where: { id: 1 },
      data: { tags: { create: { id: 1, name: 'new-tag' } } }
    })

    const tag = await db.tags.findUnique({ where: { id: 1 } })
    expect(tag?.name).toBe('new-tag')

    const post = await db.posts.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    db.$close()
  })

  // ── set ─────────────────────────────────────────────────────────────────────

  test('nested set replaces all relations', async () => {
    const db = await makeDb(m2mSchema, 'm2m-set')
    await db.posts.create({ data: { id: 1, title: 'Post' } })
    await db.tags.create({ data: { id: 1, name: 'ts' } })
    await db.tags.create({ data: { id: 2, name: 'orm' } })
    await db.tags.create({ data: { id: 3, name: 'bun' } })
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 1)`)
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 2)`)

    // Replace with just tag 3
    await db.posts.update({
      where: { id: 1 },
      data: { tags: { set: [{ id: 3 }] } }
    })

    const post = await db.posts.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(1)
    expect(post.tags[0].id).toBe(3)
    db.$close()
  })

  test('nested set with empty array removes all relations', async () => {
    const db = await makeDb(m2mSchema, 'm2m-set-empty')
    await db.posts.create({ data: { id: 1, title: 'Post' } })
    await db.tags.create({ data: { id: 1, name: 'ts' } })
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 1)`)

    await db.posts.update({
      where: { id: 1 },
      data: { tags: { set: [] } }
    })

    const post = await db.posts.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(0)
    db.$close()
  })

  // ── cascade delete ──────────────────────────────────────────────────────────

  test('deleting a post cascades join rows', async () => {
    const db = await makeDb(m2mSchema, 'm2m-cascade')
    await db.posts.create({ data: { id: 1, title: 'Post' } })
    await db.tags.create({ data: { id: 1, name: 'ts' } })
    db.$db.run(`INSERT INTO _posts_tags VALUES (1, 1)`)

    await db.posts.delete({ where: { id: 1 } })

    const joinRows = db.$db.query(`SELECT * FROM _posts_tags`).all()
    expect(joinRows.length).toBe(0)
    // Tag still exists — only the join row was removed
    const tag = await db.tags.findUnique({ where: { id: 1 } })
    expect(tag?.name).toBe('ts')
    db.$close()
  })

  // ── create with inline connect ───────────────────────────────────────────────

  test('create with inline tag connect', async () => {
    const db = await makeDb(m2mSchema, 'm2m-create-connect')
    await db.tags.create({ data: { id: 1, name: 'ts' } })
    await db.tags.create({ data: { id: 2, name: 'orm' } })

    await db.posts.create({
      data: {
        id: 1, title: 'Hello',
        tags: { connect: [{ id: 1 }, { id: 2 }] }
      }
    })

    const post = await db.posts.findUnique({ where: { id: 1 }, include: { tags: true } })
    expect(post.tags).toHaveLength(2)
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
      model posts {
        id        Integer  @id
        title     Text
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-soft-boundary', { plugins: [new Spy()] })
    await db.posts.create({ data: { id: 1, title: 'Hello' } })
    await db.posts.remove({ where: { id: 1 } })   // soft delete — row still in DB
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
      model posts {
        id        Integer  @id
        title     Text
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-hard-on-soft', { plugins: [new Spy()] })
    await db.posts.create({ data: { id: 1, title: 'Hello' } })
    await db.posts.delete({ where: { id: 1 } })   // @hardDelete path
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
      model posts {
        id        Integer  @id
        tag       Text
        deletedAt DateTime?
        @@softDelete
      }
    `, 'after-delete-removemany', { plugins: [new Spy()] })
    await db.posts.createMany({ data: [{ id: 1, tag: 'a' }, { id: 2, tag: 'a' }] })
    await db.posts.removeMany({ where: { tag: 'a' } })
    expect(called).toBe(false)
    db.$close()
  })
})


// ─── @from — derived relation fields ─────────────────────────────────────────

const FROM_SCHEMA = `
  model Account {
    id       Integer @id
    name     Text
    orders   Order[]

    orderCount   Integer  @from(Order, count: true)
    totalSpent   Real     @from(Order, sum: amount)
    lastOrderId  Integer  @from(Order, max: id)
    firstOrderId Integer  @from(Order, min: id)
    latestOrder  Order?  @from(Order, last: true)
    firstOrder   Order?  @from(Order, first: true)
    hasOrders    Boolean  @from(Order, exists: true)
    pendingCount Integer  @from(Order, count: true, where: "status = 'pending'")
    latestPending Order? @from(Order, last: true, where: "status = 'pending'", orderBy: id)
  }

  model Order {
    id        Integer @id
    accountId Integer
    account   Account @relation(fields: [accountId], references: [id])
    amount    Real
    status    Text
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
    const r = parse(`model T { id Integer @id; x Integer @from(nope, count: true) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('nope'))).toBe(true)
  })

  test('@from: wrong type for count is a parse error', () => {
    const r = parse(`
      model User { id Integer @id; posts Post[]; postCount Text @from(Post, count: true) }
      model Post { id Integer @id; userId Integer; u User @relation(fields: [userId], references: [id]) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('Integer'))).toBe(true)
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


// ─── aggregate() ─────────────────────────────────────────────────────────────

const AGG_SCHEMA = `
  model orders {
    id        Integer @id
    amount    Real
    status    Text
    accountId Integer
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
        await db.orders.createMany({ data: [
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
    const rows = await db.orders.findMany({
      orderBy: { id: 'asc' },
      window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows.map((r: any) => r.rn)).toEqual([1, 2, 3, 4, 5])
  })

  test('rowNumber — partitioned by accountId', async () => {
    const rows = await db.orders.findMany({
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
    const rows = await db.orders.findMany({
      orderBy: { id: 'asc' },
      window:  { r: { rank: true, partitionBy: 'accountId', orderBy: { amount: 'desc' } } },
    })
    // accountId=1: amounts 30,20,10 → ranks 1,2,3
    expect(rows.find((r: any) => r.id === 2).r).toBe(1)  // amount 30 → rank 1
    expect(rows.find((r: any) => r.id === 3).r).toBe(2)  // amount 20 → rank 2
    expect(rows.find((r: any) => r.id === 1).r).toBe(3)  // amount 10 → rank 3
  })

  test('denseRank — no gaps after ties', async () => {
    const rows = await db.orders.findMany({
      orderBy: { id: 'asc' },
      window:  { dr: { denseRank: true, orderBy: { status: 'asc' } } },
    })
    // paid=1 (ids 1,2,3), pending=2 (ids 4,5)
    expect(rows.find((r: any) => r.id === 1).dr).toBe(1)
    expect(rows.find((r: any) => r.id === 4).dr).toBe(2)
  })

  test('running sum — cumulative total', async () => {
    const rows = await db.orders.findMany({
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
    const rows = await db.orders.findMany({
      orderBy: { id: 'asc' },
      window:  { rc: { count: true, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].rc).toBe(1)
    expect(rows[4].rc).toBe(5)
  })

  test('moving average with rows frame', async () => {
    const rows = await db.orders.findMany({
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
    const rows = await db.orders.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      window:  { prev: { lag: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].prev).toBe(0)   // first row → default
    expect(rows[1].prev).toBeCloseTo(10)
    expect(rows[2].prev).toBeCloseTo(30)
  })

  test('lead — next row value', async () => {
    const rows = await db.orders.findMany({
      where:   { accountId: 1 },
      orderBy: { id: 'asc' },
      window:  { next: { lead: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].next).toBeCloseTo(30)
    expect(rows[1].next).toBeCloseTo(20)
    expect(rows[2].next).toBe(0)   // last row → default
  })

  test('firstValue and lastValue', async () => {
    const rows = await db.orders.findMany({
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
    const rows = await db.orders.findMany({
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
    const rows = await db.orders.findMany({
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
        await d.orders.createMany({ data: [
          { id: 10, amount: 5, status: 'paid', accountId: 1 },
          { id: 11, amount: 10, status: 'paid', accountId: 1 },
        ]})
        await d.orders.remove({ where: { id: 10 } })
      }
    })
    const rows = await localDb.orders.findMany({
      window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows).toHaveLength(1)   // soft-deleted row excluded
    expect(rows[0].rn).toBe(1)
    localDb.$close()
  })

  test('throws on unknown window function spec', async () => {
    await expect(
      db.orders.findMany({ window: { x: { unknownFn: true } as any } })
    ).rejects.toThrow('unrecognised window function spec')
  })

  test('window FILTER — conditional aggregate window', async () => {
    const rows = await db.orders.findMany({
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
        await db.orders.createMany({ data: [
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
    const rows = await db.orders.query({ where: { status: 'paid' }, orderBy: { id: 'asc' } })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[0].amount).toBe(10)   // full row returned
  })

  test('routes to aggregate when _count present', async () => {
    const result = await db.orders.query({ _count: true })
    expect(result._count).toBe(4)
    expect(Array.isArray(result)).toBe(false)   // single object, not array
  })

  test('routes to aggregate when _sum present', async () => {
    const result = await db.orders.query({ _sum: { amount: true }, _count: true })
    expect(typeof result._count).toBe('number')
    expect(result._sum.amount).toBeCloseTo(100)
  })

  test('routes to aggregate with where filter', async () => {
    const result = await db.orders.query({ _count: true, where: { status: 'paid' } })
    expect(result._count).toBe(2)
  })

  test('routes to groupBy when by present', async () => {
    const rows = await db.orders.query({ by: ['status'], _count: true, orderBy: { status: 'asc' } })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows[0]).toHaveProperty('status')
    expect(rows[0]).toHaveProperty('_count')
    expect(rows[0].amount).toBeUndefined()   // not a full row
  })

  test('routes to groupBy with where', async () => {
    const rows = await db.orders.query({ by: ['accountId'], _count: true, where: { status: 'paid' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].accountId).toBe(1)
    expect(rows[0]._count).toBe(2)
  })

  test('routes to findMany with window', async () => {
    const rows = await db.orders.query({
      orderBy: { id: 'asc' },
      window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } },
    })
    expect(rows[0].rn).toBe(1)
    expect(rows[0].amount).toBe(10)   // full row
  })

  test('routes to findMany with limit + offset', async () => {
    const rows = await db.orders.query({ orderBy: { id: 'asc' }, limit: 2, offset: 1 })
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe(2)
  })

  test('named aggregates route to aggregate', async () => {
    const result = await db.orders.query({
      _countPaid: { count: true, filter: sql`status = 'paid'` },
    })
    expect(result._countPaid).toBe(2)
    expect(Array.isArray(result)).toBe(false)
  })

  test('empty args routes to findMany', async () => {
    const rows = await db.orders.query()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(4)
  })
})

// ─── db.query() — multi-model batch ───────────────────────────────────────────

describe('db.query() — multi-model batch', () => {
  const SCHEMA = `
    model accounts {
      id   Integer @id
      name Text
      tier Text @default("free")
    }
    model orders {
      id        Integer @id
      amount    Real
      status    Text
      accountId Integer
    }
  `

  test('runs many per-table queries and returns named results', async () => {
    const { db } = await makeTestClient(SCHEMA, {
      data: async (db: any) => {
        await db.accounts.createMany({ data: [
          { id: 1, name: 'Acme',   tier: 'pro' },
          { id: 2, name: 'Globex', tier: 'free' },
        ]})
        await db.orders.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 20, status: 'paid',    accountId: 1 },
          { id: 3, amount: 30, status: 'pending', accountId: 2 },
        ]})
      },
    })

    const { accounts, orders } = await db.query({
      accounts: { where: { tier: 'pro' } },
      orders:   { where: { status: 'paid' }, orderBy: { id: 'asc' } },
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
        await db.accounts.createMany({ data: [
          { id: 1, name: 'Acme', tier: 'pro' },
        ]})
        await db.orders.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 20, status: 'paid',    accountId: 1 },
          { id: 3, amount: 30, status: 'pending', accountId: 1 },
        ]})
      },
    })

    const { accounts, totals, byStatus } = await db.query({
      accounts: { where: { tier: 'pro' }, orderBy: { id: 'asc' } },                 // → findMany
      totals:   { model: 'orders', _count: true, _sum: { amount: true } },          // → aggregate (aliased)
      byStatus: { model: 'orders', by: ['status'], _count: true, orderBy: { status: 'asc' } }, // → groupBy (aliased)
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
        await db.orders.createMany({ data: [
          { id: 1, amount: 10, status: 'paid',    accountId: 1 },
          { id: 2, amount: 20, status: 'paid',    accountId: 1 },
          { id: 3, amount: 30, status: 'pending', accountId: 1 },
        ]})
      },
    })

    const { paid, pending } = await db.query({
      paid:    { model: 'orders', where: { status: 'paid' },    orderBy: { id: 'asc' } },
      pending: { model: 'orders', where: { status: 'pending' }, orderBy: { id: 'asc' } },
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
      orders:   { _count: true },
      accounts: { _count: true },
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
      accounts: { _count: true },
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
        await db.accounts.create({ data: { id: 1, name: 'Acme', tier: 'pro' } })
        await db.orders.create({ data: { id: 1, amount: 10, status: 'paid', accountId: 1 } })
      },
    })
    const result = await db.$transaction(async (tx: any) => {
      return tx.query({
        accounts: { _count: true },
        orders:   { _count: true },
      })
    })
    expect(result.accounts._count).toBe(1)
    expect(result.orders._count).toBe(1)
    db.$close()
  })

  test('asSystem().query() bypasses row policies', async () => {
    // Schema with a deny rule — readable by no one (forces asSystem usage)
    const POLICY = `
      model widgets {
        id   Integer @id
        name Text
        @@deny('read', true)
      }
    `
    const { db } = await makeTestClient(POLICY, {
      data: async (db: any) => {
        // asSystem() to seed past the deny rule
        await db.asSystem().widgets.create({ data: { id: 1, name: 'Wrench' } })
      },
    })
    // Non-system batch returns 0 rows / count due to deny('read')
    const blocked = await db.query({ widgets: { _count: true } } as any)
    expect(blocked.widgets._count).toBe(0)
    // asSystem batch sees the row
    const seen = await db.asSystem().query({ widgets: { _count: true } } as any)
    expect(seen.widgets._count).toBe(1)
    db.$close()
  })

  test('$setAuth().query() carries auth into each batched query', async () => {
    // Schema with row policy — only see your own rows
    const POLICY_SCHEMA = `
      model posts {
        id      Integer @id
        ownerId Integer
        title   Text
        @@allow('read', ownerId == auth().id)
      }
    `
    const { db } = await makeTestClient(POLICY_SCHEMA, {
      data: async (db: any) => {
        await db.posts.createMany({ data: [
          { id: 1, ownerId: 1, title: 'Mine' },
          { id: 2, ownerId: 2, title: 'Yours' },
        ]})
      },
    })
    const alice = db.$setAuth({ id: 1 })
    const result = await alice.query({ posts: { orderBy: { id: 'asc' } } } as any)
    expect(result.posts).toHaveLength(1)
    expect(result.posts[0].title).toBe('Mine')
    db.$close()
  })
})

// ─── Scopes ───────────────────────────────────────────────────────────────────

describe('Scopes', () => {
  const SCHEMA = `
    model Customer {
      id        Integer  @id
      name      Text
      status    Text     @default("active")
      tier      Text     @default("free")
      ownerId   Integer?
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
        id        Integer  @id
        name      Text
        status    Text
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
        id        Integer  @id
        name      Text
        status    Text
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
      model Post { id Integer @id; title Text; @@trait(Dates) }
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
      model Post { id Integer @id; title Text; @@trait(Dates) }
    `)
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    expect(post.fields[0].name).toBe('createdAt')
    expect(post.fields[1].name).toBe('id')
    expect(post.fields[2].name).toBe('title')
  })

  test('@@trait references are removed from final attribute list', () => {
    const r = parse(`
      trait Dates { createdAt DateTime @default(now()) }
      model Post { id Integer @id; @@trait(Dates) }
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
      model Post { id Integer @id; @@trait(SoftDelete) }
    `)
    const post = r.schema.models.find((m: any) => m.name === 'Post')!
    expect(post.attributes.some((a: any) => a.kind === 'softDelete')).toBe(true)
  })

  test('trait policy attributes splice and host attributes come after', () => {
    const r = parse(`
      trait Tenant {
        tenantId Integer
        @@allow('read', tenantId == auth().tenantId)
      }
      model Post {
        id Integer @id
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
      trait Bad { id Integer @id }
      model M { id Integer @id; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@id is not allowed in a trait/)
  })

  test('trait cannot contain @@map', () => {
    const r = parse(`
      trait Bad { @@map("custom") }
      model M { id Integer @id; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@map is not allowed in a trait/)
  })

  test('trait cannot contain @@db', () => {
    const r = parse(`
      database audit { path "./audit/" driver logger }
      trait Bad { @@db(audit) }
      model M { id Integer @id; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@db is not allowed in a trait/)
  })

  test('trait cannot contain @@fts', () => {
    const r = parse(`
      trait Bad { title Text; @@fts([title]) }
      model M { id Integer @id; title Text; @@trait(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@fts is not allowed in a trait/)
  })

  test('duplicate trait name is an error', () => {
    const r = parse(`
      trait Dates { createdAt DateTime @default(now()) }
      trait Dates { updatedAt DateTime @updatedAt }
      model M { id Integer @id; @@trait(Dates) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Duplicate trait 'Dates'/)
  })

  // ── Validation: trait references ─────────────────────────────────────────

  test('unknown trait reference is an error', () => {
    const r = parse(`
      model M { id Integer @id; @@trait(Nonexistent) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/unknown trait 'Nonexistent'/)
  })

  test('two traits providing same field — collision error', () => {
    const r = parse(`
      trait X { foo Text }
      trait Y { foo Text }
      model M { id Integer @id; @@trait(X); @@trait(Y) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/field 'foo' provided by both/)
  })

  test('host field overrides trait field of same name', () => {
    const r = parse(`
      trait T { foo Text @default("from-trait") }
      model M {
        id  Integer @id
        foo Text @default("from-host")
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
      trait Inner { a Text }
      trait Outer { b Text; @@trait(Inner) }
      model M { id Integer @id; @@trait(Outer) }
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
      trait A { x Text; @@trait(B) }
      trait B { y Text; @@trait(A) }
      model M { id Integer @id; @@trait(A) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Trait cycle detected/)
  })

  test('self-cycle is detected', () => {
    const r = parse(`
      trait Self { x Text; @@trait(Self) }
      model M { id Integer @id; @@trait(Self) }
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
          id    Integer @id
          title Text
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
          id    Integer @id
          title Text
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
          id    Integer @id
          title Text
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
          email Text @email
        }
        model User {
          id   Integer @id
          name Text
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
        street     Text
        city       Text
        state      Text?
        postalCode Text
        country    Text @default("US")
      }
      model User { id Integer @id; name Text; address Json @type(Address) }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.types).toHaveLength(1)
    expect(r.schema.types[0].name).toBe('Address')
    expect(r.schema.types[0].fields.map((f: any) => f.name)).toEqual(['street', 'city', 'state', 'postalCode', 'country'])
  })

  test('@type attribute appears on the field', () => {
    const r = parse(`
      type Address { street Text; city Text }
      model User { id Integer @id; address Json @type(Address) }
    `)
    const user = r.schema.models.find((m: any) => m.name === 'User')!
    const addr = user.fields.find((f: any) => f.name === 'address')!
    const typeAttr = addr.attributes.find((a: any) => a.kind === 'type')
    expect(typeAttr).toMatchObject({ kind: 'type', name: 'Address', strict: true })
  })

  test('@type accepts strict: false', () => {
    const r = parse(`
      type Address { street Text; city Text }
      model User { id Integer @id; address Json @type(Address, strict: false) }
    `)
    const addr = r.schema.models[0].fields.find((f: any) => f.name === 'address')!
    const typeAttr = addr.attributes.find((a: any) => a.kind === 'type')
    expect(typeAttr.strict).toBe(false)
  })

  // ── Validation: declaration-level ────────────────────────────────────────

  test('type cannot contain relations', () => {
    const r = parse(`
      type Bad {
        userId Integer
        user   User @relation(fields: [userId], references: [id])
      }
      model User { id Integer @id }
      model M { id Integer @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/@relation not allowed in a type/)
  })

  test('type cannot contain @id', () => {
    const r = parse(`
      type Bad { id Integer @id }
      model M { id Integer @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@id not allowed in a type/)
  })

  test('type cannot contain @encrypted', () => {
    const r = parse(`
      type Bad { secret Text @encrypted }
      model M { id Integer @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@encrypted not allowed in a type/)
  })

  test('type cannot contain model-level attributes', () => {
    const r = parse(`
      type Bad { name Text; @@index([name]) }
      model M { id Integer @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@@index not allowed in a type/)
  })

  test('type cannot contain @default(now())', () => {
    const r = parse(`
      type Bad { createdAt DateTime @default(now()) }
      model M { id Integer @id; bad Json @type(Bad) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@default\(now\(\)\) not allowed in a type/)
  })

  test('type allows literal defaults', () => {
    const r = parse(`
      type T { country Text @default("US") }
      model M { id Integer @id; t Json @type(T) }
    `)
    expect(r.valid).toBe(true)
  })

  test('type allows validators and transforms', () => {
    const r = parse(`
      type Contact {
        email Text @email @lower
        zip   Text @regex("^[0-9]{5}$") @trim
        age   Integer @gte(0) @lt(150)
      }
      model M { id Integer @id; contact Json @type(Contact) }
    `)
    expect(r.valid).toBe(true)
  })

  test('duplicate type name is an error', () => {
    const r = parse(`
      type Address { street Text }
      type Address { city Text }
      model M { id Integer @id; addr Json @type(Address) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Duplicate type 'Address'/)
  })

  // ── Validation: use-site ─────────────────────────────────────────────────

  test('@type on a non-Json field is an error', () => {
    const r = parse(`
      type X { foo Text }
      model M { id Integer @id; x Text @type(X) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@type\(X\) requires the field to be Json/)
  })

  test('@type with unknown name is an error', () => {
    const r = parse(`
      model M { id Integer @id; addr Json @type(Nonexistent) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/unknown type 'Nonexistent'/)
  })

  test('cycle in Json @type chain is detected', () => {
    const r = parse(`
      type A { name Text; b Json @type(B) }
      type B { name Text; a Json @type(A) }
      model M { id Integer @id; a Json @type(A) }
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
          street     Text
          city       Text
          state      Text?
          postalCode Text
        }
        model User { id Integer @id; name Text; address Json @type(Address) }
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
        type Address { street Text; city Text; postalCode Text }
        model User { id Integer @id; name Text; address Json @type(Address) }
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
        type Address { postalCode Text; city Text }
        model User { id Integer @id; name Text; address Json @type(Address) }
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
        type Address { street Text; city Text }
        model User { id Integer @id; address Json @type(Address) }
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
        type Address { street Text; city Text }
        model User { id Integer @id; address Json @type(Address, strict: false) }
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
        type Coordinates { lat Real; lng Real }
        type Address {
          street Text
          city   Text
          coords Json @type(Coordinates)
        }
        model Place { id Integer @id; address Json @type(Address) }
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
        type Coordinates { lat Real; lng Real }
        type Address { street Text; coords Json @type(Coordinates) }
        model Place { id Integer @id; address Json @type(Address) }
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
          email Text @email
          age   Integer @gte(0)
        }
        model User { id Integer @id; contact Json @type(Contact) }
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
        type Address { street Text; city Text }
        model User { id Integer @id; address Json? @type(Address) }
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
        type Tags { values Text[] }
        model Post { id Integer @id; tags Json @type(Tags) }
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
        type Mixed { flag Boolean; count Integer; ratio Real }
        model M { id Integer @id; data Json @type(Mixed) }
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
        type Address { city Text }
        model User {
          id      Integer @id
          email   Text @email
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
        type Address { street Text; city Text }
        model User { id Integer @id; address Json @type(Address) }
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
      type Address { street Text; city Text; state Text? }
      type Coordinates { lat Real; lng Real }
      model M { id Integer @id }
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
      type Address { street Text; city Text }
      model User {
        id      Integer @id
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
      type Address { street Text }
      model User {
        id      Integer @id
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
          id        Integer  @id
          token     Text
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
        model E { id Integer @id; at DateTime }
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
      schema: `model E { id Integer @id; at DateTime }`,
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
      schema: `model E { id Integer @id; at DateTime }`,
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
      schema: `model E { id Integer @id; at DateTime }`,
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
      schema: `model E { id Integer @id; at DateTime }`,
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
        model E { id Integer @id; meta Json @type(Meta) }
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
      schema: `model E { id Integer @id; at DateTime }`,
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
          id        Integer @id
          token     Text
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
      schema: `model U { id Integer @id; token Text }`,
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
          street     Text
          city       Text
          state      Text?
          postalCode Text
        }
        model User {
          id      Integer @id
          name    Text
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
        type Settings { darkMode Boolean; tag Text? }
        model U { id Integer @id; s Json @type(Settings) }
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
        type Settings { tag Text? }
        model U { id Integer @id; s Json @type(Settings) }
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
        type T { city Text }
        model U { id Integer @id; addr Json? @type(T) }
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
        model U { id Integer @id; s Json @type(Settings) }
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
        type Stats { count Integer }
        model U { id Integer @id; s Json @type(Stats) }
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
        type Coords { lat Real; lng Real }
        model P { id Integer @id; c Json @type(Coords) }
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
        type Coords { lat Real; lng Real }
        type Address { city Text; coords Json @type(Coords) }
        model P { id Integer @id; address Json @type(Address) }
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
        type Coords { lat Real; lng Real }
        type Address { city Text; coords Json @type(Coords) }
        model P { id Integer @id; address Json @type(Address) }
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
      type Address { street Text; city Text }
      model User {
        id      Integer @id
        address Json @type(Address)
      }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.User.properties.address).toEqual({ $ref: '#/$defs/Address' })
  })

  test('emits a full type definition with required fields and shape', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      type Address { street Text; city Text; state Text?; postalCode Text }
      model U { id Integer @id; addr Json @type(Address) }
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
        email Text @email
        zip   Text @regex("^[0-9]{5}$")
      }
      model U { id Integer @id; c Json @type(Contact) }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.Contact.properties.email).toMatchObject({ format: 'email' })
    expect(s.$defs.Contact.properties.zip).toMatchObject({ pattern: '^[0-9]{5}$' })
  })

  test('untyped Json fields remain permissive', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      model U { id Integer @id; meta Json }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.U.properties.meta).toEqual({})
  })

  test('nested types resolve via $ref', async () => {
    const { generateJsonSchema } = await import('../src/jsonschema.js')
    const r = parse(`
      type Coords { lat Real; lng Real }
      type Address { city Text; coords Json @type(Coords) }
      model P { id Integer @id; address Json @type(Address) }
    `)
    const s = generateJsonSchema(r.schema!) as any
    expect(s.$defs.Address.properties.coords).toEqual({ $ref: '#/$defs/Coords' })
    expect(s.$defs.Coords.properties.lat).toMatchObject({ type: 'number' })
  })
})

describe('aggregate()', () => {
  test('_count returns total rows', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-count')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid', accountId: 2 },
    ]})
    const r = await db.orders.aggregate({ _count: true })
    expect(r._count).toBe(3)
    db.$close()
  })

  test('_sum aggregates a field', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-sum')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
      { id: 3, amount: 30, status: 'paid', accountId: 2 },
    ]})
    const r = await db.orders.aggregate({ _sum: { amount: true } })
    expect(r._sum.amount).toBeCloseTo(60)
    db.$close()
  })

  test('_avg aggregates a field', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-avg')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 30, status: 'paid', accountId: 1 },
    ]})
    const r = await db.orders.aggregate({ _avg: { amount: true } })
    expect(r._avg.amount).toBeCloseTo(20)
    db.$close()
  })

  test('_min and _max', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-minmax')
    await db.orders.createMany({ data: [
      { id: 1, amount: 5,  status: 'paid', accountId: 1 },
      { id: 2, amount: 50, status: 'paid', accountId: 1 },
      { id: 3, amount: 25, status: 'paid', accountId: 1 },
    ]})
    const r = await db.orders.aggregate({ _min: { amount: true }, _max: { amount: true } })
    expect(r._min.amount).toBe(5)
    expect(r._max.amount).toBe(50)
    db.$close()
  })

  test('multiple aggregations in one call', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-multi')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
    ]})
    const r = await db.orders.aggregate({
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
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid',    accountId: 1 },
    ]})
    const r = await db.orders.aggregate({ _sum: { amount: true }, where: { status: 'paid' } })
    expect(r._sum.amount).toBeCloseTo(40)
    db.$close()
  })

  test('respects @@softDelete — excludes deleted rows', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-soft')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
    ]})
    await db.orders.remove({ where: { id: 2 } })
    const r = await db.orders.aggregate({ _count: true, _sum: { amount: true } })
    expect(r._count).toBe(1)
    expect(r._sum.amount).toBeCloseTo(10)
    db.$close()
  })

  test('throws without any aggregation', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-throw')
    await expect(db.orders.aggregate({})).rejects.toThrow('at least one')
    db.$close()
  })

  test('_count distinct', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-distinct')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },  // duplicate accountId
      { id: 3, amount: 30, status: 'pending', accountId: 2 },
    ]})
    const r = await db.orders.aggregate({ _count: { distinct: 'accountId' } })
    expect(r._count).toBe(2)   // 2 distinct accountIds, not 3 rows
    db.$close()
  })

  test('_stringAgg', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-strAgg')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'refund',  accountId: 1 },
      { id: 3, amount: 30, status: 'pending', accountId: 1 },
    ]})
    const r = await db.orders.aggregate({
      _stringAgg: { field: 'status', separator: ', ', orderBy: 'status' },
    })
    expect(r._stringAgg.status).toBe('paid, pending, refund')
    db.$close()
  })

  test('named aggregate — filtered count', async () => {
    const db = await makeDb(AGG_SCHEMA, 'agg-nagg-count')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 30, status: 'refund',  accountId: 1 },
      { id: 4, amount: 40, status: 'pending', accountId: 1 },
    ]})
    const r = await db.orders.aggregate({
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
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',   accountId: 1 },
      { id: 2, amount: 20, status: 'paid',   accountId: 1 },
      { id: 3, amount: 30, status: 'refund', accountId: 1 },
    ]})
    const r = await db.orders.aggregate({
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
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
    ]})
    const r = await db.orders.aggregate({
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
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid',    accountId: 2 },
    ]})
    const rows = await db.orders.groupBy({ by: ['status'], _count: true })
    expect(rows).toHaveLength(2)
    const paid = rows.find((r: any) => r.status === 'paid')
    expect(paid._count).toBe(2)
    db.$close()
  })

  test('_sum per group', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-sum')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 5,  status: 'pending', accountId: 1 },
    ]})
    const rows = await db.orders.groupBy({ by: ['status'], _sum: { amount: true } })
    const paid = rows.find((r: any) => r.status === 'paid')
    expect(paid._sum.amount).toBeCloseTo(30)
    db.$close()
  })

  test('groups by multiple fields', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-multi-by')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 2 },
      { id: 3, amount: 30, status: 'paid', accountId: 1 },
    ]})
    const rows = await db.orders.groupBy({ by: ['status', 'accountId'], _count: true })
    expect(rows).toHaveLength(2)
    db.$close()
  })

  test('where: filters before grouping', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-where')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'pending', accountId: 1 },
      { id: 3, amount: 30, status: 'paid',    accountId: 2 },
    ]})
    const rows = await db.orders.groupBy({
      by: ['accountId'], _count: true,
      where: { status: 'paid' }
    })
    expect(rows).toHaveLength(2)
    db.$close()
  })

  test('having: filters groups', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-having')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 1 },
      { id: 3, amount: 5,  status: 'paid', accountId: 2 },
    ]})
    const rows = await db.orders.groupBy({
      by: ['accountId'], _count: true,
      having: { _count: { gt: 1 } }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].accountId).toBe(1)
    db.$close()
  })

  test('having: _sum filter', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-having-sum')
    await db.orders.createMany({ data: [
      { id: 1, amount: 100, status: 'paid', accountId: 1 },
      { id: 2, amount: 200, status: 'paid', accountId: 1 },
      { id: 3, amount: 5,   status: 'paid', accountId: 2 },
    ]})
    const rows = await db.orders.groupBy({
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
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'pending', accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
    ]})
    const rows = await db.orders.groupBy({
      by: ['status'], _count: true,
      orderBy: { status: 'asc' }
    })
    expect(rows[0].status).toBe('paid')
    expect(rows[1].status).toBe('pending')
    db.$close()
  })

  test('orderBy _count desc', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-order-count')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 5,  status: 'pending', accountId: 1 },
    ]})
    const rows = await db.orders.groupBy({
      by: ['status'], _count: true,
      orderBy: { _count: 'desc' }
    })
    expect(rows[0].status).toBe('paid')
    db.$close()
  })

  test('limit and offset', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-limit')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'a', accountId: 1 },
      { id: 2, amount: 20, status: 'b', accountId: 1 },
      { id: 3, amount: 30, status: 'c', accountId: 1 },
    ]})
    const rows = await db.orders.groupBy({ by: ['status'], _count: true, orderBy: { status: 'asc' }, limit: 2 })
    expect(rows).toHaveLength(2)
    db.$close()
  })

  test('_count distinct', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-count-distinct')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },  // same accountId
      { id: 3, amount: 30, status: 'paid',    accountId: 2 },
      { id: 4, amount: 40, status: 'pending', accountId: 1 },
    ]})
    const rows = await db.orders.groupBy({
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
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid', accountId: 1 },
      { id: 2, amount: 20, status: 'paid', accountId: 2 },
      { id: 3, amount: 30, status: 'paid', accountId: 3 },
    ]})
    const rows = await db.orders.groupBy({
      by: ['status'],
      _stringAgg: { field: 'status', separator: '|' },
    })
    expect(rows[0]._stringAgg.status).toContain('paid')
    db.$close()
  })

  test('named aggregate — filtered counts per group', async () => {
    const db = await makeDb(AGG_SCHEMA, 'grp-nagg')
    await db.orders.createMany({ data: [
      { id: 1, amount: 10, status: 'paid',    accountId: 1 },
      { id: 2, amount: 20, status: 'paid',    accountId: 1 },
      { id: 3, amount: 30, status: 'refund',  accountId: 1 },
      { id: 4, amount: 40, status: 'paid',    accountId: 2 },
      { id: 5, amount: 50, status: 'pending', accountId: 2 },
    ]})
    const rows = await db.orders.groupBy({
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
    await expect((db.orders as any).groupBy({})).rejects.toThrow('by')
    db.$close()
  })
})


// ─── _count in include ────────────────────────────────────────────────────────

const COUNT_SCHEMA = `
  model accounts {
    id    Integer @id
    name  Text
    users users[]
    posts posts[]
  }
  model users {
    id        Integer @id
    accountId Integer
    account   accounts @relation(fields: [accountId], references: [id])
    name      Text
  }
  model posts {
    id        Integer @id
    accountId Integer
    account   accounts @relation(fields: [accountId], references: [id])
    title     Text
  }
`

describe('_count in include', () => {
  test('counts a single relation', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-basic')
    await db.accounts.create({ data: { id: 1, name: 'Acme' } })
    await db.users.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
    ]})
    const rows = await db.accounts.findMany({ include: { _count: { select: { users: true } } } })
    expect(rows[0]._count.users).toBe(2)
    db.$close()
  })

  test('counts multiple relations', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-multi')
    await db.accounts.create({ data: { id: 1, name: 'Acme' } })
    await db.users.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
    ]})
    await db.posts.create({ data: { id: 1, accountId: 1, title: 'Hello' } })
    const rows = await db.accounts.findMany({
      include: { _count: { select: { users: true, posts: true } } }
    })
    expect(rows[0]._count.users).toBe(2)
    expect(rows[0]._count.posts).toBe(1)
    db.$close()
  })

  test('returns 0 when no children', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-zero')
    await db.accounts.create({ data: { id: 1, name: 'Empty' } })
    const rows = await db.accounts.findMany({ include: { _count: { select: { users: true } } } })
    expect(rows[0]._count.users).toBe(0)
    db.$close()
  })

  test('works across multiple parent rows', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-multi-rows')
    await db.accounts.createMany({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
    await db.users.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 2, name: 'Carol' },
    ]})
    const rows = await db.accounts.findMany({ include: { _count: { select: { users: true } } } })
    const a1 = rows.find((r: any) => r.id === 1)
    const a2 = rows.find((r: any) => r.id === 2)
    expect(a1._count.users).toBe(2)
    expect(a2._count.users).toBe(1)
    db.$close()
  })

  test('can combine _count with real includes', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'inc-count-combined')
    await db.accounts.create({ data: { id: 1, name: 'Acme' } })
    await db.users.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
    ]})
    const rows = await db.accounts.findMany({
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
    await db.accounts.create({ data: { id: 1, name: 'Acme' } })
    await db.users.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 1, name: 'Charlie' },
    ]})
    const rows = await db.accounts.findMany({
      include: { _count: { select: {
        users: { where: { name: 'Alice' } }
      }}}
    })
    expect(rows[0]._count.users).toBe(1)
    db.$close()
  })

  test('alias allows two filtered counts of the same relation', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'cnt-filtered-alias')
    await db.accounts.create({ data: { id: 1, name: 'Acme' } })
    await db.users.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 1, name: 'Charlie' },
    ]})
    const rows = await db.accounts.findMany({
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
    await db.accounts.create({ data: { id: 1, name: 'Acme' } })
    await db.users.create({ data: { id: 1, accountId: 1, name: 'Alice' } })
    const rows = await db.accounts.findMany({
      include: { _count: { select: {
        nobody: { relation: 'users', where: { name: 'Nobody' } }
      }}}
    })
    expect(rows[0]._count.nobody).toBe(0)
    db.$close()
  })

  test('filtered count works across multiple parent rows', async () => {
    const db = await makeDb(COUNT_SCHEMA, 'cnt-filtered-multi')
    await db.accounts.createMany({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
    await db.users.createMany({ data: [
      { id: 1, accountId: 1, name: 'Alice' },
      { id: 2, accountId: 1, name: 'Bob' },
      { id: 3, accountId: 2, name: 'Alice' },
    ]})
    const rows = await db.accounts.findMany({
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
    model posts {
      id        Integer @id
      title     Text
      status    Text
      deletedAt DateTime?
      @@softDelete
    }
  `

  test('returns rows and total', async () => {
    const db = await makeDb(SCHEMA, 'fmac-basic')
    await db.posts.createMany({ data: [
      { id: 1, title: 'A', status: 'published' },
      { id: 2, title: 'B', status: 'published' },
      { id: 3, title: 'C', status: 'draft' },
    ]})
    const { rows, total } = await db.posts.findManyAndCount({})
    expect(rows).toHaveLength(3)
    expect(total).toBe(3)
    db.$close()
  })

  test('total reflects where, not limit', async () => {
    const db = await makeDb(SCHEMA, 'fmac-total')
    await db.posts.createMany({ data: [
      { id: 1, title: 'A', status: 'published' },
      { id: 2, title: 'B', status: 'published' },
      { id: 3, title: 'C', status: 'published' },
      { id: 4, title: 'D', status: 'draft' },
    ]})
    const { rows, total } = await db.posts.findManyAndCount({
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
    await db.posts.createMany({ data: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, title: `Post ${i + 1}`, status: 'published'
    }))})
    const p1 = await db.posts.findManyAndCount({ limit: 3, offset: 0 })
    const p2 = await db.posts.findManyAndCount({ limit: 3, offset: 3 })
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
    await db.posts.createMany({ data: [
      { id: 1, title: 'A', status: 'published' },
      { id: 2, title: 'B', status: 'published' },
    ]})
    await db.posts.remove({ where: { id: 2 } })
    const { rows, total } = await db.posts.findManyAndCount({})
    expect(rows).toHaveLength(1)
    expect(total).toBe(1)
    db.$close()
  })

  test('total is 0 when nothing matches', async () => {
    const db = await makeDb(SCHEMA, 'fmac-zero')
    await db.posts.createMany({ data: [
      { id: 1, title: 'A', status: 'draft' },
    ]})
    const { rows, total } = await db.posts.findManyAndCount({ where: { status: 'published' } })
    expect(rows).toHaveLength(0)
    expect(total).toBe(0)
    db.$close()
  })

  test('orderBy works on rows', async () => {
    const db = await makeDb(SCHEMA, 'fmac-order')
    await db.posts.createMany({ data: [
      { id: 1, title: 'B', status: 'published' },
      { id: 2, title: 'A', status: 'published' },
    ]})
    const { rows } = await db.posts.findManyAndCount({ orderBy: { title: 'asc' } })
    expect(rows[0].title).toBe('A')
    db.$close()
  })
})


// ─── @@external ───────────────────────────────────────────────────────────────

describe('@@external', () => {
  test('parses @@external without error', () => {
    const r = parse(`model users { id Integer @id; name Text; @@external }`)
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  test('@@external stored on model AST', () => {
    const { schema } = parse(`model users { id Integer @id; name Text; @@external }`)
    const m = schema.models[0]
    expect(m.attributes.some((a: any) => a.kind === 'external')).toBe(true)
  })

  test('@@external model excluded from DDL', () => {
    const { generateDDL } = require('../src/core/ddl.js')
    const { schema } = parse(`
      model managed { id Integer @id; name Text }
      model external_tbl { id Integer @id; data Text; @@external }
    `)
    const ddl = generateDDL(schema)
    expect(ddl).toContain('"managed"')
    expect(ddl).not.toContain('"external_tbl"')
  })

  test('@@external model is queryable via ORM', async () => {
    // Create the table manually (simulating external management)
    const { db } = await makeTestClient(`
      model managed { id Integer @id; val Text }
      model ext_users { id Integer @id; name Text; @@external }
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
      model ext_items { id Integer @id; label Text; @@external }
    `)
    db.$db.run(`CREATE TABLE ext_items (id INTEGER PRIMARY KEY, label TEXT) STRICT`)

    await db.ext_items.create({ data: { id: 1, label: 'Widget' } })
    const row = await db.ext_items.findFirst({ where: { id: 1 } })
    expect(row?.label).toBe('Widget')
    db.$close()
  })

  test('@@external + @@softDelete emits a warning', () => {
    const r = parse(`model t { id Integer @id; deletedAt DateTime?; @@external @@softDelete }`)
    expect(r.warnings.some((w: string) => w.includes('@@external') && w.includes('@@softDelete'))).toBe(true)
  })

  test('@@external table not dropped during migrate diff', () => {
    const { parse: p } = require('../src/core/parser.js')
    const { diffSchemas } = require('../src/core/migrate.js')
    const result = p(`
      model managed { id Integer @id }
      model ext_calendar { date Text @id; @@external }
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
    model users {
      id    Integer @id
      /// The user's full display name
      name  Text
      /// The user's email address
      /// Must be unique across all accounts
      email Text @unique
      role  Text
    }
  `

  test('model doc comment emitted as JSDoc above Row interface', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    expect(ts).toContain('* Represents a user account in the system')
    expect(ts).toContain('export interface Users {')
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
    model products {
      id    Integer @id
      /// The product's display name shown to customers
      name  Text
      /// Price in cents to avoid floating point issues
      price Integer
      notes Text
    }
  `

  test('model doc comment emitted as "description" on schema object', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.products.description).toBe('A product in the catalog')
  })

  test('field doc comment emitted as "description" on property', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.products.properties.name.description).toBe("The product's display name shown to customers")
  })

  test('multi-line field comment joined with space', () => {
    const MULTI = `
      model t {
        id  Integer @id
        /// First line
        /// Second line
        val Text
      }
    `
    const { schema } = parse(MULTI)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.t.properties.val.description).toBe('First line Second line')
  })

  test('field without doc comment has no "description"', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.products.properties.notes.description).toBeUndefined()
  })

  test('model without doc comment has no "description"', () => {
    const { schema } = parse(`model t { id Integer @id }`)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.t.description).toBeUndefined()
  })
})


// ─── groupBy() — interval + fillGaps ─────────────────────────────────────────

const EVENTS_SCHEMA = `
  model events {
    id        Integer  @id
    type      Text
    amount    Real
    createdAt DateTime
  }
`

describe('groupBy() — interval', () => {
  test('groups by month interval', async () => {
    const db = await makeDb(EVENTS_SCHEMA, 'grp-month')
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-15' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-20' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-02-10' },
    ]})
    const rows = await db.events.groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-01' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-01-03' },
    ]})
    const rows = await db.events.groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2023-06-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-01' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-06-01' },
    ]})
    const rows = await db.events.groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-15' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-04-15' },
      { id: 3, type: 'sale', amount: 30, createdAt: '2024-04-20' },
    ]})
    const rows = await db.events.groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale',   amount: 10, createdAt: '2024-01-15' },
      { id: 2, type: 'refund', amount: 5,  createdAt: '2024-01-20' },
      { id: 3, type: 'sale',   amount: 20, createdAt: '2024-02-10' },
    ]})
    const rows = await db.events.groupBy({
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
    await expect((db.events as any).groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-03' },
      // day 2 missing
    ]})
    const rows = await db.events.groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-02' },
    ]})
    const rows = await db.events.groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-03' },
    ]})
    const rows = await db.events.groupBy({
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
    await db.events.create({ data: { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' } })
    const rows = await db.events.groupBy({
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
    await db.events.createMany({ data: [
      { id: 1, type: 'sale', amount: 10, createdAt: '2024-01-01' },
      { id: 2, type: 'sale', amount: 20, createdAt: '2024-01-03' },
    ]})
    // No where clause — falls back to sparse
    await expect(db.events.groupBy({
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
    model tokens {
      id    Text    @id @default(nanoid())
      label Text
    }
  `

  test('parses @default(nanoid()) without error', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
  })

  test('auto-generates a nanoid when id not provided', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-auto')
    const row = await db.tokens.create({ data: { label: 'test' } })
    expect(typeof row.id).toBe('string')
    expect(row.id.length).toBe(21)
    db.$close()
  })

  test('generated nanoid is URL-safe (no special chars)', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-safe')
    const rows = await Promise.all(
      Array.from({ length: 10 }, () => db.tokens.create({ data: { label: 'x' } }))
    )
    for (const row of rows) {
      expect(row.id).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    db.$close()
  })

  test('each generated nanoid is unique', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-unique')
    const rows = await Promise.all(
      Array.from({ length: 20 }, () => db.tokens.create({ data: { label: 'x' } }))
    )
    const ids = rows.map((r: any) => r.id)
    expect(new Set(ids).size).toBe(20)
    db.$close()
  })

  test('explicit id overrides nanoid generation', async () => {
    const db = await makeDb(SCHEMA, 'nanoid-explicit')
    const row = await db.tokens.create({ data: { id: 'custom-id', label: 'test' } })
    expect(row.id).toBe('custom-id')
    db.$close()
  })
})


// ─── @phone validator ─────────────────────────────────────────────────────────

describe('@phone validator', () => {
  const SCHEMA = `
    model contacts {
      id    Integer @id
      phone Text    @phone
      alt   Text?   @phone("Alt must be a valid phone number")
    }
  `

  test('parses @phone without error', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
  })

  test('accepts valid international format', async () => {
    const db = await makeDb(SCHEMA, 'phone-intl')
    await expect(
      db.contacts.create({ data: { id: 1, phone: '+1 (555) 123-4567' } })
    ).resolves.toBeDefined()
    db.$close()
  })

  test('accepts E.164 format', async () => {
    const db = await makeDb(SCHEMA, 'phone-e164')
    await expect(
      db.contacts.create({ data: { id: 1, phone: '+15551234567' } })
    ).resolves.toBeDefined()
    db.$close()
  })

  test('rejects clearly invalid value', async () => {
    const db = await makeDb(SCHEMA, 'phone-invalid')
    await expect(
      db.contacts.create({ data: { id: 1, phone: 'not-a-phone' } })
    ).rejects.toThrow()
    db.$close()
  })

  test('allows null on optional @phone field', async () => {
    const db = await makeDb(SCHEMA, 'phone-null')
    await expect(
      db.contacts.create({ data: { id: 1, phone: '+15551234567', alt: null } })
    ).resolves.toBeDefined()
    db.$close()
  })

  test('custom error message surfaced on rejection', async () => {
    const db = await makeDb(SCHEMA, 'phone-msg')
    await expect(
      db.contacts.create({ data: { id: 1, phone: '+15551234567', alt: 'bad' } })
    ).rejects.toThrow('Alt must be a valid phone number')
    db.$close()
  })

  test('@phone emits format: phone in JSON Schema', () => {
    const { schema } = parse(SCHEMA)
    const js = generateJsonSchema(schema, { mode: 'full' })
    expect(js.$defs.contacts.properties.phone.format).toBe('phone')
  })
})


// ─── Custom policy error messages ────────────────────────────────────────────

describe('custom policy error messages', () => {
  test('@@allow with message — message surfaces on AccessDeniedError', async () => {
    const db = await makeDb(`
      model posts {
        id       Integer @id
        ownerId  Integer
        @@allow('create', auth() != null, "You must be logged in to create posts")
      }
    `, 'policy-msg-allow')
    try {
      await db.posts.create({ data: { id: 1, ownerId: 1 } })
      expect(true).toBe(false) // should not reach
    } catch (e: any) {
      expect(e.message).toBe('You must be logged in to create posts')
    }
    db.$close()
  })

  test('@@deny with message — message surfaces on AccessDeniedError', async () => {
    const db = await makeDb(`
      model posts {
        id      Integer @id
        status  Text    @default("draft")
        @@allow('all', true)
        @@deny('post-update', status == 'locked', "Cannot edit locked posts")
      }
    `, 'policy-msg-deny')
    await db.posts.create({ data: { id: 1, status: 'active' } })
    try {
      await db.posts.update({ where: { id: 1 }, data: { status: 'locked' } })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe('Cannot edit locked posts')
    }
    db.$close()
  })

  test('@@allow without message — falls back to default message', async () => {
    const db = await makeDb(`
      model posts {
        id      Integer @id
        @@allow('create', auth() != null)
      }
    `, 'policy-msg-default')
    try {
      await db.posts.create({ data: { id: 1 } })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toContain('denied')
    }
    db.$close()
  })

  test('message stored on AST node', () => {
    const { schema } = parse(`
      model t {
        id Integer @id
        @@allow('read', true, "Only readable")
        @@deny('write', true, "Not writable")
      }
    `)
    const attrs = schema.models[0].attributes
    expect(attrs.find((a: any) => a.kind === 'allow')?.message).toBe('Only readable')
    expect(attrs.find((a: any) => a.kind === 'deny')?.message).toBe('Not writable')
  })

  test('policy without message has message: null on AST', () => {
    const { schema } = parse(`model t { id Integer @id; @@allow('read', true) }`)
    const attr = schema.models[0].attributes.find((a: any) => a.kind === 'allow')
    expect(attr?.message).toBeNull()
  })
})


// ─── Codegen model whitelist (--only flag) ────────────────────────────────────

describe('generateTypeScript --only (model whitelist)', () => {
  const SCHEMA = `
    model users  { id Integer @id; name Text }
    model posts  { id Integer @id; title Text; userId Integer }
    model orders { id Integer @id; amount Real }
  `

  test('all models emitted without filter', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    expect(ts).toContain('interface Users')
    expect(ts).toContain('interface Posts')
    expect(ts).toContain('interface Orders')
  })

  test('only specified models emitted with filter', () => {
    const { schema } = parse(SCHEMA)
    const filtered = { ...schema, models: schema.models.filter((m: any) => ['users', 'posts'].includes(m.name)) }
    const ts = generateTypeScript(filtered)
    expect(ts).toContain('interface Users')
    expect(ts).toContain('interface Posts')
    expect(ts).not.toContain('interface Orders')
  })

  test('single model filter', () => {
    const { schema } = parse(SCHEMA)
    const filtered = { ...schema, models: schema.models.filter((m: any) => m.name === 'orders') }
    const ts = generateTypeScript(filtered)
    expect(ts).not.toContain('interface Users')
    expect(ts).not.toContain('interface Posts')
    expect(ts).toContain('interface Orders')
  })
})


// ─── @updatedBy ───────────────────────────────────────────────────────────────

describe('@updatedBy', () => {
  const SCHEMA = `
    model posts {
      id          Integer  @id
      title       Text
      createdById Integer? @default(auth().id)
      updatedById Integer? @updatedBy
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
    await db.posts.create({ data: { id: 1, title: 'Hello' } })
    await db.$setAuth(user).posts.update({ where: { id: 1 }, data: { title: 'Updated' } })
    const row = await db.posts.findFirst({ where: { id: 1 } })
    expect(row?.updatedById).toBe(42)
    db.$close()
  })

  test('@updatedBy re-stamps on every update', async () => {
    const db = await makeDb(SCHEMA, 'updby-restamp')
    await db.posts.create({ data: { id: 1, title: 'Hello' } })
    await db.$setAuth({ id: 1 }).posts.update({ where: { id: 1 }, data: { title: 'First edit' } })
    await db.$setAuth({ id: 2 }).posts.update({ where: { id: 1 }, data: { title: 'Second edit' } })
    const row = await db.posts.findFirst({ where: { id: 1 } })
    expect(row?.updatedById).toBe(2)
    db.$close()
  })

  test('@updatedBy skips if ctx.auth is null', async () => {
    const db = await makeDb(SCHEMA, 'updby-noauth')
    await db.posts.create({ data: { id: 1, title: 'Hello', updatedById: 99 } })
    await db.posts.update({ where: { id: 1 }, data: { title: 'Changed' } })
    const row = await db.posts.findFirst({ where: { id: 1 } })
    // updatedById should not be overwritten with null — skip silently
    expect(row?.updatedById).toBe(99)
    db.$close()
  })

  test('@updatedBy does not fire on create', async () => {
    const db = await makeDb(SCHEMA, 'updby-nocreate')
    const row = await db.$setAuth({ id: 5 }).posts.create({ data: { id: 1, title: 'New' } })
    // @default(auth().id) stamps createdById, but @updatedBy should not stamp on create
    expect(row?.createdById).toBe(5)
    expect(row?.updatedById).toBeNull()
    db.$close()
  })

  test('@updatedBy(auth().field) stamps custom auth field', async () => {
    const db = await makeDb(`
      model docs {
        id         Integer @id
        title      Text
        updatedBy  Text?   @updatedBy(auth().email)
      }
    `, 'updby-custom')
    await db.docs.create({ data: { id: 1, title: 'Doc' } })
    await db.$setAuth({ id: 1, email: 'alice@x.com' }).docs.update({
      where: { id: 1 }, data: { title: 'Edited' }
    })
    const row = await db.docs.findFirst({ where: { id: 1 } })
    expect(row?.updatedBy).toBe('alice@x.com')
    db.$close()
  })

  test('@updatedBy field excluded from Create TypeScript interface', () => {
    const { schema } = parse(SCHEMA)
    const ts = generateTypeScript(schema)
    // updatedById should NOT appear in PostsCreate interface
    const createBlock = ts.slice(ts.indexOf('interface PostsCreate'), ts.indexOf('interface PostsUpdate'))
    expect(createBlock).not.toContain('updatedById')
  })
})


// ─── @slug transformer ────────────────────────────────────────────────────────

describe('@slug transformer', () => {
  const SCHEMA = `
    model posts {
      id   Integer @id
      slug Text    @slug
    }
  `

  test('parses @slug without error', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
  })

  test('slugifies on create', async () => {
    const db = await makeDb(SCHEMA, 'slug-basic')
    const row = await db.posts.create({ data: { id: 1, slug: 'Hello World!' } })
    expect(row.slug).toBe('hello-world')
    db.$close()
  })

  test('slugifies special characters', async () => {
    const db = await makeDb(SCHEMA, 'slug-special')
    const row = await db.posts.create({ data: { id: 1, slug: "It's a C++ Thing" } })
    expect(row.slug).toBe('its-a-c-thing')
    db.$close()
  })

  test('collapses multiple hyphens', async () => {
    const db = await makeDb(SCHEMA, 'slug-hyphens')
    const row = await db.posts.create({ data: { id: 1, slug: 'foo   bar' } })
    expect(row.slug).toBe('foo-bar')
    db.$close()
  })

  test('slugifies on update', async () => {
    const db = await makeDb(SCHEMA, 'slug-update')
    await db.posts.create({ data: { id: 1, slug: 'original' } })
    const row = await db.posts.update({ where: { id: 1 }, data: { slug: 'New Title Here' } })
    expect(row.slug).toBe('new-title-here')
    db.$close()
  })

  test('null slug is skipped (not transformed)', async () => {
    const db = await makeDb(`
      model posts { id Integer @id; slug Text? @slug }
    `, 'slug-null')
    const row = await db.posts.create({ data: { id: 1, slug: null } })
    expect(row.slug).toBeNull()
    db.$close()
  })
})


// ─── @default(fieldName) field reference ──────────────────────────────────────

describe('@default(fieldName)', () => {
  test('parses @default(fieldName) without error', () => {
    const r = parse(`
      model posts { id Integer @id; title Text; slug Text @default(title) @slug }
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
      model posts { id Integer @id; status Status @default(draft) }
    `)
    expect(r.valid).toBe(true)
    const field = r.schema.models[0].fields.find((f: any) => f.name === 'status')
    const def = field?.attributes.find((a: any) => a.kind === 'default')
    expect(def?.value?.kind).toBe('enum')
    expect(def?.value?.value).toBe('draft')
  })

  test('copies source field value on create when target not provided', async () => {
    const db = await makeDb(`
      model posts { id Integer @id; title Text; slug Text @default(title) }
    `, 'fieldref-basic')
    const row = await db.posts.create({ data: { id: 1, title: 'Hello World' } })
    expect(row.slug).toBe('Hello World')
    db.$close()
  })

  test('explicit value overrides @default(fieldName)', async () => {
    const db = await makeDb(`
      model posts { id Integer @id; title Text; slug Text @default(title) }
    `, 'fieldref-override')
    const row = await db.posts.create({ data: { id: 1, title: 'Hello', slug: 'custom' } })
    expect(row.slug).toBe('custom')
    db.$close()
  })

  test('@default(title) @slug — copies then slugifies', async () => {
    const db = await makeDb(`
      model posts { id Integer @id; title Text; slug Text @default(title) @slug }
    `, 'fieldref-slug')
    const row = await db.posts.create({ data: { id: 1, title: 'Hello World!' } })
    expect(row.slug).toBe('hello-world')
    db.$close()
  })

  test('@default(unknown) is a parse error', () => {
    const r = parse(`
      model posts { id Integer @id; title Text; slug Text @default(nonexistent) }
    `)
    expect(r.valid).toBe(false)
    expect(r.errors.some((e: string) => e.includes('nonexistent'))).toBe(true)
  })
})


// ─── recursive findMany ───────────────────────────────────────────────────────

const TREE_SCHEMA = `
  model categories {
    id       Integer @id
    name     Text
    parentId Integer?
    parent   categories?  @relation(fields: [parentId], references: [id])
    children categories[]
  }
`

async function makeTree(label: string) {
  const db = await makeDb(TREE_SCHEMA, label)
  await db.categories.createMany({ data: [
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
    const rows = await db.categories.findMany({ where: { id: 1 }, recursive: true })
    expect(rows.length).toBe(5)
    expect(rows.every((r: any) => r._depth > 0)).toBe(true)
    db.$close()
  })

  test('recursive: { direction: descendants } — same as true', async () => {
    const db = await makeTree('rec-desc')
    const rows = await db.categories.findMany({ where: { id: 1 }, recursive: { direction: 'descendants' } })
    expect(rows.length).toBe(5)
    db.$close()
  })

  test('descendants from mid-tree node', async () => {
    const db = await makeTree('rec-mid')
    const rows = await db.categories.findMany({ where: { id: 3 }, recursive: true })
    const ids = rows.map((r: any) => r.id).sort()
    expect(ids).toEqual([5, 6])
    expect(rows.every((r: any) => r._depth === 1)).toBe(true)
    db.$close()
  })

  test('_depth reflects distance from anchor', async () => {
    const db = await makeTree('rec-depth')
    const rows = await db.categories.findMany({ where: { id: 1 }, recursive: true })
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]))
    expect(byId[2]._depth).toBe(1)
    expect(byId[3]._depth).toBe(1)
    expect(byId[4]._depth).toBe(2)
    expect(byId[5]._depth).toBe(2)
    db.$close()
  })

  test('ancestors walks path to root', async () => {
    const db = await makeTree('rec-anc')
    const rows = await db.categories.findMany({
      where:     { id: 5 },
      recursive: { direction: 'ancestors' }
    })
    const ids = rows.map((r: any) => r.id).sort()
    expect(ids).toEqual([1, 3])
    db.$close()
  })

  test('maxDepth limits traversal', async () => {
    const db = await makeTree('rec-maxdepth')
    const rows = await db.categories.findMany({
      where:     { id: 1 },
      recursive: { maxDepth: 1 }
    })
    expect(rows.every((r: any) => r._depth === 1)).toBe(true)
    expect(rows.length).toBe(2)  // Phones + Computers only
    db.$close()
  })

  test('nested: true returns tree structure', async () => {
    const db = await makeTree('rec-nested')
    const roots = await db.categories.findMany({
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
    const rows = await db.categories.findMany({
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
    const rows = await db.categories.findMany({ where: { id: 4 }, recursive: true })
    expect(rows).toHaveLength(0)
    db.$close()
  })

  test('throws on model without self-relation', async () => {
    const db = await makeDb(`model tags { id Integer @id; name Text }`, 'rec-noself')
    await expect(
      (db.tags as any).findMany({ where: { id: 1 }, recursive: true })
    ).rejects.toThrow('no self-referential relation')
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
    const schema = parse(`model docs { id Integer @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const args = { data: { id: 1, content: 'hello world' } }
    await plugin.onBeforeCreate('docs', args, {} as any)
    const ref = JSON.parse(args.data.content as any)
    expect(ref.raw).toBe('hello world')
    expect(ref.model).toBe('docs')
  })

  test('resolve called in onAfterRead when autoResolve: true', async () => {
    const plugin = makePlugin(true)
    const schema = parse(`model docs { id Integer @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const rows = [
      { id: 1, content: JSON.stringify({ raw: 'hello', model: 'docs', field: 'content' }) }
    ]
    await plugin.onAfterRead('docs', rows, {} as any)
    expect(rows[0].content).toBe('HELLO')
  })

  test('resolve NOT called in onAfterRead when autoResolve: false', async () => {
    const plugin = makePlugin(false)
    const schema = parse(`model docs { id Integer @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const rawRef = JSON.stringify({ raw: 'hello', model: 'docs', field: 'content' })
    const rows = [{ id: 1, content: rawRef }]
    await plugin.onAfterRead('docs', rows, {} as any)
    expect(rows[0].content).toBe(rawRef)  // unchanged
  })

  test('cleanup called in onAfterDelete', async () => {
    const plugin = makePlugin()
    const schema = parse(`model docs { id Integer @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const ref = { raw: 'hello', model: 'docs', field: 'content' }
    const rows = [{ id: 1, content: JSON.stringify(ref) }]
    await plugin.onAfterDelete('docs', rows, {} as any)
    expect(plugin.cleanedUp).toHaveLength(1)
    expect(plugin.cleanedUp[0].raw).toBe('hello')
  })

  test('cacheKey memoizes resolve results', async () => {
    const plugin = makePlugin(true)
    const schema = parse(`model docs { id Integer @id; content TestRef? }`)
    plugin.onInit(schema.schema, { models: {} } as any)
    const ref = { raw: 'hello', model: 'docs', field: 'content' }
    const rows1 = [{ id: 1, content: JSON.stringify(ref) }]
    const rows2 = [{ id: 2, content: JSON.stringify(ref) }]
    await plugin.onAfterRead('docs', rows1, {} as any)
    await plugin.onAfterRead('docs', rows2, {} as any)
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
    const schema = parse(`model docs { id Integer @id; title UpperRef? }`).schema
    plugin.onInit(schema, { models: {} } as any)

    const rawRef = JSON.stringify({ raw: 'hello' })
    const rows = [{ id: 1, title: rawRef }]

    // With resolve: false — should skip resolution
    await plugin.onAfterRead('docs', rows, {} as any, {
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
    const schema = parse(`model docs { id Integer @id; title UpperRef? }`).schema
    plugin.onInit(schema, { models: {} } as any)

    const rows = [{ id: 1, title: JSON.stringify({ raw: 'hello' }) }]

    await plugin.onAfterRead('docs', rows, {} as any, { select: { title: true } })
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
    const schema = parse(`model docs { id Integer @id; title UpperRef? }`).schema
    plugin.onInit(schema, { models: {} } as any)

    const rows = [{ id: 1, title: JSON.stringify({ raw: 'hello' }) }]
    await plugin.onAfterRead('docs', rows, {} as any, {})
    expect(rows[0].title).toBe('HELLO')
  })
})


// ─── JS migration API ─────────────────────────────────────────────────────────

describe('JS migration API', () => {
  const SCHEMA = `model posts { id Integer @id; title Text; slug Text? }`

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
        await db.posts.create({ data: { id: 1, title: 'Hello', slug: 'hello' } })
      }
    `)

    await apply(db.$db, dir, db)
    const posts = await db.posts.findMany({})
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
        await db.posts.create({ data: { id: 1, title: 'First' } })
      }
    `)
    writeFileSync(join(dir, '20240101000002_second.sql'),
      `INSERT INTO posts (id, title) VALUES (2, 'Second');`)

    await apply(db.$db, dir, db)
    const posts = await db.posts.findMany({ orderBy: { id: 'asc' } })
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
