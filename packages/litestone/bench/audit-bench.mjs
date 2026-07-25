// Performance audit micro-benchmarks for Litestone
// Run: bun bench/audit-bench.mjs [filter]
import { createClient } from '../src/index.js'
import { GatePlugin } from '../src/plugins/gate.js'
import { Plugin } from '../src/core/plugin.js'
import { autoMigrate } from '../src/core/migrations.js'
import { mkdirSync, rmSync, appendFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'

const filter = process.argv[2] || ''
const DIR = '/tmp/ls-bench'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const results = []
function report(name, metric, value, note = '') {
  results.push({ name, metric, value, note })
  console.log(`${name.padEnd(46)} ${metric.padEnd(22)} ${value}${note ? '   // ' + note : ''}`)
}
const ms = (t0) => (performance.now() - t0)
const run = async (name, fn) => {
  if (filter && !name.includes(filter)) return
  try { await fn() } catch (e) { console.log(`${name} FAILED: ${e.message}`) }
}

// A schema with 15 models to make per-model rebuild costs visible
const manyModels = Array.from({ length: 15 }, (_, i) => `
model m${i} {
  id        Int  @id
  name      String
  flag      Boolean  @default(false)
  data      Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`).join('\n')

// ── 1. $setAuth per-request rebuild ─────────────────────────────────────────
await run('setAuth-rebuild', async () => {
  const db = await createClient({ schema: manyModels, db: ':memory:' })
  // warm
  db.$setAuth({ id: 0 })
  const N = 2000
  let t0 = performance.now()
  for (let i = 0; i < N; i++) db.$setAuth({ id: i })          // fresh object each time (typical req.user)
  const fresh = ms(t0)
  const sameUser = { id: 1 }
  t0 = performance.now()
  for (let i = 0; i < N; i++) db.$setAuth(sameUser)           // identity-cached path
  const cached = ms(t0)
  report('1. $setAuth fresh user objects (15 models)', 'us/call', (fresh / N * 1000).toFixed(1))
  report('1. $setAuth same object (WeakMap hit)', 'us/call', (cached / N * 1000).toFixed(2))
  report('1. $setAuth cache-miss penalty', 'x slower', (fresh / cached).toFixed(0))
  db.$close()
})

// ── 2. GatePlugin getLevel call amplification ───────────────────────────────
await run('gate-getlevel', async () => {
  let calls = 0
  const schema = `model posts { id Int @id; title String \n @@gate("2.4.4.6") }`
  const db = await createClient({
    schema, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: async () => { calls++; return 5 } })],
  })
  const scoped = db.$setAuth({ id: 1 })
  await scoped.posts.create({ data: { title: 'x' } })
  calls = 0
  const OPS = 200
  const t0 = performance.now()
  for (let i = 0; i < OPS; i++) await scoped.posts.findMany({})
  report('2. GatePlugin getLevel() calls for 200 reads', 'calls', calls, 'comment claims once per model per request')
  report('2. GatePlugin 200 gated findMany', 'us/op', (ms(t0) / OPS * 1000).toFixed(1))
  db.$close()
})

// ── 3. PluginRunner no-op hook overhead ─────────────────────────────────────
await run('plugin-noop', async () => {
  const schema = `model users { id Int @id; name String }`
  const mk = (plugins) => createClient({ schema, db: ':memory:', plugins })
  const N = 30000
  const bench = async (db) => {
    await db.users.create({ data: { name: 'a' } })
    for (let i = 0; i < 500; i++) await db.users.findFirst({ where: { id: 1 } }) // warm
    const t0 = performance.now()
    for (let i = 0; i < N; i++) await db.users.findFirst({ where: { id: 1 } })
    const t = ms(t0); db.$close(); return t
  }
  const none = await bench(await mk(undefined))
  class P extends Plugin {}
  const three = await bench(await mk([new P(), new P(), new P()]))
  report('3. findFirst, 0 plugins', 'us/op', (none / N * 1000).toFixed(2))
  report('3. findFirst, 3 no-op plugins', 'us/op', (three / N * 1000).toFixed(2), 'delta = base-class no-op hook dispatch')
})

