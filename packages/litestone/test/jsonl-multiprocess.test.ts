// The audit trail with more than one process writing it (`FJS-665`).
//
// A `driver logger` database is schema-global — every tenant's client and every
// process appends to one file and one companion index — and `docs/concurrency.md`
// recommends running a second process. Three things were wrong with that, and
// each destroys a trail rather than inconveniencing it.
//
// **These run REAL processes.** Every one of the three needs two writers racing
// on one file, which is the one thing a single-process test cannot stage: the
// window is between two adjacent syscalls, and nothing inside one event loop can
// sit in it. Measured on the pre-fix code, and the numbers are in `CHANGES.md`.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { createClient } from '../src/index.js'
import { openIndexDb, withWriteLock, indexPathFor } from '../src/drivers/jsonl-index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fjs-mp-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const SCHEMA = (dir: string) => `
  database main  { path "${join(dir, 'main.db')}" }
  database trail { path "${join(dir, 'trail.jsonl')}"  driver jsonl }
  model Note  { id Int @id  body String }
  model Entry {
    id      String @id @default(uuid())
    actorId String
    body    String
    @@db(trail)
    @@index([actorId])
  }`

/** A child process that appends `n` rows as `tag`, through the real driver. */
function writerSource(dir: string, tag: string, n: number) {
  return `
    import { createClient } from ${JSON.stringify(join(HERE, '../src/index.js'))}
    const db = await createClient({ db: ${JSON.stringify(join(dir, 'main.db'))},
      schema: ${JSON.stringify(SCHEMA(dir))} })
    const sys = db.asSystem()
    for (let i = 0; i < ${n}; i++) await sys.entry.create({ data: { actorId: '${tag}', body: '${tag}' + i } })
  `
}

function runWriters(dir: string, tags: string[], n: number) {
  const files = tags.map(tag => {
    const f = join(dir, `w-${tag}.mjs`)
    writeFileSync(f, writerSource(dir, tag, n))
    return f
  })
  // Spawned together, then all awaited — `spawnSync` per file would serialise
  // them and prove nothing, which is the whole point of the file.
  const script = files.map(f => `bun ${JSON.stringify(f)} &`).join('\n') + '\nwait\n'
  const sh = join(dir, 'run.sh')
  writeFileSync(sh, script)
  return spawnSync('bash', [sh], { encoding: 'utf8', timeout: 120_000 })
}

describe('many processes appending to one trail', () => {

  // `statSync(f).size` then `appendFileSync` is two syscalls, so a second
  // process appending between them makes the recorded offset name the OTHER
  // writer's line. Measured pre-fix at 1,999 of 8,000 — one in four — and an
  // indexed read then answers the wrong record with NO error, which for an audit
  // trail is the worst failure there is.
  test('every indexed row points at its own line, not another writer\'s', async () => {
    const dir  = tmp()
    const tags = ['A', 'B', 'C', 'D']
    const res  = runWriters(dir, tags, 150)
    expect(res.status).toBe(0)

    const file = join(dir, 'trail.jsonl')
    const disk = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    // Nothing was lost on the way in — a driver that dropped writes would make
    // every assertion below vacuous.
    expect(disk).toHaveLength(tags.length * 150)

    const db  = await createClient({ db: join(dir, 'main.db'), schema: SCHEMA(dir) })
    const sys = db.asSystem()
    for (const tag of tags) {
      const rows = await sys.entry.findMany({ where: { actorId: tag } })
      expect(rows).toHaveLength(150)
      // The assertion that fails on the old code: an offset naming another
      // writer's line reads back a row whose actorId is somebody else's.
      expect(rows.filter((r: { actorId: string } | null) => !r || r.actorId !== tag)).toHaveLength(0)
    }
  }, 120_000)

  // The index is the most contended database an app has. Under a rollback
  // journal, 8 concurrent writers killed 2 of 8 outright on the DDL that ran on
  // every open, and dropped 12 rows to SQLITE_BUSY with a worst insert of
  // 5,007 ms. The DDL is skipped when the table is already right, and the
  // sidecar is in WAL.
  test('no writer is killed and no row is dropped', async () => {
    const dir = tmp()
    const res = runWriters(dir, ['A', 'B', 'C', 'D', 'E', 'F'], 120)

    expect(res.status).toBe(0)
    expect(res.stderr).not.toMatch(/SQLITE_BUSY/)
    expect(res.stderr).not.toMatch(/database is locked/)

    const disk = readFileSync(join(dir, 'trail.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(disk).toHaveLength(6 * 120)
  }, 120_000)

  // `journal_mode = WAL` is persistent, so opening an index an older build wrote
  // is the migration — and it needs a moment with no other connection, which a
  // rolling deploy is exactly when there is not one. Measured against a live
  // reader before this: the switch waited the whole `busy_timeout` and then
  // threw, **5,008 ms and an exception at boot on the audit path**.
  test('an index an older build wrote upgrades, and never fails the open to do it', async () => {
    const dir = tmp()
    const path = join(dir, 'legacy.index.db')
    const old  = new Database(path)
    old.run('PRAGMA busy_timeout = 5000')
    old.run('CREATE TABLE idx (id TEXT PRIMARY KEY) STRICT')
    expect((old.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete')
    old.run('BEGIN'); old.query('SELECT * FROM idx').all()      // an old process, mid-read

    const t0 = Date.now()
    const held = openIndexDb(path, 5000)                        // must not throw
    const took = Date.now() - t0
    try {
      // It gave up quickly rather than waiting out the caller's timeout, and it
      // is usable — correctness here is the lock, not the journal mode.
      expect(took).toBeLessThan(2000)
      expect((held.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000)
    } finally { held.close() }

    old.run('ROLLBACK'); old.close()
    const free = openIndexDb(path, 5000)                        // nobody holding it now
    try {
      expect((free.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    } finally { free.close() }
  })

  test('the sidecar is in WAL, which is what makes taking its lock affordable', async () => {
    const dir = tmp()
    const db  = await createClient({ db: join(dir, 'main.db'), schema: SCHEMA(dir) })
    await db.asSystem().entry.create({ data: { actorId: 'a', body: 'b' } })

    const idx = openIndexDb(indexPathFor(join(dir, 'trail.jsonl')))
    try {
      expect((idx.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    } finally { idx.close() }
  })
})

describe('the lock', () => {

  // The lock is a transaction rather than a lockfile because a lockfile has no
  // answer for a writer that dies holding it. This is the property that buys:
  // the OS drops a dead process's file locks, so the next writer proceeds.
  test('a process that dies holding it does not block the next writer', async () => {
    const dir = tmp()
    const db  = await createClient({ db: join(dir, 'main.db'), schema: SCHEMA(dir) })
    await db.asSystem().entry.create({ data: { actorId: 'a', body: 'first' } })

    const idxPath = indexPathFor(join(dir, 'trail.jsonl'))
    const killer  = join(dir, 'die.mjs')
    writeFileSync(killer, `
      import { openIndexDb } from ${JSON.stringify(join(HERE, '../src/drivers/jsonl-index.js'))}
      const db = openIndexDb(${JSON.stringify(idxPath)})
      db.run('BEGIN IMMEDIATE')
      db.run('CREATE TABLE IF NOT EXISTS _held (x INTEGER)')
      process.kill(process.pid, 'SIGKILL')      // dies holding the write lock
    `)
    spawnSync('bun', [killer], { timeout: 30_000 })

    // Not merely "no error" — the row has to actually land, or a swallowed
    // failure would pass.
    await db.asSystem().entry.create({ data: { actorId: 'a', body: 'second' } })
    const rows = await db.asSystem().entry.findMany({ where: { actorId: 'a' } })
    expect(rows.map((r: { body: string }) => r.body).sort()).toEqual(['first', 'second'])
  }, 60_000)

  test('it is re-entrant, so a caller already holding it is not a nested BEGIN', () => {
    const dir = tmp()
    const db  = openIndexDb(join(dir, 'lock.db'))
    try {
      const out = withWriteLock(db, () => withWriteLock(db, () => 'inner ran'))
      expect(out).toBe('inner ran')
      expect(db.inTransaction).toBe(false)      // and it was released
    } finally { db.close() }
  })
})

describe('compaction', () => {

  // `readFileSync` → filter → `writeFileSync` over the same path, with nothing
  // excluding a writer: every line appended between the read and the write was
  // discarded. Measured pre-fix, one 681 ms compaction against one appender:
  // **4,637 rows destroyed**, as a contiguous hole with the first and last rows
  // present — so nothing anywhere reported a thing.
  //
  // The read is inside the lock, not just the write. Locking the write alone
  // leaves the window where it was and makes it WIDER, because compaction then
  // waits for the lock while the writer keeps appending: measured at a 297-row
  // gap.
  test('a writer appending during a compaction loses nothing', async () => {
    const dir  = tmp()
    const file = join(dir, 'trail.jsonl')

    // Seeded straight to disk: 30k lines is enough that the read and rewrite
    // take long enough for the appends below to land inside them.
    let buf = ''
    for (let i = 0; i < 30_000; i++) buf += JSON.stringify({ id: `old-${i}`, actorId: 'old', body: 'x'.repeat(160) }) + '\n'
    writeFileSync(file, buf)

    const db  = await createClient({ db: join(dir, 'main.db'), schema: SCHEMA(dir) })
    const sys = db.asSystem()
    await sys.entry.findMany({ where: { actorId: 'old' }, limit: 1 })   // build the index warm

    // A child appends while this process compacts. It signals readiness so the
    // compaction lands mid-flight rather than before it or after it.
    const w = join(dir, 'append.mjs')
    writeFileSync(w, `
      import { createClient } from ${JSON.stringify(join(HERE, '../src/index.js'))}
      import { writeFileSync } from 'node:fs'
      const db = await createClient({ db: ${JSON.stringify(join(dir, 'main.db'))}, schema: ${JSON.stringify(SCHEMA(dir))} })
      const sys = db.asSystem()
      writeFileSync(${JSON.stringify(join(dir, '.ready'))}, '1')
      let n = 0
      const until = Date.now() + 2500
      while (Date.now() < until) await sys.entry.create({ data: { actorId: 'new', body: 'n' + n++ } })
      writeFileSync(${JSON.stringify(join(dir, '.wrote'))}, String(n))
    `)
    const sh = join(dir, 'go.sh')
    writeFileSync(sh, `bun ${JSON.stringify(w)} &\nwait\n`)
    const child = Bun.spawn(['bash', sh])

    while (!existsSync(join(dir, '.ready'))) await new Promise(r => setTimeout(r, 5))
    await new Promise(r => setTimeout(r, 400))
    const { compactJsonl } = await import('../src/tools/retention.js')
    const model = (db as { $schema: { models: { name: string }[] } }).$schema.models.find(m => m.name === 'Entry')
    compactJsonl(file, model, null, '256kb', Date.now)
    await child.exited

    const wrote = Number(readFileSync(join(dir, '.wrote'), 'utf8'))
    expect(wrote).toBeGreaterThan(100)          // the overlap has to be real

    // Size compaction keeps the NEWEST bytes, so the survivors must be a
    // contiguous suffix. A GAP is the race — rows appended between the read and
    // the write-back, discarded by the rewrite.
    const ns = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l)).filter((r: { actorId: string }) => r.actorId === 'new')
      .map((r: { body: string }) => Number(r.body.slice(1))).sort((a: number, b: number) => a - b)
    let gaps = 0
    for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) gaps++
    expect(gaps).toBe(0)
    expect(ns[ns.length - 1]).toBe(wrote - 1)   // the last row written is there
  }, 120_000)

  // The rewrite is a temp file plus `rename`. `writeFileSync` over the path
  // truncates first, so a crash inside it leaves a truncated trail and a
  // concurrent reader sees a half-written file.
  test('it leaves no temp file behind', async () => {
    const dir  = tmp()
    const file = join(dir, 'trail.jsonl')
    let buf = ''
    for (let i = 0; i < 400; i++) buf += JSON.stringify({ id: `old-${i}`, actorId: 'old', body: 'x'.repeat(200) }) + '\n'
    writeFileSync(file, buf)

    const db = await createClient({ db: join(dir, 'main.db'), schema: SCHEMA(dir) })
    const { compactJsonl } = await import('../src/tools/retention.js')
    const model = (db as { $schema: { models: { name: string }[] } }).$schema.models.find(m => m.name === 'Entry')
    const res = compactJsonl(file, model, null, '8kb', Date.now)

    expect(res?.removed).toBeGreaterThan(0)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([])
  })
})

describe('an index beside a file that already has lines', () => {

  // `drifted` is false when there is no table at all, so an index CREATED beside
  // an existing trail stayed empty and every indexed read answered nothing —
  // which reads as an empty log. The old compaction unlinked the index on every
  // sweep, so that was the state a trail reached the first night its retention
  // elapsed.
  test('is filled from the file rather than created empty', async () => {
    const dir  = tmp()
    const file = join(dir, 'trail.jsonl')
    for (let i = 0; i < 50; i++)
      appendFileSync(file, JSON.stringify({ id: `seed-${i}`, actorId: 'seeded', body: `b${i}` }) + '\n')
    expect(existsSync(indexPathFor(file))).toBe(false)

    const db  = await createClient({ db: join(dir, 'main.db'), schema: SCHEMA(dir) })
    const sys = db.asSystem()
    const rows = await sys.entry.findMany({ where: { actorId: 'seeded' } })

    expect(rows).toHaveLength(50)
    expect(rows.filter((r: { actorId: string } | null) => !r || r.actorId !== 'seeded')).toHaveLength(0)
  })
})
