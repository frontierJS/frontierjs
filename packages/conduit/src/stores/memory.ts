// ============================================================
// Conduit — In-Memory Store
// Default registry backend. Zero dependencies.
// Use this for stateless apps or testing.
// Targets are lost on process restart.
// ============================================================

import type { ConduitStore, TargetDescriptor } from '../types.ts'

export function createMemoryStore(): ConduitStore {
  const map = new Map<string, TargetDescriptor>()

  // Reads hand out copies. The SQLite store rebuilds descriptors from rows
  // and so is copy-on-read for free; this store would otherwise return the
  // live registry object, letting any consumer mutate it by accident.
  const copy = (d: TargetDescriptor): TargetDescriptor =>
    ({ ...d, auth: { ...d.auth } })

  return {
    async init() {
      // Nothing to initialize for in-memory store
    },

    async get(id) {
      const found = map.get(id)
      return found ? copy(found) : null
    },

    async set(descriptor) {
      // Preserve original registered_at if the target already exists
      const existing = map.get(descriptor.id)
      map.set(descriptor.id, copy({
        ...descriptor,
        registered_at: existing?.registered_at ?? descriptor.registered_at
      }))
    },

    async delete(id) {
      map.delete(id)
    },

    async list() {
      return [...map.values()]
        .sort((a, b) => a.registered_at - b.registered_at)
        .map(copy)
    },

    async touch(id) {
      const target = map.get(id)
      if (target) map.set(id, { ...target, last_seen_at: Date.now() })
    }
  }
}
