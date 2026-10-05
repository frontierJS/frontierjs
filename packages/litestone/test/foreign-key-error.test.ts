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

describe('a bulk or soft-delete cascade a Restrict child refuses (FJS-1609)', () => {
  const SOFT = `
    model Account {
      id        Int        @id @default(autoincrement())
      deletedAt DateTime?
      projects  Project[]  @hardDelete
      @@softDelete(cascade)
    }

    model Project {
      id        Int      @id @default(autoincrement())
      accountId Int
      account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
      tasks     Task[]
    }

    model Task {
      id        Int      @id @default(autoincrement())
      projectId Int
      project   Project  @relation(fields: [projectId], references: [id], onDelete: Restrict)
    }
  `

  async function chain(d: any) {
    const c = await d.candidate.create({ data: {} })
    const a = await d.application.create({ data: { candidateId: c.id } })
    const o = await d.offer.create({ data: { applicationId: a.id } })
    return { c, a, o }
  }

  test('deleteMany names the child', async () => {
    const { a, o } = await chain(db)
    const e = await thrown(db.application.deleteMany({ where: { id: a.id } }))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.model).toBe('Application')
    expect(e.child).toEqual({ model: 'Offer', id: o.id })
    expect(await db.application.count()).toBe(1)
  })

  test('deleteMany through a cascade too', async () => {
    const { o } = await chain(db)
    const e = await thrown(db.candidate.deleteMany({}))
    expect(e).toBeInstanceOf(ForeignKeyError)
    expect(e.child).toEqual({ model: 'Offer', id: o.id })
  })

  test('a hard remove and removeMany name the child', async () => {
    const { a, o } = await chain(db)
    for (const e of [
      await thrown(db.application.remove({ where: { id: a.id } })),
      await thrown(db.application.removeMany({ where: { id: a.id } })),
    ]) {
      expect(e).toBeInstanceOf(ForeignKeyError)
      expect(e.child).toEqual({ model: 'Offer', id: o.id })
    }
  })

  test('a soft remove whose @hardDelete child is held by a Restrict grandchild', async () => {
    const d = await createClient({ db: ':memory:', schema: SOFT })
    const acc = await d.account.create({ data: {} })
    const p = await d.project.create({ data: { accountId: acc.id } })
    const t = await d.task.create({ data: { projectId: p.id } })
    const one = await thrown(d.account.remove({ where: { id: acc.id } }))
    expect(one).toBeInstanceOf(ForeignKeyError)
    expect(one.child).toEqual({ model: 'Task', id: t.id })
    const many = await thrown(d.account.removeMany({ where: { id: acc.id } }))
    expect(many).toBeInstanceOf(ForeignKeyError)
    expect(many.child).toEqual({ model: 'Task', id: t.id })
  })

  test('a refused removeMany cascade leaves the children it reached before the refusal live (FJS-1714)', async () => {
    const d = await createClient({ db: ':memory:', schema: `
      model Account {
        id        Int        @id @default(autoincrement())
        deletedAt DateTime?
        notes     Note[]
        projects  Project[]  @hardDelete
        @@softDelete(cascade)
      }

      model Note {
        id        Int       @id @default(autoincrement())
        accountId Int
        account   Account   @relation(fields: [accountId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }

      model Project {
        id        Int      @id @default(autoincrement())
        accountId Int
        account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
        tasks     Task[]
      }

      model Task {
        id        Int      @id @default(autoincrement())
        projectId Int
        project   Project  @relation(fields: [projectId], references: [id], onDelete: Restrict)
      }
    ` })
    const acc = await d.account.create({ data: {} })
    await d.note.create({ data: { accountId: acc.id } })
    const p = await d.project.create({ data: { accountId: acc.id } })
    await d.task.create({ data: { projectId: p.id } })
    for (const verb of ['remove', 'removeMany'] as const) {
      const e = await thrown(d.account[verb]({ where: { id: acc.id } }))
      expect(e).toBeInstanceOf(ForeignKeyError)
      expect(await d.note.count()).toBe(1)
      expect(await d.account.count()).toBe(1)
    }
  })
})

describe('a value the column cannot hold (FJS-1609, FJS-D521)', () => {
  const TYPED = `
    model Doc {
      id Int    @id @default(autoincrement())
      n  Int
      f  Float?
    }
  `
  test('every write names the field in a ValidationError', async () => {
    const d = await createClient({ db: ':memory:', schema: TYPED })
    const row = await d.doc.create({ data: { n: 1 } })
    const writes: Array<() => Promise<unknown>> = [
      () => d.doc.create({ data: { n: 1.5 } }),
      () => d.doc.create({ data: { n: 1, f: 'x' as any } }),
      () => d.doc.createMany({ data: [{ n: 1.5 }] }),
      () => d.doc.update({ where: { id: row.id }, data: { n: 1.5 } }),
      () => d.doc.updateMany({ where: {}, data: { n: 'abc' as any } }),
      () => d.doc.upsert({ where: { id: 99 }, create: { n: 1.5 }, update: {} }),
    ]
    for (const w of writes) {
      const e = await thrown(w())
      expect(e?.name).toBe('ValidationError')
      expect(['n', 'f']).toContain(e.errors[0].path[0])
      expect(e.errors[0].message).toContain('cannot hold')
    }
  })
})
