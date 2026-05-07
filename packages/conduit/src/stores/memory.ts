// ============================================================
// Conduit — In-Memory Store
// Default registry backend. Zero dependencies.
// Use this for stateless apps or testing.
// Targets are lost on process restart.
// ============================================================

import type { ConduitStore, TargetDescriptor } from '../types.ts'

export function createMemoryStore(): ConduitStore {
  const map = new Map<string, TargetDescriptor>()

  return {
    init() {
      // Nothing to initialise for in-memory store
    },

    get(id) {
      return map.get(id) ?? null
    },

    set(descriptor) {
      // Preserve original registered_at if the target already exists
      const existing = map.get(descriptor.id)
      map.set(descriptor.id, {
        ...descriptor,
        registered_at: existing?.registered_at ?? descriptor.registered_at
      })
    },

    delete(id) {
      map.delete(id)
    },

    list() {
      return [...map.values()].sort((a, b) => a.registered_at - b.registered_at)
    },

    touch(id) {
      const target = map.get(id)
      if (target) map.set(id, { ...target, last_seen_at: Date.now() })
    }
  }
}
