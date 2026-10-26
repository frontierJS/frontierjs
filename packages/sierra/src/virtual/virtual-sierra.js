/**
 * virtual-sierra.js — the two Vite virtual modules an app's page runs.
 *
 * `virtual:sierra` is the entry `index.html` names (`FJS-D1085`): the boot,
 * then the app's `src/main.js` when there is one, then `src/App.mesa` — or the
 * bare `RouterView` without one — mounted into `#app`.
 *
 * `virtual:sierra/boot` is everything that must run before any app module:
 * the router over the route table, Junction, the model schemas, analytics, the
 * theme and the dev overlay. Its own module because an import is hoisted, so a
 * boot written in the entry's body would run AFTER `main.js` had created its
 * resources, and what app code imports the route table from. The scanner and
 * the schema plugin invalidate it.
 */

import { generateOverlayScript } from '../build/dev-overlay.js'
import { refusal } from '../build/refusal.js'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { routeTablePath } from '../scanner/generate-route-table.js'

// Absolute path to this sierra package's root — used to resolve sierra/* imports
// from the virtual:sierra module (which has no file path context for Node resolution).
const _monoRoot   = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const _sierraRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const _sierraExports = JSON.parse(readFileSync(resolve(_sierraRoot, 'package.json'), 'utf8')).exports

const VIRTUAL_ID  = 'virtual:sierra'
const RESOLVED_ID = '\0virtual:sierra'
const BOOT_ID     = 'virtual:sierra/boot'
export const RESOLVED_BOOT_ID = '\0virtual:sierra/boot'

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

// ─── What the browser is handed of the config ────────────────────────────────

// The config is a Node module, and it imports whatever its plugins need — `node:fs`,
// a remark plugin. Importing it into the browser to read three keys blanked every
// page of `vite dev`, so these go over as JSON and nothing else of it does
// (`FJS-D552`).
const BROWSER_KEYS = ['junction', 'analytics', 'theme']

/**
 * The first function under a browser key, as a key path, or null.
 * JSON would drop it in silence; a custom analytics provider is a module path.
 */
