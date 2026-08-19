// web/src/prefs.js — the browser's own preferences.
//
// A plain object watched with `$:`, the same shape `session.js` uses. It is
// not a resource and not a model: nothing here is a fact about the shop, so
// nothing here belongs in db/schema.lite.
//
// The theme does not belong here. It is the one preference with a mechanism
// under it — a class on <html>, applied by a <head> script before first paint —
// and that script is written by the build, which this file is not part of.
// Adding a `theme` key back would apply it after the bundle loads, which is the
// flash the script exists to remove. It lives in sierra.config.js.

const KEY = 'shop_prefs'

const DEFAULTS = {
  dense:         false,
  perPage:       10,
  defaultStatus: '',
  noteTemplate:  '',
  // Read by /orders/: on, the reference opens the quick-view drawer; off, it
  // navigates to the order's own page.
  quickView:     false,
}

/** Live preferences. Mutated in place so `$:` path watches see the change. */
export const prefs = { ...DEFAULTS, ...read() }

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/**
 * Merge a set of edits in and persist. The screen edits local state and calls
 * this once, so nothing changes under the rest of the app until Save.
 */
export function savePrefs(edits = {}) {
  Object.assign(prefs, edits)
  localStorage.setItem(KEY, JSON.stringify(prefs))
  return prefs
}
