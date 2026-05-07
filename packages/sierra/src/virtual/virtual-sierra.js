/**
 * virtual-sierra.js — Vite virtual module: `virtual:sierra`
 *
 * Generates the runtime bootstrap module that:
 * - Imports the route manifest
 * - Boots the router with the tree + sierra config
 * - Wires Junction if configured
 * - Wires analytics if configured
 * - Re-exports manifest arrays for app code
 *
 * The virtual module is regenerated whenever:
 * - The route manifest changes (scanner-plugin invalidates it)
 * - sierra.config.js changes
 */

import { generateOverlayScript } from '../build/dev-overlay.js'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { existsSync } from 'fs'

// Absolute path to this sierra package's root — used to resolve sierra/* imports
// from the virtual:sierra module (which has no file path context for Node resolution).
const _monoRoot   = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const _sierraRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const VIRTUAL_ID = 'virtual:sierra'
const RESOLVED_ID = '\0virtual:sierra'
const VIRTUAL_CONFIG_ID = 'virtual:sierra-config'
const RESOLVED_CONFIG_ID = '\0virtual:sierra-config'

/**
 * @param {import('./index.js').SierraConfig} config
 * @param {object} sierraContext
 * @returns {import('vite').Plugin}
 */
export function virtualSierraPlugin(config, sierraContext) {
  const manifestOutput = config.manifest?.output ?? 'config/routes.js'
  // Path to the sierra config file — resolved at configResolved time
  let sierraConfigPath = 'config/sierra.config.js'
  let root = process.cwd()

  return {
    name: 'sierra:virtual',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
      // Resolve the sierra config path from the vite config root
      sierraConfigPath = config._configPath
        ?? viteConfig.configFile?.replace(/vite\.config\.[jt]s$/, 'config/sierra.config.js')
        ?? `${root}/config/sierra.config.js`
    },

    resolveId(id, importer) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      if (id === VIRTUAL_CONFIG_ID) return RESOLVED_CONFIG_ID
      // Resolve @frontierjs/* cross-package imports from within sierra source files.
      // When Vite follows the file: symlink it processes sierra's real path, which
      // has no node_modules of its own — @frontierjs/junction/client etc. can't be
      // found. Resolve them as siblings of _sierraRoot in the monorepo instead.
      // Resolve @frontierjs/* cross-package imports from within sierra source files.
      // This handles both the real source path and any Bun .bun/ cache copy —
      // the common trait is the importer path contains the sierra package files.
      const isSierraFile = importer && (
        importer.startsWith(_sierraRoot) ||
        importer.includes('/node_modules/@frontierjs/sierra/') ||
        importer.includes('+sierra') ||
        importer.includes('frontierjs+sierra')
      )
      if (id.startsWith('@frontierjs/') && isSierraFile) {
        const rest     = id.slice('@frontierjs/'.length)   // e.g. "junction/client"
        const slashIdx = rest.indexOf('/')
        const pkgName  = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
        const sub      = slashIdx === -1 ? null : rest.slice(slashIdx + 1)
        const pkgRoot  = resolve(_monoRoot, pkgName)
        const candidates = sub
          ? [
              resolve(pkgRoot, sub + '.ts'),
              resolve(pkgRoot, sub + '.js'),
              resolve(pkgRoot, sub, 'index.ts'),
              resolve(pkgRoot, sub, 'index.js'),
            ]
          : [
              resolve(pkgRoot, 'index.ts'),
              resolve(pkgRoot, 'index.js'),
              resolve(pkgRoot, 'src', 'index.ts'),
              resolve(pkgRoot, 'src', 'index.js'),
            ]
        for (const c of candidates) {
          if (existsSync(c)) return c
        }
      }

      // Resolve 'sierra/*' imports that originate from the virtual:sierra module.
      // Virtual modules have no file-system path, so Node can't walk up to find
      // node_modules. We resolve them directly to sierra's source files.
      if (importer === RESOLVED_ID || importer === RESOLVED_CONFIG_ID) {
        const sub = id.startsWith('sierra/') ? id.slice('sierra/'.length)
                  : id.startsWith('@frontierjs/sierra/') ? id.slice('@frontierjs/sierra/'.length)
                  : null
        if (sub) {
          // Map known subpaths directly — mirrors the exports field in package.json
          const subpathMap = {
            'router':          'src/router/index.js',
            'router/internals':'src/router/internals.js',
            'theme':           'src/theme/index.js',
            'junction':        'src/junction/index.js',
            'analytics':       'src/analytics/index.js',
            'fetch':           'src/fetch/index.js',
          }
          const rel = subpathMap[sub]
          if (rel) return resolve(_sierraRoot, rel)
        }
      }
      // Resolve 'sierra/*' imports that originate from the virtual:sierra module.
      // Virtual modules have no file-system path, so Node can't walk up to find
      // node_modules. We resolve them directly to sierra's source files.
      if (importer === RESOLVED_ID || importer === RESOLVED_CONFIG_ID) {
        const sub = id.startsWith('sierra/') ? id.slice('sierra/'.length)
                  : id.startsWith('@frontierjs/sierra/') ? id.slice('@frontierjs/sierra/'.length)
                  : null
        if (sub) {
          const subpathMap = {
            'router':           'src/router/index.js',
            'router/internals': 'src/router/internals.js',
            'theme':            'src/theme/index.js',
            'junction':         'src/junction/index.js',
            'analytics':        'src/analytics/index.js',
            'fetch':            'src/fetch/index.js',
            'presence':         'src/presence/index.js',
            'devtools':         'src/devtools/index.js',
          }
          const rel = subpathMap[sub]
          if (rel) return resolve(_sierraRoot, rel)
        }
      }
    },

    load(id) {
      if (id === RESOLVED_ID) return generateVirtualSierra(config, manifestOutput, sierraConfigPath)
      if (id === RESOLVED_CONFIG_ID) {
        // Re-export the real sierra.config.js — resolved at build time
        return `export { default } from '${sierraConfigPath}'`
      }
      return null
    },
  }
}

