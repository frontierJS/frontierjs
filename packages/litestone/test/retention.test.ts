/**
 * test/retention.test.ts — `retention 30d` on a `database` block (`FJS-521`).
 *
 * Three things were wrong and only one of them was the one we went looking for.
 *
 *   • The sweep named the MODEL where the table is snake_case, so
 *     `DELETE FROM "AuditEvent"` matched nothing and the throw landed in a catch
 *     commented *table may not exist yet*. Every multi-word model kept every row
 *     for ever, silently. `Log` survived only because SQLite matches identifiers
 *     case-insensitively — which is why a single-word test would have passed.
 *   • It ran once, inside `createClient`. A server that stays up never prunes.
 *   • A compaction that threw was swallowed, so a broken policy and a policy
 *     with nothing to do looked identical.
 *
 * The cutoff is still a ROLLING INSTANT — the duration back from the moment the
 * pass runs — and that is asserted here rather than left implied, because a
 * calendar-aligned window needs a zone the seed cannot yet state (`FJS-D143`).
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database as BunDatabase } from 'bun:sqlite'
import { createClient } from '../src/index.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'litestone-retention-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

// AuditEvent is the point: two words, so the table is `audit_event` and the
// model name names nothing. Log is the control that used to pass anyway.
const SCHEMA = (dir: string) => `
  database main { path "${join(dir, 'app.db')}"  retention 90d }
  model Log        { id Int @id @default(autoincrement())  body String  createdAt DateTime @default(now()) }
  model AuditEvent { id Int @id @default(autoincrement())  body String  createdAt DateTime @default(now()) }
  model Setting    { id Int @id @default(autoincrement())  key  String }
`

async function seeded() {
  const dir = tmp()
  const db  = await createClient({ schema: SCHEMA(dir) })
  const sys = db.asSystem()
  for (const model of ['log', 'auditEvent'] as const) {
    await sys[model].create({ data: { body: 'old',   createdAt: ago(200) } })
    await sys[model].create({ data: { body: 'fresh', createdAt: ago(2)   } })
  }
  await sys.setting.create({ data: { key: 'k' } })
  return { db, sys, dir }
}

const bodies = async (sys: any, model: string) =>
  (await sys[model].findMany()).map((r: { body: string }) => r.body).sort()

describe('the sweep names the TABLE', () => {
  test('a multi-word model is swept — it never was', async () => {
    const { sys } = await seeded()
    const swept = await sys.$retain()

    expect(await bodies(sys, 'auditEvent')).toEqual(['fresh'])
    expect(swept.find((r: { model: string }) => r.model === 'AuditEvent'))
      .toMatchObject({ table: 'audit_event', removed: 1 })
  })

  test('the single-word control is swept too, as it always was', async () => {
    const { sys } = await seeded()
    await sys.$retain()
    expect(await bodies(sys, 'log')).toEqual(['fresh'])
  })

  test('a model with no createdAt is left alone rather than failing, and the report says so', async () => {
    const { sys } = await seeded()
    const swept = await sys.$retain()
    expect(swept.find((r: { model: string }) => r.model === 'Setting'))
      .toMatchObject({ database: 'main', table: 'setting', removed: 0, skipped: 'no createdAt DateTime' })
    expect((await sys.setting.findMany()).length).toBe(1)
  })

  test('a model dated by another name is reported skipped, not absent (FJS-2285)', async () => {
    const dir = tmp()
    const db  = await createClient({ schema: `
      database main { path "${join(dir, 'app.db')}" }
      database serp { path "${join(dir, 'serp.db')}"  retention 90d }
      model Ranking { id Int @id @default(autoincrement())  createdAt DateTime @default(now())  @@db(serp) }
      model Raw     { id Int @id @default(autoincrement())  fetchedAt DateTime @default(now())  @@db(serp) }
    ` })
    const sys = db.asSystem()
    await sys.ranking.create({ data: { createdAt: ago(200) } })
    await sys.raw.create({ data: { fetchedAt: ago(200) } })

    const swept = await sys.$retain()
    expect(swept.find((r: { model: string }) => r.model === 'Ranking')).toMatchObject({ removed: 1 })
    expect(swept.find((r: { model: string }) => r.model === 'Raw'))
      .toMatchObject({ database: 'serp', removed: 0, skipped: 'no createdAt DateTime' })
    expect((await sys.raw.findMany()).length).toBe(1)
  })
})

describe('$retain() — because startup is not a schedule', () => {
  test('sweeps rows that aged past the window AFTER the client opened', async () => {
    const dir = tmp()
    const db  = await createClient({ schema: SCHEMA(dir) })
    const sys = db.asSystem()

    // Nothing to do at boot, which is the state a long-lived server is in every
    // day after the deploy. The row is written already stale.
    await sys.auditEvent.create({ data: { body: 'stale', createdAt: ago(200) } })
    expect((await sys.auditEvent.findMany()).length).toBe(1)

    expect((await sys.$retain()).find((r: { model: string }) => r.model === 'AuditEvent')?.removed).toBe(1)
    expect((await sys.auditEvent.findMany()).length).toBe(0)
  })

  test('answers one row per table it touched, and is quiet when there is nothing', async () => {
    const { sys } = await seeded()
    await sys.$retain()
    const second = await sys.$retain()
    expect(second.every((r: { removed: number }) => r.removed === 0)).toBe(true)
    expect(second.map((r: { model: string }) => r.model).sort()).toEqual(['AuditEvent', 'Log', 'Setting'])
  })

  test('each row names the database it swept and its driver, as RetainResult declares', async () => {
    const { sys } = await seeded()
    for (const r of await sys.$retain()) {
      expect(typeof r.database).toBe('string')
      expect(['sqlite', 'jsonl', 'trail']).toContain(r.driver)
    }
  })

  test('the cutoff is a rolling instant, so a row inside the window stays', async () => {
    const dir = tmp()
    const db  = await createClient({ schema: SCHEMA(dir) })
    const sys = db.asSystem()
    // 89 days and 23 hours: inside 90 flat days from NOW, whatever the calendar
    // or the zone would say about it.
    await sys.log.create({ data: { body: 'just-inside', createdAt: new Date(Date.now() - (90 * 86_400_000 - 3_600_000)).toISOString() } })
    await sys.$retain()
    expect(await bodies(sys, 'log')).toEqual(['just-inside'])
  })
})

describe('who may run it', () => {
  test('refused off a scoped client, naming asSystem()', async () => {
    const { db } = await seeded()
    expect(() => db.$setAuth({ id: 1 }).$retain()).toThrow(/asSystem\(\)/)
  })

  test('refused off the root client too — it applies no access rules', async () => {
    const { db } = await seeded()
    expect(() => db.$retain()).toThrow(/applies none of this schema's access rules/)
  })
})

describe('the jsonl half', () => {
  test('compacts on demand, not only when the client opened', async () => {
    const dir = tmp()
    const logs = join(dir, 'logs/')
    const src = `
      database main { path "${join(dir, 'app.db')}" }
      database logs { path "${logs}"  driver jsonl  retention 90d }
      model Entry { id Int @id @default(autoincrement())  body String  createdAt DateTime @default(now())  @@db(logs) }
    `
    const db  = await createClient({ schema: src })
    const sys = db.asSystem()

    await sys.entry.create({ data: { body: 'old',   createdAt: ago(200) } })
    await sys.entry.create({ data: { body: 'fresh', createdAt: ago(1)   } })
    expect((await sys.entry.findMany()).length).toBe(2)

    const swept = await sys.$retain()
    expect(swept.find((r: { model: string }) => r.model === 'Entry')?.removed).toBe(1)

    const file = swept.find((r: { model: string }) => r.model === 'Entry')!.table as string
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('"old"')
  })

  // `@default(now())` on a jsonl model read the wall clock, so a row written
  // after the client's clock moved was stamped in the past of that clock and
  // the next sweep removed it with the old one (`FJS-1922`).
  test('@default(now()) is stamped from the client clock', async () => {
    const dir = tmp()
    let at = Date.now()
    const db  = await createClient({
      schema: `
        database main { path "${join(dir, 'app.db')}" }
        database logs { path "${join(dir, 'logs/')}"  driver jsonl  retention 30d }
        model Entry { id Int @id @default(autoincrement())  body String  createdAt DateTime @default(now())  @@db(logs) }
      `,
      now: () => new Date(at),
    })
    const sys = db.asSystem()
    await sys.entry.create({ data: { body: 'old' } })
    at += 31 * 86_400_000
    const fresh = await sys.entry.create({ data: { body: 'new' } })
    expect(new Date(fresh.createdAt).getTime()).toBe(at)

    const swept = await sys.$retain()
    expect(swept.find((r: { model: string }) => r.model === 'Entry')?.removed).toBe(1)
    expect((await sys.entry.findMany()).map((r: { body: string }) => r.body)).toEqual(['new'])
  })

  // The compaction rewrites the file, so every byte offset the companion index
  // holds is wrong. It used to answer that by DELETING the index — and SQLite
  // marks a connection readonly when its file is unlinked underneath, so the
  // next append threw `SQLITE_READONLY_DBMOVED` from inside the driver, on the
  // audit path, which is fire-and-forget: the request that caused it answered
  // 201 and the process died a tick later (`FJS-540`).
  //
  // **It rebuilds the index instead now** (`FJS-665`), which removes that crash
  // at its root rather than recovering from it — and is the precondition for the
  // index being in WAL at all, since an unlink there leaves `-wal` and `-shm`
  // behind and the next write answers `ok` into an inode with no directory
  // entry. So this test asserts the opposite of what it used to: the file is
  // still there, and it holds the offsets of the rows that SURVIVED.
  //
  // The reopen guard `FJS-540` added stays and is asserted below, because
  // nothing stops a hand-written probe or an older build removing the file.
  test('a sweep rebuilds the index rather than deleting it', async () => {
    const dir = tmp()
    const src = `
      database main { path "${join(tmp(), 'app.db')}" }
      database logs { path "${join(dir, 'logs/')}"  driver jsonl  retention 90d }
      // An @@index is what puts a companion index.db beside the file, and it is
      // the shape a trail database always has — makeLoggerAutoModel declares
      // two of them. Without one the driver opens no index and this proves nothing.
      model Entry { id Int @id @default(autoincrement())  body String  createdAt DateTime @default(now())  @@db(logs)  @@index([body]) }
    `
    const db  = await createClient({ schema: src })
    const sys = db.asSystem()

    await sys.entry.create({ data: { body: 'old',   createdAt: ago(200) } })
    await sys.entry.create({ data: { body: 'fresh', createdAt: ago(1)   } })

    const file  = (await sys.$retain()).find((r: { model: string }) => r.model === 'Entry')!.table as string
    const index = file + '.index.db'
    expect(existsSync(index)).toBe(true)    // the compaction kept it

    // The survivor is findable THROUGH the index, which is the half that says
    // the offsets were rebuilt rather than merely left alone: the rewrite moved
    // 'fresh' to byte 0, and an index still holding its old offset would read a
    // different line or none.
    expect(await bodies(sys, 'entry')).toEqual(['fresh'])

    // The write that used to kill the process.
    await sys.entry.create({ data: { body: 'after', createdAt: ago(0) } })
    expect(existsSync(index)).toBe(true)
    expect(await bodies(sys, 'entry')).toEqual(['after', 'fresh'])

    // `FJS-540`'s guard, still standing: the driver notices an index removed
    // under it and opens a new one rather than throwing READONLY_DBMOVED.
    rmSync(index, { force: true })
    await sys.entry.create({ data: { body: 'later', createdAt: ago(0) } })
    expect(existsSync(index)).toBe(true)
  })
})

// A sweep is a DELETE, and a row that held a File held bytes outside SQLite.
// The ORM's delete hands its rows to the plugins and FileStorage removes the
// objects; the sweep's raw DELETE handed them to nothing, so the bytes a
// retention exists to forget were the ones it kept (FJS-1921).
describe('a swept row takes its files with it', () => {
  const FILE_SCHEMA = (dir: string) => `
    database main { path "${join(dir, 'app.db')}" }
    database raws { path "${join(dir, 'raws.db')}"  retention 30d }
    model Batch { id Int @id @default(autoincrement())  body File  createdAt DateTime @default(now())  @@db(raws) }
  `
  // What the store holds, by content, so the test does not depend on the key pattern.
  const stored = (dir: string) => {
    const root = join(dir, 'objects')
    if (!existsSync(root)) return []
    return (readdirSync(root, { recursive: true }) as string[])
      .filter(f => statSync(join(root, f)).isFile())
      .map(f => readFileSync(join(root, f), 'utf8')).sort()
  }

  async function open(dir: string) {
    const { FileStorage } = await import('../src/storage/file-storage.js')
    const files = FileStorage({ provider: 'local', localPath: join(dir, 'objects') })
    return createClient({ schema: FILE_SCHEMA(dir), plugins: [files] })
  }

  test('$retain() removes the object of every row it deletes, and only those', async () => {
    const dir = tmp()
    const db: any = await open(dir)
    const sys = db.asSystem()
    await sys.batch.create({ data: { body: Buffer.from('old'),   createdAt: ago(31) } })
    await sys.batch.create({ data: { body: Buffer.from('fresh'), createdAt: ago(1) } })
    expect(stored(dir)).toEqual(['fresh', 'old'])

    const swept = await sys.$retain()
    expect(swept.find((r: { model: string }) => r.model === 'Batch')?.removed).toBe(1)
    expect(stored(dir)).toEqual(['fresh'])
    db.$close()
  })

  test('the startup pass removes them too', async () => {
    const dir = tmp()
    const first: any = await open(dir)
    await first.asSystem().batch.create({ data: { body: Buffer.from('old'), createdAt: ago(31) } })
    expect(stored(dir)).toEqual(['old'])
    first.$close()

    const db: any = await open(dir)
    expect(await db.asSystem().batch.count()).toBe(0)
    expect(stored(dir)).toEqual([])
    db.$close()
  })
})

// A plugin that hears deletes makes the sweep read its doomed rows, and that
// read goes through the shared tables, which refuse outside any flavor. The
// batch catch turned the refusal into a warning and the sweep reported 0 on
// every retention table of an app with a File column anywhere (FJS-3552).
describe('a sweep a plugin hears runs as the system', () => {
  const SCHEMA = (dir: string) => `
    database main { path "${join(dir, 'app.db')}" }
    database sync { path "${join(dir, 'sync.db')}"  retention 30d }
    model Doc   { id Int @id @default(autoincrement())  body File }
    model Batch { id Int @id @default(autoincrement())  source String @system  createdAt DateTime @default(now())  @@db(sync) }
  `
  async function open(dir: string) {
    const { FileStorage } = await import('../src/storage/file-storage.js')
    return createClient({ schema: SCHEMA(dir), plugins: [FileStorage({ provider: 'local', localPath: join(dir, 'objects') })] })
  }

  test('$retain() off asSystem() removes the rows', async () => {
    const dir = tmp()
    const db: any = await open(dir)
    const sys = db.asSystem()
    await sys.batch.create({ data: { source: 'old',   createdAt: ago(31) } })
    await sys.batch.create({ data: { source: 'fresh', createdAt: ago(1) } })

    const swept = await sys.$retain()
    expect(swept.find((r: { model: string }) => r.model === 'Batch')).toMatchObject({ removed: 1 })
    expect(swept.some((r: { error?: string }) => r.error)).toBe(false)
    expect((await sys.batch.findMany()).map((b: { source: string }) => b.source)).toEqual(['fresh'])
    db.$close()
  })

  test('the startup pass removes them too', async () => {
    const dir = tmp()
    const first: any = await open(dir)
    await first.asSystem().batch.create({ data: { source: 'old', createdAt: ago(31) } })
    first.$close()

    const db: any = await open(dir)
    expect(await db.asSystem().batch.count()).toBe(0)
    db.$close()
  })
})

// The rows a foreign key's `onDelete: Cascade` takes are removed by SQLite inside
// the parent's own DELETE, so the sweep's RETURNING named the parent and nothing
// under it, and the child's object stayed in the store (FJS-2097). The ORM path
// reads the doomed children first through the cascade sinks (FJS-1497).
describe('a swept row takes its cascaded children\'s files with it', () => {
  const CASCADE_SCHEMA = (dir: string) => `
    database main { path "${join(dir, 'app.db')}"  retention 30d }
    model Batch {
      id Int @id @default(autoincrement())
      docs Doc[]
      createdAt DateTime @default(now())
    }
    model Doc {
      id Int @id @default(autoincrement())
      batch Batch @relation(fields: [batchId], references: [id], onDelete: Cascade)
      batchId Int
      body File
    }
  `
  const stored = (dir: string) => {
    const root = join(dir, 'objects')
    if (!existsSync(root)) return []
    return (readdirSync(root, { recursive: true }) as string[])
      .filter(f => statSync(join(root, f)).isFile())
      .map(f => readFileSync(join(root, f), 'utf8')).sort()
  }

  test('$retain() removes the object of a child the cascade deleted', async () => {
    const dir = tmp()
    const { FileStorage } = await import('../src/storage/file-storage.js')
    const files = FileStorage({ provider: 'local', localPath: join(dir, 'objects') })
    const db: any = await createClient({ schema: CASCADE_SCHEMA(dir), plugins: [files] })
    const sys = db.asSystem()
    const old   = await sys.batch.create({ data: { createdAt: ago(40) } })
    const fresh = await sys.batch.create({ data: { createdAt: ago(1) } })
    await sys.doc.create({ data: { batchId: old.id,   body: Buffer.from('old-doc') } })
    await sys.doc.create({ data: { batchId: fresh.id, body: Buffer.from('fresh-doc') } })
    expect(stored(dir)).toEqual(['fresh-doc', 'old-doc'])

    await sys.$retain()
    expect(await sys.doc.count()).toBe(1)
    expect(stored(dir)).toEqual(['fresh-doc'])
    db.$close()
  })
})

describe('the startup pass takes cascaded files too', () => {
  test('a reopened client has swept the child object', async () => {
    const dir = tmp()
    const { FileStorage } = await import('../src/storage/file-storage.js')
    const open = () => createClient({
      schema: `
        database main { path "${join(dir, 'app.db')}"  retention 30d }
        model Batch { id Int @id @default(autoincrement())  docs Doc[]  createdAt DateTime @default(now()) }
        model Doc {
          id Int @id @default(autoincrement())
          batch Batch @relation(fields: [batchId], references: [id], onDelete: Cascade)
          batchId Int
          body File
        }`,
      plugins: [FileStorage({ provider: 'local', localPath: join(dir, 'objects') })],
    }) as any
    const first = await open()
    const b = await first.asSystem().batch.create({ data: { createdAt: ago(40) } })
    await first.asSystem().doc.create({ data: { batchId: b.id, body: Buffer.from('old-doc') } })
    first.$close()

    const db = await open()
    expect(await db.asSystem().doc.count()).toBe(0)
    const root = join(dir, 'objects')
    const left = existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).filter(f => statSync(join(root, f)).isFile()) : []
    expect(left).toEqual([])
    db.$close()
  })
})

// A sweep was one DELETE over every doomed row, run by createClient before the
// app listened, and it first read every one of those rows into memory whenever
// ANY plugin was installed — a gate included, which has nothing to do with a
// delete. A year of rankings took 22.8 minutes to boot and 28 GB resident
// (FJS-2288).
describe('a sweep is batches that yield', () => {
  const BIG = (dir: string) => `
    database main { path "${join(dir, 'app.db')}"  retention 30d }
    model Reading { id Int @id @default(autoincrement())  v Int  createdAt DateTime @default(now()) }
  `
  // Rows straight into the file, since a backlog is what an existing table holds
  // the first time a window is declared over it.
  async function backlog(dir: string, n: number) {
    const db: any = await createClient({ schema: BIG(dir) })
    db.$close()
    const { Database } = await import('bun:sqlite')
    const raw = new Database(join(dir, 'app.db'))
    const ins = raw.prepare('INSERT INTO reading (v, createdAt) VALUES (?, ?)')
    raw.transaction(() => { for (let i = 0; i < n; i++) ins.run(i, ago(40)) })()
    ins.run(-1, ago(1))
    raw.close()
  }

  test('createClient does not wait for a backlog, and $retain() finishes it', async () => {
    const { RETENTION_BATCH } = await import('../src/core/retention.js')
    const dir = tmp()
    await backlog(dir, RETENTION_BATCH * 5 + 7)
    const db: any = await createClient({ schema: BIG(dir) })
    const sys = db.asSystem()
    // The boot's batch and the drain's first ran before createClient resolved;
    // the drain yields a macrotask between batches, so no third has yet.
    expect(await sys.reading.count()).toBeGreaterThanOrEqual(RETENTION_BATCH * 3)
    await sys.$retain()
    expect(await sys.reading.count()).toBe(1)
    db.$close()
  })

  test('a client closed while the backlog drains stops sweeping, quietly', async () => {
    const { RETENTION_BATCH } = await import('../src/core/retention.js')
    const dir = tmp()
    await backlog(dir, RETENTION_BATCH * 3)
    const warned: unknown[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { warned.push(a) }
    try {
      const db: any = await createClient({ schema: BIG(dir) })
      db.$close()
      await new Promise(r => setTimeout(r, 50))
    } finally { console.warn = warn }
    expect(warned).toEqual([])
  })

  test('each batch is its own statement, and the event loop runs between them', async () => {
    const { runSqliteRetention, RETENTION_BATCH } = await import('../src/core/retention.js')
    const { parse } = await import('../src/core/parser.js')
    const { Database } = await import('bun:sqlite')
    const raw = new Database(':memory:')
    raw.run('CREATE TABLE reading (id INTEGER PRIMARY KEY, v INT, createdAt TEXT)')
    const ins = raw.prepare('INSERT INTO reading (v, createdAt) VALUES (?, ?)')
    raw.transaction(() => { for (let i = 0; i < RETENTION_BATCH * 2 + 5; i++) ins.run(i, ago(40)) })()
    const models = parse(BIG('/tmp')).schema.models

    const heard: number[] = []
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 0)
    const swept = await runSqliteRetention(raw, models, '30d', {
      onRemoved: async (_m: string, rows: unknown[]) => { heard.push(rows.length) },
    })
    clearInterval(timer)
    expect(swept[0].removed).toBe(RETENTION_BATCH * 2 + 5)
    expect(heard).toEqual([RETENTION_BATCH, RETENTION_BATCH, 5])
    expect(ticks).toBeGreaterThan(0)
    raw.close()
  })

  test('rows are read only for a model something hears the delete of', async () => {
    const { runSqliteRetention } = await import('../src/core/retention.js')
    const { parse } = await import('../src/core/parser.js')
    const { Database } = await import('bun:sqlite')
    const raw = new Database(':memory:')
    raw.run('CREATE TABLE reading (id INTEGER PRIMARY KEY, v INT, createdAt TEXT)')
    raw.prepare('INSERT INTO reading (v, createdAt) VALUES (?, ?)').run(1, ago(40))
    const models = parse(BIG('/tmp')).schema.models
    const seen: string[] = []
    const spy = new Proxy(raw, { get: (t, k) => k === 'prepare' || k === 'query'
      ? (sql: string) => { seen.push(sql); return (t as any)[k](sql) }
      : (t as any)[k]?.bind?.(t) ?? (t as any)[k] })
    let called = 0
    await runSqliteRetention(spy, models, '30d', { hears: () => false, onRemoved: async () => { called++ } })
    expect(called).toBe(0)
    expect(seen.filter(s => /SELECT \*/.test(s))).toEqual([])
    expect(raw.query('SELECT count(*) AS n FROM reading').get()).toEqual({ n: 0 })
    raw.close()
  })

  test('a plugin hears deletes only when it answers them — the gate does not', async () => {
    const { PluginRunner, LitestonePlugin } = await import('../src/core/plugin.js')
    const { GatePlugin } = await import('../src/plugins/gate.js')
    class Listens extends LitestonePlugin { async onAfterDelete() {} }
    expect(new PluginRunner([new GatePlugin()]).hearsDeletes).toBe(false)
    expect(new PluginRunner([new LitestonePlugin()]).hearsDeletes).toBe(false)
    expect(new PluginRunner([new GatePlugin(), new Listens()]).hearsDeletes).toBe(true)
    expect(new PluginRunner([{ onAfterDelete: async () => {} }]).hearsDeletes).toBe(true)
  })
})

