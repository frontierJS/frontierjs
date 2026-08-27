// ─── deploy-journal.test.js — the shape of the deploy journal ────────────────
//
// `db/deploy.lite` is opened as its OWN Litestone client whose `main` is
// `deploy.db`, rather than declared as a second `database` block on the app's
// client. Three properties make that the right shape and one makes the
// alternative wrong; all four were measured before the fragment was written and
// each one, if it stopped holding, would change what the models look like.
//
// A real client over a real file throughout. A stand-in would agree with the
// fragment about everything, including the two things that were wrong when this
// was first written down.

import { describe, test, expect, afterEach } from 'bun:test'
import { resolve, dirname, join }            from 'path'
import { fileURLToPath }                     from 'url'
import { tmpdir }                            from 'os'
import { mkdtempSync, existsSync, statSync,
         readdirSync, readFileSync, rmSync } from 'fs'

import { createClient } from '../../litestone/src/index.js'

const __dir    = dirname(fileURLToPath(import.meta.url))
const FRAGMENT = readFileSync(resolve(__dir, '../db/deploy.lite'), 'utf8')

// The header explains the `@@db(main)` rule, so a plain string search over the
// file finds the explanation and calls it a violation. Comments are blanked
// first here for the same reason `fli check` blanks them: this repo documents
// its own hazards in the words a rule matches.
const DECLARATIONS = FRAGMENT.replace(/^\s*\/\/.*$/gm, '')

