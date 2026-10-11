// trail-model-name.test.ts — the trail's `model` column holds the MODEL name.
//
// A `@@trail` write was filed under the SQL table name (`pay_window`) while
// `$audit({ model: 'PayWindow' })` filed the name it was handed, so one
// `where: { model }` matched half the trail and read as *not logged* (FJS-2380).

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

describe('the trail names a model by its model name', () => {
  test('a @@trail write and a $audit event match one where { model }', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-trail-model-'))
    try {
      const db: any = await createClient({ resolveFrom: dir, schema: `
        database main  { path "${dir}/main.db" }
        database audit { path "${dir}/audit/" driver trail }
        model PayWindow { id Int @id  name String  @@trail(audit) }
      ` })
      const sys = db.asSystem()
      await sys.payWindow.create({ data: { id: 1, name: 'a' } })
      await sys.payWindow.update({ where: { id: 1 }, data: { name: 'b' } })
      await db.$audit({ operation: 'read', model: 'PayWindow', records: [1] })
      // The accessor and the table name are spellings of the same model.
      await db.$audit({ operation: 'read', model: 'payWindow', records: [1] })
      await db.$audit({ operation: 'read', model: 'pay_window', records: [1] })
      // A name that is no model (an extract's dataset) is written as given.
      await db.$audit({ operation: 'export', model: 'monthly' })
      await tick(); await tick()

      expect(await sys.auditTrail.count({ where: { model: 'PayWindow' } })).toBe(5)
      expect(await sys.auditTrail.count({ where: { model: 'monthly' } })).toBe(1)
      db.$close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
