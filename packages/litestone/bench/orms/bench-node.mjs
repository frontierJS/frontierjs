// The same four calls on Node + better-sqlite3, where Drizzle, Prisma and ZenStack
// run natively. Litestone is Bun-only, so it is absent: read each ORM against its own
// raw row, never across the two files' absolute µs.
// `node bench-node.mjs [round-count] [case-filter]`. Shares the shape of bench.mjs.
import Database from 'better-sqlite3'
import { rmSync, mkdirSync } from 'node:fs'

const ROWS = 10_000
const ROUNDS = Number(process.argv[2] ?? 5)
const ONLY = process.argv[3]
mkdirSync('data', { recursive: true })

const fresh = name => { for (const s of ['', '-wal', '-shm']) rmSync(`data/${name}.db${s}`, { force: true }); return `data/${name}.db` }
function seeded(name) {
  const db = new Database(fresh(name))
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL')
  db.exec('CREATE TABLE user (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER NOT NULL)')
  const ins = db.prepare('INSERT INTO user (name, age) VALUES (?, ?)')
  db.transaction(() => { for (let i = 0; i < ROWS; i++) ins.run(`u${i}`, i % 80) })()
  return db
}

const impls = {}

{
  const db = seeded('node-raw')
  const q1 = db.prepare('SELECT id, name, age FROM user WHERE id = ?')
  const qm = db.prepare('SELECT id, name, age FROM user WHERE age >= ? LIMIT ?')
  const qc = db.prepare('INSERT INTO user (name, age) VALUES (?, ?) RETURNING id, name, age')
  const qu = db.prepare('UPDATE user SET age = ? WHERE id = ? RETURNING id, name, age')
  impls.raw = {
    findUnique: async i => q1.get((i % ROWS) + 1),
    findMany:   async () => qm.all(40, 100),
    create:     async () => qc.get('x', 1),
    update:     async i => qu.get(i % 80, (i % ROWS) + 1),
  }
}

{
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const { sqliteTable, integer, text } = await import('drizzle-orm/sqlite-core')
  const { eq, gte, sql } = await import('drizzle-orm')
  const user = sqliteTable('user', { id: integer('id').primaryKey({ autoIncrement: true }), name: text('name').notNull(), age: integer('age').notNull() })
  const db = drizzle(seeded('node-drizzle'))
  impls.drizzle = {
    findUnique: async i => (await db.select().from(user).where(eq(user.id, (i % ROWS) + 1)).limit(1))[0],
    findMany:   async () => db.select().from(user).where(gte(user.age, 40)).limit(100),
    create:     async () => (await db.insert(user).values({ name: 'x', age: 1 }).returning())[0],
    update:     async i => (await db.update(user).set({ age: i % 80 }).where(eq(user.id, (i % ROWS) + 1)).returning())[0],
  }
  const p1 = db.select().from(user).where(eq(user.id, sql.placeholder('id'))).limit(1).prepare()
  const pm = db.select().from(user).where(gte(user.age, sql.placeholder('age'))).limit(100).prepare()
  const pc = db.insert(user).values({ name: sql.placeholder('name'), age: sql.placeholder('age') }).returning().prepare()
  const pu = db.update(user).set({ age: sql.placeholder('age') }).where(eq(user.id, sql.placeholder('id'))).returning().prepare()
  impls['drizzle+prepared'] = {
    findUnique: async i => p1.get({ id: (i % ROWS) + 1 }),
    findMany:   async () => pm.all({ age: 40 }),
    create:     async () => pc.get({ name: 'x', age: 1 }),
    update:     async i => pu.get({ age: i % 80, id: (i % ROWS) + 1 }),
  }
}

{
  seeded('node-prisma').close()
  const { PrismaClient } = await import('./generated/prisma/client.ts')
  const { PrismaBetterSqlite3 } = await import('@prisma/adapter-better-sqlite3')
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: 'file:./data/node-prisma.db' }) })
  impls.prisma = {
    findUnique: i => db.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
    findMany:   () => db.user.findMany({ where: { age: { gte: 40 } }, take: 100 }),
    create:     () => db.user.create({ data: { name: 'x', age: 1 } }),
    update:     i => db.user.update({ where: { id: (i % ROWS) + 1 }, data: { age: i % 80 } }),
  }
}

{
  const { ZenStackClient } = await import('@zenstackhq/orm')
  const { SqliteDialect } = await import('kysely')
  const { PolicyPlugin } = await import('@zenstackhq/plugin-policy')
  const { schema } = await import('./zenstack/schema.ts')
  const db = new ZenStackClient(schema, { dialect: new SqliteDialect({ database: seeded('node-zenstack') }) })
  const policed = db.$use(new PolicyPlugin()).$setAuth({ id: 1 })
  for (const [name, c] of [['zenstack', db], ['zenstack+policy', policed]])
    impls[name] = {
      findUnique: i => c.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
      findMany:   () => c.user.findMany({ where: { age: { gte: 40 } }, take: 100 }),
      create:     () => c.user.create({ data: { name: 'x', age: 1 } }),
      update:     i => c.user.update({ where: { id: (i % ROWS) + 1 }, data: { age: i % 80 } }),
    }
}

const cases = [['findUnique', 20_000], ['findMany', 2_000], ['create', 5_000], ['update', 5_000]]
  .filter(([n]) => !ONLY || n === ONLY)

async function time(fn, ops) {
  for (let i = 0; i < Math.min(ops / 10, 500); i++) await fn(i)
  const t = performance.now()
  for (let i = 0; i < ops; i++) await fn(i)
  return ((performance.now() - t) * 1000) / ops
}

const median = a => [...a].sort((x, y) => x - y)[a.length >> 1]
const names = Object.keys(impls)
const table = {}
for (const [c, ops] of cases) {
  const samples = Object.fromEntries(names.map(n => [n, []]))
  for (let r = 0; r < ROUNDS; r++)
    for (const n of names) {
      try { samples[n].push(await time(impls[n][c], ops)) }
      catch (e) { samples[n].error = e.message.split('\n')[0] }
    }
  table[c] = Object.fromEntries(names.map(n => [n, samples[n].length ? median(samples[n]) : NaN]))
  for (const n of names) if (samples[n].error) console.error(`${c}/${n}: ${samples[n].error}`)
}

console.log(`\nNode ${process.version}, µs/op, median of ${ROUNDS} interleaved rounds, ${ROWS} rows (x raw in parens)\n`)
console.log(['case'.padEnd(12), ...names.map(n => n.padStart(19))].join(''))
for (const [c] of cases) {
  const raw = table[c].raw
  console.log([c.padEnd(12), ...names.map(n => `${table[c][n].toFixed(1)} (${(table[c][n] / raw).toFixed(1)}x)`.padStart(19))].join(''))
}
process.exit(0)
