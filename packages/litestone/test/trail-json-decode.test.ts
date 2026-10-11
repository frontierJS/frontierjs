// trail-json-decode.test.ts — a jsonl trail's Json columns read back decoded.
//
// The entry is built with `records`, `before`, `after` and `meta` as JSON text,
// which a SQL trail's reader decodes and a jsonl line stored as a quoted string,
// so the same `findMany` answered `"[1]"` on one and `[1]` on the other
// (`FJS-2421`). A user model's Json column on the same driver answers the object.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

describe('a jsonl trail decodes its Json columns', () => {
  test('records, before, after and meta come back as values, and the line holds values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-json-'))
    try {
      const db: any = await createClient({ resolveFrom: dir, schema: `
        database main  { path "${dir}/main.db" }
        database audit { path "${dir}/audit/" driver trail }
        model Thing { id Int @id  name String  @@trail(audit) }
      ` })
      const sys = db.asSystem()
      await sys.thing.create({ data: { id: 1, name: 'a' } })
      await sys.thing.update({ where: { id: 1 }, data: { name: 'b' } })
      await db.$audit({ operation: 'read', model: 'thing', records: [1], meta: { tool: 'x' } })
      await tick(); await tick()

      const rows = await sys.auditTrail.findMany({ orderBy: { createdAt: 'asc' } })
      const update = rows.find((r: any) => r.operation === 'update')
      expect(update.records).toEqual([1])
      expect(update.before).toEqual({ id: 1, name: 'a' })
      expect(update.after).toEqual({ id: 1, name: 'b' })
      expect(rows.find((r: any) => r.operation === 'read').meta).toEqual({ tool: 'x' })
      expect(rows.find((r: any) => r.operation === 'create').meta).toBeNull()

      const lines = readFileSync(join(dir, 'audit', 'AuditTrail.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      expect(lines.every((l: any) => Array.isArray(l.records))).toBe(true)
      db.$close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
