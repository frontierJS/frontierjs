// Scale bench — one big schema through the whole Data realm, timed.
//
// The fixture is `test/fixtures/scale/openmrp.lite`: 188 models, ~1,900 columns,
// ~300 relations, derived from a real manufacturing ERP. Everything here is
// already covered functionally by the suite at small sizes; what this asks is
// whether any of it is superlinear, because nothing else in the repo runs the
// parser, the DDL emitter or autoMigrate at more than ~40 models.
//
//   bun bench/scale-schema.mjs [path-to.lite]
//
// Prints a table. It asserts nothing — a number that moves is for a person to read.

import { readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, generateDDL, generateJsonSchema, createClient, introspect, buildPristine, diffSchemas } from '../src/index.js'
import { Database } from 'bun:sqlite'

const file   = process.argv[2] ?? new URL('../test/fixtures/scale/openmrp.lite', import.meta.url).pathname
const source = readFileSync(file, 'utf8')
const rows   = []

const time = async (label, fn) => {
  const t0 = performance.now()
  const out = await fn()
  rows.push([label, performance.now() - t0])
  return out
}

// ─── the pure halves ───────────────────────────────────────────────
const parsed = await time('parse', () => parse(source))
if (!parsed.valid) { console.error(parsed.errors.join('\n')); process.exit(1) }
const schema = parsed.schema
const models = schema.models.length
await time('parse x10 (warm)', () => { for (let i = 0; i < 10; i++) parse(source) })

const ddl = await time('generateDDL', () => generateDDL(schema))
const js  = await time('generateJsonSchema', () => generateJsonSchema(schema))

// ─── a real database ───────────────────────────────────────────────
const dbPath = join(tmpdir(), `litestone-scale-${process.pid}.db`)
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(p)) rmSync(p)

const db = await time('createClient + autoMigrate', () =>
  createClient({ schema: source, db: dbPath, autoMigrate: true }))

// The case CLAUDE.md names: an unchanged schema must migrate nothing. A constraint
// compared by text rebuilds every table on every boot, and only size shows it.
const db2 = await time('reboot, unchanged schema', () =>
  createClient({ schema: source, db: dbPath, autoMigrate: true }))

// ...and that it really was nothing, rather than fast enough not to notice.
const pristineDb = new Database(':memory:')
const pristine   = buildPristine(pristineDb, parsed)
pristineDb.close()
const live = introspect(new Database(dbPath))
const diff = await time('diff live vs schema', () => diffSchemas(pristine, live, parsed))
const changes = Object.values(diff).flat().filter(Boolean).length

const sys = db.asSystem()
const row = i => ({ name: `Acme ${i}`, accountTypeCode: 'customer', onboardingStatusCode: 'done' })

await time('write 1 row', () => sys.account.create({ data: row(0) }))
await time('write 500 rows', async () => {
  for (let i = 1; i <= 500; i++) await sys.account.create({ data: row(i) })
})
await time('findMany limit 100', () => sys.account.findMany({ limit: 100 }))
// Account is the widest model in the fixture — ~50 hasMany back-references — so this
// is the one that shows whether include planning costs anything at that width.
await time('findMany + include x3', () => sys.account.findMany({
  limit: 100, include: { accountUsers: true, items: true, invoices: true } }))
await time('count', () => sys.account.count())
await time('findFirst by unique', () => sys.account.findFirst({ where: { name: 'Acme 250' } }))

const ddlStatements = (typeof ddl === 'string' ? ddl : String(ddl)).split(';').filter(s => s.trim()).length

// ─── report ────────────────────────────────────────────────────────
const w = Math.max(...rows.map(r => r[0].length))
console.log(`\n  ${models} models · ${source.split('\n').length} lines · ${(source.length / 1024).toFixed(0)} KB`)
console.log(`  ${ddlStatements} DDL statements · ${Object.keys(js.$defs ?? {}).length} JSON Schema $defs\n`)
for (const [label, ms] of rows) console.log(`  ${label.padEnd(w)}  ${ms.toFixed(1).padStart(8)} ms`)
console.log(`\n  unchanged-schema diff: ${changes === 0 ? 'no changes' : changes + ' PENDING CHANGES — a boot rebuilds'}\n`)

// A Litestone client throws on an unknown property, so a plain `db.close?.()` explodes.
for (const c of [db, db2]) if ('close' in c) c.close()
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(p)) rmSync(p)
