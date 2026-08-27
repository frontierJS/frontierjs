// store.js — backend-agnostic in-memory store for resource records.
//
// Ported from @frontierjs/sierra/junction/resource.js's createStore (Sierra v0.1.0).
// Pure logic. Apps consume this through Mesa via useStore() (see ./mesa-bridge.js).
//
// Differences from Sierra:
//   - Sierra's primary `store` comes from `client.resource(name, idField).store` —
//     Junction's own per-resource store auto-populated by WS push events.
//   - Jetty has no in-page Junction client. Junction lives in Harbor. We provide
//     a parallel in-memory store with the same interface, and the resource
//     module wires it from harbor channel:event messages (see resource.js).

/**
 * Create an in-memory record store with subscribe/upsert/remove semantics.
 *
 * @param {object} [opts]
 * @param {Array}  [opts.initial=[]]      — seed data
 * @param {string} [opts.idField='id']    — record identity key
 */
export function createStore(opts = {}) {
  const { initial = [], idField = 'id' } = opts

  let _data = Array.isArray(initial) ? [...initial] : initial
  // The query the rows are the answer to. `null` until a populate() — which is
  // not the same as `{}`: an empty filter admits every row, and *nobody has
  // asked yet* can grade none of them.
  let _query = null
  const _subs = new Set()

  function _notify() {
    for (const fn of _subs) {
      try { fn(_data) }
      catch (e) { console.error('[jetty] store subscriber threw', e) }
    }
  }

  const store = {
    /** Current value. */
    get() { return _data },

    /**
     * Subscribe to changes. Calls fn(currentValue) immediately.
     * Returns an unsubscribe function.
     */
    subscribe(fn) {
      _subs.add(fn)
      try { fn(_data) } catch (e) { console.error('[jetty] store init call threw', e) }
      return () => _subs.delete(fn)
    },

    /**
     * Replace the entire dataset. Notifies subscribers.
     *
     * Clears the remembered query, because rows put here by hand are not the
     * answer to the last `populate()`'s question and grading a pushed record
     * against it would be grading it against somebody else's filter.
     * `populate()` sets the query back afterwards.
     */
    set(data) {
      _data  = data
      _query = null
      _notify()
    },

    /**
     * Insert or replace a record by its id. New record goes to the end;
     * existing record is replaced in place. Always notifies.
     */
    upsert(record) {
      if (!Array.isArray(_data)) {
        // For non-array stores (e.g. single-record), upsert just replaces.
        _data = record
        _notify()
        return
      }
      const idx = _data.findIndex(r => r?.[idField] === record?.[idField])
      _data = idx === -1
        ? [..._data, record]
        : [..._data.slice(0, idx), record, ..._data.slice(idx + 1)]
      _notify()
    },

    /** Remove a record by id. No-op if id not found. */
    remove(id) {
      if (!Array.isArray(_data)) return
      const next = _data.filter(r => r?.[idField] !== id)
      if (next.length !== _data.length) {
        _data = next
        _notify()
      }
    },

    /**
     * Clear and replace from a service.find result, and resolve to the ROWS.
     *
     * find() may hand back a bare array (a custom service) or Junction's list
     * envelope `{ kind, object, data, total, limit, offset }` — both are
     * legitimate, so both are accepted.
     *
     * Returns the rows, not the raw result, matching Sierra's `load()`. It used
     * to return the raw result while setting the store to the rows, so
     * `await load(...)` and `store.get()` gave different shapes from one call.
     * Pagination metadata stays reachable via `service.find()` directly.
     */
    async populate(service, query, params) {
      const result = await service.find(query, params)
      const list = Array.isArray(result) ? result : (result?.data ?? [])
      store.set(list)
      _query = query ?? {}   // after set(), which clears it
      return list
    },

    /**
     * The filter this store's rows are the answer to — what the last
     * `populate()` asked for, `null` before there has been one.
     *
     * Read by the push handler, which cannot decide whether an arriving record
     * belongs here without it. Kept on the store rather than beside it because
     * the rows and the question they answer go stale together: a `set()` from
     * somewhere else is rows this store can say nothing about, so it clears the
     * query rather than leaving the previous one to grade them.
     */
    query() { return _query },
  }

  return store
}
