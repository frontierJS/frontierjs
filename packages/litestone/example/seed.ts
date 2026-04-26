#!/usr/bin/env bun
// seed.ts — creates and seeds all databases defined in schema.lite
//
// Usage:
//   bun seed.ts
//   bun seed.ts --studio     (seed then open studio)

import { createClient }    from '../src/index.js'
import { parse, generateDDL, generateDDLForDatabase } from '../src/index.js'
import { splitStatements } from '../src/core/migrate.js'
import { existsSync, unlinkSync, rmSync, mkdirSync, readFileSync } from 'fs'
import { Database } from 'bun:sqlite'

const __dir      = import.meta.dir
const OPEN_STUDIO = process.argv.includes('--studio')

// ─── Parse schema ─────────────────────────────────────────────────────────────

const parseResult = parse(readFileSync(`${__dir}/schema.lite`, 'utf8'))
if (!parseResult.valid) {
  for (const e of parseResult.errors) console.error('  ✗', e)
  process.exit(1)
}
for (const w of parseResult.warnings ?? [])
  console.warn('  ⚠', w)

// ─── Fresh start — remove all existing databases ───────────────────────────────

const toRemove = ['./example.db', './analytics.db', './logs', './audit']
for (const p of toRemove.map(p => `${__dir}/${p}`)) {
  if (!existsSync(p)) continue
  if (p.endsWith('.db')) unlinkSync(p)
  else rmSync(p, { recursive: true, force: true })
  console.log(`  ↺  removed ${p.replace(__dir + '/', '')}`)
}
console.log()

// ─── Create SQLite tables for main + analytics databases ──────────────────────
// JSONL and logger databases are schema-less — the driver manages them.

function initSqliteDb(absPath: string, dbName: string) {
  const raw = new Database(absPath)
  raw.run('PRAGMA journal_mode = WAL')
  raw.run('PRAGMA page_size = 8192')
  raw.run('PRAGMA foreign_keys = ON')
  const ddl = generateDDLForDatabase(parseResult.schema, dbName)
  for (const stmt of splitStatements(ddl)) {
    if (stmt.startsWith('PRAGMA')) continue
    raw.run(stmt)
  }
  raw.close()
  console.log(`  ✓  ${dbName} tables created (${absPath.replace(__dir + '/', '')})`)
}

initSqliteDb(`${__dir}/example.db`,   'main')
initSqliteDb(`${__dir}/analytics.db`, 'analytics')
console.log()

// ─── Open client ──────────────────────────────────────────────────────────────
// Single createClient call — routes all models to their declared database.
// No explicit db option needed since the schema declares all paths.

// Point all database env vars to the example/ directory so createClient
// opens the same files that initSqliteDb created — regardless of cwd.
process.env.MAIN_DB_PATH      = `${__dir}/example.db`
process.env.ANALYTICS_DB_PATH = `${__dir}/analytics.db`
process.env.LOGS_PATH         = `${__dir}/logs/`
process.env.AUDIT_PATH        = `${__dir}/audit/`

// Dev key — 64 hex chars = 32 bytes. In production use process.env.ENCRYPTION_KEY.
const DEV_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

// Track query timing during seed — shows onQuery hook in action.
// In production you'd write to a log file, send to telemetry, etc.
const slowQueries: string[] = []

const db = await createClient({
  parsed:     parseResult,
  encryptionKey: DEV_KEY,
  onQuery: (e) => {
    if (e.duration > 20)
      slowQueries.push(`${e.model}.${e.operation} ${e.duration.toFixed(1)}ms`)
  },
})
const sys = db.asSystem()   // bypass policies for seeding

// ─── Main database ────────────────────────────────────────────────────────────

// Accounts
const [acme, globex, initech] = await Promise.all([
  sys.accounts.create({ data: { id: 1, name: 'Acme Corp',  plan: 'pro',        meta: { seats: 25, region: 'us-east' } } }),
  sys.accounts.create({ data: { id: 2, name: 'Globex',     plan: 'starter',    meta: { seats: 5 } } }),
  sys.accounts.create({ data: { id: 3, name: 'Initech',    plan: 'enterprise', meta: { seats: 100 } } }),
])
console.log(`  ✓  accounts (main):  ${[acme, globex, initech].map(a => a.name).join(', ')}`)
console.log(`       slugs:          ${[acme, globex, initech].map(a => a.slug).join(', ')}`)

