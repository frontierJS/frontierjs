// test/foreign-key-error.test.ts
//
// A refused foreign key names the model, the relation and the value (FJS-1454,
// ruled FJS-D521). It reached the caller as SQLite's bare `FOREIGN KEY
// constraint failed`, so a loader of 443,834 rows could not tell a missing
// verse from a missing lemma, and a retention job could not tell which child
// held the person it was forgetting.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient, ForeignKeyError } from '../src/index.js'

const SCHEMA = `
  model Verse {
    id      Int    @id @default(autoincrement())
    verseId String @unique
    words   Word[]
  }

  model Lemma {
    id         Int    @id @default(autoincrement())
    strongsTag String @unique
    words      Word[]
  }

  model Word {
    id         Int     @id @default(autoincrement())
    text       String
    verseId    String
    verse      Verse   @relation(fields: [verseId], references: [verseId])
    strongsTag String?
    lemma      Lemma?  @relation(fields: [strongsTag], references: [strongsTag])
  }

  model Candidate {
    id           Int           @id @default(autoincrement())
    applications Application[]
  }

  model Application {
    id          Int       @id @default(autoincrement())
    candidateId Int
    candidate   Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)
    offers      Offer[]
  }

  model Offer {
    id            Int         @id @default(autoincrement())
    applicationId Int
    application   Application @relation(fields: [applicationId], references: [id], onDelete: Restrict)
  }
`

let db: any

beforeEach(async () => {
  db = await createClient({ db: ':memory:', schema: SCHEMA })
  await db.verse.create({ data: { verseId: '40017020' } })
  await db.lemma.create({ data: { strongsTag: 'G1' } })
})

const thrown = (p: Promise<unknown>) => p.then(() => null, (e: any) => e)

describe('a write naming a parent that does not exist (FJS-1454)', () => {
  test('create names the relation and the value', async () => {
    const e = await thrown(db.word.create({ data: { text: 'x', verseId: '40017021', strongsTag: 'G1' } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.model).toBe('Word')
    expect(e.relation).toBe('verse')
    expect(e.field).toBe('verseId')
    expect(e.value).toBe('40017021')
    expect(e.status).toBe(422)
    expect(e.errors).toEqual([{ path: ['verseId'], message: expect.stringContaining('40017021') }])
  })

  test('the other relation is told apart', async () => {
    const e = await thrown(db.word.create({ data: { text: 'x', verseId: '40017020', strongsTag: 'G9' } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.relation).toBe('lemma')
  })

  test('update too', async () => {
    const w = await db.word.create({ data: { text: 'x', verseId: '40017020' } })
    const e = await thrown(db.word.update({ where: { id: w.id }, data: { verseId: 'nope' } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.relation).toBe('verse')
  })
})

describe('a delete a Restrict child refuses (FJS-1454)', () => {
  test('one hop names the child', async () => {
    const c = await db.candidate.create({ data: {} })
    const a = await db.application.create({ data: { candidateId: c.id } })
    const o = await db.offer.create({ data: { applicationId: a.id } })
    const e = await thrown(db.application.delete({ where: { id: a.id } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.model).toBe('Application')
    expect(e.child).toEqual({ model: 'Offer', id: o.id })
    expect(e.status).toBe(422)
  })

  test('through a cascade too', async () => {
    const c = await db.candidate.create({ data: {} })
    const a = await db.application.create({ data: { candidateId: c.id } })
    const o = await db.offer.create({ data: { applicationId: a.id } })
    const e = await thrown(db.candidate.delete({ where: { id: c.id } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.child).toEqual({ model: 'Offer', id: o.id })
  })
})
