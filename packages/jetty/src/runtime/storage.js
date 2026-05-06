// makeStorage — typed access to browser.storage areas.
// Phase 0: pass-through w/ promise normalization. Real typed shim lands Phase 1.
// IndexedDB lives at browser.idb (separate from storage namespace) — wired Phase 1.

export function makeStorage() {
  const api = (typeof browser !== 'undefined' && browser.storage)
    ? browser.storage
    : (typeof chrome !== 'undefined' && chrome.storage)

  if (!api) return inertStorage()

  return {
    local:   wrap(api.local),
    sync:    wrap(api.sync),
    session: api.session ? wrap(api.session) : inertArea('session'),
  }
}

function wrap(area) {
  // Chrome's storage already returns Promises in MV3 when called w/o callback.
  // Firefox's webextension API does too. Just expose passthrough w/ a guard.
  if (!area) return inertArea('?')
  return {
    get(keys)            { return Promise.resolve(area.get(keys)) },
    set(items)           { return Promise.resolve(area.set(items)) },
    remove(keys)         { return Promise.resolve(area.remove(keys)) },
    clear()              { return Promise.resolve(area.clear()) },
  }
}

function inertArea(name) {
  const err = () => Promise.reject(new Error(`storage.${name} unavailable in this context`))
  return { get: err, set: err, remove: err, clear: err }
}

function inertStorage() {
  return { local: inertArea('local'), sync: inertArea('sync'), session: inertArea('session') }
}