/**
 * Generate the virtual:sierra module source code.
 *
 * @param {import('./index.js').SierraConfig} config
 * @param {string} manifestOutput
 * @param {string} sierraConfigPath — absolute path to sierra.config.js
 */
function generateVirtualSierra(config, manifestOutput, sierraConfigPath) {
  const lines = []

  // Import the manifest and the live sierra.config.js.
  // Using the absolute path resolved by Vite ensures the correct file is
  // imported regardless of where vite.config.js lives.
  lines.push(`import { tree, components, loaders, layouts, published, indexed, redirects } from '/${manifestOutput}'`)
  lines.push(`import sierraConfig from '${sierraConfigPath}'`)
  lines.push(``)

  // Mesa signal bridge — must come first, before router init.
  // Sierra signals (router/signals.js) use a plain pub/sub .get()/.set()/.subscribe()
  // interface. Mesa's reactivity system tracks signal reads via a module-level
  // _listener variable that is set during createEffect / render() / createMemo
  // execution. Sierra's .get() doesn't touch _listener — so Mesa components
  // would never re-render when Sierra signals change.
  //
  // The bridge: for each Sierra signal, create a Mesa createSignal pair.
  // Patch the Sierra signal's .get() with the Mesa read function (so reads
  // inside Mesa effects register correctly), and wire Sierra's .subscribe()
  // to drive the Mesa write function (so Sierra-side mutations notify Mesa).
  //
  // This runs once, synchronously, at module evaluation time — before any
  // component mounts — so the patched .get() is in place when Mesa's
  // first render pass runs.
  lines.push(`// ── Mesa–Sierra signal bridge ───────────────────────────────────`)
  lines.push(`import { createSignal as $$cs } from '@frontierjs/mesa/runtime'`)
  lines.push(`import {`)
  lines.push(`  activeRoute  as $$sig_activeRoute,`)
  lines.push(`  params       as $$sig_params,`)
  lines.push(`  pendingRoute as $$sig_pendingRoute,`)
  lines.push(`  meta         as $$sig_meta,`)
  lines.push(`  data         as $$sig_data,`)
  lines.push(`  loadError    as $$sig_loadError,`)
  lines.push(`  pageSlots    as $$sig_pageSlots,`)
  lines.push(`  page         as $$sig_page,`)
  lines.push(`} from '@frontierjs/sierra/router'`)
  if (config.theme) {
    lines.push(`import { theme as $$sig_theme } from '@frontierjs/sierra/theme'`)
  }
  lines.push(``)
  // $$bridge is a module-level function so it's reachable for the theme call.
  // It's prefixed $$ to avoid clashing with any user variable.
  lines.push(`function $$bridge(sierraSignal) {`)
  lines.push(`  if (!sierraSignal || typeof sierraSignal.get !== 'function') return`)
  lines.push(`  const [mesaRead, mesaWrite] = $$cs(sierraSignal.get())`)
  lines.push(`  // Sierra → Mesa: when Sierra sets the signal, push the new value`)
  lines.push(`  // into the Mesa signal so Mesa effects re-run.`)
  lines.push(`  // subscribe() calls fn(currentValue) immediately — that's fine,`)
  lines.push(`  // it just re-confirms the initial Mesa signal value synchronously.`)
  lines.push(`  sierraSignal.subscribe((v) => mesaWrite(v))`)
  lines.push(`  // Patch .get() so calls inside Mesa effects / render() register`)
  lines.push(`  // as reactive dependencies — the critical half of the bridge.`)
  lines.push(`  sierraSignal.get = mesaRead`)
  lines.push(`}`)
  lines.push(``)
  lines.push(`$$bridge($$sig_activeRoute)`)
  lines.push(`$$bridge($$sig_params)`)
  lines.push(`$$bridge($$sig_pendingRoute)`)
  lines.push(`$$bridge($$sig_meta)`)
  lines.push(`$$bridge($$sig_data)`)
  lines.push(`$$bridge($$sig_loadError)`)
  lines.push(`$$bridge($$sig_pageSlots)`)
  lines.push(`$$bridge($$sig_page)`)
  lines.push(`// node is the same object reference as activeRoute — already bridged.`)
  if (config.theme) {
    lines.push(`$$bridge($$sig_theme)`)
  }
  lines.push(``)

  // Router init
  lines.push(`// ── Router ─────────────────────────────────────────────────────`)
  lines.push(`import { initRouter } from '@frontierjs/sierra/router'`)
  lines.push(``)
  lines.push(`initRouter(tree, components, loaders, {`)
  lines.push(`  trailingSlash: ${JSON.stringify(config.trailingSlash ?? 'always')},`)
  lines.push(`  scrollRestoration: 'manual',`)
  if (config.base) {
    lines.push(`  base: ${JSON.stringify(config.base)},`)
  }
  lines.push(`}, layouts)`)
  lines.push(``)

  // Junction wiring — enabled when junction.url is configured
  if (config.junction?.url) {
    lines.push(`// ── Junction ───────────────────────────────────────────────────`)
    lines.push(`import { initJunction } from '@frontierjs/sierra/junction'`)
    lines.push(``)
    lines.push(`await initJunction(sierraConfig.junction)`)
    lines.push(``)
  }

  // Analytics wiring — only if configured
  if (config.analytics) {
    lines.push(`// ── Analytics ──────────────────────────────────────────────────`)
    lines.push(`import { initAnalytics } from '@frontierjs/sierra/analytics'`)
    lines.push(``)
    lines.push(`initAnalytics(sierraConfig.analytics)`)
    lines.push(``)
  }

  // Theme management — only if configured
  if (config.theme) {
    lines.push(`// ── Theme ──────────────────────────────────────────────────────`)
    lines.push(`import { initTheme } from '@frontierjs/sierra/theme'`)
    lines.push(``)
    lines.push(`initTheme(sierraConfig.theme)`)
    lines.push(``)
  }

  // Dev-only error forwarding + HMR
  lines.push(`// ── Dev error overlay + HMR ────────────────────────────────────`)
  lines.push(`if (import.meta.env.DEV) {`)
  lines.push(`  window.addEventListener('error', e => console.error('[Sierra]', e))`)
  lines.push(`  window.addEventListener('unhandledrejection', e => console.error('[Sierra]', e))`)
  lines.push(``)
  // Inline the overlay script
  for (const overlayLine of generateOverlayScript().split('\n')) {
    lines.push(`  ${overlayLine}`)
  }
  lines.push(``)
  lines.push(`  // HMR: when a .mesa file changes, re-navigate instead of full-reload.`)
  lines.push(`  // The router re-imports the updated module, updates the registry, and`)
  lines.push(`  // remounts the affected route. Layout state is preserved when possible.`)
  lines.push(`  if (import.meta.hot) {`)
  lines.push(`    import.meta.hot.on('sierra:hmr', async ({ file }) => {`)
  lines.push(`      const { hmrReload } = await import('@frontierjs/sierra/router')`)
  lines.push(`      // Flatten the route tree to pass all nodes to hmrReload`)
  lines.push(`      function flatNodes(node) {`)
  lines.push(`        return [node, ...(node.children ?? []).flatMap(flatNodes)]`)
  lines.push(`      }`)
  lines.push(`      await hmrReload(file, flatNodes(tree))`)
  lines.push(`    })`)
  lines.push(`  }`)
  lines.push(`}`)
  lines.push(``)

  // Re-export manifest for app code
  lines.push(`// Re-export manifest — importable from 'virtual:sierra'`)
  lines.push(`export { tree, components, loaders, layouts, published, indexed, redirects }`)

  return lines.join('\n')
}

// Named export for unit testing
export function _generateVirtualSierra(config, manifestOutput) {
  return generateVirtualSierra(config, manifestOutput, '/config/sierra.config.js')
}
