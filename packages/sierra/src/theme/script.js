/**
 * theme/script.js — flash-prevention script builder.
 *
 * Deliberately dependency-free. This is imported by the post-build pipeline,
 * which runs in Node during `vite build` and while vite.config.js is being
 * loaded. It used to live in theme/index.js next to the theme signal, so the
 * build-time import chain
 *
 *   vite.config.js → sierra/build → postbuild/index.js
 *                  → postbuild/inject-theme.js → theme/index.js
 *                  → router/signals.js → @frontierjs/mesa/runtime.js
 *
 * dragged the client runtime into config resolution. That was harmless only
 * while signals.js happened to have no imports; the moment it imported the Mesa
 * runtime, loading vite.config.js failed with
 * "Cannot find package '@frontierjs/mesa'".
 *
 * Keep this module free of imports — which is also why the defaults below are
 * restated rather than imported from index.js. They are checked against it by
 * `tests/prefetch-theme.test.js`, because two copies of a default is exactly
 * the shape that drifts.
 */

const DEFAULT_THEMES = ['theme-default', 'theme-dark']

/**
 * Generate the tiny inline script that prevents theme flash.
 * Must run synchronously before body paint — injected into <head>.
 *
 * It writes to `document.documentElement` and nothing else: <body> has not
 * been parsed when a <head> script runs, so the element is not a choice.
 *
 * @param {object} config — theme config
 * @returns {string}      — minified JS string (no <script> wrapper)
 */
export function buildThemeScript(config = {}) {
  const themes = Array.isArray(config.themes) && config.themes.length
    ? config.themes
    : DEFAULT_THEMES

  const defaultTheme = config.default   ?? 'system'
  const persist      = config.persist   ?? true
  const key          = config.key       ?? 'theme'
  const apply        = config.apply     ?? 'class'
  const attribute    = config.attribute ?? 'data-theme'

  const light = config.system?.light ?? themes[0]
  const dark  = config.system?.dark  ?? themes[1] ?? themes[0]

  // A persisted value this app no longer offers is ignored, matching
  // resolveTheme(): otherwise a reader who once picked a since-removed theme
  // gets a class with no stylesheet behind it, before paint, for ever.
  const known = JSON.stringify(themes)

  const fallback = defaultTheme === 'system'
    ? `window.matchMedia('(prefers-color-scheme: dark)').matches?${JSON.stringify(dark)}:${JSON.stringify(light)}`
    : JSON.stringify(themes.includes(defaultTheme) ? defaultTheme : themes[0])

  // Generate a self-contained IIFE
  // Minified for inline use — must be valid JS with no external deps
  return `(function(){` +
    `var k=${known};` +
    `var s=${persist ? `localStorage.getItem(${JSON.stringify(key)})` : 'null'};` +
    `var t=k.indexOf(s)>-1?s:(${fallback});` +
    `var e=document.documentElement;` +
    (apply === 'attribute'
      ? `e.setAttribute(${JSON.stringify(attribute)},t);`
      : `for(var i=0;i<k.length;i++)e.classList.remove(k[i]);e.classList.add(t);`) +
    `})()`
}
