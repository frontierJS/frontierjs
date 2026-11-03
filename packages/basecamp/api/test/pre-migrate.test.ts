// test/pre-migrate.test.ts
// The copy boot takes before it migrates (`FJS-3907`), over a real file and
// litestone's real `apply()`. The migrations are two of this file's own, so
// the cases do not move when the app's history does.

import { test, expect, beforeEach } from 'bun:test'
import { Database }  from 'bun:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir }    from 'node:os'
import { join }      from 'node:path'
import { apply }     from '@frontierjs/litestone/migrations'
import { copyBeforeMigrating, preMigrateDir, PRE_MIGRATE_KEEP } from '../src/domain/backup/pre-migrate.ts'

const log = { info() {} }
let root: string, dbPath: string, migrations: string

const migration = (name: string, sql: string) => writeFileSync(join(migrations, name), sql)
const tables    = (path: string) => {
  const db = new Database(path, { readonly: true })
  try { return (db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(r => r.name).filter(n => !/^(_|sqlite_)/.test(n)).sort() }
  finally { db.close() }
}

beforeEach(() => {
  root       = mkdtempSync(join(tmpdir(), 'pre-migrate-'))
  dbPath     = join(root, 'basecamp.db')
  migrations = join(root, 'migrations')
  mkdirSync(migrations)
  migration('20260101000000_first.sql', 'CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT);')
})

test('a first boot has nothing to protect, so nothing is copied', () => {
  const db = new Database(dbPath)
  expect(copyBeforeMigrating(db, dbPath, migrations, log)).toBeNull()
  db.close()
})

test('a database with nothing pending is not copied', async () => {
  const db = new Database(dbPath)
  await apply(db, migrations)
  expect(copyBeforeMigrating(db, dbPath, migrations, log)).toBeNull()
  db.close()
})

test('a pending migration over applied ones is copied first, and the copy is the database before it', async () => {
  const db = new Database(dbPath)
  await apply(db, migrations)
  db.run(`INSERT INTO lead (name) VALUES ('kept')`)
  chmodSync(dbPath, 0o600)
  migration('20260102000000_second.sql', 'CREATE TABLE deal (id INTEGER PRIMARY KEY);')

  const copy = copyBeforeMigrating(db, dbPath, migrations, log)!
  await apply(db, migrations)
  db.close()

  expect(copy.startsWith(preMigrateDir(dbPath))).toBe(true)
  expect(statSync(copy).mode & 0o777).toBe(statSync(dbPath).mode & 0o777)
  expect(tables(copy)).toEqual(['lead'])
  expect(tables(dbPath)).toEqual(['deal', 'lead'])
  const kept = new Database(copy, { readonly: true })
  expect(kept.query('SELECT name FROM lead').all()).toEqual([{ name: 'kept' }])
  kept.close()
})

test(`only the newest ${PRE_MIGRATE_KEEP} copies are kept`, async () => {
  const db = new Database(dbPath)
  await apply(db, migrations)
  migration('20260102000000_second.sql', 'CREATE TABLE deal (id INTEGER PRIMARY KEY);')
  const made: string[] = []
  for (let i = 0; i < PRE_MIGRATE_KEEP + 2; i++) {
    made.push(copyBeforeMigrating(db, dbPath, migrations, log)!)
    await Bun.sleep(2)
  }
  db.close()
  expect(readdirSync(preMigrateDir(dbPath)).sort()).toEqual(made.slice(-PRE_MIGRATE_KEEP).map(p => p.split('/').pop()!).sort())
})

test('a copy that cannot be written stops the boot before anything is migrated', async () => {
  const db = new Database(dbPath)
  await apply(db, migrations)
  migration('20260102000000_second.sql', 'CREATE TABLE deal (id INTEGER PRIMARY KEY);')
  // A file where the directory should be: mkdir refuses, and nothing is applied.
  writeFileSync(preMigrateDir(dbPath), '')
  expect(() => copyBeforeMigrating(db, dbPath, migrations, log)).toThrow()
  db.close()
  expect(tables(dbPath)).toEqual(['lead'])
})
