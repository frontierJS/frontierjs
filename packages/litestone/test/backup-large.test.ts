// FJS-2802 — serialize() materializes the whole database, so a file too big
// for memory must take the VACUUM INTO arm, which streams.
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupSqliteTo, readBackupStamp } from '../src/core/backup.js'

// A handle whose serialize() fails the way a 4.5 GB file does.
function oomOnSerialize(db: Database) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'serialize') return () => { throw new Error('Out of memory') }
      const v = (target as any)[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

describe('backupSqliteTo — size arm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ls-backup-large-'))

  test('a database over maxSerializeBytes is copied by VACUUM INTO, not serialize()', async () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.run(`INSERT INTO t (v) VALUES ('a'), ('b')`)
    const dest = join(dir, 'big.db')
    await backupSqliteTo(oomOnSerialize(db) as any, dest, { maxSerializeBytes: 0 })
    expect(existsSync(dest)).toBe(true)
    const copy = new Database(dest, { readonly: true })
    expect((copy.query('SELECT COUNT(*) n FROM t').get() as any).n).toBe(2)
    copy.close()
    db.close()
  })

  test('a small database still takes serialize()', async () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const dest = join(dir, 'small.db')
    await expect(backupSqliteTo(oomOnSerialize(db) as any, dest)).rejects.toThrow('Out of memory')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
