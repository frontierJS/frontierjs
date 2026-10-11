// test/tenant-create.test.ts
// tenants.create() with no migrations directory builds the file from the
// schema's DDL in ONE transaction. Run autocommit, each of a 188-model
// schema's 645 statements was its own fsync — 3.6 s per tenant against ~80 ms
// — and a statement that threw left the tables before it in a file nobody had
// registered.
//
// Traps in this file:
//   • A failure mid-loop is forced with a file already at the tenant's path
//     holding a VIEW named like a table: CREATE TABLE IF NOT EXISTS passes
//     over it, and the CREATE INDEX after it throws. A stray TABLE missing the
//     indexed column does not — SQLite reads the unknown quoted name as a
//     string literal and indexes a constant.
//   • The speed case has a budget ~20x the measured time, so it fails only if
//     the statements stop sharing a transaction. On a tmpfs, where a sync is
//     free, it passes either way.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { createTenantRegistry } from '../src/tenant.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function registry(schema: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ls-tenant-create-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'tenants'))
  return { dir, reg: createTenantRegistry({ parsed: parse(schema), dir: join(dir, 'tenants'), registry: join(dir, 'registry.db') }) }
}

const SCHEMA = `
model Author {
  id   Int    @id
  name String
}

model Book {
  id    Int    @id
  title String
  isbn  String
  @@index([isbn])
}
`

describe('tenants.create() builds the file in one transaction', () => {
  it('a statement that throws leaves no file and no registration, and the id can be created again', async () => {
    const { dir, reg: pending } = registry(SCHEMA)
    const reg = await pending
    const file = join(dir, 'tenants', 'acme.db')
    const stray = new Database(file)
    stray.run('CREATE VIEW "book" AS SELECT 1 AS id')
    stray.close()

    await expect(reg.create('acme')).rejects.toThrow(/view/)
    expect(existsSync(file)).toBe(false)
    expect(reg.exists('acme')).toBe(false)

    const db = await reg.create('acme')
    await db.asSystem().book.create({ data: { id: 1, title: 'T', isbn: '978' } })
    expect((await db.asSystem().book.findUnique({ where: { id: 1 } }))?.isbn).toBe('978')
    reg.close()
  })

  it('a 188-model schema builds well inside the budget', async () => {
    const scale = readFileSync(new URL('./fixtures/scale/openmrp.lite', import.meta.url), 'utf8')
    const { reg: pending } = registry(scale)
    const reg = await pending
    const t0 = performance.now()
    await reg.create('big')
    expect(performance.now() - t0).toBeLessThan(1500)
    reg.close()
  }, 20000)
})

// FJS-1608: with a migrationsDir, create() used to discard what apply() returned.
describe('tenants.create() with a migrationsDir reads what apply() answers', () => {
  const GOOD = 'CREATE TABLE "author" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL);'

  function withMigrations(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'ls-tenant-create-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'tenants'))
    mkdirSync(join(dir, 'migrations'))
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'migrations', name), body)
    const pending = createTenantRegistry({
      parsed: parse(SCHEMA), dir: join(dir, 'tenants'), registry: join(dir, 'registry.db'),
      migrationsDir: join(dir, 'migrations'),
    })
    return { dir, pending }
  }

  const refuses: Array<[string, Record<string, string>]> = [
    ['a migration that throws', { '20260101000000_init.sql': `${GOOD}\nCREATE TABLE "author" ("id" INTEGER);` }],
    ['a .js migration, refused before anything runs', { '20260101000000_init.sql': GOOD, '20260102000000_data.js': 'export default () => {}' }],
    ['files that match no migration name', { 'init.sql': GOOD }],
  ]

  for (const [label, files] of refuses) {
    it(`${label} leaves no file and no registration`, async () => {
      const { dir, pending } = withMigrations(files)
      const reg = await pending
      const file = join(dir, 'tenants', 'acme.db')

      await expect(reg.create('acme')).rejects.toThrow(/was not created/)
      expect(existsSync(file)).toBe(false)
      expect(reg.exists('acme')).toBe(false)
      reg.close()
    })
  }
})
