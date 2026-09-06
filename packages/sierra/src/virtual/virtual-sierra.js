/**
 * virtual-sierra.js — Vite virtual module: `virtual:sierra`
 *
 * Generates the runtime bootstrap module that:
 * - Imports the route table
 * - Boots the router with the tree + sierra config
 * - Wires Junction if configured
 * - Wires analytics if configured
 * - Re-exports the route table's arrays for app code
 *
 * The virtual module is regenerated whenever:
 * - The route table changes (scanner-plugin invalidates it)
 * - sierra.config.js changes
 */

import { generateOverlayScript } from '../build/dev-overlay.js'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'

// Absolute path to this sierra package's root — used to resolve sierra/* imports
// from the virtual:sierra module (which has no file path context for Node resolution).
const _monoRoot   = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const _sierraRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const VIRTUAL_ID = 'virtual:sierra'
const RESOLVED_ID = '\0virtual:sierra'
const VIRTUAL_CONFIG_ID = 'virtual:sierra-config'
const RESOLVED_CONFIG_ID = '\0virtual:sierra-config'

/**
 * Resolve an `@frontierjs/<pkg>[/<subpath>]` specifier imported from inside the
 * Sierra package.
 *
 * Sierra's own source lives outside the consuming app, so when Vite follows the
 * link/symlink it transforms Sierra's *real* path — which has no node_modules of
 * its own. Node's resolution can't help from there, so this walks the sibling
 * packages instead.
 *
 * It reads the target package's `exports` map rather than guessing file paths.
 * The previous version tried `<pkg>/client.ts`, `<pkg>/client.js`,
 * `<pkg>/client/index.ts`, `<pkg>/client/index.js` — none of which match
 * Junction, whose real file is `<pkg>/src/client/index.ts` declared as
 * `"./client": "./src/client/index.ts"`. That failure was invisible whenever the
 * app happened to have its own node_modules entry for the package, and surfaced
 * as `Failed to resolve import "@frontierjs/junction/client"` when it didn't —
 * e.g. under `bun link`, or in a `packages/*` monorepo.
 *
 * @param {string} id  e.g. '@frontierjs/junction/client'
 * @returns {string|null} absolute file path, or null
 */
function _resolveFrontierSubpath(id, searchRoots) {
  const rest     = id.slice('@frontierjs/'.length)
  const slashIdx = rest.indexOf('/')
  const pkgName  = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
  const subPath  = slashIdx === -1 ? '.' : './' + rest.slice(slashIdx + 1)

  // Where sibling packages might live. _monoRoot is the directory containing
  // the sierra package, which covers both `frontier/{mesa,sierra,…}` and
  // `repo/packages/{mesa,sierra,…}` layouts.
  const roots = (searchRoots ?? [
    _monoRoot,
    resolve(_monoRoot, 'node_modules', '@frontierjs'),
    resolve(_sierraRoot, 'node_modules', '@frontierjs'),
  ]).map(base => resolve(base, pkgName))

  for (const pkgRoot of roots) {
    const manifestPath = resolve(pkgRoot, 'package.json')
    if (!existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }

    // 1. The package's own exports map — authoritative.
    const target = _pickExport(manifest.exports, subPath)
    if (target) {
      const abs = resolve(pkgRoot, target)
      if (existsSync(abs)) return abs
    }

    // 2. `main` for a bare package specifier without exports.
    if (subPath === '.' && manifest.main) {
      const abs = resolve(pkgRoot, manifest.main)
      if (existsSync(abs)) return abs
    }

    // 3. Path guesses, for packages that declare neither.
    const bare = subPath === '.' ? null : subPath.slice(2)
    const guesses = bare
      ? [`${bare}.ts`, `${bare}.js`, `${bare}/index.ts`, `${bare}/index.js`,
         `src/${bare}.ts`, `src/${bare}.js`, `src/${bare}/index.ts`, `src/${bare}/index.js`]
      : ['index.ts', 'index.js', 'src/index.ts', 'src/index.js']
    for (const g of guesses) {
      const abs = resolve(pkgRoot, g)
      if (existsSync(abs)) return abs
    }
  }

  return null
}

