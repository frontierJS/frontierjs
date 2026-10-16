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
import { createTestEnv } from '../src/testing.js'
import { GatePlugin } from '../src/plugins/gate.js'

const tick = () => new Promise((r) => setImmediate(r))

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver trail }
  model Secret {
    id   String @id @default(uuid())
    name String
    @@gate(4)
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

  test('the model declares @@gate(8)', async () => {
    await withClient(async (db) => {
      const model = db.$schema.models.find((m: any) => m.name === 'AuditTrail')
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
      expect(rows[0].model).toBe('Secret')
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
          @@gate(6)
        }
        model Note { id Int @id  body String  @@gate(2)  @@trail(audit) }
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

// The jsonl reader compiles no row policy, so a trail model's @@allow or
// @@deny parsed and admitted every caller to every row (FJS-2148).
describe('a row policy on a trail model is refused by name', () => {

  for (const rule of [`@@allow('read', auth().id == actorId)`, `@@deny('read', auth().id != actorId)`]) {
    test(rule.slice(0, 7), async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-gate-'))
      const schema = `
        database main  { path ":memory:" }
        database audit { path "${dir}/audit/" driver trail model AuditRow }
        model AuditRow {
          id        String   @id @default(uuid())
          operation String
          model     String
          actorId   String?
          createdAt DateTime @default(now())
          @@db(audit)
          @@gate(2)
          ${rule}
        }
        model Note { id Int @id  body String  @@trail(audit) }
      `
      try {
        await expect(createClient({ schema, resolveFrom: dir })).rejects.toThrow(/'driver trail'.*no row policy/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

// FJS-2532 — a schema declaring only a trail database has no `database main`,
// and the test env's template main.db had nowhere to land.
describe('createTestEnv on a schema whose only declared database is a trail', () => {
  test('boots, and the undeclared main is a working database', async () => {
    const env = await createTestEnv({ schema: `
      database audit { path "./audit/" driver trail }
      model Thing { id Int @id @default(autoincrement())  name String  @@trail(audit) }
    ` })
    try {
      await env.system.thing.create({ data: { name: 'a' } })
      expect(await env.system.thing.findMany()).toHaveLength(1)
    } finally {
      env.close()
    }
  })
})
