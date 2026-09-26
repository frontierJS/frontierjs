/*
 * kv.ts
 *
 * The `store` node's port over the `KvEntry` model (`FJS-D281`), through the
 * system client of the run's tenant — the rows are orion's own, gated at 8 —
 * which `systemOf` finds from the run's actor.
 *
 * `KvEntry` declares `@@expires(expiresAt)`, so an entry past its deadline
 * reads as absent the moment it lapses, whether or not the sweep has removed
 * it, and the deadline is minted from the client's own clock (`$now()`) — the
 * one the window grades on. The two lookups that must see a lapsed row say
 * `withExpired`: `set`, which overwrites it in place rather than colliding with
 * it on `@@unique([scope, key])`, and `delete`, which removes it either way.
 */

import type { IKeyValueStore } from "./engine/ports"

interface KvTable {
  findFirst(args: object): Promise<{ id: string; value: unknown } | null>
  create(args: object): Promise<unknown>
  update(args: object): Promise<unknown>
  deleteMany(args: object): Promise<{ count: number }>
}

export function litestoneKeyValue(systemOf: (actor: unknown) => { kvEntry: KvTable; $now(): Date }): IKeyValueStore {
  return {
    async get(actor, scope, key) {
      const row = await systemOf(actor).kvEntry.findFirst({ where: { scope, key } })
      return row ? row.value : undefined
    },

    async set(actor, scope, key, value, ttlMs) {
      const db   = systemOf(actor)
      const data = { value, expiresAt: ttlMs === undefined ? null : new Date(db.$now().getTime() + ttlMs).toISOString() }
      const row  = await db.kvEntry.findFirst({ where: { scope, key }, withExpired: true })
      if (row) {
        await db.kvEntry.update({ where: { id: row.id }, data, select: false, withExpired: true })
        return
      }
      // Two runs setting one new key race here; the loser's insert is the row
      // the winner made, and its value is the one that lands.
      try {
        await db.kvEntry.create({ data: { scope, key, ...data }, select: false })
      } catch (err) {
        if ((err as Error).name !== "UniqueConflictError") throw err
        const winner = await db.kvEntry.findFirst({ where: { scope, key }, withExpired: true })
        await db.kvEntry.update({ where: { id: winner!.id }, data, select: false, withExpired: true })
      }
    },

    async delete(actor, scope, key) {
      const db  = systemOf(actor)
      const row = await db.kvEntry.findFirst({ where: { scope, key } })
      await db.kvEntry.deleteMany({ where: { scope, key }, withExpired: true })
      return row !== null
    },
  }
}
