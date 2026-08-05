#!/usr/bin/env bun
// db/generate.js — regenerate the initial migration from schema.lite.
//
//   bun db/generate.js            write db/migrations/001_initial_schema.sql
//   bun db/generate.js --check    exit 1 if the file on disk is stale (CI)
//   bun db/generate.js --print    dump the DDL to stdout, write nothing
//
// The schema is the seed. This script is the only thing allowed to write SQL
// into the migrations directory — if you find yourself hand-editing the
// generated file, the change belongs in schema.lite instead.
//
// Once Basecamp is a workspace member with a package.json, this becomes
// `bun run db:ddl`. It has no dependencies beyond the workspace's litestone
// source, so it runs today, uninstalled.

import { parseFile, generateDDL } from '../../litestone/src/index.js'

const SCHEMA = new URL('./schema.lite', import.meta.url).pathname
const OUT    = new URL('./migrations/001_initial_schema.sql', import.meta.url).pathname

const HEADER = `-- ============================================================
-- Basecamp — initial schema
--
-- GENERATED FROM db/schema.lite. Do not edit by hand.
-- Regenerate:  bun db/generate.js
--
-- The previous hand-written SQL is kept at db/legacy-sql/ for reference.
-- It used snake_case columns and INTEGER epoch-ms timestamps; Litestone
-- emits camelCase columns and ISO-8601 TEXT, so the two are NOT compatible.
-- ============================================================

`

const result = parseFile(SCHEMA)

if (result.errors?.length) {
  console.error('schema.lite has errors:')
  for (const e of result.errors) console.error('  •', e)
  process.exit(1)
}

for (const w of result.warnings ?? []) console.warn('warning:', w)

const sql = HEADER + generateDDL(result.schema)

if (process.argv.includes('--print')) {
  console.log(sql)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  const current = await Bun.file(OUT).text().catch(() => null)
  if (current === sql) {
    console.log('up to date —', result.schema.models.length, 'models')
    process.exit(0)
  }
  console.error('STALE: 001_initial_schema.sql does not match schema.lite. Run: bun db/generate.js')
  process.exit(1)
}

await Bun.write(OUT, sql)
console.log(`wrote ${OUT}`)
console.log(`${result.schema.models.length} models, ${result.schema.enums.length} enums`)
