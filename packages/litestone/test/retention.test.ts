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
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
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
  const db  = await createClient({ schema: SCHEMA(dir), autoMigrate: true })
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
    const swept = sys.$retain()

    expect(await bodies(sys, 'auditEvent')).toEqual(['fresh'])
    expect(swept.find((r: { model: string }) => r.model === 'AuditEvent'))
      .toMatchObject({ table: 'audit_event', removed: 1 })
  })

  test('the single-word control is swept too, as it always was', async () => {
    const { sys } = await seeded()
    sys.$retain()
    expect(await bodies(sys, 'log')).toEqual(['fresh'])
  })

  test('a model with no createdAt is left alone rather than failing', async () => {
    const { sys } = await seeded()
    const swept = sys.$retain()
    expect(swept.some((r: { model: string }) => r.model === 'Setting')).toBe(false)
    expect((await sys.setting.findMany()).length).toBe(1)
  })
})

describe('$retain() — because startup is not a schedule', () => {
  test('sweeps rows that aged past the window AFTER the client opened', async () => {
    const dir = tmp()
    const db  = await createClient({ schema: SCHEMA(dir), autoMigrate: true })
    const sys = db.asSystem()

    // Nothing to do at boot, which is the state a long-lived server is in every
    // day after the deploy. The row is written already stale.
    await sys.auditEvent.create({ data: { body: 'stale', createdAt: ago(200) } })
    expect((await sys.auditEvent.findMany()).length).toBe(1)

    expect(sys.$retain().find((r: { model: string }) => r.model === 'AuditEvent')?.removed).toBe(1)
    expect((await sys.auditEvent.findMany()).length).toBe(0)
  })

  test('answers one row per table it touched, and is quiet when there is nothing', async () => {
    const { sys } = await seeded()
    sys.$retain()
    const second = sys.$retain()
    expect(second.every((r: { removed: number }) => r.removed === 0)).toBe(true)
    expect(second.map((r: { model: string }) => r.model).sort()).toEqual(['AuditEvent', 'Log'])
  })

  test('the cutoff is a rolling instant, so a row inside the window stays', async () => {
    const dir = tmp()
    const db  = await createClient({ schema: SCHEMA(dir), autoMigrate: true })
    const sys = db.asSystem()
    // 89 days and 23 hours: inside 90 flat days from NOW, whatever the calendar
    // or the zone would say about it.
    await sys.log.create({ data: { body: 'just-inside', createdAt: new Date(Date.now() - (90 * 86_400_000 - 3_600_000)).toISOString() } })
    sys.$retain()
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
    const db  = await createClient({ schema: src, autoMigrate: true })
    const sys = db.asSystem()

    await sys.entry.create({ data: { body: 'old',   createdAt: ago(200) } })
    await sys.entry.create({ data: { body: 'fresh', createdAt: ago(1)   } })
    expect((await sys.entry.findMany()).length).toBe(2)

    const swept = sys.$retain()
    expect(swept.find((r: { model: string }) => r.model === 'Entry')?.removed).toBe(1)

    const file = swept.find((r: { model: string }) => r.model === 'Entry')!.table as string
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('"old"')
  })

  // The compaction rewrites the file, so every byte offset the companion index
  // holds is wrong — it is deleted and, the comment said, "rebuilt lazily".
  // Nothing rebuilt it. SQLite marks a connection readonly when its file is
  // unlinked underneath, so the next append threw `SQLITE_READONLY_DBMOVED`
  // from inside the driver, on the audit path, which is fire-and-forget: the
  // request that caused it answered 201 and the process died a tick later
  // (`FJS-540`). The sweep only removes anything once the oldest row is past
  // the window, so it is a crash on the first night after a deployment's
  // retention period elapses, with nothing in the request log.
  //
  // The test above cannot see it because it never writes again afterwards,
  // which is the whole of why this one sits beside it rather than inside it.
  test('the driver keeps working after a sweep has deleted its index', async () => {
    const dir = tmp()
    const src = `
      database main { path "${join(tmp(), 'app.db')}" }
      database logs { path "${join(dir, 'logs/')}"  driver jsonl  retention 90d }
      // An @@index is what puts a companion index.db beside the file, and it is
      // the shape a logger database always has — makeLoggerAutoModel declares
      // two of them. Without one the driver opens no index and this proves nothing.
      model Entry { id Int @id @default(autoincrement())  body String  createdAt DateTime @default(now())  @@db(logs)  @@index([body]) }
    `
    const db  = await createClient({ schema: src, autoMigrate: true })
    const sys = db.asSystem()

    await sys.entry.create({ data: { body: 'old',   createdAt: ago(200) } })
    await sys.entry.create({ data: { body: 'fresh', createdAt: ago(1)   } })

    const file  = sys.$retain().find((r: { model: string }) => r.model === 'Entry')!.table as string
    const index = file + '.index.db'
    expect(existsSync(index)).toBe(false)   // the compaction took it

    // The write that used to kill the process.
    await sys.entry.create({ data: { body: 'after', createdAt: ago(0) } })
    expect(existsSync(index)).toBe(true)    // …and put it back

    // Both halves still answer: the row written after the sweep, and the one
    // that survived it. A reopen that lost the survivors would be a different
    // bug wearing this one's fix.
    expect(await bodies(sys, 'entry')).toEqual(['after', 'fresh'])
  })
})
