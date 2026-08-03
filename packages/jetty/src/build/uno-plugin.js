// uno-plugin.js — lazy UnoCSS Vite plugin loader for jetty's build pipeline.
//
// UnoCSS is an OPTIONAL peer dependency. Consumer extensions that don't use
// it shouldn't pay any cost. This loader probes for `unocss` in the same
// places mesa-plugin probes for `@frontierjs/mesa` — primarily the consumer
// extension's node_modules.
//
// Returns the UnoCSS Vite plugin(s) when found, or null when not. Callers
// should treat null as "skip — consumer doesn't use UnoCSS" and proceed.
//
// We use this on the Pages build (dock/options/piers). Islands have their
// own UnoCSS story via the runtime DOM-mirror in src/island/unocss-mirror.js.
//
// Why we wrap rather than re-export: UnoCSS's Vite plugin returns an array
// of plugins — Vite supports either form, but jetty's plugin lists are
// flattened arrays of plugin objects. We flatten here so callers get a
// uniform shape.

import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let _cachedFactory = null  // resolved unocss/vite UnoCSS function, or `false` if probed and not found

/**
 * Try to load UnoCSS's Vite plugin from a probe location.
 * Returns the imported `UnoCSS` function (or false on miss).
 */
async function locateUnoCSSFactory(extRoot, viteRoot) {
  if (_cachedFactory !== null) return _cachedFactory

  const candidates = []
  if (extRoot)  candidates.push(resolve(extRoot,  'node_modules/unocss/dist/vite.mjs'))
  if (viteRoot) candidates.push(resolve(viteRoot, 'node_modules/unocss/dist/vite.mjs'))

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const mod = await import(pathToFileURL(p).href)
        // The Vite plugin factory is the default export.
        const factory = mod.default ?? mod.UnoCSS ?? mod.default?.default
        if (typeof factory === 'function') {
          _cachedFactory = factory
          return factory
        }
      } catch (e) {
        // Try next candidate
      }
    }
  }

  _cachedFactory = false
  return false
}

/**
 * Probe and return the UnoCSS Vite plugin(s) if available.
 *
 * @param {Object} opts
 * @param {string} [opts.extRoot]   — consumer extension root (where node_modules and uno.config live)
 * @param {string} [opts.viteRoot]  — Vite project root (fallback)
 * @param {Object} [opts.options]   — passed to UnoCSS's Vite plugin factory
 * @returns {Promise<Array|null>}   — flat array of Vite plugins, or null if UnoCSS isn't installed
 */
export async function loadUnoCSSPlugins({ extRoot = null, viteRoot = null, options = {} } = {}) {
  const factory = await locateUnoCSSFactory(extRoot, viteRoot)
  if (!factory) return null

  // Tell UnoCSS where to find uno.config.{js,ts} — without this it searches
  // from Vite's root, which is the cache dir for jetty's pages build (NOT
  // the user's project root). The cache dir has no config so UnoCSS would
  // fall back to defaults and miss the consumer's content globs.
  //
  // Probe order:
  //   1. config/uno.config.{js,mjs,ts} — jetty convention (alongside
  //      jetty.config.js, where extension config lives)
  //   2. uno.config.{js,mjs,ts} at root — UnoCSS default convention
  //
  // Either works; config/ wins on tie so consumers can keep all their
  // tooling config in one place without polluting the project root.
  const finalOptions = { ...options }
  if (extRoot && !finalOptions.configFile) {
    const cfgCandidates = [
      resolve(extRoot, 'config/uno.config.js'),
      resolve(extRoot, 'config/uno.config.mjs'),
      resolve(extRoot, 'config/uno.config.ts'),
      resolve(extRoot, 'uno.config.js'),
      resolve(extRoot, 'uno.config.mjs'),
      resolve(extRoot, 'uno.config.ts'),
    ]
    for (const c of cfgCandidates) {
      if (existsSync(c)) {
        finalOptions.configFile = c
        break
      }
    }
  }

  // UnoCSS returns either a plugin or an array. Flatten and filter out falsy.
  const result = factory(finalOptions)
  const list = Array.isArray(result) ? result : [result]
  return list.filter(Boolean)
}

/**
 * Synchronous probe — returns true if UnoCSS appears to be installed in
 * the given extRoot. Used by auto-gen to decide whether to emit the
 * `import 'virtual:uno.css'` line.
 */
export function isUnoCSSInstalled(extRoot) {
  if (!extRoot) return false
  return existsSync(resolve(extRoot, 'node_modules/unocss/package.json'))
}
