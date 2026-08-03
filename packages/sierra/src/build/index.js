/**
 * build/index.js — createSierraViteConfig
 *
 * The main entry point for Sierra's Vite integration.
 * Returns a complete Vite config object from a sierra.config.js.
 *
 * Usage in vite.config.js:
 *   import { defineConfig } from 'vite'
 *   import { createSierraViteConfig } from 'sierra/build'
 *   import config from './config/sierra.config.js'
 *   export default defineConfig(createSierraViteConfig(config))
 *
 * @module sierra/build
 */

import { resolve } from 'path'
import { mesaPlugin } from './mesa-plugin.js'
import { devtoolsPlugin } from './devtools-plugin.js'
import { scannerPlugin } from './scanner-plugin.js'
import { schemaPlugin }  from './schema-plugin.js'
import { virtualSierraPlugin } from '../virtual/virtual-sierra.js'
import { runPostBuild } from '../postbuild/index.js'
import { prerenderRoutes } from './prerender.js'
import { autoImportPlugin } from './auto-import-plugin.js'

/**
 * @typedef {Object} SierraConfig
 * @property {'spa'|'static'|'widget'} target
 * @property {string} [routesDir='src/routes']
 * @property {string} [base='/']
 * @property {'always'|'never'|'preserve'} [trailingSlash='always']
 * @property {'spa'|'static'} [render='spa']
 * @property {string} [outDir='dist/client']
 * @property {{ dir?: string, entry?: string, outDir?: string }} [widgets]
 * @property {{ shadowDOM?: boolean }} [mesa]
 * @property {{ components?: string[] }} [autoImport]
 * @property {{ output?: string, environments?: object }} [manifest]
 * @property {object} [junction]
 * @property {object} [analytics]
 * @property {object} [vite]  — raw Vite overrides, merged last
 * @property {Array}  [plugins] — additional Vite plugins
 */

/**
 * Shared context passed between Sierra plugins so they can
 * communicate without re-running scans.
 *
 * @typedef {Object} SierraContext
 * @property {object|null} tree        — current route tree
 * @property {Map} islandMap           — file → island entries from ctx.islands
 * @property {Map} staticMap           — file → ctx.isStatic boolean
 */

/**
 * Create a complete Vite config from a Sierra config object.
 *
 * @param {SierraConfig} config
 * @returns {import('vite').UserConfig}
 */
export function createSierraViteConfig(config = {}) {
  const {
    target = 'spa',
    routesDir = 'src/routes',
    outDir = 'dist/client',
    base = '/',
    vite: viteOverrides = {},
    plugins: userPlugins = [],
    mesa: mesaOptions = {},
  } = config

  // Shared state between plugins
  /** @type {SierraContext} */
  const sierraContext = {
    tree: null,
    islandMap: new Map(),
    staticMap: new Map(),
    layoutPropMap: new Map(),  // layout file path → Set of export let prop names
    autoImportMap: new Map(),  // ComponentName → absolute file path
  }

  const sierraPlugins = []

  if (target === 'spa' || target === 'static') {
    // Before the scanner: virtual:sierra embeds the generated model schemas,
    // so they must exist by the time it is built.
    sierraPlugins.push(schemaPlugin(config, sierraContext))
    sierraPlugins.push(scannerPlugin(config, sierraContext))
    sierraPlugins.push(virtualSierraPlugin(config, sierraContext))
    sierraPlugins.push(postBuildPlugin(config, sierraContext))
  }

  // Auto-import (all targets — widget components benefit too)
  const aiPlugin = autoImportPlugin(config, sierraContext)
  if (aiPlugin) sierraPlugins.push(aiPlugin)

  // Mesa compiler for all targets
  // Devtools toolbar — dev only, no bundle impact in production
  sierraPlugins.push(devtoolsPlugin(config))

  sierraPlugins.push(mesaPlugin({ ...mesaOptions, routesDir }, sierraContext))

  // CSS injection for widget target
  if (target === 'widget' && mesaOptions.shadowDOM) {
    // injectCssIntoJs plugin — dynamically imported so it's only
    // loaded when actually needed
    sierraPlugins.push(injectCssPlugin())
  }

  // Build the base Vite config per target
  const baseConfig = buildBaseConfig(config, sierraPlugins, userPlugins)

  // Merge user vite overrides last — they win over everything
  return deepMerge(baseConfig, viteOverrides)
}