/**
 * Pick a file from an `exports` map for a given subpath.
 *
 * Handles the shapes these packages actually use: a bare string, a conditions
 * object, and wildcard subpaths. Conditions are tried browser → import →
 * module → default, since everything resolved here is destined for the client
 * bundle.
 */
function _pickExport(exports, subPath) {
  if (!exports) return null

  // Shorthand: `"exports": "./index.js"` means the root subpath only.
  if (typeof exports === 'string') return subPath === '.' ? exports : null

  const unwrap = (entry) => {
    if (!entry) return null
    if (typeof entry === 'string') return entry
    for (const cond of ['browser', 'import', 'module', 'default']) {
      if (entry[cond]) {
        const v = unwrap(entry[cond])
        if (v) return v
      }
    }
    return null
  }

  if (exports[subPath]) return unwrap(exports[subPath])

  // Wildcards, e.g. "./*": "./src/*.js"
  for (const [pattern, entry] of Object.entries(exports)) {
    if (!pattern.includes('*')) continue
    const [head, tail = ''] = pattern.split('*')
    if (!subPath.startsWith(head) || !subPath.endsWith(tail)) continue
    const star = subPath.slice(head.length, subPath.length - tail.length || undefined)
    const target = unwrap(entry)
    if (target) return target.replace('*', star)
  }

  return null
}

/** Filenames `sierra.config` may carry, in preference order. */
const SIERRA_CONFIG_NAMES = ['sierra.config.js', 'sierra.config.mjs', 'sierra.config.ts']

/**
 * Locate `sierra.config.js` on disk.
 *
 * `virtual:sierra` emits a literal `import sierraConfig from '<path>'`, so a wrong
 * answer here is a hard build failure — `Module not found` — not a degraded mode.
 *
 * This used to be a string rewrite of the resolved Vite config path
 * (`…/vite.config.js` → `…/config/sierra.config.js`), which assumed `vite.config.js`
 * sat at the Vite root. The convention is a dedicated `config/` folder, so the
 * common case — `config/vite.config.js` next to `config/sierra.config.js` — derived
 * `config/config/sierra.config.js` and could never build. Both layouts are supported
 * now, by looking rather than by assuming: the sibling of the Vite config first,
 * then `config/` beneath it, then the same two against the Vite root.
 *
 * `_configPath` still wins outright, for a config that lives somewhere else entirely.
 *
 * @param {object} opts
 * @param {string} [opts.explicit]   — config._configPath
 * @param {string} [opts.configFile] — viteConfig.configFile, absolute
 * @param {string} opts.root         — the Vite root
 * @returns {string} absolute path; the best guess when nothing exists yet
 */
export function resolveSierraConfigPath({ explicit, configFile, root }) {
  if (explicit) return explicit

  const dirs = []
  if (configFile) {
    const configDir = dirname(configFile)
    dirs.push(configDir, resolve(configDir, 'config'))
  }
  dirs.push(resolve(root, 'config'), root)

  for (const dir of dirs) {
    for (const name of SIERRA_CONFIG_NAMES) {
      const abs = resolve(dir, name)
      if (existsSync(abs)) return abs
    }
  }

  // Nothing on disk. Point at the conventional location so the failure names the
  // place the file belongs, instead of a doubled path nobody wrote.
  return resolve(root, 'config', SIERRA_CONFIG_NAMES[0])
}

/**
 * @param {import('./index.js').SierraConfig} config
 * @param {object} sierraContext
 * @returns {import('vite').Plugin}
 */
