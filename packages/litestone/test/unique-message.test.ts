// test/unique-message.test.ts
//
// An author's sentence on @@unique (FJS-D2302, FJS-4371). A conditional
// @@unique answered "Bet: productId is already taken", which never said the
// taken thing was the ACTIVE slot -- the predicate is the whole meaning, and
// nothing in the refusal carried it. The message replaces the per-field sentence
// and the summary's tail; the predicate goes on `err.constraint` for the
// developer and never into `errors[]`, which a form renders.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const SCHEMA = `
  model Bet {
    id        Int    @id @default(autoincrement())
    productId Int
    status    String
    @@unique([productId], where: status == 'active', "this product already has an active bet")
    @@gate(0)
  }

  model Seat {
    id     Int    @id @default(autoincrement())
    row    String
    number Int
    @@unique([row, number], "that seat is taken")
    @@gate(0)
  }

  model Plain {
    id   Int    @id @default(autoincrement())
    a    String
    b    String
    @@unique([a, b])
    @@gate(0)
  }
`

const thrown = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)

describe('@@unique carries an author message (FJS-D2302)', () => {
  test('a conditional @@unique answers with its message, and the predicate goes on constraint', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    await db.bet.create({ data: { productId: 1, status: 'active' } })
    await db.bet.create({ data: { productId: 1, status: 'settled' } })
    const e = await thrown(db.bet.create({ data: { productId: 1, status: 'active' } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.status).toBe(409)
    expect(e.message).toBe('Bet: this product already has an active bet.')
    expect(e.errors).toEqual([{ path: ['productId'], message: 'this product already has an active bet' }])
    expect(e.constraint).toBe(`"status" = 'active'`)
  })

  test('a plain composite answers with its message on every member', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    await db.seat.create({ data: { row: 'A', number: 1 } })
    const e = await thrown(db.seat.create({ data: { row: 'A', number: 1 } }))
    expect(e?.name).toBe('UniqueConflictError')
    expect(e.message).toBe('Seat: that seat is taken.')
    expect(e.errors.map((x: any) => x.message)).toEqual(['that seat is taken', 'that seat is taken'])
    expect(e.constraint).toBeUndefined()
  })

  test('without a message the sentence is unchanged', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    await db.plain.create({ data: { a: 'x', b: 'y' } })
    const e = await thrown(db.plain.create({ data: { a: 'x', b: 'y' } }))
    expect(e.message).toContain('is already taken — those values must be unique together')
  })

  test('parses after either named argument and reads to the node', () => {
    const r = parse(`model W { id Int @id  a Int  b Int?
      @@unique([a, b], nullsDistinct: true, "one per pair")
    }`)
    expect(r.errors).toEqual([])
    expect(r.schema.models[0].attributes.find((x: any) => x.kind === 'uniqueIndex').message).toBe('one per pair')
  })

  test('two declarations over one column set with different messages are refused', () => {
    const r = parse(`model W { id Int @id  a Int  s String
      @@unique([a], "one per a")
      @@unique([a], where: s == 'y', "one y per a")
    }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(/@@unique\(\[a\]\).*different messages/)
  })
})