/**
 * Build the base Vite config for a given target.
 */
function buildBaseConfig(config, sierraPlugins, userPlugins) {
  const {
    target = 'spa',
    base = '/',
    outDir = 'dist/client',
    routesDir = 'src/routes',
  } = config

  /** @type {import('vite').UserConfig} */
  const shared = {
    base,
    resolve: {
      alias: {
        '@': resolve(process.cwd(), 'src'),
        // NOTE: @frontierjs/mesa subpath resolution is handled by the resolveId
        // hook in mesaPlugin, which resolves both bare and .js-suffixed forms to
        // absolute file paths. No aliases needed here.
      },
    },
    optimizeDeps: {
      // Exclude Sierra from esbuild's dep pre-scan.
      // Sierra contains .mesa files that esbuild can't parse — they need
      // the Mesa Vite plugin, which only runs after the scan phase.
      // Excluding sierra means Vite won't try to crawl its internals.
      exclude: ['sierra'],
    },
    plugins: [
      ...sierraPlugins,
      ...userPlugins,
    ],
    server: {
      port: parseInt(process.env.PORT ?? '3000'),
      host: !!process.env.VITE_HOST_APP,
      open: false,
      hmr: {
        overlay: true,
      },
    },
    build: {
      outDir,
      cssCodeSplit: false,
      minify: process.env.NODE_ENV === 'production',
    },
  }

  switch (target) {
    case 'spa':
      return {
        ...shared,
        build: {
          ...shared.build,
          rollupOptions: {
            // No special config — Vite's default chunking handles SPA well
          },
        },
      }

    case 'static':
      // Same Vite config as 'spa' — the difference is not in how the bundle is
      // produced but in what happens after it: postBuildPlugin's closeBundle
      // prerenders every route declaring `render: static` to its own
      // index.html. This branch used to carry a comment saying SSG "is handled
      // separately" and nothing handled it, so the target silently built an SPA.
      return {
        ...shared,
        build: { ...shared.build },
      }

    case 'widget': {
      const widgetsDir = config.widgets?.dir ?? 'src/Embeds'
      // Widget builds are handled by a separate build loop
      // vite.config.js for widgets just sets up the dev server
      return {
        ...shared,
        build: {
          ...shared.build,
          outDir: config.widgets?.outDir ?? 'dist',
          cssCodeSplit: false,
        },
      }
    }

    default:
      throw new Error(`[Sierra] Unknown target: ${target}. Must be 'spa', 'static', or 'widget'.`)
  }
}

/**
 * CSS injection plugin for widget/shadow DOM builds.
 * Strips the CSS asset from the bundle and injects it as a string
 * via the @unocss-placeholder marker.
 *
 * This is the Sierra-owned version of the frontier injectCssIntoJs plugin.
 */
function injectCssPlugin() {
  let cssToInject = ''

  return {
    name: 'sierra:inject-css',
    enforce: 'post',

    generateBundle(opts, bundle) {
      let styleCode = ''

      // Collect all CSS assets and remove them from bundle
      for (const [key, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'asset' && chunk.fileName.endsWith('.css')) {
          styleCode += chunk.source
          delete bundle[key]
        }
      }

      if (styleCode) {
        cssToInject = styleCode
      }

      // Replace @unocss-placeholder marker in the JS bundle with the CSS string
      for (const key of Object.keys(bundle)) {
        const chunk = bundle[key]
        if (
          chunk.type === 'chunk' &&
          chunk.fileName.match(/\.[cm]?js$/) &&
          !chunk.fileName.includes('polyfill')
        ) {
          chunk.code = chunk.code.replace(
            '"@unocss-placeholder"',
            JSON.stringify(cssToInject.trim())
          )
          break
        }
      }
    },
  }
}