export function virtualSierraPlugin(config, sierraContext) {
  const tableOutput = config.routeTable?.output ?? 'config/routes.js'
  // Path to the sierra config file — resolved at configResolved time
  let sierraConfigPath = 'config/sierra.config.js'
  let root = process.cwd()

  return {
    name: 'sierra:virtual',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
      sierraConfigPath = resolveSierraConfigPath({
        explicit:   config._configPath,
        configFile: viteConfig.configFile,
        root,
      })
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
        const hit = _resolveFrontierSubpath(id)
        if (hit) return hit
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
      if (id === RESOLVED_ID) return generateVirtualSierra(config, tableOutput, sierraConfigPath, sierraContext)
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
 * @param {string} tableOutput
 * @param {string} sierraConfigPath — absolute path to sierra.config.js
 */
function generateVirtualSierra(config, tableOutput, sierraConfigPath, sierraContext) {
  const lines = []

  // Import the route table and the live sierra.config.js.
  // Using the absolute path resolved by Vite ensures the correct file is
  // imported regardless of where vite.config.js lives.
  lines.push(`import { tree, components, loaders, layouts, published, indexed, redirects } from '/${tableOutput}'`)
  lines.push(`import sierraConfig from '${sierraConfigPath}'`)
  lines.push(``)

  // NO SIGNAL BRIDGE.
  //
  // This is where a ~45-line $$bridge block used to be generated. It created a
  // Mesa createSignal pair for each router signal, subscribed Sierra's pub/sub
  // to drive the Mesa writer, and monkey-patched `.get` on the exported signal
  // object so reads inside Mesa effects registered as dependencies.
  //
  // The router exports no signal at all now — `page`, `status` and `theme` are
  // plain objects a component watches with `$:` — so there is nothing to bridge
  // and nothing to patch. Removing it also removed the `.value` desync it caused
  // (see signals.js) and the ordering requirement that the patch land before any
  // component's first render.

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
    // Not awaited. initJunction is synchronous now and exposes `whenReady`
    // for callers that specifically need the WebSocket transport; awaiting it
    // here blocked the entire entry module — and therefore first paint — on a
    // server round-trip for every returning visitor.
    lines.push(`initJunction(sierraConfig.junction)`)
    lines.push(``)
  }

  // Model schemas, generated from db/schema.lite by build/schema-plugin.js.
  // Emitted before any route module is evaluated, so createResource() can read
  // a model's field shape without each resource file restating it.
  if (sierraContext?.schemaDefs && Object.keys(sierraContext.schemaDefs).length > 0) {
    lines.push(`// ── Model schemas (generated from ${sierraContext.schemaPath ?? 'schema.lite'}) ──`)
    lines.push(`import { registerSchemas } from '@frontierjs/sierra/junction'`)
    // The whole $defs table goes over, plus which of its entries are models.
    // The table is what `$ref` points into (enum fields are emitted as
    // {"$ref":"#/$defs/Plan"}), and the model list is what keeps an enum from
    // being addressable as a resource.
    //
    // The third argument is what UPDATE mode differs by, per model — an
    // `@immutable` column's `readOnly`, a sealing one's `x-litestone-seal`, the
    // `@version` property. A patch rather than a second table because the
    // second copy is +26 KB gzipped on `example` and the delta is +2 KB
    // (`FJS-807`); `schema-plugin.js` computes it from the two generated
    // documents.
    lines.push(
      `registerSchemas(${JSON.stringify(sierraContext.schemaDefs)}, ` +
      `${JSON.stringify(sierraContext.schemaModels ?? null)}, ` +
      `${JSON.stringify(sierraContext.schemaUpdate ?? null)})`
    )
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

  // Re-export the route table for app code
  lines.push(`// Re-export the route table — importable from 'virtual:sierra'`)
  lines.push(`export { tree, components, loaders, layouts, published, indexed, redirects }`)

  return lines.join('\n')
}

// Named export for unit testing
export function _generateVirtualSierra(config, tableOutput) {
  return generateVirtualSierra(config, tableOutput, '/config/sierra.config.js')
}

// Named export for unit testing — see tests/frontier-resolution.test.js
export function _resolveFrontierSubpathForTest(id, searchRoots) {
  return _resolveFrontierSubpath(id, searchRoots)
}
