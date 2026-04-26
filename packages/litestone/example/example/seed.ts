#!/usr/bin/env bun
// seed.ts — creates and seeds example.db
//
// Usage:
//   bun seed.ts
//   bun seed.ts --studio     (seed then open studio)

import { createClient } from '../src/index.js'
import { parse, generateDDL } from '../src/index.js'
import { splitStatements } from '../../src/core/migrate.js'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { Database } from 'bun:sqlite'

const __dir      = import.meta.dir
const DB_PATH    = `${__dir}/example.db`
const SCHEMA_PATH= `${__dir}/schema.lite`
const OPEN_STUDIO= process.argv.includes('--studio')

// ─── Fresh start ──────────────────────────────────────────────────────────────

if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH)
  console.log('  ↺  removed existing example.db\n')
}

// ─── Create tables ────────────────────────────────────────────────────────────

const parseResult = parse(readFileSync(SCHEMA_PATH, 'utf8'))
if (!parseResult.valid) {
  for (const e of parseResult.errors) console.error('  ✗', e)
  process.exit(1)
}

const rawDb = new Database(DB_PATH)
rawDb.run('PRAGMA journal_mode = WAL')
rawDb.run('PRAGMA page_size = 8192')
rawDb.run('PRAGMA foreign_keys = ON')

for (const stmt of splitStatements(generateDDL(parseResult.schema))) {
  if (stmt.startsWith('PRAGMA')) continue
  rawDb.run(stmt)
}
rawDb.close()

console.log('  ✓  tables created from schema.lite\n')

// ─── Seed via client ──────────────────────────────────────────────────────────

const db = await createClient(DB_PATH, parseResult)

// Accounts
const [acme, globex, initech] = await Promise.all([
  db.accounts.create({ data: { id: 1, name: 'Acme Corp',  plan: 'pro',      meta: { seats: 25, region: 'us-east' } } }),
  db.accounts.create({ data: { id: 2, name: 'Globex',     plan: 'starter',  meta: { seats: 5 } } }),
  db.accounts.create({ data: { id: 3, name: 'Initech',    plan: 'enterprise', meta: { seats: 100 } } }),
])
console.log(`  ✓  accounts: ${[acme,globex,initech].map(a=>a.name).join(', ')}`)
console.log(`       slugs:  ${[acme,globex,initech].map(a=>a.slug).join(', ')}`)

// Users — displayName and initials are generated columns
const users = await db.users.createMany({ data: [
  { id: 1, accountId: acme.id,    email: 'alice@acme.com',     firstName: 'Alice',   lastName: 'Chen',   isAdmin: true,  role: 'admin',  prefs: { theme: 'dark'  } },
  { id: 2, accountId: acme.id,    email: 'bob@acme.com',       firstName: 'Bob',     lastName: 'Torres', isAdmin: false, role: 'member', prefs: { theme: 'light' } },
  { id: 3, accountId: acme.id,    email: 'carol@acme.com',     firstName: 'Carol',   lastName: 'Ruiz',   isAdmin: false, role: 'member', prefs: null },
  { id: 4, accountId: globex.id,  email: 'dave@globex.com',    firstName: 'Dave',    lastName: 'Kim',    isAdmin: true,  role: 'admin',  prefs: null },
  { id: 5, accountId: globex.id,  email: 'eve@globex.com',     firstName: 'Eve',     lastName: 'Patel',  isAdmin: false, role: 'member', prefs: null },
  { id: 6, accountId: initech.id, email: 'frank@initech.com',  firstName: 'Frank',   lastName: 'Liu',    isAdmin: true,  role: 'admin',  prefs: null },
  { id: 7, accountId: initech.id, email: 'grace@initech.com',  firstName: 'Grace',   lastName: 'Walsh',  isAdmin: false, role: 'viewer', prefs: null },
]})