// A cascade sink used to hear whenever ANY plugin was installed, and the gate is
// one that answers neither a delete nor a write — so an ORM delete under a gate
// read every cascaded child to hand it to no one (FJS-2292).
describe('an ORM delete reads cascaded children only for what hears them', () => {
  const childReads = async (plugins: (LitestonePlugin: any) => unknown[]) => {
    const { Database } = await import('bun:sqlite')
    const { LitestonePlugin } = await import('../src/core/plugin.js')
    const db: any = await createClient({
      schema: `
        database main { path "${join(tmp(), 'app.db')}" }
        model Batch { id Int @id @default(autoincrement())  docs Doc[] }
        model Doc {
          id Int @id @default(autoincrement())
          batch Batch @relation(fields: [batchId], references: [id], onDelete: Cascade)
          batchId Int
        }
      `,
      plugins: plugins(LitestonePlugin) as any,
    })
    const sys = db.asSystem()
    const batch = await sys.batch.create({ data: {} })
    await sys.doc.create({ data: { batchId: batch.id } })
    const seen: string[] = []
    const { query, prepare } = Database.prototype
    Database.prototype.query = function (this: unknown, sql: string) { seen.push(sql); return query.call(this, sql) }
    Database.prototype.prepare = function (this: unknown, sql: string) { seen.push(sql); return prepare.call(this, sql) }
    try { await sys.batch.delete({ where: { id: batch.id } }) } finally { Object.assign(Database.prototype, { query, prepare }) }
    db.$close()
    return seen.filter(s => /SELECT \* FROM "doc"/.test(s)).length
  }

  test('the gate alone is not a listener', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    expect(await childReads(() => [new GatePlugin()])).toBe(0)
  })

  test('a plugin answering a delete is', async () => {
    expect(await childReads(P => [new (class extends P { async onAfterDelete() {} })()])).toBe(1)
  })

  test('a plugin answering a write is, since SetNull is an update it hears', async () => {
    expect(await childReads(P => [new (class extends P { async onAfterWrite() {} })()])).toBe(1)
  })
})

