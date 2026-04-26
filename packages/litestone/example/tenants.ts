// example/tenants.ts — multi-tenant + multi-DB example
//
// Layout after first run:
//
//   db/
//     schema.lite
//     tenants-registry.db   ← tenant index (IDs + metadata)
//     migrations/
//     tenants/
//       acme.db             ← per-tenant SQLite (main + analytics)
//       globex.db
//       initech.db
//     logs/                 ← GLOBAL — shared across all tenants
//     audit/                ← GLOBAL — shared across all tenants
//
// Run:  bun example/tenants.ts

import {
  createTenantRegistry,
  GatePlugin,
  FrontierGateGetLevel,
} from '../src/index.js'

// ─── Setup ────────────────────────────────────────────────────────────────────

const tenants = await createTenantRegistry({
  path:          './example/schema.lite',
  migrationsDir: './example/migrations',

  // Per-tenant encryption key — function receives the tenantId
  // Fall back to a shared dev key if no tenant-specific key is set
  encryptionKey: (tenantId) =>
    process.env[`TENANT_KEY_${tenantId.toUpperCase()}`] ??
    process.env.DEFAULT_TENANT_KEY ??
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',

  maxOpen: 50,

  // clientOptions are forwarded to every createClient() call
  // so every tenant connection gets plugins, filters, hooks, etc.
  clientOptions: {
    plugins: [
      new GatePlugin({ getLevel: FrontierGateGetLevel }),
    ],
    filters: {
      // Each tenant only sees their own data — enforced at the DB layer
      // (in a real app you'd scope by accountId or similar)
    },
    onQuery: (e) => {
      if (e.duration > 50)
        console.warn(`[${e.model}] slow query: ${e.operation} ${e.duration.toFixed(1)}ms`)
    },
  },
})

console.log('✓  tenant registry ready')
console.log(`   dir:      ${new URL('../db/tenants', import.meta.url).pathname}`)
console.log(`   registry: ${new URL('../db/tenants-registry.db', import.meta.url).pathname}`)
console.log()

// ─── Create tenants ───────────────────────────────────────────────────────────

if (!tenants.exists('acme')) {
  await tenants.create('acme',    { plan: 'pro',        region: 'us-east' })
  await tenants.create('globex',  { plan: 'starter',    region: 'eu-west' })
  await tenants.create('initech', { plan: 'enterprise', region: 'us-west' })
  console.log('✓  created tenants: acme, globex, initech')
} else {
  console.log('✓  tenants already exist')
}

console.log(`   open connections: ${tenants.openCount}`)
console.log()

// ─── Use a tenant ─────────────────────────────────────────────────────────────

const acme = await tenants.get('acme')

// Standard Litestone client — all ops scoped to acme.db
const [alice] = await Promise.all([
  acme.users.upsert({
    where:  { email: 'alice@acme.com' },
    create: { name: 'Alice Chen', email: 'alice@acme.com', role: 'admin', verifiedAt: new Date().toISOString(), activatedAt: new Date().toISOString() },
    update: {},
  }),
])

console.log(`✓  acme user: ${alice.name} (${alice.email})`)

// Auth-scoped client — gate levels + policies apply
const userDb  = acme.$setAuth(alice)
const sysDb   = acme.asSystem()

console.log(`   $config.schemaPath:    ${acme.$config.schemaPath}`)
console.log(`   $config.migrationsDir: ${acme.$config.migrationsDir}`)
console.log()

// ─── Fan-out queries ──────────────────────────────────────────────────────────

// Count users across all tenants
const { total, byTenant } = await tenants.aggregate(
  db => db.users.count()
)
console.log(`✓  user count across all tenants: ${total}`)
console.log(`   by tenant:`, byTenant)
console.log()

// Query only pro/enterprise tenants
const rows = await tenants.query(
  db => db.users.findMany(),
  {
    where:       { plan: 'pro' },
    flatten:     true,
    tenantField: 'tenantId',
    concurrency: 5,
  }
)
console.log(`✓  pro tenant users (flattened): ${rows.length} rows`)
console.log()

// ─── Metadata ─────────────────────────────────────────────────────────────────

tenants.meta.set('acme', { seats: 50 })

const proTenants = tenants.meta.findMany({ where: { plan: 'pro' } })
console.log(`✓  pro tenants:`, proTenants.map(t => t.id))
console.log()

// ─── Migrations ───────────────────────────────────────────────────────────────

// Apply pending migrations to all tenants concurrently
// const result = await tenants.migrate()
// console.log(`✓  migrations: ${result.migrations} applied across ${result.tenants} tenants`)

// Migrate only a subset
// await tenants.migrate({ only: ['acme'] })
// await tenants.migrate({ where: { plan: 'enterprise' } })

// ─── Testing pattern ──────────────────────────────────────────────────────────

// const testTenants = await createTenantRegistry({
//   path:     './db/schema.lite',
//   databases: ':memory:',   // all SQLite → :memory:, registry → :memory:
// })

// ─── Cleanup ─────────────────────────────────────────────────────────────────

tenants.close()
console.log('✓  connections closed')
