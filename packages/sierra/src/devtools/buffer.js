/**
 * Client-side ring buffers for devtools.
 * Initialised from the `state` snapshot. No persistence.
 */
export function createBuffer({ requests = 200, logs = 500, events = 200 } = {}) {
  // True circular buffer. The previous implementation was `push()` followed by
  // `shift()` on overflow — O(n) per push once full, so at the default 500-log
  // cap every single log line memmoved 500 elements. A write index and modular
  // arithmetic make it O(1); all() materialises in insertion order only when
  // something actually reads.
  const _ring = (cap) => {
    let buf = new Array(cap)
    let head = 0        // next write slot
    let count = 0       // live entries, saturating at cap

    return {
      /** Push, returning the entry this evicted (or undefined). */
      push(item) {
        const evicted = count === cap ? buf[head] : undefined
        buf[head] = item
        head = (head + 1) % cap
        if (count < cap) count++
        return evicted
      },
      all() {
        if (count < cap) return buf.slice(0, count)
        // Full: oldest entry sits at `head`.
        return buf.slice(head).concat(buf.slice(0, head))
      },
      /** Iterate newest-first without materialising a copy. */
      *reversed() {
        for (let i = 0; i < count; i++) {
          yield buf[(head - 1 - i + cap * 2) % cap]
        }
      },
      clear() { buf = new Array(cap); head = 0; count = 0 },
      get size() { return count },
    }
  }

  const reqs   = _ring(requests)
  const logs_  = _ring(logs)
  const evts   = _ring(events)

  // telemetryId → { hooks: [], queries: [] } — events arriving before their request
  const _hooks = new Map()

  // telemetryId → the request entry currently in the ring.
  // addHook/addQuery used to locate their request with
  // `reqs.all().find(r => r.id === ...)` — a linear scan of up to 200 entries,
  // run once per hook and once per query event, and hooks are far more frequent
  // than requests. This index makes it O(1). Entries evicted from the ring are
  // pruned lazily below.
  const _byId = new Map()

  function _getHooks(telemetryId) {
    if (!_hooks.has(telemetryId)) _hooks.set(telemetryId, { hooks: [], queries: [] })
    return _hooks.get(telemetryId)
  }

  // Cap pending hook map to avoid unbounded growth
  function _pruneHooks() {
    if (_hooks.size > 50) {
      const oldest = _hooks.keys().next().value
      if (oldest !== undefined) _hooks.delete(oldest)
    }
  }

  return {
    requests: reqs,
    logs:     logs_,
    events:   evts,

    addRequest(entry) {
      // Merge any hooks/queries that arrived before this request
      const pending = _hooks.get(entry.id)
      const enriched = { ...entry, hooks: pending?.hooks ?? [], queries: pending?.queries ?? [] }
      _hooks.delete(entry.id)
      // The ring tells us exactly what fell off, so the id index stays in sync
      // in O(1). Scanning all() to reconcile — as an earlier version of this did
      // — copies the whole ring on every request once it is full, which is worse
      // than the linear lookup this index exists to remove.
      const evicted = reqs.push(enriched)
      if (evicted) _byId.delete(evicted.id)
      _byId.set(entry.id, enriched)
      return enriched
    },

    addHook(event) {
      const existing = _byId.get(event.telemetryId)
      if (existing) {
        existing.hooks.push(event)
        return { found: true, request: existing }
      }
      const pending = _getHooks(event.telemetryId)
      pending.hooks.push(event)
      _pruneHooks()
      return { found: false }
    },

    addQuery(event) {
      const existing = _byId.get(event.telemetryId)
      if (existing) {
        existing.queries.push(event)
        return { found: true, request: existing }
      }
      const pending = _getHooks(event.telemetryId)
      pending.queries.push(event)
      _pruneHooks()
      return { found: false }
    },

    initFromState(state) {
      reqs.clear(); logs_.clear(); evts.clear(); _hooks.clear(); _byId.clear()
      ;(state.requests ?? []).forEach(r => {
        const e = { ...r, hooks: [], queries: [] }
        const evicted = reqs.push(e)
        if (evicted) _byId.delete(evicted.id)
        _byId.set(e.id, e)
      })
      ;(state.logs     ?? []).forEach(l => logs_.push(l))
      ;(state.events   ?? []).forEach(e => evts.push(e))
    },
  }
}
