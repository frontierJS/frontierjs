// permissions — manifest-derived permission set + audit-miss warnings.
//
// Two distinct checks:
//   1. AUDIT-MISS (dev only). Warn first time an API is called whose
//      permission isn't in the declared manifest. Static analysis can miss
//      dynamic dispatch like browser[apiName].something — this catches it.
//   2. UNAVAILABLE API. If permission is missing, Chrome may not expose the
//      surface at all. Throw clear error in that case.

let _permsCache = null
let _warnedKeys = null

export function getDeclaredPermissions(runtime) {
  if (_permsCache) return _permsCache
  if (!runtime?.getManifest) {
    _permsCache = new Set()
    return _permsCache
  }
  try {
    const m = runtime.getManifest() ?? {}
    _permsCache = new Set([
      ...(m.permissions || []),
      ...(m.optional_permissions || []),
    ])
  } catch {
    _permsCache = new Set()
  }
  return _permsCache
}

// Reset for tests — not exported in main barrel.
export function _resetPermissionsCache() {
  _permsCache = null
  _warnedKeys = null
}

// Audit-miss dev warning. Idempotent per (surface, perm) pair.
// Returns the underlying API surface unchanged — call site decides whether
// to also throw if surface is undefined.
export function auditCheck(runtime, surfaceName, requiredPerm, isDev) {
  if (!isDev) return
  const perms = getDeclaredPermissions(runtime)
  if (perms.has(requiredPerm)) return
  if (!_warnedKeys) _warnedKeys = new Set()
  const key = `${surfaceName}:${requiredPerm}`
  if (_warnedKeys.has(key)) return
  _warnedKeys.add(key)
  console.warn(
    `[jetty] browser.${surfaceName} used but permission "${requiredPerm}" not declared. ` +
    `Add to permissions.declared in jetty.config.js (or enable permissions.audit).`
  )
}

// Throws clear error when underlying API surface is undefined (= permission missing
// at runtime, regardless of what manifest declared).
export function requireSurface(api, surfaceName, requiredPerm) {
  if (api == null) {
    throw new Error(
      `browser.${surfaceName} unavailable — likely missing "${requiredPerm}" permission. ` +
      `Check manifest and reload the extension.`
    )
  }
  return api
}
