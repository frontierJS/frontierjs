// cascade-seen.test.ts — a row a foreign key's `onDelete: Cascade` removes is
// a deleted row, to the plugins and to the trail.
//
// The cascade runs inside SQLite's own DELETE statement, so the client only
// ever named the ONE row the caller did. Measured in the jazzhr stressor:
// deleting 288 candidates wrote 0 `application.delete` lines to a `@@log(audit)`
// trail and left all 288 résumés in the file store (FJS-1497).

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate } from '../src/index.js'
import { Plugin } from '../src/core/plugin.js'

const tick = () => new Promise((r) => setImmediate(r))

const TRAIL = `
  id            Int      @id @default(autoincrement())
  operation     String
  model         String
  field         String?
  records       Json
  before        Json?
  after         Json?
  actorId       String?
  actorType     String?
  correlationId String?
  source        String?
  origin        String?
  ip            String?
  userAgent     String?
  tenant        String?
  meta          Json?
  createdAt     DateTime @default(now())
`

const SCHEMA = `
  database main { path ":memory:" model AuditRow }
  model AuditRow { ${TRAIL} }
  model Person {
    id    Int @id
    name  String
    apps  Application[]
  }
  model Application {
    id        Int @id
    personId  Int
    person    Person @relation(fields: [personId], references: [id], onDelete: Cascade)
    cards     Scorecard[]
    @@log(main)
  }
  model Scorecard {
    id     Int @id
    appId  Int
    app    Application @relation(fields: [appId], references: [id], onDelete: Cascade)
    @@log(main)
  }
  model Note {
    id        Int @id
    personId  Int?
    person    Person? @relation(fields: [personId], references: [id])
  }
`

class Spy extends Plugin {
  deleted: Record<string, number[]> = {}
  async onAfterDelete(model: string, rows: any[]) {
    ;(this.deleted[model] ??= []).push(...rows.map(r => r.id))
  }
}

async function seeded() {
  const spy = new Spy()
  const db: any = await createClient({ schema: SCHEMA, db: ':memory:', plugins: [spy] })
  await autoMigrate(db)
  const sys = db.asSystem()
  await sys.person.create({ data: { id: 1, name: 'Ada' } })
  await sys.person.create({ data: { id: 2, name: 'Bo' } })
  await sys.application.create({ data: { id: 10, personId: 1 } })
  await sys.application.create({ data: { id: 11, personId: 1 } })
  await sys.application.create({ data: { id: 20, personId: 2 } })
  await sys.scorecard.create({ data: { id: 100, appId: 10 } })
  await sys.scorecard.create({ data: { id: 101, appId: 11 } })
  await sys.scorecard.create({ data: { id: 200, appId: 20 } })
  await tick()
  return { db, sys, spy }
}

async function deleteLines(sys: any) {
  await tick()
  const rows = await sys.auditRow.findMany({ where: { operation: 'delete' } })
  const out: Record<string, number[]> = {}
  for (const r of rows) (out[r.model] ??= []).push(...r.records)
  for (const k of Object.keys(out)) out[k].sort((a, b) => a - b)
  return out
}

