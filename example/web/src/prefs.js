// web/src/prefs.js — the browser's own preferences.
//
// A plain object watched with `$:`, the same shape `session.js` uses. It is
// not a resource and not a model: nothing here is a fact about the shop, so
// nothing here belongs in db/schema.lite.
//
// The theme is applied to <body> as a class, which is the whole mechanism —
// @frontierjs/css is custom-property inheritance, so one class on any ancestor
// re-themes everything below it.

const KEY = 'shop_prefs'

export const THEMES = [
  'theme-default', 'theme-dark', 'theme-forest',
  'theme-midnight', 'theme-sunset', 'theme-elite',
]

const DEFAULTS = {
  theme:         'theme-default',
  dense:         false,
  perPage:       10,
  defaultStatus: '',
  noteTemplate:  '',
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
  applyTheme()
  return prefs
}

/**
 * Put the chosen theme on <body>, removing whichever one is there. Called on
 * boot and on save; the class list is the source of truth for what is applied,
 * so nothing has to remember the previous value.
 */
export function applyTheme() {
  if (typeof document === 'undefined') return
  const body = document.body
  for (const t of THEMES) body.classList.remove(t)
  body.classList.add(THEMES.includes(prefs.theme) ? prefs.theme : DEFAULTS.theme)
}
