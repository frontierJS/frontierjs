// loadConfig — reads ext/config/jetty.config.js, applies per-browser merge.
//
// Merge rules (spec):
//   - chrome:/firefox: blocks deep-merge into root for that browser
//   - objects merge recursively
//   - arrays REPLACE (no concat) — avoids "did my list grow" ambiguity

import { pathToFileURL } from 'node:url'
import { resolve }       from 'node:path'
import { existsSync }    from 'node:fs'

export async function loadConfig({ root, browser }) {
  const configPath = resolve(root, 'config/jetty.config.js')
  if (!existsSync(configPath)) {
    throw new Error(`jetty.config.js not found at ${configPath}`)
  }

  const mod = await import(pathToFileURL(configPath).href)
  const raw = mod.default ?? mod
  if (raw == null || typeof raw !== 'object') {
    throw new Error(`jetty.config.js must export a config object (got ${typeof raw})`)
  }

  return applyBrowserOverrides(raw, browser)
}

export function applyBrowserOverrides(raw, browser) {
  const { chrome, firefox, ...root } = raw
  const overrides = browser === 'chrome' ? chrome : browser === 'firefox' ? firefox : null
  if (!overrides) return { ...root, _browser: browser }
  return { ...deepMerge(root, overrides), _browser: browser }
}

// Deep merge: objects recurse, arrays REPLACE. Primitives replace.
export function deepMerge(base, override) {
  if (override === undefined) return base
  if (base === undefined) return override
  if (Array.isArray(base) || Array.isArray(override)) return override // arrays replace
  if (typeof base !== 'object' || typeof override !== 'object') return override
  if (base === null || override === null) return override

  const out = { ...base }
  for (const k of Object.keys(override)) {
    out[k] = deepMerge(base[k], override[k])
  }
  return out
}
