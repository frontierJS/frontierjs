// test/cross-process.test.ts — a write announced past this process (FJS-642).
//
// Every assertion here needs TWO REAL PROCESSES. `$tapEvents` is a callback list
// on one client, so a single-process test passes with the whole feature removed:
// the events it hears are its own. The worker is spawned, writes through its own
// client against the same file, and exits; this process asserts what arrived.
//
// The negative controls are the half that matters. A mechanism that announces
// everything to everybody would pass the first assertion and be unusable — so a
// process must NOT hear its own writes twice, a database that did not declare
// the layer must record nothing at all, and the ORDER must survive, because
// each delivery re-reads its row and a parallel re-read lands a create after
// the remove that undid it.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Database } from 'bun:sqlite'

import { createClient, parse, autoMigrate } from '../src/index.js'

const SRC = resolve(import.meta.dir, '../src/index.js')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lite-xp-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const schemaFor = (file: string, announce: 'crossProcess' | 'inProcess') => `
database main {
  path     "${file}"
  announce ${announce}
}
enum Status { draft  published }
model Post {
  id     Int    @id @default(autoincrement())
  title  String
  status Status @default(draft)
  @@db(main)
  @@transitions(status, publish: draft -> published)
}
`

/** Run `body` in a separate process against the same file, and wait for it. */
const inAnotherProcess = (file: string, schema: string, body: string) => {
  const f = join(dir, `w-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(f, `
    const { createClient } = await import(${JSON.stringify(SRC)})
    const db  = await createClient({ schema: ${JSON.stringify(schema)} })
    const sys = db.asSystem()
    ${body}
    db.$close()
  `)
  // Spawned rather than run inline, and awaited asynchronously: spawnSync blocks
  // this process's event loop, so no fs.watch callback could run while the
  // worker wrote and every re-read would see the world as the worker left it.
  return new Promise<void>((res, rej) => {
    let err = ''
    const p = spawn('bun', [f])
    p.stderr.on('data', d => { err += d })
    p.on('exit', code => code === 0 ? res() : rej(new Error(err.slice(0, 400))))
  })
}

const settle = (ms = 350) => new Promise(r => setTimeout(r, ms))

const openDeclared = async (announce: 'crossProcess' | 'inProcess' = 'crossProcess') => {
  const file   = join(dir, 'app.db')
  const schema = schemaFor(file, announce)
  const db     = await createClient({ schema })
  autoMigrate(db, parse(schema))
  const heard: any[] = []
  db.$tapEvents((e: any) => { heard.push(e) })
  return { db, file, schema, heard }
}

describe('a second process is heard', () => {
  test('its writes arrive as the events a local write would have fired', async () => {
    const { db, schema, heard } = await openDeclared()

    await inAnotherProcess(schema.match(/path\s+"([^"]+)"/)![1], schema, `
      const row = await sys.post.create({ data: { title: 'from the worker' } })
      await sys.post.update({ where: { id: row.id }, data: { title: 'renamed' } })
    `)
    await settle()

    const events = heard.filter(e => e.foreign)
    expect(events.map(e => e.event)).toEqual(['create', 'update'])
    expect(events[0].model).toBe('Post')
    expect(events[0].scope).toBe('row')
    db.$close()
  })

  test('the table carries the id and never the row, and the row is re-read HERE', async () => {
    // The security half, and it is asserted against the TABLE rather than
    // against the delivered event: writing the row would put the plaintext of
    // every @encrypted and @guarded column into a table beside the ciphertext,
    // undoing encryption at rest to save a read.
    //
    // Deliberately not asserted: WHICH version of the row arrives. A re-read
    // answers the row as it is now, so a create delivered after a later update
    // carries the later title — correct for a live store, and timing-dependent,
    // so pinning a value here would be pinning the scheduler.
    const { db, file, schema, heard } = await openDeclared()
    await inAnotherProcess('', schema, `
      await sys.post.create({ data: { title: 'a secret worth not copying' } })
    `)
    await settle()

    const raw  = new Database(file, { readonly: true })
    const cols = (raw.query(`PRAGMA table_info("_litestone_events")`).all() as any[]).map(c => c.name)
    const rows = raw.query(`SELECT * FROM "_litestone_events"`).all() as any[]
    raw.close()
    expect(cols).not.toContain('row')
    expect(JSON.stringify(rows)).not.toContain('a secret worth not copying')
    expect(rows[0].recordId).toBe('1')

    const created = heard.find(e => e.foreign && e.event === 'create')
    expect(created.result?.title).toBe('a secret worth not copying')
    expect(created.recordId).toBe('1')
    db.$close()
  })

  test('a bulk write arrives as a count, not as rows', async () => {
    // The shape `changed` already has (`FJS-D34`) — the batch size is a property
    // of the call, so a bulk write announces once whatever it wrote.
    const { db, schema, heard } = await openDeclared()
    await inAnotherProcess('', schema, `
      await sys.post.createMany({ data: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    `)
    await settle()

    const bulk = heard.find(e => e.foreign && e.scope === 'collection')
    expect(bulk.count).toBe(3)
    expect(bulk.result).toBeNull()
    expect(heard.filter(e => e.foreign)).toHaveLength(1)
    db.$close()
  })

  test('a removal carries the id and no row, because there is nothing left to read', async () => {
    const { db, schema, heard } = await openDeclared()
    await inAnotherProcess('', schema, `
      const row = await sys.post.create({ data: { title: 'doomed' } })
      await sys.post.delete({ where: { id: row.id } })
    `)
    await settle()

    const removed = heard.find(e => e.foreign && e.event === 'remove')
    expect(removed.recordId).toBe('1')
    expect(removed.result).toBeNull()
    db.$close()
  })

  test('a transition carries the move', async () => {
    const { db, schema, heard } = await openDeclared()
    await inAnotherProcess('', schema, `
      const row = await db.post.create({ data: { title: 'a post' } })
      await db.post.transition(row.id, 'publish')
    `)
    await settle()

    const moved = heard.find(e => e.foreign && e.event === 'transition')
    expect(moved.from).toBe('draft')
    expect(moved.to).toBe('published')
    expect(moved.transition).toBe('publish')
    db.$close()
  })

  test('order survives, though every delivery re-reads its row', async () => {
    // Each delivery awaits a read, so firing them off in parallel lets a later
    // event's read finish first — and a subscriber that sees a create after the
    // remove that undid it holds a row that is gone. Order is the one thing a
    // live store cannot repair for itself.
    const { db, schema, heard } = await openDeclared()
    await inAnotherProcess('', schema, `
      const row = await sys.post.create({ data: { title: 'x' } })
      await sys.post.update({ where: { id: row.id }, data: { title: 'y' } })
      await sys.post.createMany({ data: [{ title: 'p' }, { title: 'q' }] })
      await sys.post.delete({ where: { id: row.id } })
    `)
    await settle()

    expect(heard.filter(e => e.foreign).map(e => e.event))
      .toEqual(['create', 'update', 'create', 'remove'])
    db.$close()
  })
})

describe('the negative controls', () => {
  test('a process does not hear its OWN writes twice', async () => {
    // Every recorded row carries the client instance that wrote it, and a
    // process skips its own: it has already announced them in-process, and
    // re-announcing would double every event and re-enter any subscriber that
    // writes.
    const { db, heard } = await openDeclared()
    await db.asSystem().post.create({ data: { title: 'mine' } })
    await settle()

    expect(heard).toHaveLength(1)
    expect(heard[0].foreign).toBeUndefined()
    db.$close()
  })

  test('a database that did not declare it records nothing', async () => {
    // The write tax is a row per write, so it is declared. An app that runs one
    // process must pay nothing and carry no table.
    const { db, file, schema } = await openDeclared('inProcess')
    await db.asSystem().post.create({ data: { title: 'mine' } })
    db.$close()

    const raw = new Database(file, { readonly: true })
    const table = raw.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_litestone_events'`).get()
    raw.close()
    expect(table).toBeNull()
    expect(schema).toContain('announce inProcess')
  })

  test('a declared database records one row per announced write', async () => {
    const { db, file } = await openDeclared()
    const sys = db.asSystem()
    await sys.post.create({ data: { title: 'a' } })
    await sys.post.createMany({ data: [{ title: 'b' }, { title: 'c' }] })
    await settle(50)
    db.$close()

    const raw  = new Database(file, { readonly: true })
    const rows = raw.query(`SELECT event, model, scope, count FROM "_litestone_events" ORDER BY id`).all() as any[]
    raw.close()
    // Two announcements, not three writes: the bulk call announces its count.
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ event: 'create', model: 'Post', scope: 'row', count: 1 })
    expect(rows[1]).toMatchObject({ event: 'create', model: 'Post', scope: 'collection', count: 2 })
  })

  test('the row is recorded even when nothing in THIS process is listening', async () => {
    // The audience for a recorded announcement is in another process, so the
    // guards that skip building a payload cannot ask only about this one. This
    // is the assertion that fails if `hasAudience` goes back to checking the
    // local listeners alone.
    const file   = join(dir, 'quiet.db')
    const schema = schemaFor(file, 'crossProcess')
    const db     = await createClient({ schema })
    autoMigrate(db, parse(schema))
    await db.asSystem().post.create({ data: { title: 'nobody here is listening' } })
    db.$close()

    const raw = new Database(file, { readonly: true })
    const n   = (raw.query(`SELECT count(*) c FROM "_litestone_events"`).get() as any).c
    raw.close()
    expect(n).toBe(1)
  })
})

