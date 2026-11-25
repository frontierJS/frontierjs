// The ops writes are system-only (FJS-D2363, FJS-4621): $backup, $rotateKey,
// $attach and $detach copy, re-key or rewire the database file under no
// access rule, so only asSystem() runs them — the same line $retain holds.
// Root $db is refused where raw SQL is (FJS-D52: the schema declares access
// rules); a scoped client never hands out the raw handle.
//
// The lists below are written out rather than read from client.js, so a
// method added to the system client fails the walk until somebody says which
// side of the line it is on (FJS-597).

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ls-sysonly-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const KEY = 'a'.repeat(64)

const GATED = `
model Note {
  id   Int @id @default(autoincrement())
  body String
  @@allow(all, auth() != null)
}
`
const OPEN = `
model Note {
  id   Int @id @default(autoincrement())
  body String
}
`

const REFUSED  = ['$backup', '$rotateKey', '$attach', '$detach', '$retain']
const READABLE = ['$walStatus', '$backupStamp', '$clearBackupStamp', '$ping', '$schemaGaps']

async function client(schema: string) {
  const dir = tmp()
  const db  = await createClient({ schema, db: join(dir, 'app.db'), encryptionKey: KEY })
  return { db, dir }
}

describe('the ops writes refuse every client but asSystem()', () => {
  for (const name of ['$backup', '$rotateKey', '$attach', '$detach']) {
    test(`${name} is refused on the root, $setAuth and $scopedBy clients, naming asSystem()`, async () => {
      const { db } = await client(OPEN)
      for (const c of [db, db.$setAuth({ id: 7 }), db.$scopedBy({})]) {
        const fn = (c as any)[name]
        expect(typeof fn).toBe('function')
        expect(() => fn('x', 'x')).toThrow(`db.asSystem().${name}(`)
      }
    })
  }

  test('a scoped client writes no backup', async () => {
    const { db, dir } = await client(OPEN)
    const dest = join(dir, 'leak.db')
    expect(() => (db.$setAuth({ id: 7 }) as any).$backup(dest)).toThrow(/asSystem/)
    expect(existsSync(dest)).toBe(false)
  })

  test('asSystem() runs them, and $attach still chains on the system client', async () => {
    const { db, dir } = await client(OPEN)
    const sys = db.asSystem() as any
    await sys.$backup(join(dir, 'ok.db'))
    expect(existsSync(join(dir, 'ok.db'))).toBe(true)
    const again = sys.$attach(join(dir, 'ok.db'), 'a1')
    expect(again).toBe(sys)
    sys.$detach('a1')
    await sys.$rotateKey('b'.repeat(64))
  })

  test('the readable ops stay readable on a scoped client', async () => {
    const { db } = await client(OPEN)
    const c = db.$setAuth({ id: 7 }) as any
    expect(() => c.$walStatus()).not.toThrow()
    expect(() => c.$ping()).not.toThrow()
    expect(() => c.$backupStamp()).not.toThrow()
  })
})

describe('the raw $db handle', () => {
  test('refused on a scoped client whatever the schema', async () => {
    const { db } = await client(OPEN)
    expect(() => (db.$setAuth({ id: 7 }) as any).$db).toThrow(/db\.asSystem\(\)\.\$db/)
    expect(() => (db.$scopedBy({}) as any).$db).toThrow(/db\.asSystem\(\)\.\$db/)
  })

  test('refused on the root client once the schema declares access rules', async () => {
    const { db } = await client(GATED)
    expect(() => (db as any).$db).toThrow(/access rules/)
    expect((db.asSystem() as any).$db).toBeTruthy()
  })

  test('handed out on the root client of a schema with none', async () => {
    const { db } = await client(OPEN)
    expect((db as any).$db).toBeTruthy()
  })
})

describe('every system method is on one side of the line', () => {
  test('each $-method of asSystem() is refused or readable on a scoped client', async () => {
    const { db } = await client(OPEN)
    const sys = db.asSystem() as any
    const scoped = db.$setAuth({ id: 7 }) as any
    const fns = Reflect.ownKeys(sys)
      .filter((k): k is string => typeof k === 'string' && k.startsWith('$'))
      .filter(k => { try { return typeof sys[k] === 'function' } catch { return false } })
    const unclassified = fns.filter(k => !REFUSED.includes(k) && !READABLE.includes(k) && !SHARED.includes(k))
    expect(unclassified).toEqual([])
    for (const k of REFUSED) expect(() => scoped[k]('x', 'x')).toThrow(/asSystem/)
  })
})

// Methods that read or plan through the caller's own rules, so every flavor
// has its own and none is an ops write.
const SHARED = [
  '$transaction', '$search', '$hold', '$lock', '$locks', '$close', '$checkWhere', '$checkOrderBy',
  '$protectedFields', '$trailMarks', '$primaryKey', '$mirrorKey', '$tenantPath', '$declaresAccessRules',
  '$capabilitiesFor', '$claimsFor', '$readAs', '$checkWrite', '$readGrading', '$readReach', '$readColumns',
  '$fromColumns', '$fromReach', '$inWindow', '$now', '$levelOf', '$softDelete', '$commitments', '$scopes',
  '$audit', '$enums', '$plugins', '$files', '$tenancy', '$schema', '$setAuth', '$scopedBy',
]