// Users — salary shows field-level @allow; apiKey uses @secret
const userResult = await sys.users.createMany({ data: [
  { id: 1, accountId: acme.id,    email: 'alice@acme.com',    firstName: 'Alice',   lastName: 'Chen',   role: 'admin',  salary: 140000, apiKey: 'key_alice_abc123' },
  { id: 2, accountId: acme.id,    email: 'bob@acme.com',      firstName: 'Bob',     lastName: 'Torres', role: 'member', salary:  95000  },
  { id: 3, accountId: acme.id,    email: 'carol@acme.com',    firstName: 'Carol',   lastName: 'Ruiz',   role: 'member', salary:  87000  },
  { id: 4, accountId: globex.id,  email: 'dave@globex.com',   firstName: 'Dave',    lastName: 'Kim',    role: 'admin',  salary: 120000, apiKey: 'key_dave_xyz789' },
  { id: 5, accountId: globex.id,  email: 'eve@globex.com',    firstName: 'Eve',     lastName: 'Patel',  role: 'member', salary:  82000  },
  { id: 6, accountId: initech.id, email: 'frank@initech.com', firstName: 'Frank',   lastName: 'Liu',    role: 'admin',  salary: 155000, apiKey: 'key_frank_mno456' },
  { id: 7, accountId: initech.id, email: 'grace@initech.com', firstName: 'Grace',   lastName: 'Walsh',  role: 'viewer', salary:  68000  },
] })
const alice = await sys.users.findUnique({ where: { id: 1 } })
console.log(`  ✓  users (main):     ${userResult.count} created`)
console.log(`       displayName:    "${alice!.displayName}"  initials: "${alice!.initials}"`)

// Demonstrate @secret — apiKey is encrypted at rest, invisible without asSystem()
const aliceAsUser = await db.$setAuth({ id: 1, accountId: 1, role: 'member' }).users.findUnique({ where: { id: 1 } })
const aliceAsSys  = await sys.users.findUnique({ where: { id: 1 } })
console.log(`       apiKey (member context): ${(aliceAsUser as any).apiKey === undefined ? 'undefined ✓ (stripped by @secret)' : 'visible ✗'}`)
console.log(`       apiKey (asSystem):       ${(aliceAsSys as any).apiKey ? 'decrypted ✓' : 'missing ✗'}`)

// Demonstrate field-level @allow — salary only visible to role=admin
const aliceAdmin  = await db.$setAuth({ id: 1, accountId: 1, role: 'admin'  }).users.findFirst({ where: { id: 1 } })
const bobMember   = await db.$setAuth({ id: 2, accountId: 1, role: 'member' }).users.findFirst({ where: { id: 1 } })
console.log(`       salary (admin):          ${(aliceAdmin as any).salary !== undefined ? '$' + (aliceAdmin as any).salary.toLocaleString() + ' ✓' : 'missing ✗'}`)
console.log(`       salary (member):         ${(bobMember as any).salary === undefined ? 'undefined ✓ (stripped by @allow)' : 'visible ✗'}`)

// Soft-delete grace
await sys.users.remove({ where: { id: 7 } })
console.log(`       grace soft-deleted (grace@initech.com)`)

// Products
const prodResult = await sys.products.createMany({ data: [
  { id: 1, accountId: acme.id,    name: 'Widget Pro',  price: 9900,  discount: 0.10 },
  { id: 2, accountId: acme.id,    name: 'Widget Lite', price: 4900,  discount: 0.00 },
  { id: 3, accountId: globex.id,  name: 'Gadget Plus', price: 14900, discount: 0.20 },
  { id: 4, accountId: initech.id, name: 'Tool Suite',  price: 29900, discount: 0.15 },
] })
const widgetPro = await sys.products.findUnique({ where: { id: 1 } })
console.log(`  ✓  products (main):  ${prodResult.count} created`)
console.log(`       "Widget Pro" → slug: "${widgetPro!.slug}"  salePrice: $${(widgetPro!.salePrice / 100).toFixed(2)}`)