// The delete's OWN-row prefetch fired for any installed plugin, so a bulk delete
// under a gate selected the rows it handed to no listener (FJS-2293).
describe('an ORM delete reads its own rows only for what hears them', () => {
  const ownReads = async (plugins: (LitestonePlugin: any) => unknown[], cascade = false) => {
    const { Database } = await import('bun:sqlite')
    const { LitestonePlugin } = await import('../src/core/plugin.js')
    const db: any = await createClient({
      schema: `
        database main { path "${join(tmp(), 'app.db')}" }
        model Batch { id Int @id @default(autoincrement())  docs Doc[] }
        model Doc {
          id Int @id @default(autoincrement())
          batch Batch @relation(fields: [batchId], references: [id], ${cascade ? 'onDelete: Cascade' : 'onDelete: Restrict'})
          batchId Int
        }
      `,
      plugins: plugins(LitestonePlugin) as any,
    })
    const sys = db.asSystem()
    const batch = await sys.batch.create({ data: {} })
    const seen: string[] = []
    const { query, prepare } = Database.prototype
    Database.prototype.query = function (this: unknown, sql: string) { seen.push(sql); return query.call(this, sql) }
    Database.prototype.prepare = function (this: unknown, sql: string) { seen.push(sql); return prepare.call(this, sql) }
    try { await sys.batch.deleteMany({ where: { id: batch.id } }) } finally { Object.assign(Database.prototype, { query, prepare }) }
    db.$close()
    return seen.filter(s => /^\s*SELECT .* FROM "batch"/.test(s)).length
  }

  test('the gate alone is not a listener', async () => {
    const { GatePlugin } = await import('../src/plugins/gate.js')
    expect(await ownReads(() => [new GatePlugin()])).toBe(0)
  })

  test('a plugin answering a delete is', async () => {
    expect(await ownReads(P => [new (class extends P { async onAfterDelete() {} })()])).toBe(1)
  })
})

