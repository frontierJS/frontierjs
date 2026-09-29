// A write to a model in a database other than main is inside the same
// transaction a write to main is (`FJS-1459`).
//
// The transaction manager used to hold main's connection alone, so a bulk write
// to a second file ran its statements on that file's own connection and
// autocommitted them one by one: a refused `createMany` left every row before
// the bad one written while its error said nothing in the batch was, and a
// `$transaction` that threw rolled back main and nothing else.
//
// What stays NOT atomic is the commit itself — two files are two COMMITs — and
// the last case pins that a failure between them is named rather than silent.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/core/client.js'
import { makeTxManager } from '../src/core/transaction.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lite-seconddb-'))
  dirs.push(d)
  return d
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const SCHEMA = `
database main  { path "./app.db" }
database other { path "./other.db" }

model A {
  id  Int    @id @default(autoincrement())
  tag String @unique
  @@gate("0")
}

model B {
  id  Int    @id @default(autoincrement())
  tag String @unique
  @@db(other)
  @@gate("0")
}
`

const open = async () => {
  const db: any = await createClient({ schema: SCHEMA, resolveFrom: tmp() })
  expect(db.$rawDbs.main).not.toBe(db.$rawDbs.other)
  return db
}

const rows = (n: number, dupAt: number) =>
  Array.from({ length: n }, (_, i) => ({ tag: i === dupAt ? 't0' : `t${i}` }))

describe('a second database is inside the transaction', () => {
  it('writes none of a refused createMany, as its error says', async () => {
    const db = await open()
    for (const m of ['a', 'b']) {
      await expect(db[m].createMany({ data: rows(50, 30) })).rejects.toThrow(/nothing in the batch was written/)
      expect(await db[m].count()).toBe(0)
    }
    await db.$close()
  })

  it('rolls back a create in the second database when $transaction throws', async () => {
    const db = await open()
    await db.$transaction(async (tx: any) => {
      await tx.b.create({ data: { tag: 'x' } })
      throw new Error('rollback')
    }).catch(() => {})
    expect(await db.b.count()).toBe(0)
    await db.$close()
  })

  it('rolls back a single-statement update there too', async () => {
    const db = await open()
    const row = await db.b.create({ data: { tag: 'before' } })
    await db.$transaction(async (tx: any) => {
      await tx.b.update({ where: { id: row.id }, data: { tag: 'after' } })
      throw new Error('rollback')
    }).catch(() => {})
    expect((await db.b.findFirst({ where: { id: row.id } })).tag).toBe('before')
    await db.$close()
  })

  it('rolls back both databases, and commits both', async () => {
    const db = await open()
    await db.$transaction(async (tx: any) => {
      await tx.a.create({ data: { tag: 'a' } })
      await tx.b.create({ data: { tag: 'b' } })
      throw new Error('rollback')
    }).catch(() => {})
    expect(await db.a.count()).toBe(0)
    expect(await db.b.count()).toBe(0)

    await db.$transaction(async (tx: any) => {
      await tx.a.create({ data: { tag: 'a' } })
      await tx.b.create({ data: { tag: 'b' } })
      // read back off the same transaction, before either commits
      expect(await tx.b.count()).toBe(1)
    })
    expect(await db.a.count()).toBe(1)
    expect(await db.b.count()).toBe(1)
    await db.$close()
  })

  it('takes a nested savepoint in the second database as well', async () => {
    const db = await open()
    await db.$transaction(async (tx: any) => {
      await tx.b.create({ data: { tag: 'outer' } })
      await tx.$transaction(async (inner: any) => {
        await inner.b.create({ data: { tag: 'inner' } })
        throw new Error('inner')
      }).catch(() => {})
    })
    expect((await db.b.findMany()).map((r: any) => r.tag)).toEqual(['outer'])
    await db.$close()
  })
})

describe('the commit is per file', () => {
  const fake = (name: string, log: string[], failOn?: string) => ({
    run(sql: string) {
      if (sql === failOn) throw new Error(`${name}: ${sql} failed`)
      log.push(`${name}:${sql}`)
    },
  })

  it('names what committed when a later file refuses its COMMIT', () => {
    const log: string[] = []
    const tx = makeTxManager([
      { name: 'main',  db: fake('main', log) },
      { name: 'other', db: fake('other', log, 'COMMIT') },
    ])
    expect(() => tx.wrap(() => {})).toThrow(/'other'[\s\S]*COMMIT failed[\s\S]*committed: none · rolled back: other, main/)
    // main is committed LAST, so a refusal anywhere before it leaves main clean
    expect(log).toEqual(['main:BEGIN IMMEDIATE', 'other:BEGIN IMMEDIATE', 'other:ROLLBACK', 'main:ROLLBACK'])
  })

  it('names the files already committed when one after them refuses', () => {
    const log: string[] = []
    const tx = makeTxManager([
      { name: 'main',  db: fake('main', log) },
      { name: 'one',   db: fake('one', log) },
      { name: 'two',   db: fake('two', log, 'COMMIT') },
    ])
    expect(() => tx.wrap(() => {})).toThrow(/committed: one · rolled back: two, main/)
    expect(log.slice(3)).toEqual(['one:COMMIT', 'two:ROLLBACK', 'main:ROLLBACK'])
  })
})