// ── 4. @regex validator recompilation ───────────────────────────────────────
await run('regex-validate', async () => {
  const mk = (attr) => createClient({
    schema: `model items { id Int @id; slug String ${attr}; n Int }`, db: ':memory:',
  })
  const N = 20000
  const rows = Array.from({ length: N }, (_, i) => ({ slug: `slug-${i}`, n: i }))
  const bench = async (db) => {
    const t0 = performance.now()
    await db.items.createMany({ data: rows })
    const t = ms(t0); db.$close(); return t
  }
  const plain = await bench(await mk(''))
  const rx = await bench(await mk('@regex("^[a-z0-9-]{3,40}$")'))
  report('4. createMany 20k rows, no @regex', 'ms', plain.toFixed(0))
  report('4. createMany 20k rows, one @regex field', 'ms', rx.toFixed(0), 'delta ~= 20k new RegExp() compiles')
})

// ── 5. autoMigrate no-op cost ───────────────────────────────────────────────
await run('automigrate', async () => {
  const db = await createClient({ schema: manyModels, db: `${DIR}/auto.db` })
  autoMigrate(db) // ensure in sync
  const N = 50
  const t0 = performance.now()
  for (let i = 0; i < N; i++) autoMigrate(db)
  report('5. autoMigrate already-in-sync (15 models)', 'ms/call', (ms(t0) / N).toFixed(1), 'runs full pristine build + 2x introspection')
  db.$close()
})

// ── 6. JSONL full-scan reads ────────────────────────────────────────────────
await run('jsonl-scan', async () => {
  mkdirSync(`${DIR}/logs`, { recursive: true })
  // Pre-write 200k rows directly (avoid slow per-row create path for setup)
  const lines = []
  for (let i = 0; i < 200000; i++)
    lines.push(JSON.stringify({ id: i + 1, method: 'GET', path: `/x/${i}`, status: 200 + (i % 300), createdAt: new Date(1700000000000 + i * 1000).toISOString() }))
  appendFileSync(`${DIR}/logs/apiRequests.jsonl`, lines.join('\n') + '\n')
  const schema = `
database main { path "/tmp/ls-bench/main.db" }
database logs { path "${DIR}/logs/"\n driver jsonl }
model apiRequests { method String; path String; status Int; createdAt DateTime @default(now()) \n @@db(logs) }`
  const db = await createClient({ schema })
  let t0 = performance.now()
  await db.apiRequests.findFirst({ where: { status: 500 } })
  report('6. JSONL findFirst on 200k-row file', 'ms', ms(t0).toFixed(0), 'full read+parse per query')
  t0 = performance.now()
  await db.apiRequests.count({})
  report('6. JSONL count() on 200k-row file', 'ms', ms(t0).toFixed(0))
  t0 = performance.now()
  await db.apiRequests.findMany({ limit: 50 })
  report('6. JSONL findMany limit 50', 'ms', ms(t0).toFixed(0))
  // append path
  const N = 2000
  t0 = performance.now()
  for (let i = 0; i < N; i++) await db.apiRequests.create({ data: { method: 'GET', path: '/y', status: 200 } })
  report('6. JSONL create() per-row append', 'us/op', (ms(t0) / N * 1000).toFixed(0), 'existsSync+statSync+appendFileSync per row')
  db.$close()
})

// ── 7. sigv4 presign throughput ─────────────────────────────────────────────
await run('sigv4', async () => {
  const { presignUrl } = await import('../src/storage/sigv4.js')
  const cfg = { accessKeyId: 'AKIAXXXXXXXXXXXXXXXX', secretAccessKey: 'x'.repeat(40), region: 'auto', service: 's3' }
  const N = 3000
  await presignUrl('GET', 'https://bucket.example.com/key/0', cfg, 3600)
  const t0 = performance.now()
  for (let i = 0; i < N; i++)
    await presignUrl('GET', `https://bucket.example.com/key/${i}`, cfg, 3600)
  report('7. presignUrl (no signing-key cache)', 'us/op', (ms(t0) / N * 1000).toFixed(0), '5+ importKey+HMAC per call')
})