// FJS-2290: a sweep frees pages that stay in the file. A window grows the file to
// its high-water mark unless the database was created able to hand pages back.
describe('a sweep hands its pages back', () => {
  const pages = (path: string) => {
    const raw = new BunDatabase(path)
    try {
      return {
        mode: raw.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number },
        free: (raw.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
      }
    } finally { raw.close() }
  }

  test('a database declaring a window is created incremental, and its free pages are reclaimed', async () => {
    const dir  = tmp()
    const path = join(dir, 'app.db')
    const db   = await createClient({ schema: SCHEMA(dir) })
    const sys  = db.asSystem()
    const pad  = 'x'.repeat(2000)
    for (let i = 0; i < 300; i++) await sys.log.create({ data: { body: pad, createdAt: ago(200) } })
    await sys.log.create({ data: { body: 'fresh', createdAt: ago(2) } })

    const swept = await sys.$retain()
    expect(swept.find((r: any) => r.model === 'Log')?.removed).toBe(300)

    const after = pages(path)
    expect(after.mode.auto_vacuum).toBe(2)
    expect(after.free).toBeLessThan(10)
    db.$close()
  })

  test('a database with no window keeps the default', async () => {
    const dir  = tmp()
    const path = join(dir, 'plain.db')
    const db   = await createClient({ schema: `database main { path "${path}" }\nmodel Log { id Int @id @default(autoincrement())  body String }` })
    await db.asSystem().log.create({ data: { body: 'x' } })
    expect(pages(path).mode.auto_vacuum).toBe(0)
    db.$close()
  })
})