// Verify generated columns populated
const alice = await db.users.findUnique({ where: { id: 1 } })
console.log(`  ✓  users: ${users.count} created`)
console.log(`       displayName: "${alice!.displayName}"  initials: "${alice!.initials}"`)

// Soft-delete one user to demonstrate the feature
await db.users.remove({ where: { id: 7 } })
console.log(`       grace soft-deleted (grace@initech.com)`)

// Products — slug and salePrice are generated columns
const products = await db.products.createMany({ data: [
  { id: 1, accountId: acme.id,    name: 'Widget Pro',    price: 9900,  discount: 0.10 },
  { id: 2, accountId: acme.id,    name: 'Widget Lite',   price: 4900,  discount: 0.0  },
  { id: 3, accountId: globex.id,  name: 'Gadget Plus',   price: 14900, discount: 0.20 },
  { id: 4, accountId: initech.id, name: 'Tool Suite',    price: 29900, discount: 0.15 },
]})
const widgetPro = await db.products.findUnique({ where: { id: 1 } })
console.log(`  ✓  products: ${products.count} created`)
console.log(`       "Widget Pro" → slug: "${widgetPro!.slug}"  salePrice: $${(widgetPro!.salePrice / 100).toFixed(2)}`)

// Leads — fullName is a generated column
const leads = await db.leads.createMany({ data: [
  { id: 1,  accountId: acme.id,    firstName: 'Sara',   lastName: 'Park',     email: 'sara@co.co',        status: 'active',    score: 87.5 },
  { id: 2,  accountId: acme.id,    firstName: 'James',  lastName: 'Wright',   email: 'james@biz.io',      status: 'converted', score: 94.0 },
  { id: 3,  accountId: acme.id,    firstName: 'Lily',   lastName: 'Santos',   email: 'lily@startup.com',  status: 'active',    score: 62.3 },
  { id: 4,  accountId: globex.id,  firstName: 'Noah',   lastName: 'Bell',     email: 'noah@org.io',       status: 'active',    score: 71.0 },
  { id: 5,  accountId: globex.id,  firstName: 'Mia',    lastName: 'Russo',    email: 'mia@agency.net',    status: 'archived',  score: 28.5 },
  { id: 6,  accountId: initech.id, firstName: 'Ethan',  lastName: 'Wade',     email: 'ethan@corp.com',    status: 'active',    score: 44.2 },
  { id: 7,  accountId: initech.id, firstName: 'Ava',    lastName: 'Stone',    email: 'ava@enterprise.io', status: 'active',    score: 78.9 },
]})
const sara = await db.leads.findUnique({ where: { id: 1 } })
console.log(`  ✓  leads: ${leads.count} created`)
console.log(`       "Sara Park" → fullName: "${sara!.fullName}"`)

// Messages — FTS5 indexed
const msgs = await db.messages.createMany({ data: [
  { id: 1,  userId: 1, accountId: acme.id,    title: 'Welcome',             body: 'Welcome to Litestone — SQLite-first query client for Bun.' },
  { id: 2,  userId: 1, accountId: acme.id,    title: 'Schema functions',    body: 'Schema functions let you define reusable SQL expressions like slug and fullName.' },
  { id: 3,  userId: 2, accountId: acme.id,    title: null,                  body: 'The SQLite migration ran cleanly. All generated columns are populated correctly.' },
  { id: 4,  userId: 2, accountId: acme.id,    title: 'FTS5 search',         body: 'Full text search with FTS5 is incredibly fast. The BM25 ranking is accurate.' },
  { id: 5,  userId: 3, accountId: acme.id,    title: null,                  body: 'Soft delete works great — deletedAt IS NULL is always added to WHERE clauses.' },
  { id: 6,  userId: 4, accountId: globex.id,  title: 'WAL mode',            body: 'WAL mode with dual read/write connections means reads never block writes.' },
  { id: 7,  userId: 4, accountId: globex.id,  title: null,                  body: 'Cursor pagination is O(log n) via index. Much faster than offset for large tables.' },
  { id: 8,  userId: 5, accountId: globex.id,  title: 'Partial indexes',     body: 'Partial indexes on soft-delete tables only index live rows — smaller and faster.' },
  { id: 9,  userId: 6, accountId: initech.id, title: 'Litestream',          body: 'Litestone is Litestream-compatible — WAL mode and synchronous NORMAL already set.' },
  { id: 10, userId: 6, accountId: initech.id, title: null,                  body: 'Boolean fields auto-coerce 0/1 from SQLite to true/false in JavaScript.' },
]})
console.log(`  ✓  messages: ${msgs.count} created (FTS5 indexed)`)

