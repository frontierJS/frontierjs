// api/test/migrate.test.ts
// Boot brings both databases to db/migrations/ (FJS-4627), over the real
// schema and real files in a temp directory: a fresh pair is built whole, and a
// migration pending on chat.db is applied after a copy is taken.

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@frontierjs/litestone'
import { migrateAtBoot } from '../src/core/migrate.ts'

const SCHEMA     = new URL('../../db/schema.lite', import.meta.url).pathname
const MIGRATIONS = new URL('../../db/migrations', import.meta.url).pathname
const LAST_CHAT  = readdirSync(join(MIGRATIONS, 'chat')).filter(n => n.endsWith('.sql')).sort().pop()!

let dir: string
const saved = { main: process.env.DATABASE_URL, chat: process.env.CHAT_DATABASE_URL }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workbench-migrate-'))
  process.env.DATABASE_URL      = join(dir, 'workbench.db')
  process.env.CHAT_DATABASE_URL = join(dir, 'chat.db')
})
afterAll(() => {
  for (const [k, v] of [['DATABASE_URL', saved.main], ['CHAT_DATABASE_URL', saved.chat]] as const)
    v === undefined ? delete process.env[k] : process.env[k] = v
  rmSync(dir, { recursive: true, force: true })
})

// As app.ts does: migrated first, then the client opens on what that built.
const boot = async (root = MIGRATIONS) => {
  await migrateAtBoot(SCHEMA, root)
  const c: any = await createClient({ path: SCHEMA, resolveFrom: 'schema', encryptionKey: '0'.repeat(64) })
  await c.$close?.()
}
const tables = (path: string) => {
  const raw = new Database(path, { readonly: true })
  try { return (raw.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(r => r.name) }
  finally { raw.close() }
}
const journal = (db: string) => {
  const raw = new Database(join(dir, db), { readonly: true })
  try { return (raw.query('SELECT name FROM _litestone_migrations').all() as { name: string }[]).map(r => r.name) }
  finally { raw.close() }
}

test('a first boot applies every migration to both databases and copies nothing', async () => {
  await boot()
  expect(journal('workbench.db').length).toBe(readdirSync(join(MIGRATIONS, 'main')).filter(n => n.endsWith('.sql')).length)
  expect(journal('chat.db')).toContain(LAST_CHAT)
  expect(readdirSync(dir)).not.toContain('pre-migrate')
})

test('a migration pending on chat.db is applied at boot, after a copy of the database without it', async () => {
  const root = join(dir, 'migrations')
  cpSync(MIGRATIONS, root, { recursive: true })
  writeFileSync(join(root, 'chat', '29991231000000_probe.sql'), 'CREATE TABLE probe (id INTEGER PRIMARY KEY);')
  await boot(root)
  expect(journal('chat.db')).toContain('29991231000000_probe.sql')
  expect(tables(join(dir, 'chat.db'))).toContain('probe')
  const copies = readdirSync(join(dir, 'pre-migrate')).filter(n => n.endsWith('.db'))
  expect(copies).toHaveLength(1)
  expect(copies[0]).toStartWith('chat.db--')
  expect(tables(join(dir, 'pre-migrate', copies[0]))).not.toContain('probe')
})