// Leads — demonstrate @@deny('update', status == 'archived')
const leadResult = await sys.leads.createMany({ data: [
  { id: 1, accountId: acme.id,    firstName: 'Sara',  lastName: 'Park',   email: 'sara@co.co',       status: 'active',    score: 87.5 },
  { id: 2, accountId: acme.id,    firstName: 'James', lastName: 'Wright', email: 'james@biz.io',     status: 'converted', score: 94.0 },
  { id: 3, accountId: acme.id,    firstName: 'Lily',  lastName: 'Santos', email: 'lily@startup.com', status: 'active',    score: 62.3 },
  { id: 4, accountId: globex.id,  firstName: 'Noah',  lastName: 'Bell',   email: 'noah@org.io',      status: 'active',    score: 71.0 },
  { id: 5, accountId: globex.id,  firstName: 'Mia',   lastName: 'Russo',  email: 'mia@agency.net',   status: 'archived',  score: 28.5 },
  { id: 6, accountId: initech.id, firstName: 'Ethan', lastName: 'Wade',   email: 'ethan@corp.com',   status: 'active',    score: 44.2 },
  { id: 7, accountId: initech.id, firstName: 'Ava',   lastName: 'Stone',  email: 'ava@enterprise.io',status: 'active',    score: 78.9 },
] })
console.log(`  ✓  leads (main):     ${leadResult.count} created`)

// Show @@deny in action — archived lead cannot be updated by regular user
const acmeMember = db.$setAuth({ id: 1, accountId: 1, role: 'member' })
const archivedUpdate = await acmeMember.leads.update({ where: { id: 5 }, data: { score: 50 } })
console.log(`       update archived lead (Mia):  ${archivedUpdate === null ? 'null ✓ (@@deny blocked it)' : 'updated ✗'}`)

// Messages — FTS5 indexed
const msgResult = await sys.messages.createMany({ data: [
  { id: 1,  userId: 1, accountId: acme.id,    title: 'Welcome',          body: 'Welcome to Litestone — SQLite-first query client for Bun.' },
  { id: 2,  userId: 1, accountId: acme.id,    title: 'Schema functions', body: 'Schema functions let you define reusable SQL expressions like slug and fullName.' },
  { id: 3,  userId: 2, accountId: acme.id,    title: null,               body: 'The SQLite migration ran cleanly. All generated columns are populated correctly.' },
  { id: 4,  userId: 2, accountId: acme.id,    title: 'FTS5 search',      body: 'Full text search with FTS5 is incredibly fast. The BM25 ranking is accurate.' },
  { id: 5,  userId: 3, accountId: acme.id,    title: null,               body: 'Soft delete works great — deletedAt IS NULL is always added to WHERE clauses.' },
  { id: 6,  userId: 4, accountId: globex.id,  title: 'WAL mode',         body: 'WAL mode with dual read/write connections means reads never block writes.' },
  { id: 7,  userId: 4, accountId: globex.id,  title: null,               body: 'Cursor pagination is O(log n) via index. Much faster than offset for large tables.' },
  { id: 8,  userId: 5, accountId: globex.id,  title: 'Partial indexes',  body: 'Partial indexes on soft-delete tables only index live rows — smaller and faster.' },
  { id: 9,  userId: 6, accountId: initech.id, title: 'Multi-DB',         body: 'Litestone supports multiple databases — sqlite, jsonl, and logger drivers.' },
  { id: 10, userId: 6, accountId: initech.id, title: null,               body: 'Row-level policies with @@allow and @@deny compile to SQL WHERE injections.' },
] })
console.log(`  ✓  messages (main):  ${msgResult.count} created (FTS5 indexed)`)

// ─── Analytics database ───────────────────────────────────────────────────────

