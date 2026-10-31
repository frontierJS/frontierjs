// `@@anonymous` — a row nobody may attribute (`FJS-D349`).
//
// The absence that protects an anonymous row is not all on its own model. The
// connectteam survey carried no actor, no timestamp and no log, and still gave
// every response its name back through ONE `@@trail(audit)` on the roster table
// written in the same transaction: the trail's millisecond clock, in order,
// against the anonymous table's rowid order. So the word refuses both ends — a
// correlatable column or log on the anonymous model at parse, and a logged
// write sharing a transaction with an anonymous one at runtime.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, createClient, autoMigrate } from '../src/index.js'

const TRAIL = 'database audit { path "./audit/" driver trail }\n'

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

  test('its own @@trail, which stamps an actor and the whole row on every write', () => {
    refuses(TRAIL + 'model Ballot {\n id Int @id\n @@anonymous\n @@trail(audit)\n}', /Ballot.*@@anonymous.*@@trail\(audit\)/s)
  })

  test('a field @trail — written, or implied by @secret', () => {
    refuses(TRAIL + 'model Ballot {\n id Int @id\n note String @trail(audit)\n @@anonymous\n}', /field 'note'.*logged/)
  })

  test('a column stamped from the writer', () => {
    refuses('model User { id Int @id\n @@auth }\nmodel Ballot {\n id Int @id\n @@anonymous\n @@createdBy\n}', /field 'createdById'.*writer/)
    refuses('model User { id Int @id\n @@auth }\nmodel Ballot {\n id Int @id\n by Int @updatedBy\n @@anonymous\n}', /field 'by'.*writer/)
  })

  test('a clock column — a millisecond is a join key', () => {
    refuses('model Ballot {\n id Int @id\n at DateTime @default(now())\n @@anonymous\n}', /field 'at'.*clock/)
    refuses('model Ballot {\n id Int @id\n at DateTime @updatedAt\n @@anonymous\n}', /field 'at'.*clock/)
  })

  // FJS-D1700: the service that holds the minimum-group rule is the only read
  // path, so a view reading the rows below the model's own read gate is refused.
  const RESPONSE = 'model Response {\n id Int @id\n teamId String\n score Int\n @@anonymous\n @@gate(8.8.9.9)\n}\n'
  const view = (sql: string, gate: string) =>
    `view ResponseLeak {\n teamId String\n score Int\n @@sql("${sql}")\n @@gate(${gate})\n}\n`

  test('a view reading it below its read gate (FJS-3701)', () => {
    refuses(RESPONSE + view('SELECT teamId, score FROM Response', '0'), /View 'ResponseLeak'.*Response.*@@anonymous.*read level 0.*8/s)
    refuses(RESPONSE + view('SELECT r.teamId, r.score FROM responses r', '7'), /View 'ResponseLeak'.*Response/s)
    refuses(RESPONSE.replace('@@gate(8.8.9.9)', '@@map("answers")\n @@gate(8.8.9.9)') + view('SELECT teamId, score FROM answers', '0'), /View 'ResponseLeak'.*Response/s)
  })

  test('a view at or above its read gate, or not naming it, parses', () => {
    expect(parse(RESPONSE + view('SELECT teamId, score FROM Response', '8')).errors).toEqual([])
    expect(parse(RESPONSE + 'model Team {\n id Int @id\n name String\n @@gate(0.8)\n}\n' + view('SELECT name AS teamId, 0 AS score FROM team', '0')).errors).toEqual([])
  })

  test('it takes no argument', () => {
    const r = parse('model Ballot {\n id Int @id\n @@anonymous(x)\n}')
    expect(r.valid).toBe(false)
  })
})

describe('@@anonymous — a logged write in the same transaction is refused', () => {
  const SCHEMA = `
    database main  { path ":memory:" }
    database audit { path "./audit/" driver trail }
    model Ballot   { id Int @id  rating Int  @@anonymous }
    model Roster   { id Int @id  person String  answered Boolean @default(false)  @@trail(audit) }
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
      await tx.$audit({ operation: 'survey.answered', model: 'Ballot', meta: { person: 'ana' } })
    })).rejects.toThrow(/\$audit.*Ballot.*@@anonymous/s)
    await expect(db.$transaction(async (tx: any) => {
      await tx.$audit({ operation: 'survey.answered', model: 'Ballot', meta: { person: 'ana' } })
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

// The announcement is the trail's clock without the trail: a roster flip
// broadcast at the instant the anonymous table grows names who answered
// (`FJS-3711`). A transaction that wrote an anonymous row announces none of its
// other writes, to any audience (`FJS-D1704`).
describe('@@anonymous — a transaction that wrote one announces nothing else', () => {
  const schemaAt = (file: string) => `
    database main { path "${file}"  announce crossProcess }
    model Ballot  { id Int @id  rating Int  @@anonymous }
    model Roster  { id Int @id  person String  answered Boolean @default(false) }
  `

  async function open() {
    const dir  = mkdtempSync(join(tmpdir(), 'ls-anon-quiet-'))
    const file = join(dir, 'main.db')
    const hooked: any[] = []
    const db: any = await createClient({ schema: schemaAt(file), onEvent: { change: (e: any) => { hooked.push(e) } } })
    await autoMigrate(db)
    const tapped: any[] = []
    db.$tapEvents((e: any) => { tapped.push(e) })
    const recorded = () => {
      const { Database } = require('bun:sqlite')
      const raw = new Database(file, { readonly: true })
      try { return raw.query('SELECT model, recordId FROM _litestone_events').all() }
      finally { raw.close() }
    }
    return { db: db.asSystem(), tapped, hooked, recorded, close: () => { db.$close(); rmSync(dir, { recursive: true, force: true }) } }
  }

  const settle = () => new Promise(r => setTimeout(r, 20))

  test('the roster flip beside a ballot reaches no tap, no onEvent hook and no cross-process record', async () => {
    const { db, tapped, hooked, recorded, close } = await open()
    await db.roster.create({ data: { id: 1, person: 'ana' } })
    await settle()
    tapped.length = 0; hooked.length = 0
    const before = recorded().filter((r: any) => r.model === 'Roster').length

    await db.$transaction(async (tx: any) => {
      await tx.roster.update({ where: { id: 1 }, data: { answered: true } })
      await tx.ballot.create({ data: { id: 1, rating: 4 } })
    })
    await settle()

    expect(tapped.filter(e => e.model === 'Roster')).toEqual([])
    expect(hooked.filter(e => e.model === 'Roster')).toEqual([])
    expect(recorded().filter((r: any) => r.model === 'Roster').length).toBe(before)
    expect((await db.roster.findFirst({ where: { id: 1 } })).answered).toBe(true)
    close()
  })

  test('the same flip with no ballot beside it is announced', async () => {
    const { db, tapped, recorded, close } = await open()
    await db.roster.create({ data: { id: 1, person: 'ana' } })
    await db.$transaction(async (tx: any) => {
      await tx.roster.update({ where: { id: 1 }, data: { answered: true } })
    })
    await settle()
    expect(tapped.filter(e => e.model === 'Roster').length).toBe(2)
    expect(recorded().filter((r: any) => r.model === 'Roster').length).toBe(2)
    close()
  })
})
