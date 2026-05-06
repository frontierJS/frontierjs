// @frontierjs/jetty/browser — cross-browser API shim.
//
// Phase 1: typed surfaces w/ permission-required error messages and dev-mode
// audit-miss warnings. Each surface lazy-checks its required permission on
// first access; dev warns once per (surface, perm) pair.
//
// Surface coverage (per spec):
//   storage.{local,sync,session}, runtime, tabs, scripting, contextMenus,
//   action, alarms, idb (separate IDB wrapper)
//
// Escape hatch: browser.raw exposes underlying chrome / browser globals.
//
// Dev mode detection: __JETTY_DEV__ is replaced at build time.
// Production builds skip audit warnings (would be noise for fixed manifest).

import { auditCheck, requireSurface } from './permissions.js'
import { idb }                        from './idb.js'

// Dev mode detection: `__JETTY_DEV__` is replaced at build time by Vite's
// `define` config (set in vite-config.js). Avoids any reference to
// `import.meta` at the source level — important because this module is also
// reached from island content scripts, which run as CLASSIC scripts in MV3
// (not modules), and the parser rejects any literal `import.meta` token in
// classic scripts even when it's behind a `typeof` guard.
//
// In source / tests where `__JETTY_DEV__` is not substituted, `typeof` keeps
// us safe — `typeof <undefined identifier>` is the one form that doesn't
// throw a ReferenceError.
const IS_DEV = (typeof __JETTY_DEV__ !== 'undefined') ? __JETTY_DEV__ : true

function getNative() {
  // Must use globalThis.browser explicitly — `browser` is also our exported
  // const at the bottom of this module. Bare `typeof browser` resolves to the
  // local export, not the Firefox webextension global.
  if (typeof globalThis !== 'undefined') {
    if (globalThis.browser?.runtime) return globalThis.browser
    if (globalThis.chrome?.runtime)  return globalThis.chrome
  }
  return null
}

function getRuntime() {
  const n = getNative()
  return n?.runtime ?? null
}

// --- storage surface ---

function makeStorageArea(areaName) {
  return {
    get(keys) {
      const native = getNative()
      auditCheck(native?.runtime, `storage.${areaName}`, 'storage', IS_DEV)
      const area = requireSurface(native?.storage?.[areaName], `storage.${areaName}`, 'storage')
      return Promise.resolve(area.get(keys))
    },
    set(items) {
      const native = getNative()
      auditCheck(native?.runtime, `storage.${areaName}`, 'storage', IS_DEV)
      const area = requireSurface(native?.storage?.[areaName], `storage.${areaName}`, 'storage')
      return Promise.resolve(area.set(items))
    },
    remove(keys) {
      const native = getNative()
      auditCheck(native?.runtime, `storage.${areaName}`, 'storage', IS_DEV)
      const area = requireSurface(native?.storage?.[areaName], `storage.${areaName}`, 'storage')
      return Promise.resolve(area.remove(keys))
    },
    clear() {
      const native = getNative()
      auditCheck(native?.runtime, `storage.${areaName}`, 'storage', IS_DEV)
      const area = requireSurface(native?.storage?.[areaName], `storage.${areaName}`, 'storage')
      return Promise.resolve(area.clear())
    },
    onChanged: {
      addListener(fn) {
        const native = getNative()
        const area = requireSurface(native?.storage?.[areaName], `storage.${areaName}`, 'storage')
        // chrome.storage.<area>.onChanged exists in MV3
        if (area.onChanged?.addListener) {
          area.onChanged.addListener(fn)
        } else if (native.storage.onChanged?.addListener) {
          // Fallback: aggregate listener filtered by areaName.
          native.storage.onChanged.addListener((changes, scope) => {
            if (scope === areaName) fn(changes)
          })
        } else {
          throw new Error(`storage.${areaName}.onChanged unavailable`)
        }
      },
    },
  }
}

const storage = {
  local:   makeStorageArea('local'),
  sync:    makeStorageArea('sync'),
  session: makeStorageArea('session'),
}

// --- generic surface factory ---
// For surfaces that need a simple "use the native API but check permission first" wrap.
function makeSurface(surfaceKey, requiredPerm) {
  return new Proxy({}, {
    get(_, prop) {
      const native = getNative()
      auditCheck(native?.runtime, surfaceKey, requiredPerm, IS_DEV)
      const api = requireSurface(native?.[surfaceKey], surfaceKey, requiredPerm)
      const value = api[prop]
      // Bind methods so `browser.tabs.query(...)` works without losing `this`.
      return typeof value === 'function' ? value.bind(api) : value
    },
  })
}

// runtime — no permission required (always available)
const runtime = new Proxy({}, {
  get(_, prop) {
    const r = getRuntime()
    if (!r) throw new Error('browser.runtime unavailable — not in extension context')
    const value = r[prop]
    return typeof value === 'function' ? value.bind(r) : value
  },
})

// tabs — typically requires 'tabs' (full info) or 'activeTab' (limited). Spec
// surfaces both. We declare the broader 'tabs' for the audit warning; if
// only 'activeTab' is granted, chrome will return limited info but not throw.
const tabs          = makeSurface('tabs',         'tabs')
const scripting     = makeSurface('scripting',    'scripting')
const contextMenus  = makeSurface('contextMenus', 'contextMenus')
const action        = (() => {
  // chrome.action / browser.action — no permission needed for action API itself
  return new Proxy({}, {
    get(_, prop) {
      const native = getNative()
      const api = requireSurface(native?.action, 'action', /* no perm needed */ '')
      const value = api[prop]
      return typeof value === 'function' ? value.bind(api) : value
    },
  })
})()
const alarms        = makeSurface('alarms',       'alarms')

// notifications, cookies — listed in spec audit table. Add surfaces.
const notifications = makeSurface('notifications', 'notifications')
const cookies       = makeSurface('cookies',       'cookies')

// --- assembled browser surface ---

export const browser = {
  storage,
  idb,
  runtime,
  tabs,
  scripting,
  contextMenus,
  action,
  alarms,
  notifications,
  cookies,

  // Escape hatch — direct access to underlying globals.
  get raw() {
    return {
      chrome:  (typeof globalThis !== 'undefined' && globalThis.chrome)  ?? null,
      browser: (typeof globalThis !== 'undefined' && globalThis.browser) ?? null,
    }
  },
}

// Re-export permission helpers for jetty internals (build pipeline, tests).
export { _resetPermissionsCache } from './permissions.js'
