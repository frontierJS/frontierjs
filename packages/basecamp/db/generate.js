#!/usr/bin/env bun
// db/generate.js — regenerate the initial migration from schema.lite.
//
//   bun db/generate.js            write db/migrations/main/20260801000000_initial_schema.sql
//                                 and db/migrations/audit/20260801000000_audit_trail.sql
//   bun db/generate.js --check    exit 1 if the file on disk is stale (CI)
//   bun db/generate.js --print    dump the DDL to stdout, write nothing
//
// The schema is the seed. This script is the only thing allowed to write SQL
// into the migrations directory — if you find yourself hand-editing the
// generated file, the change belongs in schema.lite instead.
//
// Two things about the path are load-bearing, and both were wrong here until
// FJS-193. The 14-digit prefix is litestone's migration name —
// `listMigrationFiles` matches nothing else. And `main/` is the subdirectory a
// schema DECLARING `database main` puts its migrations in; a file directly
// under migrations/ is read by createTestEnv and invisible to `migrate apply`,
// so the suite was green against a database no deploy could build.

import { parseFile, generateDDLForDatabase } from '../../litestone/src/index.js'

const SCHEMA = new URL('./schema.lite', import.meta.url).pathname
// One file per declared SQLite database: `migrate apply` reads each database's
// migrations from its own subdirectory.
const OUTS   = {
  main:  new URL('./migrations/main/20260801000000_initial_schema.sql', import.meta.url).pathname,
  audit: new URL('./migrations/audit/20260801000000_audit_trail.sql', import.meta.url).pathname,
}

const HEADER = `-- ============================================================
-- Basecamp — initial schema
--
-- GENERATED FROM db/schema.lite. Do not edit by hand.
-- Regenerate:  bun db/generate.js
-- ============================================================

`

const result = parseFile(SCHEMA)

if (result.errors?.length) {
  console.error('schema.lite has errors:')
  for (const e of result.errors) console.error('  •', e)
  process.exit(1)
}

for (const w of result.warnings ?? []) console.warn('warning:', w)

const sqls = Object.fromEntries(
  Object.keys(OUTS).map(db => [db, HEADER + generateDDLForDatabase(result.schema, db)]))

if (process.argv.includes('--print')) {
  console.log(sqls.main)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  const stale = []
  for (const [db, out] of Object.entries(OUTS)) {
    const current = await Bun.file(out).text().catch(() => null)
    if (current !== sqls[db]) stale.push(out)
  }
  if (!stale.length) {
    console.log('up to date —', result.schema.models.length, 'models')
    process.exit(0)
  }
  console.error(`STALE: ${stale.join(', ')} does not match schema.lite. Run: bun db/generate.js`)
  process.exit(1)
}

for (const [db, out] of Object.entries(OUTS)) {
  await Bun.write(out, sqls[db])
  console.log(`wrote ${out}`)
}
console.log(`${result.schema.models.length} models, ${result.schema.enums.length} enums`)
