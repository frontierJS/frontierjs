// Two `database` blocks can name one FILE, and then they are one database.
//
// Under `strategy database` every sqlite database is redirected into the
// tenant's own file, and a literal path can be repeated outside tenancy too.
// SQLite allows one writer per file and there is one transaction manager, over
// main's connection — so a second connection to that file writes inside a
// transaction it does not hold, waits for a lock the caller itself is holding,
// and answers `database is locked` forever (`FJS-958`). Reads succeed
// throughout, which is why it looked correct until something wrote.
//
// Every claim here is PAIRED with the same schema on two paths, because a fix
// that collapsed every database onto one connection would pass any test that
// only asked about the shared-file case — and it would delete `FJS-D35`, whose
// measured split (a rolled-back main leaving the second database's row
// standing) is what puts the outbox in main.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/core/client.js'
import { createTenantRegistry } from '../src/tenant.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lite-onefile-'))
  dirs.push(d)
  return d
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const MODELS = `
model Widget {
  id   Int    @id @default(autoincrement())
  name String
  @@db(main)
  @@gate("0")
}

model Hit {
  id   Int    @id @default(autoincrement())
  path String
  @@db(analytics)
  @@gate("0")
}
`

const schema = (mainPath: string, analyticsPath: string, tenancy = '') => `
${tenancy}
database main      { path "${mainPath}" }
database analytics { path "${analyticsPath}" }
${MODELS}
`

describe('two database blocks on one file', () => {
  it('open one connection pair, and a write to the second database lands', async () => {
    const d = tmp()
    const db: any = await createClient({ schema: schema('./app.db', './app.db'), resolveFrom: d })
    expect(db.$databases.main.path).toBe(db.$databases.analytics.path)
    expect(db.$rawDbs.main).toBe(db.$rawDbs.analytics)

    await db.widget.create({ data: { name: 'w' } })
    // The FJS-958 repro: this threw `database is locked` and could not resolve.
    await db.hit.create({ data: { path: '/x' } })
    expect(await db.hit.count()).toBe(1)
    await db.$close()
  })

  it('make a transaction across both atomic, because it genuinely is one file', async () => {
    const d = tmp()
    const db: any = await createClient({ schema: schema('./app.db', './app.db'), resolveFrom: d })
    await db.$transaction(async (tx: any) => {
      await tx.widget.create({ data: { name: 'w' } })
      await tx.hit.create({ data: { path: '/x' } })
      throw new Error('rollback')
    }).catch(() => {})
    expect(await db.widget.count()).toBe(0)
    expect(await db.hit.count()).toBe(0)
    await db.$close()
  })

  // The negative control. Without it, collapsing everything onto main's
  // connection passes every assertion above.
  it('stay two connections on two paths, and the split FJS-D35 measured survives', async () => {
    const d = tmp()
    const db: any = await createClient({ schema: schema('./app.db', './analytics.db'), resolveFrom: d })
    expect(db.$databases.main.path).not.toBe(db.$databases.analytics.path)
    expect(db.$rawDbs.main).not.toBe(db.$rawDbs.analytics)

    await db.$transaction(async (tx: any) => {
      await tx.widget.create({ data: { name: 'w' } })
      await tx.hit.create({ data: { path: '/x' } })
      throw new Error('rollback')
    }).catch(() => {})
    expect(await db.widget.count()).toBe(0)
    expect(await db.hit.count()).toBe(1)
    await db.$close()
  })

  it('keep access per NAME while the handle is shared', async () => {
    const d = tmp()
    const build: any = await createClient({ schema: schema('./app.db', './app.db'), resolveFrom: d })
    await build.hit.create({ data: { path: '/x' } })
    await build.$close()

    const db: any = await createClient({
      schema:   schema('./app.db', './app.db'),
      resolveFrom: d,
      access:   { analytics: 'readonly' },
    })
    expect(db.$databases.analytics.path).toBe(db.$databases.main.path)
    // The refusal is the NAME's: no write handle under analytics, and main's
    // still open — a readonly declaration must not close the write handle out
    // from under the readwrite one sharing its file.
    expect(db.$rawDbs.analytics).toBeNull()
    expect(db.$rawDbs.main).not.toBeNull()
    await db.widget.create({ data: { name: 'w' } })
    await expect(db.hit.create({ data: { path: '/y' } })).rejects.toThrow(/readonly/i)
    // and the readonly name still READS the shared file, off the shared handle.
    expect(await db.hit.count()).toBe(1)
    await db.$close()
  })

  it('refuse a name declared access: false even where another name opened the file', async () => {
    const d = tmp()
    const db: any = await createClient({
      schema:   schema('./app.db', './app.db'),
      resolveFrom: d,
      access:   { analytics: false },
    })
    await db.widget.create({ data: { name: 'w' } })
    await expect(db.hit.count()).rejects.toThrow(/not accessible/i)
    await db.$close()
  })

  // ':memory:' is a path string two databases can share and are not one
  // database — grouping on it would put both schemas' tables in whichever
  // handle opened first.
  it('do not group two in-memory databases', async () => {
    const d = tmp()
    const db: any = await createClient({
      schema: schema('./app.db', './analytics.db'),
      resolveFrom: d,
      databases: ':memory:',
    })
    expect(db.$databases.main.path).toBe(db.$databases.analytics.path)
    expect(db.$rawDbs.main).not.toBe(db.$rawDbs.analytics)
    await db.$close()
  })
})

describe('strategy database — a tenant file holds every sqlite database', () => {
  const TENANCY = `tenancy {\n  strategy database\n  dir      "./tenants"\n  resolve  subdomain\n}`

  it('writes to a non-main database inside the tenant file', async () => {
    const d = tmp()
    const reg: any = await createTenantRegistry({
      schema:   schema('./main.db', './analytics.db', TENANCY),
      resolveFrom: d,
      dir:      join(d, 'tenants'),
      registry: join(d, 'tenants-registry.db'),
    })
    await reg.create('acme', {})
    const db: any = await reg.get('acme')

    expect(db.$databases.main.path).toBe(db.$databases.analytics.path)
    expect(db.$databases.main.path).toBe(join(d, 'tenants', 'acme.db'))
    expect(db.$rawDbs.main).toBe(db.$rawDbs.analytics)

    await db.widget.create({ data: { name: 'w' } })
    await db.hit.create({ data: { path: '/x' } })
    expect(await db.hit.count()).toBe(1)

    await reg.close()
  })
})
