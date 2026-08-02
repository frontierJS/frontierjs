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
 * Keep this module free of imports.
 */


/**
 * Generate the tiny inline script that prevents theme flash.
 * Must run synchronously before body paint — injected into <head>.
 *
 * @param {object} config — theme config
 * @returns {string}      — minified JS string (no <script> wrapper)
 */
export function buildThemeScript(config = {}) {
  const defaultTheme = config.default   ?? 'system'
  const persist      = config.persist   ?? true
  const attribute    = config.attribute ?? 'data-theme'
  const key          = config.key       ?? 'theme'

  // Generate a self-contained IIFE
  // Minified for inline use — must be valid JS with no external deps
  return `(function(){` +
    `var s=${persist ? `localStorage.getItem(${JSON.stringify(key)})` : 'null'};` +
    `var d=${
      defaultTheme === 'system'
        ? `window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'`
        : JSON.stringify(defaultTheme)
    };` +
    `document.documentElement.setAttribute(${JSON.stringify(attribute)},s||d);` +
    `})()`
}
