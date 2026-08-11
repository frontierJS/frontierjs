/**
 * src/theme/index.js — theme management
 *
 * Exposes:
 *   theme         — plain object: { value: 'light' | 'dark' }
 *   setTheme(v)   — set + persist
 *   toggleTheme() — flip between light/dark
 *
 * Config (sierra.config.js):
 *   theme: {
 *     default:   'system'     // 'light' | 'dark' | 'system'
 *     persist:   true         // save to localStorage
 *     attribute: 'data-theme' // attribute set on <html>
 *     key:       'theme'      // localStorage key
 *   }
 *
 * A tiny inline script is injected into <head> at build time
 * (by the post-build pipeline) that reads the persisted preference
 * and sets the attribute before first paint — preventing flash.
 */

import { watchProxy } from '@frontierjs/mesa/runtime.js'

// ─── Public state ────────────────────────────────────────────────────────────

/**
 * The theme — a plain object, the last of Sierra's module-level state to become
 * one. `page` and `status` went first; this one held the whole `externalSignals`
 * bridge up on its own after they did.
 *
 * Not a signal. A component makes it reactive with a `$:` path watch
 * (VISION §4.1, RULE 43):
 *
 *   import { theme } from '@frontierjs/sierra/theme'
 *   $: theme.value
 *   <button on:click={toggleTheme}>{theme.value}</button>
 *
 * @property {'light'|'dark'} value  the resolved theme — never 'system'
 */
export const theme = { value: 'light' }

// The writer's handle. Every mutation goes through it so path watches fire —
// assigning `theme.value` directly updates the object and notifies nobody
// (RULE 45). Resolved per write rather than captured at import: watchProxy is a
// no-op with no DOM (RULE 19), so a handle taken at module load in a non-browser
// environment would stay the raw object even after setRenderEnvironment() says
// otherwise. It caches per object, so this is a WeakMap hit.
const _w = () => watchProxy(theme)

// ─── Internal config ─────────────────────────────────────────────────────────

let _config = {
  default:   'system',
  persist:   true,
  attribute: 'data-theme',
  key:       'theme',
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Boot the theme system. Called by virtual:sierra.
 * @param {object} config — theme config from sierra.config.js
 */
export function initTheme(config = {}) {
  _config = {
    default:   config.default   ?? 'system',
    persist:   config.persist   ?? true,
    attribute: config.attribute ?? 'data-theme',
    key:       config.key       ?? 'theme',
  }

  if (typeof window === 'undefined') return

  // Resolve the actual theme (never 'system')
  const resolved = resolveTheme()
  _w().value = resolved
  applyTheme(resolved)

  // Watch system preference changes (only relevant if default === 'system' or
  // if user hasn't overridden)
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    // Only react to system changes if the user hasn't persisted an override
    if (_config.persist) {
      const stored = localStorage.getItem(_config.key)
      if (stored) return  // user has a preference — don't override
    }
    if (_config.default === 'system') {
      const resolved = mq.matches ? 'dark' : 'light'
      _w().value = resolved
      applyTheme(resolved)
    }
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Set the theme explicitly.
 * @param {'light'|'dark'} value
 */
export function setTheme(value) {
  if (value !== 'light' && value !== 'dark') {
    console.warn(`[Sierra] setTheme: invalid value '${value}'. Use 'light' or 'dark'.`)
    return
  }

  _w().value = value
  applyTheme(value)

  if (_config.persist && typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
    localStorage.setItem(_config.key, value)
  }
}

/**
 * Toggle between light and dark.
 */
export function toggleTheme() {
  setTheme(theme.value === 'dark' ? 'light' : 'dark')
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function resolveTheme() {
  // 1. Persisted user preference
  if (_config.persist && typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(_config.key)
    if (stored === 'light' || stored === 'dark') return stored
  }

  // 2. Config default
  if (_config.default === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  return _config.default === 'dark' ? 'dark' : 'light'
}

function applyTheme(value) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute(_config.attribute, value)
}
// ─── Inline script generation (used by post-build) ────────────────────────────
// Implementation lives in ./script.js so the post-build pipeline can import it
// without pulling this module — and with it the signal runtime — into Node-side
// config resolution.
export { buildThemeScript } from './script.js'
