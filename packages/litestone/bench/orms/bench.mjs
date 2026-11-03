// Rough cross-ORM numbers on one SQLite shape: user(id, name, age), 10k rows.
// `bun bench.mjs [round-count] [case-filter]`. Interleaved rounds, median µs/op.
// Absolute µs are one machine's; read the ratios. Raw bun:sqlite is the floor.
import { Database } from 'bun:sqlite'
import { rmSync, mkdirSync } from 'node:fs'
import { createClient } from '../../src/index.js'
import { GatePlugin }   from '../../src/plugins/gate.js'

const ROWS = 10_000
const ROUNDS = Number(process.argv[2] ?? 5)
const ONLY = process.argv[3]
mkdirSync('data', { recursive: true })

const fresh = name => { for (const s of ['', '-wal', '-shm']) rmSync(`data/${name}.db${s}`, { force: true }); return `data/${name}.db` }
const DDL = `CREATE TABLE user (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER NOT NULL)`
function seeded(name, Ctor = Database) {
  const db = new Ctor(fresh(name))
  db.pragma ? db.pragma('journal_mode = WAL') : db.run('PRAGMA journal_mode = WAL')
  ;(db.exec ?? db.run).call(db, DDL)
  const ins = db.prepare('INSERT INTO user (name, age) VALUES (?, ?)')
  const tx = db.transaction(() => { for (let i = 0; i < ROWS; i++) ins.run(`u${i}`, i % 80) })
  tx()
  return db
}

const impls = {}

// raw bun:sqlite -- the floor
{
  const db = seeded('raw'); db.run('PRAGMA synchronous = NORMAL')
  const q1 = db.query('SELECT id, name, age FROM user WHERE id = ?')
  const qm = db.query('SELECT id, name, age FROM user WHERE age >= ? LIMIT ?')
  const qc = db.query('INSERT INTO user (name, age) VALUES (?, ?) RETURNING id, name, age')
  const qu = db.query('UPDATE user SET age = ? WHERE id = ? RETURNING id, name, age')
  impls.raw = {
    findUnique: async i => q1.get((i % ROWS) + 1),
    findMany:   async () => qm.all(40, 100),
    create:     async () => qc.get('x', 1),
    update:     async i => qu.get(i % 80, (i % ROWS) + 1),
  }
}

// litestone
{
  const db = await createClient({ schema: 'model User { id Int @id; name String; age Int }', db: fresh('litestone') })
  await db.asSystem().user.createMany({ data: Array.from({ length: ROWS }, (_, i) => ({ name: `u${i}`, age: i % 80 })) })
  impls.litestone = {
    findUnique: i => db.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
    findMany:   () => db.user.findMany({ where: { age: { gte: 40 } }, limit: 100 }),
    create:     () => db.user.create({ data: { name: 'x', age: 1 } }),
    update:     i => db.user.update({ where: { id: (i % ROWS) + 1 }, data: { age: i % 80 } }),
  }
}

// litestone with the gate plugin on: read 2, create 4, update 4, delete 6, caller at level 5
{
  const base = await createClient({
    schema: 'model User { id Int @id; name String; age Int\n @@gate(2.4.4.6) }',
    db: fresh('litestone-gated'), plugins: [new GatePlugin({ getLevel: () => 5 })],
  })
  await base.asSystem().user.createMany({ data: Array.from({ length: ROWS }, (_, i) => ({ name: `u${i}`, age: i % 80 })) })
  const db = base.$setAuth({ id: 1 })
  impls['litestone+gate'] = {
    findUnique: i => db.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
    findMany:   () => db.user.findMany({ where: { age: { gte: 40 } }, limit: 100 }),
    create:     () => db.user.create({ data: { name: 'x', age: 1 } }),
    update:     i => db.user.update({ where: { id: (i % ROWS) + 1 }, data: { age: i % 80 } }),
  }
}

