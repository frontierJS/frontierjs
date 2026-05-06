// browser.idb — Promise-based IndexedDB wrapper.
//
// Service-worker safety: the chief IDB pitfall in SWs is awaiting between
// starting a transaction and using its stores. The microtask queue runs
// during the await and IDB auto-commits/aborts pending transactions when
// the queue drains and there are no in-flight requests on the tx.
//
// This wrapper avoids that by:
//   - Single-op convenience methods (get/put/delete/getAll) wrap one IDBRequest
//     per transaction. No await between tx start and request issue.
//   - Multi-op via .transaction(stores, mode, fn) where fn is SYNCHRONOUS and
//     all requests are issued before fn returns. The wrapper resolves on
//     tx.oncomplete, so multiple-op flows still work without forced awaits.
//   - .raw exposes the underlying IDBDatabase for power-user cases.
//
// API:
//   const db = await browser.idb.open('myDb', { version, schema })
//   await db.put('store', value, key?)
//   const v = await db.get('store', key)
//   await db.delete('store', key)
//   const all = await db.getAll('store')
//   await db.transaction(['s1', 's2'], 'readwrite', (s1, s2) => {
//     s1.put({ ... })
//     s2.delete(key)
//   })
//   db.close()

export const idb = {
  open(name, opts = {}) {
    return openDb(name, opts)
  },
  // Direct delete of an entire database.
  deleteDatabase(name) {
    return new Promise((resolve, reject) => {
      const idbApi = getIdb()
      if (!idbApi) return reject(new Error('IndexedDB unavailable in this context'))
      const req = idbApi.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror   = () => reject(req.error)
      req.onblocked = () => {/* still resolves on success eventually */}
    })
  },
}

function getIdb() {
  if (typeof indexedDB !== 'undefined') return indexedDB
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB
  return null
}

function openDb(name, { version = 1, schema } = {}) {
  return new Promise((resolve, reject) => {
    const idbApi = getIdb()
    if (!idbApi) return reject(new Error('IndexedDB unavailable in this context'))

    const req = idbApi.open(name, version)
    req.onerror   = () => reject(req.error)
    req.onsuccess = () => resolve(wrapDb(req.result))
    req.onblocked = () => {/* another tab holds an old version; success still fires after they close */}
    req.onupgradeneeded = (e) => {
      if (typeof schema === 'function') {
        try { schema(req.result, e.oldVersion, e.newVersion) }
        catch (err) { console.error('[jetty] idb schema callback threw:', err); throw err }
      }
    }
  })
}

function wrapDb(db) {
  return {
    raw: db,

    get(storeName, key) {
      return runOne(db, storeName, 'readonly', (s) => s.get(key))
    },
    put(storeName, value, key) {
      return runOne(db, storeName, 'readwrite', (s) =>
        key !== undefined ? s.put(value, key) : s.put(value))
    },
    delete(storeName, key) {
      return runOne(db, storeName, 'readwrite', (s) => s.delete(key))
    },
    getAll(storeName) {
      return runOne(db, storeName, 'readonly', (s) => s.getAll())
    },
    count(storeName) {
      return runOne(db, storeName, 'readonly', (s) => s.count())
    },
    clear(storeName) {
      return runOne(db, storeName, 'readwrite', (s) => s.clear())
    },

    transaction(storeNames, mode, fn) {
      const names  = Array.isArray(storeNames) ? storeNames : [storeNames]
      const tx     = db.transaction(names, mode)
      const stores = names.map((n) => tx.objectStore(n))

      // Caller MUST issue all requests synchronously inside fn — the tx
      // commits when the microtask queue drains with no in-flight requests.
      let userResult
      try {
        userResult = fn(...stores)
      } catch (err) {
        try { tx.abort() } catch {}
        return Promise.reject(err)
      }

      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(userResult)
        tx.onerror    = () => reject(tx.error)
        tx.onabort    = () => reject(tx.error || new Error('transaction aborted'))
      })
    },

    close() { db.close() },
  }
}

function runOne(db, storeName, mode, makeRequest) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, mode)
    const req = makeRequest(tx.objectStore(storeName))
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
    // tx.onerror fires too but req.onerror is the canonical signal here.
  })
}