// Audit logs
const audits = await db.audit_logs.createMany({ data: [
  { id: 1, accountId: acme.id,    userId: 1, action: 'user.created',    resource: 'users',    resourceId: 1,  meta: { ip: '1.2.3.4' } },
  { id: 2, accountId: acme.id,    userId: 1, action: 'user.created',    resource: 'users',    resourceId: 2,  meta: null },
  { id: 3, accountId: acme.id,    userId: 1, action: 'lead.converted',  resource: 'leads',    resourceId: 2,  meta: { prev: 'active', next: 'converted' } },
  { id: 4, accountId: acme.id,    userId: 2, action: 'product.created', resource: 'products', resourceId: 1,  meta: null },
  { id: 5, accountId: globex.id,  userId: 4, action: 'user.created',    resource: 'users',    resourceId: 4,  meta: null },
  { id: 6, accountId: initech.id, userId: 6, action: 'user.deleted',    resource: 'users',    resourceId: 7,  meta: { soft: true } },
]})
console.log(`  ✓  audit_logs: ${audits.count} created`)

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log()
console.log('  Database:', DB_PATH)
console.log()

const counts: Record<string, number> = {
  accounts:   await db.accounts.count(),
  users:      await db.users.count(),
  products:   await db.products.count(),
  leads:      await db.leads.count(),
  messages:   await db.messages.count(),
  audit_logs: await db.audit_logs.count(),
}
const maxLen = Math.max(...Object.keys(counts).map(k => k.length))
for (const [t, n] of Object.entries(counts))
  console.log(`    ${t.padEnd(maxLen)}  ${String(n).padStart(3)} rows`)

// Demonstrate key features
console.log()

// FTS search
const ftsResults = await db.messages.search('sqlite', { limit: 3 })
console.log(`  FTS search "sqlite" → ${ftsResults.length} results:`)
for (const r of ftsResults)
  console.log(`    [${r._rank?.toFixed(2)}]  ${r.body.slice(0, 70)}`)

// WHERE on generated column
console.log()
const smiths = await db.leads.findMany({ where: { fullName: { contains: 'an' } } })
console.log(`  WHERE fullName CONTAINS 'an' → ${smiths.length} lead(s): ${smiths.map(l=>l.fullName).join(', ')}`)

// Cursor pagination
const page = await db.products.findManyCursor({ limit: 2, orderBy: { salePrice: 'desc' } })
console.log()
console.log(`  Cursor pagination (salePrice DESC, limit 2):`)
for (const p of page.items)
  console.log(`    ${p.name.padEnd(15)}  list: $${(p.price/100).toFixed(2)}  sale: $${(p.salePrice/100).toFixed(2)}`)
console.log(`  nextCursor: ${page.nextCursor?.slice(0,20)}...  hasMore: ${page.hasMore}`)

console.log()
db.$close()

// ─── Open studio ──────────────────────────────────────────────────────────────

if (OPEN_STUDIO) {
  console.log('  Opening studio…\n')
  const cliPath = `${__dir}/../src/tools/cli.js`
  Bun.spawn(['bun', cliPath, 'studio', `--db=${DB_PATH}`, `--schema=${SCHEMA_PATH}`], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
}