const pvResult = await sys.pageViews.createMany({ data: [
  { id: 1,  path: '/dashboard',  accountId: 1, userId: 1, country: 'US', device: 'desktop', duration: 142 },
  { id: 2,  path: '/leads',      accountId: 1, userId: 1, country: 'US', device: 'desktop', duration: 67  },
  { id: 3,  path: '/dashboard',  accountId: 1, userId: 2, country: 'CA', device: 'mobile',  duration: 38  },
  { id: 4,  path: '/products',   accountId: 2, userId: 4, country: 'US', device: 'desktop', duration: 211 },
  { id: 5,  path: '/dashboard',  accountId: 2, userId: 4, country: 'US', device: 'desktop', duration: 95  },
  { id: 6,  path: '/messages',   accountId: 3, userId: 6, country: 'UK', device: 'tablet',  duration: 180 },
  { id: 7,  path: '/',           accountId: null, userId: null, country: 'DE', device: 'desktop', duration: 12 },
  { id: 8,  path: '/',           accountId: null, userId: null, country: 'FR', device: 'mobile',  duration: 8  },
] })
console.log(`  ✓  pageViews (analytics): ${pvResult.count} created`)

const statsResult = await sys.dailyStats.createMany({ data: [
  { id: 1, date: '2026-04-10', accountId: 1, views: 45, uniqueUsers: 12, avgDuration: 98.5 },
  { id: 2, date: '2026-04-10', accountId: 2, views: 22, uniqueUsers: 6,  avgDuration: 134.2 },
  { id: 3, date: '2026-04-10', accountId: 3, views: 31, uniqueUsers: 8,  avgDuration: 76.0 },
  { id: 4, date: '2026-04-11', accountId: 1, views: 58, uniqueUsers: 15, avgDuration: 112.1 },
  { id: 5, date: '2026-04-11', accountId: 2, views: 19, uniqueUsers: 5,  avgDuration: 88.7 },
] })
console.log(`  ✓  dailyStats (analytics): ${statsResult.count} created`)

// ─── JSONL database — append-only request log ─────────────────────────────────

await sys.apiRequests.createMany({ data: [
  { method: 'GET',  path: '/api/users',    status: 200, duration: 4,   userId: 1, accountId: 1, ip: '10.0.0.1' },
  { method: 'POST', path: '/api/leads',    status: 201, duration: 12,  userId: 1, accountId: 1, ip: '10.0.0.1' },
  { method: 'GET',  path: '/api/messages', status: 200, duration: 8,   userId: 2, accountId: 1, ip: '10.0.0.2' },
  { method: 'GET',  path: '/api/products', status: 200, duration: 3,   userId: 4, accountId: 2, ip: '10.0.0.3' },
  { method: 'POST', path: '/api/users',    status: 422, duration: 6,   userId: 4, accountId: 2, ip: '10.0.0.3', error: 'Validation failed: email already taken' },
  { method: 'GET',  path: '/api/leads',    status: 200, duration: 5,   userId: 6, accountId: 3, ip: '10.0.0.4' },
  { method: 'DELETE', path: '/api/users/7', status: 200, duration: 9,  userId: 6, accountId: 3, ip: '10.0.0.4' },
] })
const logCount = await sys.apiRequests.count()
console.log(`  ✓  apiRequests (logs):    ${logCount} appended to JSONL`)

// Read logs back — query by status, duration
const errors = await sys.apiRequests.findMany({ where: { status: { gte: 400 } } })
console.log(`       errors (status >= 400): ${errors.length} — "${errors[0]?.error}"`)

// ─── Audit logger — seed some traceable writes + reads ───────────────────────
// The audit database is auto-populated by any model with @@log(audit) or @log(audit).
// Users has @@log(audit) (create/update/delete) and apiKey has @secret → @log(audit).
// createMany bypasses emitLogs, so we do a few targeted single-row ops here.

// Single creates — each fires @@log(audit) → auditLogs entry
const auditUser1 = await sys.users.create({ data: {
  id: 8, accountId: acme.id, email: 'audit1@acme.com',
  firstName: 'Audit', lastName: 'One', role: 'viewer', salary: 55000
}})
await sys.users.update({ where: { id: 8 }, data: { salary: 58000 } })
await sys.users.remove({ where: { id: 8 } })

