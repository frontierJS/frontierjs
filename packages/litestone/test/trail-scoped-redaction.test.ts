// trail-scoped-redaction.test.ts — a protected column written by a scoped
// caller logs as `[redacted]`, the same as the write made as system.
//
// The trail's images were the row as the CALLER reads it, and the caller's
// read strips a @secret column, so a `system: ['apiKey']` write filed a field
// entry saying null to null and two images without the column — false
// evidence of what changed, where Invariant 7 asks for `[redacted]` (FJS-2297).

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const SCHEMA = `
  database main  { path env("MAIN_DB", "./main.db") }
  database audit { path "./audit/" driver trail }
  model Vault {
    id     Int     @id
    name   String
    apiKey String? @secret
    @@db(main)
    @@trail(audit)
  }
`

const ROW = { id: 1, name: 'v', apiKey: '[redacted]' }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ls-trail-redact-'))
  mkdirSync(join(dir, 'audit'), { recursive: true })
  const seen: any[] = []
  const db: any = await createClient({
    schema:        SCHEMA,
    databases:     { main: { path: join(dir, 'main.db') }, audit: { path: join(dir, 'audit') } },
    encryptionKey: 'a'.repeat(64),
    onLog:         (entry: any) => { seen.push({ ...entry }) },
  })
  const logged = async (operation: string) => {
    await new Promise(r => setTimeout(r, 20))
    return seen.filter(e => e.operation === operation)
  }
  return { db, logged }
}

const parse = (s: string | null) => (s == null ? null : JSON.parse(s))
const seed  = (db: any) => db.asSystem().vault.create({ data: { id: 1, name: 'v', apiKey: 'old' } })

describe('a protected column written by a scoped caller logs as [redacted]', () => {
  for (const [who, client, extra] of [
    ['as system',          (db: any) => db.asSystem(),         {}],
    ['through system: []', (db: any) => db.$setAuth({ id: 1 }), { system: ['apiKey'] }],
  ] as const) {
    test(`update ${who}`, async () => {
      const { db, logged } = await setup()
      await seed(db)
      await client(db).vault.update({ where: { id: 1 }, data: { apiKey: 'new' }, ...extra })
      const entries = await logged('update')

      const field = entries.find(e => e.field === 'apiKey')
      expect([parse(field.before), parse(field.after)]).toEqual(['[redacted]', '[redacted]'])
      const model = entries.find(e => e.field == null)
      expect([parse(model.before), parse(model.after)]).toEqual([ROW, ROW])
      db.$close()
    })

    test(`create ${who}`, async () => {
      const { db, logged } = await setup()
      await client(db).vault.create({ data: { id: 1, name: 'v', apiKey: 'new' }, ...extra })
      const entries = await logged('create')

      expect(parse(entries.find(e => e.field === 'apiKey').after)).toBe('[redacted]')
      expect(parse(entries.find(e => e.field == null).after)).toEqual(ROW)
      db.$close()
    })

    test(`delete ${who}`, async () => {
      const { db, logged } = await setup()
      await seed(db)
      await client(db).vault.delete({ where: { id: 1 } })
      const entries = await logged('delete')

      expect(parse(entries.find(e => e.field == null).before)).toEqual(ROW)
      db.$close()
    })
  }
})
