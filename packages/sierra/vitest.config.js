import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Build aliases for a sibling @frontierjs package from its own exports map.
 *
 * A plain prefix alias isn't enough: Vite would rewrite
 * `@frontierjs/junction/client` to `<pkg>/client`, but the real file is
 * `<pkg>/src/client/index.ts` — declared as `"./client": "./src/client/index.ts"`.
 * Reading the manifest keeps this correct without hardcoding another package's
 * internal layout, and mirrors what virtual-sierra.js does at build time.
 */
function aliasFromExports(pkgName, pkgDir) {
  const out = {}
  const manifestPath = resolve(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) return out

  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { return out }

  const unwrap = (e) => {
    if (!e) return null
    if (typeof e === 'string') return e
    for (const c of ['browser', 'import', 'module', 'default']) {
      if (e[c]) { const v = unwrap(e[c]); if (v) return v }
    }
    return null
  }

  for (const [sub, entry] of Object.entries(manifest.exports ?? {})) {
    if (sub.includes('*')) continue
    const target = unwrap(entry)
    if (!target) continue
    const abs = resolve(pkgDir, target)
    if (!existsSync(abs)) continue
    out[sub === '.' ? pkgName : `${pkgName}/${sub.slice(2)}`] = abs
  }

  // Longest specifier first so `@frontierjs/x/y` isn't shadowed by `@frontierjs/x`.
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[0].length - a[0].length))
}

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      // Sibling packages in the monorepo checkout. Tests exercising the Mesa
      // runtime or the Junction client need these — sierra's own node_modules
      // has neither, and Sierra's build-time resolver isn't running here.
      ...aliasFromExports('@frontierjs/junction', resolve(__dirname, '../junction')),
      ...aliasFromExports('@frontierjs/mesa',     resolve(__dirname, '../mesa')),
      '@frontierjs/mesa': resolve(__dirname, '../mesa'),
    },
  },
  // Treat .mesa files as external assets in tests — tests exercise JS modules,
  // not compiled components.
  assetsInclude: ['**/*.mesa'],
})