/**
 * Deep merge two objects. `b` wins over `a` for scalar values.
 * Arrays are concatenated.
 */
function deepMerge(a, b) {
  if (!b || typeof b !== 'object') return a
  if (!a || typeof a !== 'object') return b

  const result = { ...a }

  for (const [key, bVal] of Object.entries(b)) {
    const aVal = a[key]

    if (Array.isArray(aVal) && Array.isArray(bVal)) {
      // Concatenate arrays (e.g. plugins)
      result[key] = [...aVal, ...bVal]
    } else if (
      aVal && bVal &&
      typeof aVal === 'object' && typeof bVal === 'object' &&
      !Array.isArray(aVal)
    ) {
      result[key] = deepMerge(aVal, bVal)
    } else {
      result[key] = bVal
    }
  }

  return result
}

/**
 * Post-build pipeline plugin.
 * Runs after vite build via the closeBundle hook.
 */
function postBuildPlugin(config, sierraContext) {
  let root = process.cwd()
  let outDir = config.outDir ?? 'dist/client'
  let isBuild = false

  return {
    name: 'sierra:postbuild',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
      outDir = resolve(root, viteConfig.build?.outDir ?? config.outDir ?? 'dist/client')
      isBuild = viteConfig.command === 'build'
    },

    async closeBundle() {
      if (!isBuild) return  // skip in dev server

      // Build a minimal manifest from the tree Sierra already has
      const tree = sierraContext.tree
      if (!tree) return

      // Re-derive the flat arrays from the tree (same logic as generate-manifest)
      const allNodes = flattenTree(tree)
      const routeNodes = allNodes.filter(n => n.file !== null)

      const manifest = {
        tree,
        all:       routeNodes.map(n => n.path),
        indexed:   routeNodes
          .filter(n => n.meta?.status !== 'draft')
          .filter(n => n.meta?.robots !== 'noindex')
          .filter(n => !n.meta?.dynamic)
          .map(n => n.path),
        redirects: routeNodes
          .filter(n => n.meta?.redirect)
          .map(n => [n.path, n.meta.redirect]),
      }

      // Prerender before postbuild so the emitted HTML is on disk when
      // move404 / sitemap / speculation inspect the output directory.
      //
      // Gated on target:'static' — the per-route `render: static` frontmatter
      // is the unit of control, and this target is what opts the build into
      // acting on it. An 'spa' build ignores the frontmatter exactly as before.
      if ((config.target ?? 'spa') === 'static') {
        const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
        const pre = await prerenderRoutes({
          tree, root,
          routesDir: config.routesDir ?? 'src/routes',
          outDir,
          renderComponent,
          warn: (m) => console.warn(`  [Sierra] prerender: ${m}`),
        })

        if (pre.written.length > 0) {
          console.log(`\n  [Sierra] Prerendered ${pre.written.length} page(s):`)
          for (const f of pre.written) console.log(`    ✓ ${f}`)
        }
        // Silence is how the static target failed before — it emitted nothing
        // and said nothing. If a static build produced no pages, say so.
        if (pre.written.length === 0) {
          console.warn(
            `\n  [Sierra] target:'static' produced no pages — no route declares ` +
            `\`render: static\` in its frontmatter.`
          )
        }
      }

      const results = await runPostBuild(config, manifest, outDir, root)

      if (results.length > 0) {
        console.log('\n  [Sierra] Post-build:')
        for (const r of results) {
          console.log(`    ✓ ${r}`)
        }
        console.log()
      }
    },
  }
}

function flattenTree(node) {
  return [node, ...(node.children ?? []).flatMap(flattenTree)]
}

// Named exports for unit testing
export { deepMerge as _deepMerge }