function browserFunctionPath(config) {
  const seen = new Set()
  const walk = (value, path) => {
    if (typeof value === 'function') return path
    if (!value || typeof value !== 'object' || seen.has(value)) return null
    seen.add(value)
    for (const [k, v] of Object.entries(value)) {
      const hit = walk(v, Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`)
      if (hit) return hit
    }
    return null
  }
  for (const key of BROWSER_KEYS) {
    const hit = walk(config[key], key)
    if (hit) return hit
  }
  return null
}

/** `analytics.provider` when it is a module path, relative to the Vite root, rather than a vendor's name. */
function customProvider(analytics) {
  const provider = analytics?.provider
  return typeof provider === 'string' && provider.includes('/') ? provider : null
}

function providerFile(root, provider) {
  return resolve(root, provider.replace(/^\/+/, ''))
}

/**
 * @param {import('./index.js').SierraConfig} config
 * @param {object} sierraContext
 * @returns {import('vite').Plugin}
 */
export function virtualSierraPlugin(config, sierraContext) {
  const fn = browserFunctionPath(config)
  if (fn) {
    throw refusal(
      `[Sierra] ${fn} is a function, and ${fn.split('.')[0]} is handed to the browser as JSON. ` +
      (fn.startsWith('analytics.provider')
        ? `A custom analytics provider is a module path, relative to the Vite root: ` +
          `analytics: { provider: '/src/analytics.js' }, exporting init, pageview and track.`
        : `Set it in the app's own code instead.`))
  }
  let root = process.cwd()
  let command = 'serve'
  let base = '/'

  return {
    name: 'sierra:virtual',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
      command = viteConfig.command ?? 'serve'
      base = viteConfig.base ?? '/'
      const provider = customProvider(config.analytics)
      if (provider && !existsSync(providerFile(root, provider))) {
        throw refusal(`[Sierra] analytics.provider '${provider}' names no file under ${root}`)
      }
    },

    resolveId(id, importer) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      if (id === BOOT_ID) return RESOLVED_BOOT_ID
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
      // node_modules. They resolve through sierra's own `exports`: a list of
      // subpaths kept here as well is a second copy, and it drifts.
      if (importer === RESOLVED_ID || importer === RESOLVED_BOOT_ID) {
        const sub = id.startsWith('sierra/') ? id.slice('sierra/'.length)
                  : id.startsWith('@frontierjs/sierra/') ? id.slice('@frontierjs/sierra/'.length)
                  : null
        const rel = sub && _sierraExports['./' + sub]
        if (rel) return resolve(_sierraRoot, rel)
      }
    },

    load(id) {
      if (id === RESOLVED_ID) return generateEntry(root)
      if (id === RESOLVED_BOOT_ID) return generateVirtualSierra(config, routeTablePath(config, command), root, sierraContext)
      return null
    },

    // A top-level await in main.js makes the bundler split what main.js
    // imports into chunks that run BEFORE the entry chunk's boot, so in a build
    // every resource it imports finds no Junction client. Dev runs in order.
    // `vite` is imported here: the terminal shell reaches RESOLVED_BOOT_ID
    // through schema-plugin.js, and Haven's installed client has no vite.
    async transform(code, id) {
      if (id !== resolve(root, 'src/main.js')) return null
      const { parseAst } = await import('vite')
      const at = topLevelAwait(parseAst(code))
      if (at) {
        throw refusal(
          `[Sierra] src/main.js:${code.slice(0, at.start).split('\n').length} awaits at its top level. ` +
          `A build then runs main.js's imports before the boot, and every resource among them finds no ` +
          `Junction client. Hold the first render in App.mesa instead -- an {#if} over what it waits for.`)
      }
      return null
    },

    // An index.html naming main.js loads it twice — as the page's script and
    // from the entry — and mounts the app before main.js has run. In dev the
    // entry's src is rewritten to the URL Vite serves a virtual id at: left as
    // written, the browser reads `virtual:` as a URL scheme, fetches nothing
    // and reports nothing, and the page stays empty. Vite's hook runs first and
    // appends `?t=` after an HMR update, so the query is kept.
    transformIndexHtml(html) {
      if (/<script[^>]*\ssrc=["']\/?src\/main\.js["']/.test(html)) {
        throw refusal(
          `[Sierra] index.html loads /src/main.js, and the page's entry is virtual:sierra, ` +
          `which imports src/main.js itself and mounts src/App.mesa (FJS-D1085). ` +
          `Write <script type="module" src="virtual:sierra"></script> in its place.`)
      }
      if (command !== 'serve') return html
      return html.replace(/(<script[^>]*\ssrc=)(["'])virtual:sierra(\?[^"']*)?\2/g, `$1$2${base}@id/${VIRTUAL_ID}$3$2`)
    },
  }
}

/** The first await outside any function, or null. */
function topLevelAwait(node) {
  if (!node || typeof node.type !== 'string' || node.type.includes('Function')) return null
  if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) return node
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const hit = child && typeof child === 'object' ? topLevelAwait(child) : null
      if (hit) return hit
    }
  }
  return null
}

/** The page's entry. `src/main.js` is optional and holds side-effect imports. */
function generateEntry(root) {
  const has = (file) => existsSync(resolve(root, file))
  return [
    `import 'virtual:sierra/boot'`,
    ...(has('src/main.js') ? [`import '/src/main.js'`] : []),
    `import { mount } from '@frontierjs/mesa/runtime'`,
    has('src/App.mesa')
      ? `import App from '/src/App.mesa'`
      : `import { RouterView as App } from '@frontierjs/sierra/router'`,
    ``,
    `const root = document.getElementById('app')`,
    `if (import.meta.env.DEV && !root) throw new Error('[Sierra] index.html has no element with id="app", which is where the app mounts')`,
    // mount() inserts after its anchor, so the anchor is a node inside #app.
    `const anchor = document.createTextNode('')`,
    `root.appendChild(anchor)`,
    `mount(anchor, App, { root })`,
  ].join('\n')
}

/**
 * The namespace every `persisted()` key is stored under (`FJS-D1097` Q2) — two
 * apps on one dev origin otherwise read each other's preferences. `config.prefix`
 * when set, `''` turning it off; else the name in the nearest package.json above
 * the Vite root, which for an app whose surfaces carry no manifest is the app's.
 */
export function storagePrefix(config, root) {
  if (config.prefix !== undefined) return config.prefix ?? ''
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const manifest = resolve(dir, 'package.json')
    if (existsSync(manifest)) {
      try { return JSON.parse(readFileSync(manifest, 'utf8')).name ?? '' } catch { return '' }
    }
    if (dirname(dir) === dir) return ''
  }
}

/**
 * Generate the `virtual:sierra/boot` module source code.
 *
 * @param {import('./index.js').SierraConfig} config
 * @param {string} tableOutput
 * @param {string} root — the Vite root, which a custom analytics provider is relative to
 */
