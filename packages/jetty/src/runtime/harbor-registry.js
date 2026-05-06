// harbor-registry — typed port registry for Harbor side.
//
// Replaces Phase 0.5's flat Set<port> w/ a Map<key, Set<port>> indexed by the
// parsed port name. Key shape:
//   'dock'             — single key, port count typically ≤ 1 (popup)
//   'options'          — single key, port count ≤ 1 (one tab usually)
//   'pier:<id>'        — one key per Pier, count = open tab count for that Pier
//   'island:<id>'      — one key per Island id, count = number of host tabs
//
// Multiple ports per key is normal and intended. Options can be opened in
// multiple tabs; Islands run in every matching tab. Broadcast must hit all.
//
// All `send*` methods return bool: true iff at least one port received the
// message. False = page closed / island unmounted / no tab listening.

export function makeHarborRegistry() {
  const ports = new Map() // key → Set<port>

  return {
    add(port, parsed) {
      const key = registryKey(parsed)
      let set = ports.get(key)
      if (!set) { set = new Set(); ports.set(key, set) }
      set.add(port)
      return key
    },

    remove(port, parsed) {
      const key = registryKey(parsed)
      const set = ports.get(key)
      if (!set) return
      set.delete(port)
      if (set.size === 0) ports.delete(key)
    },

    sendTo(key, type, payload) {
      const set = ports.get(key)
      if (!set || set.size === 0) return false
      let delivered = 0
      for (const p of set) {
        try { p.postMessage({ type, payload }); delivered++ }
        catch { /* port closed mid-iteration; ignore */ }
      }
      return delivered > 0
    },

    broadcast(type, payload) {
      let delivered = 0
      for (const set of ports.values()) {
        for (const p of set) {
          try { p.postMessage({ type, payload }); delivered++ }
          catch { /* port closed; ignore */ }
        }
      }
      return delivered > 0
    },

    keys() { return [...ports.keys()] },
    countFor(key) { return ports.get(key)?.size ?? 0 },
    total() {
      let n = 0
      for (const set of ports.values()) n += set.size
      return n
    },
  }
}

export function registryKey(parsed) {
  if (parsed.type === 'pier' || parsed.type === 'island') {
    return `${parsed.type}:${parsed.id}`
  }
  // dock / options — id is the type itself, key is just the type.
  return parsed.type
}

// pages API factory — the surface exposed in Harbor's run() ctx.
//   pages.dock.send(type, payload)              → bool
//   pages.options.send(type, payload)           → bool
//   pages.piers[id].send(type, payload)         → bool  (Proxy by id)
//   pages.islands[id].send(type, payload)       → bool  (Proxy by id, Phase 4 mostly)
//   pages.broadcast(type, payload)              → bool
export function makePagesApi(registry) {
  return {
    dock:      { send: (type, payload) => registry.sendTo('dock',    type, payload) },
    options:   { send: (type, payload) => registry.sendTo('options', type, payload) },
    piers:     makeIdProxy(registry, 'pier'),
    islands:   makeIdProxy(registry, 'island'),
    broadcast: (type, payload) => registry.broadcast(type, payload),
  }
}

function makeIdProxy(registry, type) {
  return new Proxy({}, {
    get(_, id) {
      if (typeof id !== 'string') return undefined
      const key = `${type}:${id}`
      return {
        send: (msgType, payload) => registry.sendTo(key, msgType, payload),
      }
    },
  })
}
