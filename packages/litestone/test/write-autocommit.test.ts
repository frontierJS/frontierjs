// test/write-autocommit.test.ts
// A single-row create or update that is one statement runs as SQLite's own
// autocommit, not inside the lock and a BEGIN/COMMIT (`FJS-1106`, `FJS-1107`).
// Everything `FJS-638` bought has to survive that: a write with further
// statements, a post-update policy or a state machine keeps its transaction, and
// a write arriving while another context holds one still waits instead of
// joining it.
//
// Traps in this file:
//   • Whether a statement ran inside a transaction is read off the RAW
//     connection's `inTransaction` at the moment the statement executes.
//     `$tapQuery` reports neither BEGIN nor COMMIT, and asking whether BEGIN was
//     PREPARED stops meaning anything once one transaction has run, because it
//     is cached — a control asked that way after the concurrent case passes
//     whatever the write did.
//   • The spy wraps statements at prepare time, so it is installed on a fresh
//     client before the first write; a statement cached earlier is not seen.
//   • The concurrent cases are the ones a shortcut can break, and each is PAIRED
//     with the same write once nothing is open, or a fix that never took the
//     shortcut would pass the refusal alone.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const SCHEMA = `
enum Stage { draft  live }
model Author {
  id    Int    @id
  name  String @unique
  posts Post[]
}
model Post {
  id       Int     @id
  title    String
  authorId Int?
  author   Author? @relation(fields: [authorId], references: [id])
}
model Quote {
  id        Int @id
  accountId Int
  num       Int @sequence(scope: accountId)
}
model Doc {
  id    Int   @id
  stage Stage @default(draft)
  note  String?
  @@transitions(stage, publish: draft -> live)
}
model Memo {
  id   Int    @id
  body String
  @@allow('all', true)
  @@deny('post-update', body == 'forbidden')
}`

type Write = { sql: string, inTx: boolean }

/** A file-backed client, and every INSERT/UPDATE its write connection ran. */
async function client() {
  const dir = mkdtempSync(join(tmpdir(), 'ls-autocommit-'))
  dirs.push(dir)
  const db: any = await createClient({ schema: SCHEMA, db: join(dir, 'app.db') })
  const raw = db.$rawDbs.main
  const writes: Write[] = []
  const prepare = raw.prepare.bind(raw)
  raw.prepare = (sql: string) => {
    const st = prepare(sql)
    if (!/^\s*(INSERT|UPDATE)\b/i.test(sql)) return st
    return new Proxy(st, {
      get(target, key) {
        const v = (target as any)[key]
        if (key === 'run' || key === 'get' || key === 'all')
          return (...args: unknown[]) => { writes.push({ sql, inTx: raw.inTransaction }); return v.apply(target, args) }
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  }
  /** Was the last write to `table` inside a transaction? */
  const lastInTx = (verb: string, table: string) => {
    const w = [...writes].reverse().find(x => new RegExp(`^\\s*${verb}\\s+(INTO\\s+)?"${table}"`, 'i').test(x.sql))
    if (!w) throw new Error(`no ${verb} on ${table} was seen`)
    return w.inTx
  }
  return { db, sys: db.asSystem(), lastInTx }
}

// ─── create ───────────────────────────────────────────────────────────────────

describe('a one-statement create is its own autocommit', () => {
  it('a plain create, and one with select: false', async () => {
    const { sys, lastInTx, db } = await client()
    await sys.author.create({ data: { name: 'ada' } })
    expect(lastInTx('INSERT', 'author')).toBe(false)
    expect(await sys.author.create({ data: { name: 'grace' }, select: false })).toBeNull()
    expect(lastInTx('INSERT', 'author')).toBe(false)
    expect(await sys.author.count({})).toBe(2)
    db.$close()
  })

  it('a create with a nested write keeps its transaction', async () => {
    const { sys, lastInTx, db } = await client()
    await sys.author.create({ data: { name: 'ada', posts: { create: [{ title: 'one' }] } } })
    expect(lastInTx('INSERT', 'author')).toBe(true)
    db.$close()
  })

  it('a create with a @sequence keeps its transaction', async () => {
    const { sys, lastInTx, db } = await client()
    expect((await sys.quote.create({ data: { accountId: 7 } })).num).toBe(1)
    expect(lastInTx('INSERT', 'quote')).toBe(true)
    db.$close()
  })

  it('a nested create that fails leaves no parent behind', async () => {
    const { sys, db } = await client()
    await sys.post.create({ data: { id: 1, title: 'taken' } })
    await expect(sys.author.create({ data: { name: 'ada', posts: { create: [{ id: 1, title: 'dup' }] } } }))
      .rejects.toThrow()
    expect(await sys.author.count({})).toBe(0)
    db.$close()
  })

  it("a plain create during another context's transaction waits and survives its rollback", async () => {
    const { sys, lastInTx, db } = await client()
    const { A, release } = holdTransaction(sys, (tx: any) => tx.author.create({ data: { name: 'A' } }))

    await tick(10)
    let done = false
    const B = sys.author.create({ data: { name: 'B' } }).then(() => { done = true })
    await tick(10)
    expect(done).toBe(false)

    release()
    expect(await A).toBe('rolled back')
    await B
    expect((await sys.author.findMany({})).map((r: any) => r.name)).toEqual(['B'])
    expect(lastInTx('INSERT', 'author')).toBe(true)

    await sys.author.create({ data: { name: 'C' } })
    expect(lastInTx('INSERT', 'author')).toBe(false)
    db.$close()
  })

  it("a plain create inside the caller's own transaction goes with its rollback", async () => {
    const { sys, db } = await client()
    await sys.$transaction(async (tx: any) => {
      await tx.author.create({ data: { name: 'gone' } })
      throw new Error('roll back')
    }).catch(() => {})
    expect(await sys.author.count({})).toBe(0)
    db.$close()
  })

  it('a refused plain create writes nothing and the next one lands', async () => {
    const { sys, db } = await client()
    await sys.author.create({ data: { name: 'ada' } })
    await expect(sys.author.create({ data: { name: 'ada' } })).rejects.toThrow()
    await sys.author.create({ data: { name: 'grace' } })
    expect((await sys.author.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.name)).toEqual(['ada', 'grace'])
    db.$close()
  })
})

// ─── update ───────────────────────────────────────────────────────────────────

describe('a one-statement update is its own autocommit', () => {
  it('a plain update, and one with select: false', async () => {
    const { sys, lastInTx, db } = await client()
    await sys.author.create({ data: { id: 1, name: 'ada' } })
    expect((await sys.author.update({ where: { id: 1 }, data: { name: 'ada l.' } })).name).toBe('ada l.')
    expect(lastInTx('UPDATE', 'author')).toBe(false)
    expect(await sys.author.update({ where: { id: 1 }, data: { name: 'ada' }, select: false })).toBeNull()
    expect(lastInTx('UPDATE', 'author')).toBe(false)
    expect((await sys.author.findFirst({ where: { id: 1 } })).name).toBe('ada')
    db.$close()
  })

  it('an update with a nested write keeps its transaction', async () => {
    const { sys, lastInTx, db } = await client()
    await sys.author.create({ data: { id: 1, name: 'ada' } })
    await sys.author.update({ where: { id: 1 }, data: { name: 'ada l.', posts: { create: [{ title: 'one' }] } } })
    expect(lastInTx('UPDATE', 'author')).toBe(true)
    db.$close()
  })

  it('an update on a model with @@transitions keeps its transaction', async () => {
    const { sys, lastInTx, db } = await client()
    await sys.doc.create({ data: { id: 1 } })
    await sys.doc.update({ where: { id: 1 }, data: { note: 'x' } })
    expect(lastInTx('UPDATE', 'doc')).toBe(true)
    db.$close()
  })

  it('a post-update policy keeps its transaction, and its refusal is still the rollback', async () => {
    const { db, lastInTx } = await client()
    const as = db.$setAuth({ id: 1 })
    await db.asSystem().memo.create({ data: { id: 1, body: 'fine' } })
    await as.memo.update({ where: { id: 1 }, data: { body: 'still fine' } })
    expect(lastInTx('UPDATE', 'memo')).toBe(true)
    await expect(as.memo.update({ where: { id: 1 }, data: { body: 'forbidden' } })).rejects.toThrow()
    expect((await db.asSystem().memo.findFirst({ where: { id: 1 } })).body).toBe('still fine')
    db.$close()
  })

  it("a plain update during another context's transaction waits and survives its rollback", async () => {
    const { sys, lastInTx, db } = await client()
    await sys.author.create({ data: { id: 1, name: 'ada' } })
    const { A, release } = holdTransaction(sys, (tx: any) => tx.author.create({ data: { name: 'A' } }))

    await tick(10)
    let done = false
    const B = sys.author.update({ where: { id: 1 }, data: { name: 'ada l.' } }).then(() => { done = true })
    await tick(10)
    expect(done).toBe(false)

    release()
    expect(await A).toBe('rolled back')
    await B
    expect((await sys.author.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.name)).toEqual(['ada l.'])
    expect(lastInTx('UPDATE', 'author')).toBe(true)

    await sys.author.update({ where: { id: 1 }, data: { name: 'ada' } })
    expect(lastInTx('UPDATE', 'author')).toBe(false)
    db.$close()
  })

  it("a plain update inside the caller's own transaction goes with its rollback", async () => {
    const { sys, db } = await client()
    await sys.author.create({ data: { id: 1, name: 'ada' } })
    await sys.$transaction(async (tx: any) => {
      await tx.author.update({ where: { id: 1 }, data: { name: 'gone' } })
      throw new Error('roll back')
    }).catch(() => {})
    expect((await sys.author.findFirst({ where: { id: 1 } })).name).toBe('ada')
    db.$close()
  })
})

// ─── the cached statements ────────────────────────────────────────────────────

describe('a cached BEGIN and COMMIT are reused across every way a transaction ends', () => {
  it('commit, rollback, a failed statement, and commit again', async () => {
    const { sys, db } = await client()
    await sys.$transaction(async (tx: any) => { await tx.author.create({ data: { name: 'one' } }) })
    await sys.$transaction(async (tx: any) => { await tx.author.create({ data: { name: 'x' } }); throw new Error('no') }).catch(() => {})
    await sys.$transaction(async (tx: any) => { await tx.author.create({ data: { name: 'one' } }) }).catch(() => {})
    await sys.$transaction(async (tx: any) => { await tx.author.create({ data: { name: 'two' } }) })
    expect((await sys.author.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.name)).toEqual(['one', 'two'])
    expect(db.$rawDbs.main.inTransaction).toBe(false)
    db.$close()
  })
})

// ─── helpers ──────────────────────────────────────────────────────────────────

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A transaction that writes, waits to be released, then rolls back. */
function holdTransaction(sys: any, write: (tx: any) => Promise<unknown>) {
  let release!: () => void
  const paused = new Promise<void>(r => { release = r })
  const A = sys.$transaction(async (tx: any) => {
    await write(tx)
    await paused
    throw new Error('A rolls back')
  }).catch(() => 'rolled back')
  return { A, release }
}