// drizzle (bun:sqlite driver)
{
  const { drizzle } = await import('drizzle-orm/bun-sqlite')
  const { sqliteTable, integer, text } = await import('drizzle-orm/sqlite-core')
  const { eq, gte } = await import('drizzle-orm')
  const user = sqliteTable('user', { id: integer('id').primaryKey({ autoIncrement: true }), name: text('name').notNull(), age: integer('age').notNull() })
  const raw = seeded('drizzle'); raw.run('PRAGMA synchronous = NORMAL')
  const db = drizzle(raw)
  impls.drizzle = {
    findUnique: async i => (await db.select().from(user).where(eq(user.id, (i % ROWS) + 1)).limit(1))[0],
    findMany:   () => db.select().from(user).where(gte(user.age, 40)).limit(100),
    create:     async () => (await db.insert(user).values({ name: 'x', age: 1 }).returning())[0],
    update:     async i => (await db.update(user).set({ age: i % 80 }).where(eq(user.id, (i % ROWS) + 1)).returning())[0],
  }
  // The same four calls built once with placeholders: what Drizzle does when asked to.
  const { sql } = await import('drizzle-orm')
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

// prisma 7 (better-sqlite3 driver adapter)
{
  seeded('prisma').close?.()
  const { PrismaClient } = await import('./generated/prisma/client.ts')
  const { PrismaLibSql } = await import('@prisma/adapter-libsql')   // better-sqlite3 will not load under Bun
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url: 'file:./data/prisma.db' }) })
  await db.$executeRawUnsafe('PRAGMA synchronous = NORMAL').catch(() => {})
  impls.prisma = {
    findUnique: i => db.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
    findMany:   () => db.user.findMany({ where: { age: { gte: 40 } }, take: 100 }),
    create:     () => db.user.create({ data: { name: 'x', age: 1 } }),
    update:     i => db.user.update({ where: { id: (i % ROWS) + 1 }, data: { age: i % 80 } }),
  }
}

// zenstack v3 (kysely, better-sqlite3), policy plugin off and on
{
  const { ZenStackClient } = await import('@zenstackhq/orm')
  const { SqliteDialect } = await import('kysely')
  const { schema } = await import('./zenstack/schema.ts')
  seeded('zenstack').close?.()
  // Kysely's SqliteDialect wants the better-sqlite3 shape; bun:sqlite fits behind a thin shim.
  const bun = new Database('data/zenstack.db'); bun.run('PRAGMA synchronous = NORMAL')
  const database = {
    close: () => bun.close(),
    prepare(sql) {
      const st = bun.query(sql)
      return {
        reader: st.columnNames.length > 0,
        all: p => st.all(...p),
        run: p => { const r = st.run(...p); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid } },
        iterate: p => st.iterate(...p),
      }
    },
  }
  const db = new ZenStackClient(schema, { dialect: new SqliteDialect({ database }) })
  const { PolicyPlugin } = await import('@zenstackhq/plugin-policy')
  const policed = db.$use(new PolicyPlugin()).$setAuth({ id: 1 })
  impls['zenstack+policy'] = {
    findUnique: i => policed.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
    findMany:   () => policed.user.findMany({ where: { age: { gte: 40 } }, take: 100 }),
    create:     () => policed.user.create({ data: { name: 'x', age: 1 } }),
    update:     i => policed.user.update({ where: { id: (i % ROWS) + 1 }, data: { age: i % 80 } }),
  }
  impls.zenstack = {
    findUnique: i => db.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
    findMany:   () => db.user.findMany({ where: { age: { gte: 40 } }, take: 100 }),
    create:     () => db.user.create({ data: { name: 'x', age: 1 } }),
    update:     i => db.user.update({ where: { id: (i % ROWS) + 1 }, data: { age: i % 80 } }),
  }
}

const cases = [['findUnique', 20_000], ['findMany', 2_000], ['create', 5_000], ['update', 5_000]]
  .filter(([n]) => !ONLY || n === ONLY)

async function time(fn, ops) {
  for (let i = 0; i < Math.min(ops / 10, 500); i++) await fn(i)   // warm
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

console.log(`\nµs/op, median of ${ROUNDS} interleaved rounds, ${ROWS} rows (x raw in parens)\n`)
console.log(['case'.padEnd(12), ...names.map(n => n.padStart(19))].join(''))
for (const [c] of cases) {
  const raw = table[c].raw
  console.log([c.padEnd(12), ...names.map(n => `${table[c][n].toFixed(1)} (${(table[c][n] / raw).toFixed(1)}x)`.padStart(19))].join(''))
}
process.exit(0)
