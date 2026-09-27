// `@@anonymous` — a row nobody may attribute (`FJS-D349`).
//
// The absence that protects an anonymous row is not all on its own model. The
// connectteam survey carried no actor, no timestamp and no log, and still gave
// every response its name back through ONE `@@log(audit)` on the roster table
// written in the same transaction: the trail's millisecond clock, in order,
// against the anonymous table's rowid order. So the word refuses both ends — a
// correlatable column or log on the anonymous model at parse, and a logged
// write sharing a transaction with an anonymous one at runtime.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, createClient, autoMigrate } from '../src/index.js'

const TRAIL = 'database audit { path "./audit/" driver logger }\n'

describe('@@anonymous — refused at parse', () => {
  const refuses = (src: string, re: RegExp) => {
    const r = parse(src)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(re)
  }

  test('a model may declare it', () => {
    const r = parse('model Ballot {\n id Int @id\n rating Int\n day String @date\n @@anonymous\n}')
    expect(r.errors).toEqual([])
    expect(r.schema.models[0].attributes.some(a => a.kind === 'anonymous')).toBe(true)
  })

  test('its own @@log, which stamps an actor and the whole row on every write', () => {
    refuses(TRAIL + 'model Ballot {\n id Int @id\n @@anonymous\n @@log(audit)\n}', /Ballot.*@@anonymous.*@@log\(audit\)/s)
  })

  test('a field @log — written, or implied by @secret', () => {
    refuses(TRAIL + 'model Ballot {\n id Int @id\n note String @log(audit)\n @@anonymous\n}', /field 'note'.*logged/)
  })

  test('a column stamped from the writer', () => {
    refuses('model User { id Int @id\n @@auth }\nmodel Ballot {\n id Int @id\n @@anonymous\n @@createdBy\n}', /field 'createdById'.*writer/)
    refuses('model User { id Int @id\n @@auth }\nmodel Ballot {\n id Int @id\n by Int @updatedBy\n @@anonymous\n}', /field 'by'.*writer/)
  })

  test('a clock column — a millisecond is a join key', () => {
    refuses('model Ballot {\n id Int @id\n at DateTime @default(now())\n @@anonymous\n}', /field 'at'.*clock/)
    refuses('model Ballot {\n id Int @id\n at DateTime @updatedAt\n @@anonymous\n}', /field 'at'.*clock/)
  })

  test('it takes no argument', () => {
    const r = parse('model Ballot {\n id Int @id\n @@anonymous(x)\n}')
    expect(r.valid).toBe(false)
  })
})

describe('@@anonymous — a logged write in the same transaction is refused', () => {
  const SCHEMA = `
    database main  { path ":memory:" }
    database audit { path "./audit/" driver logger }
    model Ballot   { id Int @id  rating Int  @@anonymous }
    model Roster   { id Int @id  person String  answered Boolean @default(false)  @@log(audit) }
    model Note     { id Int @id  text String }
  `

  async function open() {
    const dir = mkdtempSync(join(tmpdir(), 'ls-anon-'))
    const db: any = await createClient({ schema: SCHEMA.replace('./audit/', join(dir, 'audit/')), databases: ':memory:' })
    await autoMigrate(db)
    return { db: db.asSystem(), close: () => { db.$close(); rmSync(dir, { recursive: true, force: true }) } }
  }

  test('the roster flip after the ballot — refused, and neither row lands', async () => {
    const { db, close } = await open()
    await db.roster.create({ data: { id: 1, person: 'ana' } })
    await expect(db.$transaction(async (tx: any) => {
      await tx.ballot.create({ data: { id: 1, rating: 4 } })
      await tx.roster.update({ where: { id: 1 }, data: { answered: true } })
    })).rejects.toThrow(/Roster.*Ballot.*@@anonymous/s)
    expect(await db.ballot.count()).toBe(0)
    expect((await db.roster.findFirst({ where: { id: 1 } })).answered).toBe(false)
    close()
  })

  test('the ballot after the roster flip — refused the same way', async () => {
    const { db, close } = await open()
    await db.roster.create({ data: { id: 1, person: 'ana' } })
    await expect(db.$transaction(async (tx: any) => {
      await tx.roster.update({ where: { id: 1 }, data: { answered: true } })
      await tx.ballot.create({ data: { id: 1, rating: 4 } })
    })).rejects.toThrow(/Ballot.*Roster.*@@anonymous/s)
    expect(await db.ballot.count()).toBe(0)
    close()
  })

  test('an unlogged neighbor, and each write on its own, are untouched', async () => {
    const { db, close } = await open()
    await db.$transaction(async (tx: any) => {
      await tx.ballot.create({ data: { id: 1, rating: 4 } })
      await tx.note.create({ data: { id: 1, text: 'fine' } })
    })
    await db.roster.create({ data: { id: 1, person: 'ana' } })
    await db.ballot.create({ data: { id: 2, rating: 5 } })
    expect(await db.ballot.count()).toBe(2)
    close()
  })

  test('a $audit() event beside the ballot — refused, in either order', async () => {
    const { db, close } = await open()
    await expect(db.$transaction(async (tx: any) => {
      await tx.ballot.create({ data: { id: 1, rating: 4 } })
      await tx.$audit({ operation: 'survey.answered', meta: { person: 'ana' } })
    })).rejects.toThrow(/\$audit.*Ballot.*@@anonymous/s)
    await expect(db.$transaction(async (tx: any) => {
      await tx.$audit({ operation: 'survey.answered', meta: { person: 'ana' } })
      await tx.ballot.create({ data: { id: 2, rating: 4 } })
    })).rejects.toThrow(/Ballot.*\$audit.*@@anonymous/s)
    expect(await db.ballot.count()).toBe(0)
    close()
  })

  test('a savepoint rolled back takes its write out of the pairing', async () => {
    const { db, close } = await open()
    await db.roster.create({ data: { id: 1, person: 'ana' } })
    await db.$transaction(async (tx: any) => {
      await tx.$transaction(async (inner: any) => {
        await inner.roster.update({ where: { id: 1 }, data: { answered: true } })
        throw new Error('undo')
      }).catch(() => {})
      await tx.ballot.create({ data: { id: 1, rating: 4 } })
    })
    expect(await db.ballot.count()).toBe(1)
    close()
  })
})