function generateVirtualSierra(config, tableOutput, root, sierraContext) {
  const lines = []

  lines.push(`import { tree, components, loaders, layouts, published, indexed, redirects } from '/${tableOutput}'`)
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
  lines.push(`  prefix: ${JSON.stringify(storagePrefix(config, root))},`)
  if (config.base) {
    lines.push(`  base: ${JSON.stringify(config.base)},`)
  }
  lines.push(`}, layouts)`)
  lines.push(``)

  // Junction wiring — enabled when junction.url is configured
  if (config.junction?.url) {
    lines.push(`// ── Junction ───────────────────────────────────────────────────`)
    lines.push(`import { initJunction } from '@frontierjs/sierra/resource'`)
    lines.push(``)
    // Not awaited. initJunction is synchronous now and exposes `whenReady`
    // for callers that specifically need the WebSocket transport; awaiting it
    // here blocked the entire entry module — and therefore first paint — on a
    // server round-trip for every returning visitor.
    //
    // `url` is decided HERE, in the page: the config is evaluated in Node, where
    // a `location` guard always takes its fallback, so the page called that
    // port cross-origin and every call failed CORS (`FJS-D1042`). The config's
    // `url` is the answer where there is no page — the terminal, a prerender.
    const { url, ...junction } = config.junction
    lines.push(`initJunction({ ...${JSON.stringify(junction)}, url: import.meta.env.FRONTIER_PUBLIC_API_URL || location.origin })`)
    lines.push(``)
  }

  // Model schemas, generated from db/schema.lite by build/schema-plugin.js.
  // Emitted before any route module is evaluated, so createResource() can read
  // a model's field shape without each resource file restating it.
  if (sierraContext?.schemaDefs && Object.keys(sierraContext.schemaDefs).length > 0) {
    lines.push(`// ── Model schemas (generated from ${sierraContext.schemaPath ?? 'schema.lite'}) ──`)
    lines.push(`import { registerSchemas } from '@frontierjs/sierra/resource'`)
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
    //
    // The fourth is the same for READ mode — the `@computed` / `@generated` /
    // `@derived` / `@from` family, which no write schema carries and every
    // display surface needs. It is the cheaper of the two deltas.
    lines.push(
      `registerSchemas(${JSON.stringify(sierraContext.schemaDefs)}, ` +
      `${JSON.stringify(sierraContext.schemaModels ?? null)}, ` +
      `${JSON.stringify(sierraContext.schemaUpdate ?? null)}, ` +
      `${JSON.stringify(sierraContext.schemaRead ?? null)})`
    )
    lines.push(``)
  } else if (sierraContext?.schemaFailure) {
    // A schema.lite was found and nothing reached the browser: forms render no
    // inputs and canAtLevel's unknown-is-permissive rule offers every control
    // to everyone, on a page that otherwise looks fine (`FJS-1649`).
    const where = sierraContext.schemaPath ?? 'schema.lite'
    lines.push(
      `console.error(${JSON.stringify(
        `[Sierra] ${where} was found but no client schema was generated, so every ` +
        `generated form is empty and every can() answers yes:\n${sierraContext.schemaFailure}`
      )})`)
    lines.push(``)
  }

  // The device's own database — only when the app asked for one, because it is
  // 868 kB of wasm and a worker. The URLs are the build's (`local-db-plugin.js`
  // puts the files there); nothing is fetched until the first read that needs
  // it, so an app that is never offline pays for the two lines below and
  // nothing else.
  if (sierraContext?.deviceSchema && config.offline && config.offline !== true && config.offline.db) {
    lines.push(`// ── The device's own database (offline: { db: true }) ──────────`)
    lines.push(`import { configureLocalDb } from '@frontierjs/sierra/resource'`)
    lines.push(
      `configureLocalDb(${JSON.stringify({
        schemaUrl: '/fjs-device-schema.json',
        wasmUrl:   '/fjs-sqlite/index.js',
        ...(typeof config.offline.db === 'object' ? config.offline.db : {}),
      })})`)
    lines.push(``)
  }

  // Analytics wiring — only if configured
  if (config.analytics) {
    lines.push(`// ── Analytics ──────────────────────────────────────────────────`)
    lines.push(`import { initAnalytics } from '@frontierjs/sierra/analytics'`)
    const provider = customProvider(config.analytics)
    if (provider) {
      lines.push(`import * as analyticsProvider from ${JSON.stringify(providerFile(root, provider))}`)
      lines.push(``)
      lines.push(`initAnalytics({ ...${JSON.stringify(config.analytics)}, provider: analyticsProvider })`)
    } else {
      lines.push(``)
      lines.push(`initAnalytics(${JSON.stringify(config.analytics)})`)
    }
    lines.push(``)
  }

  // Theme management — only if configured
  if (config.theme) {
    lines.push(`// ── Theme ──────────────────────────────────────────────────────`)
    lines.push(`import { initTheme } from '@frontierjs/sierra/theme'`)
    lines.push(``)
    lines.push(`initTheme(${JSON.stringify(config.theme)})`)
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

  lines.push(`export { tree, components, loaders, layouts, published, indexed, redirects }`)

  return lines.join('\n')
}

// Named exports for unit testing
export function _generateEntry(root) {
  return generateEntry(root)
}

export function _generateVirtualSierra(config, tableOutput, sierraContext) {
  return generateVirtualSierra(config, tableOutput, '/', sierraContext)
}

// Named export for unit testing — see test/frontier-resolution.test.js
export function _resolveFrontierSubpathForTest(id, searchRoots) {
  return _resolveFrontierSubpath(id, searchRoots)
}
