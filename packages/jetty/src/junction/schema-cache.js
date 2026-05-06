// Schema cache — Harbor-side schema management.
//
// Responsibilities (per spec):
//   - On first connect / install: fetch schema, store in browser.storage.local
//   - On every wake: send cached schema's version with Junction handshake
//   - On version mismatch: refetch + rebroadcast `schema` to all open ports
//
// Phase 2: the real schema shape is opaque to jetty (it's whatever Junction
// returns). Jetty just stores/retrieves/version-checks. Phase 3's Resources
// will introspect schema for type generation.

import { safeFetchSchema, safeGetServerSchemaVersion } from './adapter.js'

const STORAGE_KEY = '__jetty_schema__'

export function makeSchemaCache({ adapter, storage }) {
  let cached = null // { version, schema } | null

  return {
    /**
     * Hydrate from persistent storage. Call once on Harbor wake.
     */
    async load() {
      if (!storage?.local) return null
      try {
        const got = await storage.local.get(STORAGE_KEY)
        const value = got?.[STORAGE_KEY] ?? null
        if (value && typeof value === 'object' && 'version' in value && 'schema' in value) {
          cached = value
        }
      } catch (e) {
        console.warn('[jetty] schema cache load failed:', e.message)
      }
      return cached
    },

    /**
     * Reconcile with server: if server reports a different schema version
     * than the cached one (or we have no cache), refetch and persist.
     * Returns the current { version, schema } or null if adapter unsupports schema.
     */
    async reconcile() {
      const serverVersion = await safeGetServerSchemaVersion(adapter)
      if (serverVersion == null) {
        // Adapter doesn't expose schema versioning. If we have no cache, try
        // a full fetch as a last resort.
        if (cached == null) {
          const fetched = await safeFetchSchema(adapter)
          if (fetched) await this._persist(fetched)
        }
        return cached
      }

      if (cached?.version === serverVersion) {
        // Cache valid.
        return cached
      }

      // Mismatch or no cache → refetch.
      const fetched = await safeFetchSchema(adapter)
      if (fetched) {
        await this._persist(fetched)
      }
      return cached
    },

    /**
     * Force-invalidate cache (called from `schema:changed` channel event).
     */
    async invalidate() {
      cached = null
      if (storage?.local) {
        try { await storage.local.remove(STORAGE_KEY) } catch {}
      }
    },

    get current() { return cached },

    async _persist(value) {
      cached = value
      if (storage?.local) {
        try { await storage.local.set({ [STORAGE_KEY]: value }) }
        catch (e) { console.warn('[jetty] schema cache persist failed:', e.message) }
      }
    },
  }
}
