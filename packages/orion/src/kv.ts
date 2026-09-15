/*
 * kv.ts
 *
 * The `store` node's port over the `KvEntry` model (`FJS-D281`), through the
 * system client of the run's tenant — the rows are orion's own, gated at 8 —
 * which `systemOf` finds from the run's actor.
 *
 * An entry past its `expiresAt` reads as absent the moment it lapses, whether
 * or not the sweep has removed it; the sweep is housekeeping, not the rule.
 */

import type { IKeyValueStore } from "./engine/ports"

interface KvTable {
  findFirst(args: object): Promise<{ id: string; value: unknown; expiresAt: string | null } | null>
  create(args: object): Promise<unknown>
  update(args: object): Promise<unknown>
  deleteMany(args: object): Promise<{ count: number }>
}

export function litestoneKeyValue(systemOf: (actor: unknown) => { kvEntry: KvTable }, now: () => number = Date.now): IKeyValueStore {
  const live = (row: { expiresAt: string | null } | null) =>
    row !== null && (row.expiresAt === null || Date.parse(row.expiresAt) > now())

  return {
    async get(actor, scope, key) {
      const db  = systemOf(actor)
      const row = await db.kvEntry.findFirst({ where: { scope, key } })
      return live(row) ? row!.value : undefined
    },

    async set(actor, scope, key, value, ttlMs) {
      const db   = systemOf(actor)
      const data = { value, expiresAt: ttlMs === undefined ? null : new Date(now() + ttlMs).toISOString() }
      const row  = await db.kvEntry.findFirst({ where: { scope, key } })
      if (row) {
        await db.kvEntry.update({ where: { id: row.id }, data, select: false })
        return
      }
      // Two runs setting one new key race here; the loser's insert is the row
      // the winner made, and its value is the one that lands.
      try {
        await db.kvEntry.create({ data: { scope, key, ...data }, select: false })
      } catch (err) {
        if ((err as Error).name !== "UniqueConflictError") throw err
        const winner = await db.kvEntry.findFirst({ where: { scope, key } })
        await db.kvEntry.update({ where: { id: winner!.id }, data, select: false })
      }
    },

    async delete(actor, scope, key) {
      const db  = systemOf(actor)
      const row = await db.kvEntry.findFirst({ where: { scope, key } })
      const { count } = await db.kvEntry.deleteMany({ where: { scope, key } })
      return count > 0 && live(row)
    },
  }
}
