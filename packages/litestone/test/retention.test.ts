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

  test('a model with no createdAt is left alone rather than failing', async () => {
    const { sys } = await seeded()
    const swept = await sys.$retain()
    expect(swept.some((r: { model: string }) => r.model === 'Setting')).toBe(false)
    expect((await sys.setting.findMany()).length).toBe(1)
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
    expect(second.map((r: { model: string }) => r.model).sort()).toEqual(['AuditEvent', 'Log'])
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
