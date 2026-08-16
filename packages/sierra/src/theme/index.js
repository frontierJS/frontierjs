/**
 * src/theme/index.js — theme management
 *
 * Exposes:
 *   theme         — plain object: { value: '<theme name>' }
 *   setTheme(v)   — set + persist
 *   toggleTheme() — advance to the next configured theme
 *
 * Config (sierra.config.js):
 *   theme: {
 *     themes:  ['theme-default', 'theme-dark']  // what this app offers
 *     default: 'system'                         // a name, or 'system'
 *     system:  { light: 'theme-default', dark: 'theme-dark' }
 *     persist: true                             // save to localStorage
 *     key:     'theme'                          // localStorage key
 *     apply:   'class'                          // 'class' | 'attribute'
 *     attribute: 'data-theme'                   // only when apply: 'attribute'
 *   }
 *
 * A tiny inline script is injected into <head> at build time
 * (by the post-build pipeline) that reads the persisted preference
 * and applies it before first paint — preventing flash.
 *
 * ── Why a class on <html>, and why that is not a knob ──────────────────────
 *
 * `@frontierjs/css` ships no JavaScript, so it cannot own a switcher — but it
 * DOES own the vocabulary: eleven `theme-*` classes, each a block of
 * inheriting custom properties and nothing else. This module used to set
 * `data-theme` on <html> instead, which the design system reads NOWHERE: an
 * app calling `setTheme('dark')` changed an attribute and not one pixel. Both
 * apps in this repo went and wrote their own applier, which is the symptom
 * that says the mechanism was never real.
 *
 * The element is always <html> and there is no option for it. A `<head>`
 * script is the only thing that can beat first paint and <body> does not
 * exist yet when it runs, so a `target: 'body'` would be a setting whose only
 * effect is to reintroduce the flash. Nothing is lost: a theme is inheriting
 * tokens, so <html> reaches <body> and everything under it.
 *
 * Theming a SUBTREE — `<nav class="sidebar theme-dark">` — is a class written
 * by hand in the markup, which is what `@frontierjs/css`'s frame.css already
 * documents. It is not this switcher's job.
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
 *   import { theme, setTheme } from '@frontierjs/sierra/theme'
 *   $: theme.value
 *   <button on:click={() => setTheme('theme-dark')}>{theme.value}</button>
 *
 * @property {string} value  the resolved theme name — never 'system'
 */
export const theme = { value: '' }

// The writer's handle. Every mutation goes through it so path watches fire —
// assigning `theme.value` directly updates the object and notifies nobody
// (RULE 45). Resolved per write rather than captured at import: watchProxy is a
// no-op with no DOM (RULE 19), so a handle taken at module load in a non-browser
// environment would stay the raw object even after setRenderEnvironment() says
// otherwise. It caches per object, so this is a WeakMap hit.
const _w = () => watchProxy(theme)

// ─── Internal config ─────────────────────────────────────────────────────────

/**
 * The two the design system ships as a light/dark pair. Defaults rather than
 * a hard-coded list: an app declares whichever of the eleven it offers, and an
 * app not using `@frontierjs/css` names whatever its own stylesheet reads.
 */
const DEFAULT_THEMES = ['theme-default', 'theme-dark']

let _config = normalise({})

function normalise(config) {
  const themes = Array.isArray(config.themes) && config.themes.length
    ? config.themes
    : DEFAULT_THEMES

  // An app that named an `attribute` and no `apply` was configuring the older
  // contract, where the attribute was the only thing this module wrote. Say so
  // rather than quietly switching it to a class: the two are indistinguishable
  // from inside the app, and the symptom is a stylesheet that stops matching.
  if (config.attribute && !config.apply) {
    console.warn(
      `[Sierra] theme.attribute is set but theme.apply is not. The theme is applied as a ` +
      `CLASS now, which is what @frontierjs/css reads; add apply: 'attribute' to keep ` +
      `writing ${config.attribute}.`,
    )
  }

  return {
    themes,
    default:   config.default   ?? 'system',
    // Which of this app's themes the OS preference maps onto. Falls back to the
    // first two declared, which is the light/dark pair for any app that lists
    // them in that order and is at worst a stable choice for one that does not.
    system: {
      light: config.system?.light ?? themes[0],
      dark:  config.system?.dark  ?? themes[1] ?? themes[0],
    },
    persist:   config.persist   ?? true,
    key:       config.key       ?? 'theme',
    apply:     config.apply     ?? 'class',
    attribute: config.attribute ?? 'data-theme',
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Boot the theme system. Called by virtual:sierra.
 * @param {object} config — theme config from sierra.config.js
 */
export function initTheme(config = {}) {
  _config = normalise(config)

  if (typeof window === 'undefined') return

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
      const next = mq.matches ? _config.system.dark : _config.system.light
      _w().value = next
      applyTheme(next)
    }
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** The themes this app declared, in order. */
export function themes() {
  return [..._config.themes]
}

/**
 * Set the theme explicitly.
 *
 * An unknown name is refused by NAME and the configured list is printed with
 * it: the failure otherwise is a call that returns normally and changes
 * nothing, which reads as a broken stylesheet rather than a typo.
 *
 * @param {string} value  one of the configured theme names
 */
export function setTheme(value) {
  if (!_config.themes.includes(value)) {
    console.warn(
      `[Sierra] setTheme: '${value}' is not one of this app's themes ` +
      `(${_config.themes.join(', ')}). Declare it in sierra.config.js under theme.themes.`,
    )
    return
  }

  _w().value = value
  applyTheme(value)

  if (_config.persist && typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
    localStorage.setItem(_config.key, value)
  }
}

/**
 * Advance to the next configured theme, wrapping at the end.
 *
 * With the two-theme default this is the light/dark toggle it has always been;
 * with more it is a cycle, because "the other one" is not a question a list of
 * eleven can answer.
 */
export function toggleTheme() {
  const list = _config.themes
  const at   = list.indexOf(theme.value)
  setTheme(list[(at + 1) % list.length])
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function resolveTheme() {
  // 1. Persisted user preference — only if this app still offers it. A theme
  //    removed from the config would otherwise be restored from storage for
  //    every reader who had ever selected it, with no stylesheet behind it.
  if (_config.persist && typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(_config.key)
    if (stored && _config.themes.includes(stored)) return stored
  }

  // 2. Config default
  if (_config.default === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? _config.system.dark
      : _config.system.light
  }

  return _config.themes.includes(_config.default) ? _config.default : _config.themes[0]
}

function applyTheme(value) {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  if (_config.apply === 'attribute') {
    root.setAttribute(_config.attribute, value)
    return
  }

  // Remove the ones this app declared rather than everything matching
  // `theme-*`: an app may name its themes anything, and a class it did not
  // declare belongs to somebody else.
  for (const name of _config.themes) root.classList.remove(name)
  root.classList.add(value)
}
// ─── Inline script generation (used by post-build) ────────────────────────────
// Implementation lives in ./script.js so the post-build pipeline can import it
// without pulling this module — and with it the signal runtime — into Node-side
// config resolution.
export { buildThemeScript } from './script.js'