describe('a cascade is a delete the plugins and the trail hear about', () => {

  for (const verb of ['delete', 'remove'] as const) {
    test(`${verb}() — every row the cascade reaches, two hops down`, async () => {
      const { db, sys, spy } = await seeded()
      await sys.person[verb]({ where: { id: 1 } })

      // SQLite did remove them — the defect was never the data.
      expect(await sys.application.count({})).toBe(1)
      expect(await sys.scorecard.count({})).toBe(1)

      expect(spy.deleted.Application?.sort()).toEqual([10, 11])
      expect(spy.deleted.Scorecard?.sort()).toEqual([100, 101])
      const lines = await deleteLines(sys)
      expect(lines.application).toEqual([10, 11])
      expect(lines.scorecard).toEqual([100, 101])
      db.$close()
    })
  }

  for (const verb of ['deleteMany', 'removeMany'] as const) {
    test(`${verb}() — the whole set's children`, async () => {
      const { db, sys, spy } = await seeded()
      await sys.person[verb]({ where: { id: { in: [1, 2] } } })
      expect(spy.deleted.Application?.sort()).toEqual([10, 11, 20])
      expect(spy.deleted.Scorecard?.sort()).toEqual([100, 101, 200])
      const lines = await deleteLines(sys)
      expect(lines.application).toEqual([10, 11, 20])
      expect(lines.scorecard).toEqual([100, 101, 200])
      db.$close()
    })
  }

  test('a child whose relation does not cascade is not reported', async () => {
    const { db, sys, spy } = await seeded()
    await sys.person.create({ data: { id: 3, name: 'Cy' } })
    await sys.note.create({ data: { id: 1, personId: null } })
    await sys.person.delete({ where: { id: 3 } })
    expect(spy.deleted.Note).toBeUndefined()
    expect(spy.deleted.Application).toBeUndefined()
    db.$close()
  })

  test('a delete that removes nothing reports nothing', async () => {
    const { db, sys, spy } = await seeded()
    await sys.person.deleteMany({ where: { id: 99 } })
    expect(spy.deleted).toEqual({})
    expect(await deleteLines(sys)).toEqual({})
    db.$close()
  })
})

describe('the two stores the stressor measured', () => {

  test('a trail with no plugin at all still hears the cascade', async () => {
    const db: any = await createClient({ schema: SCHEMA, db: ':memory:' })
    await autoMigrate(db)
    const sys = db.asSystem()
    await sys.person.create({ data: { id: 1, name: 'Ada' } })
    await sys.application.create({ data: { id: 10, personId: 1 } })
    await sys.scorecard.create({ data: { id: 100, appId: 10 } })
    await sys.person.delete({ where: { id: 1 } })
    const lines = await deleteLines(sys)
    expect(lines.application).toEqual([10])
    expect(lines.scorecard).toEqual([100])
    db.$close()
  })

  test('FileStorage deletes the bytes of a cascaded row', async () => {
    const { FileStorage } = await import('../src/storage/file-storage.js')
    const files = FileStorage({ provider: 'local', bucket: 'test' }) as any
    const db: any = await createClient({
      schema: `
        model Candidate { id Int @id  docs Document[] }
        model Document {
          id           Int @id
          candidateId  Int
          candidate    Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade)
          file         File?
        }
      `,
      db: ':memory:', plugins: [files],
    })
    await autoMigrate(db)
    const removed: string[] = []
    files._provider = { ...files._provider, async delete(key: string) { removed.push(key) } }
    const sys = db.asSystem()
    await sys.candidate.create({ data: { id: 1 } })
    await sys.document.create({ data: { id: 1, candidateId: 1, file: JSON.stringify({ key: 'docs/1/cv.pdf', bucket: 'test' }) } })
    await sys.candidate.delete({ where: { id: 1 } })
    expect(removed).toEqual(['docs/1/cv.pdf'])
    db.$close()
  })
})

describe('the @hardDelete children of a soft cascade are removed rows too (FJS-1506)', () => {
  const HARD = `
    database main { path ":memory:" model AuditRow }
    model AuditRow { ${TRAIL} }
    model Person {
      id        Int @id
      deletedAt DateTime?
      docs      Document[] @hardDelete
      @@softDelete(cascade)
    }
    model Document {
      id        Int @id
      personId  Int
      person    Person @relation(fields: [personId], references: [id], onDelete: Cascade)
      pages     Page[]
      @@log(main)
    }
    model Page {
      id     Int @id
      docId  Int
      doc    Document @relation(fields: [docId], references: [id], onDelete: Cascade)
      @@log(main)
    }
  `

  async function seededHard() {
    const spy = new Spy()
    const db: any = await createClient({ schema: HARD, db: ':memory:', plugins: [spy] })
    await autoMigrate(db)
    const sys = db.asSystem()
    for (const id of [1, 2]) await sys.person.create({ data: { id } })
    await sys.document.create({ data: { id: 10, personId: 1 } })
    await sys.document.create({ data: { id: 11, personId: 1 } })
    await sys.document.create({ data: { id: 20, personId: 2 } })
    await sys.page.create({ data: { id: 100, docId: 10 } })
    await sys.page.create({ data: { id: 200, docId: 20 } })
    await tick()
    return { db, sys, spy }
  }

  test('remove() — the children and what they cascade to', async () => {
    const { db, sys, spy } = await seededHard()
    await sys.person.remove({ where: { id: 1 } })
    expect(await sys.document.count({})).toBe(1)
    expect(spy.deleted.Document?.sort()).toEqual([10, 11])
    expect(spy.deleted.Page).toEqual([100])
    const lines = await deleteLines(sys)
    expect(lines.document).toEqual([10, 11])
    expect(lines.page).toEqual([100])
    db.$close()
  })

  test('removeMany() — the whole set\'s children', async () => {
    const { db, sys, spy } = await seededHard()
    await sys.person.removeMany({ where: { id: { in: [1, 2] } } })
    expect(spy.deleted.Document?.sort()).toEqual([10, 11, 20])
    expect(spy.deleted.Page?.sort()).toEqual([100, 200])
    const lines = await deleteLines(sys)
    expect(lines.document).toEqual([10, 11, 20])
    db.$close()
  })
})

