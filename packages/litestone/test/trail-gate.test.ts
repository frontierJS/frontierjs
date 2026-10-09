// trail-gate.test.ts — who may read the model litestone synthesizes for a
// `driver trail` database (FJS-2139).
//
// `auditTrail` holds every trailed write's before- and after-image, every
// tenant's included, and it carried no @@gate — so a caller with no principal
// at all read the whole trail through the client while every model it records
// refused them. It is gated at SYSTEM(8), as the auth models are; the trail's
// own writes come from litestone and must not be graded against it.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'
import { GatePlugin } from '../src/plugins/gate.js'

const tick = () => new Promise((r) => setImmediate(r))

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver trail }
  model Secret {
    id   String @id @default(uuid())
    name String
    @@gate("4")
    @@trail(audit)
  }
`

async function withClient(fn: (db: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-gate-'))
  const db: any = await createClient({
    schema: SCHEMA(dir), resolveFrom: dir,
    plugins: [new GatePlugin({ getLevel: (user: any) => user?.level ?? 0 })],
  })
  try { await fn(db) } finally {
    db.$close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the synthesized trail model is gated at SYSTEM', () => {

  test('the model declares @@gate("8")', async () => {
    await withClient(async (db) => {
      const model = db.$schema.models.find((m: any) => m.name === 'auditTrail')
      const gate = model.attributes.find((a: any) => a.kind === 'gate')
      expect(gate?.value).toBe('8')
    })
  })

  test('nobody, and a caller below 8, is refused; asSystem reads it', async () => {
    await withClient(async (db) => {
      await db.$setAuth({ id: 'u-1', level: 7 }).secret.create({ data: { name: 'x' } })
      await tick()
      await expect(db.auditTrail.findMany({})).rejects.toThrow()
      await expect(db.$setAuth({ id: 'u-1', level: 7 }).auditTrail.findMany({})).rejects.toThrow()
      const rows = await db.asSystem().auditTrail.findMany({})
      expect(rows.length).toBe(1)
      expect(rows[0].model).toBe('secret')
    })
  })
})

describe('what the trail gate does not reach', () => {

  test('a schema whose only gate is the trail keeps db.sql — raw SQL never reaches the jsonl file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-gate-'))
    const db: any = await createClient({ resolveFrom: dir, schema: `
      database main  { path ":memory:" }
      database audit { path "${dir}/audit/" driver trail }
      model Note {
        id   Int    @id
        body String
        @@trail(audit)
      }
    ` })
    try {
      await db.note.create({ data: { id: 1, body: 'x' } })
      expect((await db.sql`SELECT body FROM note`).length).toBe(1)
    } finally {
      db.$close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a trail model the schema declares holds its own @@gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-gate-'))
    const db: any = await createClient({
      resolveFrom: dir,
      plugins: [new GatePlugin({ getLevel: (user: any) => user?.level ?? 0 })],
      schema: `
        database main  { path ":memory:" }
        database audit { path "${dir}/audit/" driver trail model AuditRow }
        model AuditRow {
          id        String   @id @default(uuid())
          operation String
          model     String
          createdAt DateTime @default(now())
          @@db(audit)
          @@gate("6")
        }
        model Note { id Int @id  body String  @@gate("2")  @@trail(audit) }
      ` })
    try {
      await db.$setAuth({ id: 'u', level: 2 }).note.create({ data: { id: 1, body: 'x' } })
      await tick()
      await expect(db.$setAuth({ id: 'u', level: 2 }).auditRow.findMany({})).rejects.toThrow(/requires level 6/)
      await expect(db.auditRow.findMany({})).rejects.toThrow(/requires level 6/)
      expect((await db.$setAuth({ id: 'u', level: 6 }).auditRow.findMany({})).length).toBe(1)
    } finally {
      db.$close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
