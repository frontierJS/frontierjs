/**
 * Client-side ring buffers for devtools.
 * Initialised from the `state` snapshot. No persistence.
 */
export function createBuffer({ requests = 200, logs = 500, events = 200 } = {}) {
  const _ring = (cap) => {
    let buf = []
    return {
      push(item) {
        buf.push(item)
        if (buf.length > cap) buf.shift()
      },
      all()     { return buf },
      clear()   { buf = [] },
      get size() { return buf.length },
    }
  }

  const reqs   = _ring(requests)
  const logs_  = _ring(logs)
  const evts   = _ring(events)

  // telemetryId → { hooks: [], queries: [] } — holds events for pending/active requests
  const _hooks = new Map()

  function _getHooks(telemetryId) {
    if (!_hooks.has(telemetryId)) _hooks.set(telemetryId, { hooks: [], queries: [] })
    return _hooks.get(telemetryId)
  }

  // Cap pending hook map to avoid unbounded growth
  function _pruneHooks() {
    if (_hooks.size > 50) {
      const oldest = [..._hooks.keys()][0]
      _hooks.delete(oldest)
    }
  }

  return {
    requests: reqs,
    logs:     logs_,
    events:   evts,

    addRequest(entry) {
      // Merge any pending hooks/queries for this telemetryId
      const pending = _hooks.get(entry.id)
      const enriched = { ...entry, hooks: pending?.hooks ?? [], queries: pending?.queries ?? [] }
      _hooks.delete(entry.id)
      reqs.push(enriched)
      return enriched
    },

    addHook(event) {
      // Update in-place if request row exists, else hold in pending map
      const existing = reqs.all().find(r => r.id === event.telemetryId)
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
      const existing = reqs.all().find(r => r.id === event.telemetryId)
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
      reqs.clear(); logs_.clear(); evts.clear(); _hooks.clear()
      ;(state.requests ?? []).forEach(r => reqs.push({ ...r, hooks: [], queries: [] }))
      ;(state.logs     ?? []).forEach(l => logs_.push(l))
      ;(state.events   ?? []).forEach(e => evts.push(e))
    },
  }
}