const roots = []
const mkroot = () => {
  const r = mkdtempSync(join(tmpdir(), 'fli-journal-'))
  roots.push(r)
  return r
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

// An ordinary app with two declared databases — two, because `$backup` over
// several is the shape a real app has and the one that writes a directory.
const appSchema = (root) => `
database main   { path "${join(root, 'db', 'main.db')}" }
database second { path "${join(root, 'db', 'second.db')}" }

model Thing { id String @id @default(uuid())  name String  @@db(main) }
model Note  { id String @id @default(uuid())  body String  @@db(second) }
`

describe('the fragment', () => {
  test('parses and opens as its own client, with main at deploy.db', async () => {
    const root     = mkroot()
    const deployDb = join(root, 'deploy.db')

    const journal = await createClient({ schema: FRAGMENT, db: deployDb })
    expect(existsSync(deployDb)).toBe(true)

    const tables = (await journal.asSystem().sql`
      SELECT name FROM sqlite_master WHERE type = 'table'`).map(r => r.name)

    for (const t of ['journal', 'release', 'binding_set', 'transition', 'transition_step'])
      expect(tables).toContain(t)
  })

  // outbox.lite carries `@@db(main)` because it is pasted into an app that
  // declares that database. This fragment is handed to createClient directly,
  // so there is no block to reference and the same line fails to parse. The
  // rule is invisible in the fragment itself — nothing there says "no @@db" —
  // so it is asserted here.
  test('a @@db(main) in it would not parse, which is why it carries none', async () => {
    expect(DECLARATIONS).not.toContain('@@db(')

    const withDb = FRAGMENT.replace('model Journal {', 'model Journal {\n  @@db(main)')
    await expect(createClient({ schema: withDb, db: join(mkroot(), 'deploy.db') }))
      .rejects.toThrow(/unknown database 'main'/)
  })

  test('a Release row writes and reads back', async () => {
    const journal = await createClient({ schema: FRAGMENT, db: join(mkroot(), 'deploy.db') })
    const sys     = journal.asSystem()

    await sys.release.create({ data: {
      id: 'rel_1', app: 'shop', environment: 'production',
      bindingsHash: 'bh1', generation: 1, schemaHash: 'sh1', pivot: 'expand',
    } })

    const [row] = await sys.release.findMany()
    expect(row.id).toBe('rel_1')
    expect(row.audienceKey).toBe('everyone')   // the column that exists before its feature
    expect(row.pivotDeclared).toBe(false)
  })

  // Two constraints say one rule, and each refuses a different mistake: the
  // CHECK refuses a second KIND of row, the primary key refuses a second copy
  // of the only one. Model-level `@@check` would be one line (`FJS-534`).
  test('the Journal header row is a singleton, and it is declared', async () => {
    const journal = await createClient({ schema: FRAGMENT, db: join(mkroot(), 'deploy.db') })
    const sys     = journal.asSystem()

    await sys.journal.create({ data: { app: 'shop', host: 'box-1' } })

    // A translated refusal, not SQLite's own sentence (`FJS-534`): the CHECK
    // names the column it is declared on, so this arrives as a ValidationError
    // on `id` and reaches a caller as a 400 rather than a 500.
    let refusal = null
    try { await sys.journal.create({ data: { id: 'other', app: 'shop', host: 'box-1' } }) }
    catch (e) { refusal = e }
    expect(refusal?.name).toBe('ValidationError')
    expect(refusal.errors).toEqual([{ path: ['id'], message: 'is not valid' }])
    expect(refusal.constraint).toBe("id = 'journal'")

    await expect(sys.journal.create({ data: { app: 'shop', host: 'box-1' } }))
      .rejects.toThrow(/already taken/)

    expect(await sys.journal.findMany()).toHaveLength(1)
  })
})

describe('the journal is its own client, not a second database block', () => {
  test('$locks lands in deploy.db, and the app never sees it', async () => {
    const root     = mkroot()
    const deployDb = join(root, 'deploy.db')

    const journal = await createClient({ schema: FRAGMENT,       db: deployDb })
    const app     = await createClient({ schema: appSchema(root) })
    await app.thing.create({ data: { name: 'a' } })

    const lock = await journal.$locks.acquire('deploy', { ttl: 60_000, owner: 'operator' })

    const held = await journal.asSystem().sql`
      SELECT "key", "owner" FROM _locks WHERE "key" = 'deploy'`
    expect(held).toHaveLength(1)
    expect(held[0].owner).toBe('operator')

    const inApp = await app.asSystem().sql`
      SELECT name FROM sqlite_master WHERE name = '_locks'`
    expect(inApp).toHaveLength(0)

    await lock.release()
  })

  // The refusal names the holder and grades 409 — which is already the shape
  // `fli revert` wants, so nothing has to be written for it. It THROWS rather
  // than answering falsy; a caller testing truthiness proceeds into a deploy
  // somebody else is running.
  test('a second holder is refused by name', async () => {
    const journal = await createClient({ schema: FRAGMENT, db: join(mkroot(), 'deploy.db') })
    const lock    = await journal.$locks.acquire('deploy', { ttl: 60_000, owner: 'operator' })

    let refusal = null
    try {
      await journal.$locks.acquire('deploy', { ttl: 1_000, wait: 0, owner: 'other' })
    } catch (e) { refusal = e }

    expect(refusal).not.toBeNull()
    expect(refusal.currentOwner).toBe('operator')
    expect(refusal.status).toBe(409)
    expect(refusal.retryable).toBe(true)

    await lock.release()
  })

  test("the app's own $backup cannot reach deploy.db", async () => {
    const root     = mkroot()
    const deployDb = join(root, 'deploy.db')

    await createClient({ schema: FRAGMENT, db: deployDb })
    const app = await createClient({ schema: appSchema(root) })
    await app.thing.create({ data: { name: 'a' } })

    const before = statSync(deployDb)
    const dest   = join(root, 'backup')
    const result = await app.$backup(dest)

    expect(Object.keys(result).sort()).toEqual(['main', 'second'])
    expect(readdirSync(dest).sort()).toEqual(['main.db', 'second.db'])

    const after = statSync(deployDb)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })

  // The negative control. Both grounds for rejecting the second-database-block
  // shape are asserted here, so the rejection stops being an argument: if
  // litestone ever moves $locks off main, or narrows $backup by default, this
  // test fails and the fragment's header comment is stale.
  test('as a second database block it would break on both counts', async () => {
    const root = mkroot()
    const schema = `
database main   { path "${join(root, 'db', 'main.db')}" }
database deploy { path "${join(root, 'db', 'deploy.db')}" }

model Thing   { id String @id @default(uuid())  name String  @@db(main) }
model Release { id String @id  pivot String  @@db(deploy)  @@gate("8") }
`
    const app = await createClient({ schema })
    await app.thing.create({ data: { name: 'a' } })

    const lock = await app.$locks.acquire('deploy', { ttl: 60_000, owner: 'operator' })

    // the lock lands in the app's database, not beside the record it protects
    const inMain = await app.asSystem().sql`
      SELECT name FROM sqlite_master WHERE name = '_locks'`
    expect(inMain).toHaveLength(1)
    await lock.release()

    // and the app's own backup sweeps the journal into the backup set
    const dest   = join(root, 'backup')
    const result = await app.$backup(dest)
    expect(Object.keys(result)).toContain('deploy')
    expect(readdirSync(dest)).toContain('deploy.db')
  })
})