describe('the declaration', () => {
  test('refuses a value outside the two', () => {
    const r = parse(`database main { path "./a.db"  announce sometimes }\nmodel P { id Int @id }`)
    expect(r.valid).toBe(false)
    expect(String(r.errors[0])).toContain("must be 'inProcess' or 'crossProcess'")
  })

  test('refuses a driver with no table to record into', () => {
    // A jsonl or logger database is a FILE — no table, and no transaction to
    // record with — so the declaration would parse and do nothing.
    const r = parse(`database logs { path "./a.jsonl"  driver jsonl  announce crossProcess }\nmodel P { id Int @id }`)
    expect(r.valid).toBe(false)
    expect(String(r.errors[0])).toContain("needs driver 'sqlite'")
  })

  test('defaults to inProcess, which is what every existing schema means', () => {
    const r = parse(`database main { path "./a.db" }\nmodel P { id Int @id }`)
    expect(r.valid).toBe(true)
    expect(r.schema.databases.find((d: any) => d.name === 'main').announce).toBe('inProcess')
  })
})

describe('two processes booting against one file', () => {
  test('the loser of a migration race reports in-sync, not a failure', async () => {
    // Both replicas diff, both decide the same migration is needed, and the
    // loser used to apply statements the winner had already applied —
    // `duplicate column name`, 5 of 10 runs. `BEGIN IMMEDIATE` serialises them
    // and the guard is what makes the loser notice: a lock alone only makes it
    // wait its turn to do the wrong thing.
    const file = join(dir, 'race.db')
    const S1 = `model Post { id Int @id @default(autoincrement())  title String }`
    const S2 = `model Post { id Int @id @default(autoincrement())  title String  extra String?  more Int? }`

    const seed = await createClient({ schema: S1, db: file })
    autoMigrate(seed, parse(S1))
    seed.$close()

    const boot = join(dir, 'boot.mjs')
    writeFileSync(boot, `
      const { createClient, parse, autoMigrate } = await import(${JSON.stringify(SRC)})
      const db = await createClient({ schema: ${JSON.stringify(S2)}, db: process.argv[2] })
      process.stdout.write(JSON.stringify(autoMigrate(db, parse(${JSON.stringify(S2)}))))
      db.$close()
    `)
    const one = () => new Promise<any>((res) => {
      let out = ''
      const p = spawn('bun', [boot, file])
      p.stdout.on('data', d => { out += d })
      p.on('exit', code => res({ code, out }))
    })

    const [a, b] = await Promise.all([one(), one()])
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    const states = [a, b].map(r => JSON.parse(r.out).main.state).sort()
    // One did the work and the other found none left. Never 'failed'.
    expect(states).toEqual(['in-sync', 'migrated'])
  })
})