// ── 8. createMany with @sequence ────────────────────────────────────────────
await run('sequence-createmany', async () => {
  const mk = (seq) => createClient({
    schema: `model quotes { id Int @id; accountId Int; num Int ${seq} }`, db: `${DIR}/seq-${seq ? 'y' : 'n'}.db`,
  })
  const N = 5000
  const rows = Array.from({ length: N }, (_, i) => ({ accountId: i % 10 }))
  const rowsWithNum = rows.map((r, i) => ({ ...r, num: i }))
  let db = await mk('')
  let t0 = performance.now()
  await db.quotes.createMany({ data: rowsWithNum })
  const plain = ms(t0); db.$close()
  db = await mk('@sequence(scope: accountId)')
  t0 = performance.now()
  await db.quotes.createMany({ data: rows })
  const seq = ms(t0); db.$close()
  report('8. createMany 5k rows (disk), no @sequence', 'ms', plain.toFixed(0))
  report('8. createMany 5k rows (disk), @sequence', 'ms', seq.toFixed(0), '2 auto-commit stmts/row outside the batch tx')
})

// ── 9. Auto-commit vs wrapped transaction (rotateKey pattern) ───────────────
await run('autocommit-vs-tx', async () => {
  const raw = new Database(`${DIR}/tx.db`)
  raw.run('PRAGMA journal_mode = WAL')
  raw.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const N = 10000
  raw.run('BEGIN'); const ins = raw.prepare('INSERT INTO t (v) VALUES (?)')
  for (let i = 0; i < N; i++) ins.run('x'); raw.run('COMMIT')
  const upd = raw.prepare('UPDATE t SET v = ? WHERE id = ?')
  let t0 = performance.now()
  for (let i = 1; i <= N; i++) upd.run('y', i)               // rotateKey style: implicit txn per row
  const auto = ms(t0)
  t0 = performance.now()
  raw.run('BEGIN'); for (let i = 1; i <= N; i++) upd.run('z', i); raw.run('COMMIT')
  const tx = ms(t0)
  report('9. 10k UPDATEs auto-commit (rotateKey style)', 'ms', auto.toFixed(0))
  report('9. 10k UPDATEs in one transaction', 'ms', tx.toFixed(0), `${(auto / tx).toFixed(1)}x faster`)
  raw.close()
})

// ── 10. upsert read-then-write vs native ON CONFLICT ────────────────────────
await run('upsert', async () => {
  const db = await createClient({ schema: `model kv { id Int @id; k String @unique; v String }`, db: ':memory:' })
  const N = 5000
  let t0 = performance.now()
  for (let i = 0; i < N; i++)
    await db.kv.upsert({ where: { k: `k${i % 500}` }, create: { k: `k${i % 500}`, v: 'a' }, update: { v: 'b' } })
  const orm = ms(t0)
  const raw = db.$rawDbs.main
  const stmt = raw.query('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v RETURNING *')
  t0 = performance.now()
  for (let i = 0; i < N; i++) stmt.get(`k${i % 500}`, 'c')
  const native = ms(t0)
  report('10. upsert() via findFirst+update/create', 'us/op', (orm / N * 1000).toFixed(1))
  report('10. native ON CONFLICT single statement', 'us/op', (native / N * 1000).toFixed(1), `${(orm / native).toFixed(0)}x`)
  db.$close()
})

// ── 11. Baseline sanity: core read/write throughput ─────────────────────────
await run('baseline', async () => {
  const db = await createClient({ schema: `model users { id Int @id; name String; age Int }`, db: ':memory:' })
  await db.users.createMany({ data: Array.from({ length: 10000 }, (_, i) => ({ name: `u${i}`, age: i % 80 })) })
  const N = 30000
  let t0 = performance.now()
  for (let i = 0; i < N; i++) await db.users.findUnique({ where: { id: (i % 10000) + 1 } })
  report('11. findUnique by PK (fast path)', 'us/op', (ms(t0) / N * 1000).toFixed(2))
  t0 = performance.now()
  for (let i = 0; i < 2000; i++) await db.users.findMany({ where: { age: { gte: 40 } }, limit: 100 })
  report('11. findMany where+limit 100 rows', 'us/op', (ms(t0) / 2000 * 1000).toFixed(1))
  t0 = performance.now()
  for (let i = 0; i < 10000; i++) await db.users.create({ data: { name: 'x', age: 1 } })
  report('11. create() single row (:memory:)', 'us/op', (ms(t0) / 10000 * 1000).toFixed(1))
  db.$close()
})

console.log('\nDone.')
