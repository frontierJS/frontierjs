/**
 * list-cache.js — what this screen last saw, so an outage is not an empty page.
 *
 * Phase 3 of the Homestead work (`IDEAS/homestead.md`). The service worker makes
 * the app OPEN with no network; this is the other half — it makes the app have
 * something in it. Without both, offline is a working shell over empty tables,
 * which reads to a person as *the data is gone*.
 *
 * ── Only for a model that declared `@@sync` ────────────────────────────────
 *
 * Writing rows to a device is a disclosure, not a performance trick: it puts
 * whatever the gate let this caller read onto disk, where it outlives the
 * session. So the same word that already says *this model is written offline*
 * is what says *this model may be kept offline* (`FJS-D298`), and a model that
 * declared nothing is cached nowhere. No new attribute, and the default is to
 * write nothing.
 *
 * ── It answers on FAILURE, not on load ─────────────────────────────────────
 *
 * A cache that answered first and revalidated after would change what every
 * online screen shows, and the framework would then own a staleness policy it
 * has no way to be right about. So the network is asked exactly as before, and
 * this only speaks when the call could not arrive — which makes the online path
 * byte-identical and the offline path a strictly better failure than a throw.
 *
 * ── The key is the QUESTION, not the model ─────────────────────────────────
 *
 * One list per (service, query, directives). Two screens reading the same model
 * through different filters saw different rows and must be given back different
 * rows; keying by model would hand a filtered screen somebody else's list and
 * be indistinguishable, on screen, from a filter that stopped working.
 */

const DB_NAME    = 'fjs-lists'
const DB_VERSION = 1
const STORE      = 'lists'

/** A promise for one IDBRequest. */
const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror   = () => reject(req.error)
})

async function openDb() {
  try {
    if (typeof indexedDB === 'undefined') return null
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    return await wrap(req)
  } catch {
    return null
  }
}

/**
 * The question a list answers, as one string.
 *
 * `JSON.stringify` of an object is key-order dependent, and two screens writing
 * the same filter in a different order are asking the same question — so the
 * keys are sorted. Without it the cache silently holds two copies and each
 * screen only ever reads its own.
 */
export function listKey(service, query, directives) {
  const norm = (o) => {
    if (!o || typeof o !== 'object') return o ?? null
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, norm(o[k])]))
  }
  return `${service}|${JSON.stringify(norm(query))}|${JSON.stringify(norm(directives))}`
}

export function createListCache({ now = () => Date.now() } = {}) {
  const mem = new Map()

  let db      = null
  let durable = false
  const ready = openDb().then(async (handle) => {
    db = handle
    durable = !!handle
    if (!handle) return
    try {
      const tx = handle.transaction(STORE, 'readonly')
      for (const row of await wrap(tx.objectStore(STORE).getAll())) mem.set(row.key, row)
    } catch { /* a store we cannot read is an empty one */ }
  })

  return {
    ready,
    get durable() { return durable },

    /** Keep what the server just answered. */
    async remember(key, rows) {
      // Awaited, and it is the whole feature: the first load of a session
      // usually resolves before the database handle does, so writing without
      // this put the rows in memory only — and memory does not survive the
      // navigation that is the entire point. The drive read an empty table.
      await ready
      // Structured-cloned by IndexedDB, so a row carrying a Date or a nested
      // object survives; one carrying a function does not, and a throw here
      // must not take the load down with it.
      const entry = { key, rows, at: now() }
      mem.set(key, entry)
      if (db) {
        try { await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry)) }
        catch { durable = false }
      }
    },

    /** What this question last answered, or null. */
    async recall(key) {
      await ready
      return mem.get(key) ?? null
    },

    /** Everything, for a screen that wants to say how much is held. */
    list: () => [...mem.values()],

    /** Somebody signed out. Rows a gate let the PREVIOUS caller read are theirs. */
    async clear() {
      mem.clear()
      if (db) {
        try { await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).clear()) }
        catch { /* gone from memory either way */ }
      }
    },
  }
}

let _cache = null

/** One list cache for the whole app. */
export function listCache() {
  if (!_cache) _cache = createListCache()
  return _cache
}

/** Test seam: forget the app-wide cache so a suite can build its own. */
export function _resetListCache() { _cache = null }