describe('a child a foreign key\'s onDelete: SetNull clears is an updated row (FJS-1505)', () => {
  const NULLED = `
    database main { path ":memory:" model AuditRow }
    model AuditRow { ${TRAIL} }
    model Person {
      id    Int @id
      notes Note[]
    }
    model Note {
      id        Int @id
      personId  Int?
      person    Person? @relation(fields: [personId], references: [id], onDelete: SetNull)
      @@log(main)
    }
  `

  class Writes extends Plugin {
    written: Array<[string, string, any]> = []
    async onAfterWrite(model: string, op: string, row: any) { this.written.push([model, op, row]) }
  }

  async function seededNotes(plugin?: Plugin) {
    const db: any = await createClient({ schema: NULLED, db: ':memory:', ...(plugin ? { plugins: [plugin] } : {}) })
    await autoMigrate(db)
    const sys = db.asSystem()
    await sys.person.create({ data: { id: 1 } })
    await sys.person.create({ data: { id: 2 } })
    await sys.note.create({ data: { id: 10, personId: 1 } })
    await sys.note.create({ data: { id: 11, personId: 1 } })
    await sys.note.create({ data: { id: 20, personId: 2 } })
    await tick()
    return { db, sys }
  }

  async function updateLines(sys: any) {
    await tick()
    const rows = await sys.auditRow.findMany({ where: { operation: 'update' } })
    return rows.filter((r: any) => r.model === 'note')
  }

  for (const verb of ['delete', 'deleteMany'] as const) {
    test(`${verb}() — each nulled child is an update line, before and after`, async () => {
      const { db, sys } = await seededNotes()
      await sys.person[verb]({ where: { id: 1 } })
      expect((await sys.note.findMany({ where: { personId: null } })).map((n: any) => n.id).sort()).toEqual([10, 11])
      const lines = await updateLines(sys)
      const ids = lines.flatMap((l: any) => l.records).sort((a: number, b: number) => a - b)
      expect(ids).toEqual([10, 11])
      for (const l of lines) {
        expect(l.before.personId).toBe(1)
        expect(l.after.personId).toBeNull()
      }
      db.$close()
    })
  }

  test('a plugin hears an update for each nulled child', async () => {
    const spy = new Writes()
    const { db, sys } = await seededNotes(spy)
    spy.written.length = 0
    await sys.person.delete({ where: { id: 1 } })
    const notes = spy.written.filter(([m, op]) => m === 'Note' && op === 'update')
    expect(notes.map(([, , r]) => r.id).sort()).toEqual([10, 11])
    expect(notes.every(([, , r]) => r.personId === null)).toBe(true)
    await tick()
    db.$close()
  })

  test('a child of another parent is not reported', async () => {
    const { db, sys } = await seededNotes()
    await sys.person.delete({ where: { id: 1 } })
    const lines = await updateLines(sys)
    expect(lines.flatMap((l: any) => l.records)).not.toContain(20)
    db.$close()
  })
})
