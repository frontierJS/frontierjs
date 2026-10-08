// audit-transition.test.ts — the trail names the MOVE, not only the states.
//
// Two moves between the same two states write identical before and after
// snapshots, so a trail recording only `operation: update` cannot tell an
// order abandoned by its `@@commitment` from one a person cancelled — which is
// the reason `abandon` is its own move at all (`FJS-D353`, `FJS-1294`). The
// cases are pairs for that reason: `cancel` against `abandon` over one edge,
// and a move against an update that is not one.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver trail }
  enum S { pending paid cancelled }
  model Order {
    id     Int    @id
    note   String @default("")
    status S      @default(pending) @trail(audit)
    @@gate("0")
    @@trail(audit)
    @@transitions(status,
      pay:     pending -> paid,
      cancel:  pending -> cancelled,
      abandon: pending -> cancelled @system
    )
  }
`

async function withDb(fn: (db: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-audit-move-'))
  const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
  try { await fn(db) }
  finally { db.$close(); rmSync(dir, { recursive: true, force: true }) }
}

/** Every update row the trail holds for one order, model-level first. */
async function updatesFor(db: any, id: number) {
  await tick()
  const rows = await db.asSystem().auditTrail.findMany({})
  return rows.filter((r: any) => r.operation === 'update' && JSON.parse(r.records).includes(id))
}

describe('an audited update names the move it made', () => {

  test('cancel and abandon share an edge and are told apart by name', async () => {
    await withDb(async (db) => {
      const u = db.$setAuth({ id: 'u-1' })
      await u.order.create({ data: { id: 1 } })
      await u.order.create({ data: { id: 2 } })
      await u.order.transition(1, 'cancel')
      await u.order.transition(2, 'abandon', { system: true })

      const cancelled = await updatesFor(db, 1)
      const abandoned = await updatesFor(db, 2)
      // Both levels: the model row and the field row `@trail` on status adds.
      expect(cancelled.map((r: any) => r.transition)).toEqual(['cancel', 'cancel'])
      expect(abandoned.map((r: any) => r.transition)).toEqual(['abandon', 'abandon'])
      // The snapshots alone are the same, which is what the column is for.
      const snap = (r: any) => JSON.parse(r.after).status
      expect(snap(cancelled.find((r: any) => r.field === null))).toBe('cancelled')
      expect(snap(abandoned.find((r: any) => r.field === null))).toBe('cancelled')
    })
  })

  test('a plain update that matches a move is named as that move', async () => {
    await withDb(async (db) => {
      const u = db.$setAuth({ id: 'u-1' })
      await u.order.create({ data: { id: 1 } })
      await u.order.update({ where: { id: 1 }, data: { status: 'paid' } })
      const [row] = (await updatesFor(db, 1)).filter((r: any) => r.field === null)
      expect(row.transition).toBe('pay')
    })
  })

  test('an update that moves nothing names no move', async () => {
    await withDb(async (db) => {
      const u = db.$setAuth({ id: 'u-1' })
      await u.order.create({ data: { id: 1 } })
      await u.order.update({ where: { id: 1 }, data: { note: 'hi' } })
      const [row] = await updatesFor(db, 1)
      expect(row.transition).toBeNull()
    })
  })
})
