// core/schema-apply.js — FJS-1797. An install command that pushes into an app
// with a migration history leaves a table in app.db and in no file, and the
// next `db:migrate` refuses it.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir }                                                      from 'node:os'
import { join, resolve }                                               from 'node:path'
import { hasMigrationHistory, schemaApplyStep }                        from '../core/schema-apply.js'

const roots = []
const dbDir = (files = []) => {
  const root = mkdtempSync(join(tmpdir(), 'fli-apply-'))
  roots.push(root)
  const db = join(root, 'db')
  mkdirSync(db)
  for (const f of files) {
    mkdirSync(join(db, 'migrations', 'main'), { recursive: true })
    writeFileSync(join(db, 'migrations', 'main', f), '-- sql\n')
  }
  return db
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

test('no migrations directory is no history, and an empty one is too', () => {
  expect(hasMigrationHistory(dbDir())).toBe(false)
  const db = dbDir()
  mkdirSync(join(db, 'migrations', 'main'), { recursive: true })
  expect(hasMigrationHistory(db)).toBe(false)
})

test('an app with a migration history gets a migration, never a push', () => {
  const step = schemaApplyStep(dbDir(['20260801000000_initial_schema.sql']), 'outbox')
  expect(step.kind).toBe('migrate')
  expect(step.argv).toBe('migrate dev outbox --schema db/schema.lite')
  expect(step.argv).not.toContain('db push')
})

test('an app with no history keeps the push, which has nothing to fall behind', () => {
  const step = schemaApplyStep(dbDir(), 'auth')
  expect(step.kind).toBe('push')
  expect(step.argv).toBe('db push --schema db/schema.lite')
})

test('every install command lands its schema through schemaApplyStep', () => {
  for (const name of ['outbox', 'backfill', 'auth']) {
    const text = readFileSync(resolve(import.meta.dir, `../commands/${name}/install.md`), 'utf8')
    expect(text).toContain('schemaApplyStep(')
    expect(text).not.toMatch(/litestone db push/)
  }
})

test('the printed outbox wiring names the scaffold\'s file and the $ spelling', () => {
  const text = readFileSync(resolve(import.meta.dir, '../commands/outbox/install.md'), 'utf8')
  expect(text).not.toContain('server.ts')
  expect(text).not.toContain('ctx.locals')
  expect(text).not.toContain('jobsDir')
})