// @secret defaults to reads:false — reads are high-volume and opt-in.
// To audit apiKey reads, declare: apiKey Text? @secret @log(audit, reads: true)
// The 3 write ops above (create + update + remove) still fire audit entries.
const auditCount = await sys.auditLogs.count()
console.log(`  ✓  auditLogs (audit):  ${auditCount} entries (create + update + delete)`)

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log()
console.log('  Databases:')
console.log(`    main       ./example.db`)
console.log(`    analytics  ./analytics.db`)
console.log(`    logs       ./logs/apiRequests.jsonl`)
console.log(`    audit      ./audit/auditLogs.jsonl  (logger driver — auto-populated)`)
console.log()

const counts = {
  'accounts  (main)':      await sys.accounts.count(),
  'users     (main)':      await sys.users.count(),
  'products  (main)':      await sys.products.count(),
  'leads     (main)':      await sys.leads.count(),
  'messages  (main)':      await sys.messages.count(),
  'pageViews (analytics)': await sys.pageViews.count(),
  'dailyStats(analytics)': await sys.dailyStats.count(),
  'apiReqs   (logs)':      await sys.apiRequests.count(),
  'auditLogs (audit)':     await sys.auditLogs.count(),
}
const maxLen = Math.max(...Object.keys(counts).map(k => k.length))
for (const [t, n] of Object.entries(counts))
  console.log(`    ${t.padEnd(maxLen)}  ${String(n).padStart(3)} rows`)

// ─── Feature demos ────────────────────────────────────────────────────────────

console.log()

// FTS search
const ftsResults = await sys.messages.search('sqlite', { limit: 3 })
console.log(`  FTS search "sqlite" → ${ftsResults.length} results`)

// onQuery hook — show any slow queries captured during seed
if (slowQueries.length) {
  console.log(`  onQuery: ${slowQueries.length} slow quer${slowQueries.length === 1 ? 'y' : 'ies'} (>20ms):`)
  for (const q of slowQueries) console.log(`       ${q}`)
} else {
  console.log(`  onQuery: all queries <20ms ✓`)
}

// $tapQuery — capture SQL for a single expression (Studio REPL uses this)
const captured: any[] = []
const stop = db.$tapQuery((e: any) => captured.push(e))
await sys.leads.findMany({ where: { status: 'active' }, orderBy: { score: 'desc' }, limit: 3 })
stop()
console.log(`  $tapQuery: captured ${captured.length} quer${captured.length === 1 ? 'y' : 'ies'}`)
console.log(`       SQL: ${captured[0]?.sql?.slice(0, 60)}…`)

// Row-level policy demo — acme member can only see their own account's leads
const acmeLeads  = await acmeMember.leads.findMany()
const otherLeads = acmeLeads.filter((l: any) => l.accountId !== 1)
console.log(`  Policy: acme member sees ${acmeLeads.length} leads (${otherLeads.length} from other accounts — should be 0)`)

// Cross-DB query — analytics from main app session
const topPages = await sys.pageViews.findMany({ orderBy: { duration: 'desc' }, limit: 3 })
console.log(`  Cross-DB: top pages by duration — ${topPages.map((p: any) => p.path).join(', ')}`)

// Cursor pagination
const page = await sys.products.findManyCursor({ limit: 2, orderBy: { salePrice: 'desc' } })
console.log(`  Cursor pagination (salePrice DESC, limit 2): ${page.items.map((p: any) => p.name).join(', ')}  hasMore: ${page.hasMore}`)

console.log()
db.$close()

// ─── Open studio ──────────────────────────────────────────────────────────────

if (OPEN_STUDIO) {
  console.log('  Opening studio…\n')
  const cliPath    = `${__dir}/../src/tools/cli.js`
  const schemaPath = `${__dir}/schema.lite`
  Bun.spawn(['bun', cliPath, 'studio', `--schema=${schemaPath}`], {
    env: { ...process.env, ENCRYPTION_KEY: DEV_KEY },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
}
