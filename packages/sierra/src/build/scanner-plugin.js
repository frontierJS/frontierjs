/**
 * scanner-plugin.js — Vite plugin that runs the route scanner
 *
 * Responsibilities:
 * - Runs scan() at build start and writes config/routes.js
 * - Watches src/routes/ for new/deleted files during dev
 * - Re-runs scanner and invalidates virtual:sierra on route changes
 * - Emits build warnings for Sierra-specific issues
 */

import { resolve, relative } from 'path'
import { scan } from '../scanner/index.js'
import { generateRouteTable } from '../scanner/generate-route-table.js'
import { classify } from '../scanner/classify.js'
import { warnDuplicateSnippets, warnReservedFrontmatter } from './warnings.js'
// From page-fields.js, not router/index.js: this runs in Node during the
// build, and router/index.js pulls in the Mesa runtime.
import { PAGE_RESERVED } from '../router/page-fields.js'

/**
 * @param {import('./index.js').SierraConfig} config
 * @param {object} sierraContext
 * @returns {import('vite').Plugin}
 */
export function scannerPlugin(config, sierraContext) {
  const routesDir = config.routesDir ?? 'src/routes'
  const tableOutput = config.routeTable?.output ?? 'config/routes.js'
  const trailingSlash = config.trailingSlash ?? 'always'

  let root = process.cwd()
  let watcher = null
  // `build` or `serve`. A static target is the SPA's config plus a prerender
  // pass, so the same plugin runs in a client-routed dev server and in a build
  // that emits files — and the two need different route tables.
  let command = 'serve'
  // Last route table emitted. The dev watchers rescan on every route-file save,
  // but the vast majority of saves are body edits that leave the route tree
  // untouched — invalidating virtual:sierra and forcing a full reload for those
  // throws away the component-level HMR that mesa-plugin just set up.
  let _lastTable = null

  async function runScan(root, warn, error) {
    const tree = await scan(routesDir, {
      cwd: root,
      trailingSlash,
    })

    // Write the route table to disk. generateRouteTable is a no-op when the
    // bytes are unchanged, so this does not touch the watcher on a body-only edit.
    // A static BUILD drops the loader imports: `load()` has already run, in
    // Node, and pulling the companions into the client graph publishes whatever
    // they import — for a storefront, the app's own database client.
    const omitLoaders = command === 'build' && (config.target ?? 'spa') === 'static'
    // A prerendered route's load() runs in Node. In dev there is a Node process
    // right here, so it runs in THIS one and the browser fetches the result —
    // which is the difference between a dev server that shows the storefront
    // and one that shows an empty page correctly. Off with
    // `dev: { staticData: false }`; never in a build, where the data is baked.
    const devStaticData = command === 'serve' && (config.dev?.staticData ?? true)
    const code = await generateRouteTable(tree, resolve(root, tableOutput), root, {
      omitLoaders, devStaticData,
    })
    const tableChanged = _lastTable !== null && _lastTable !== code
    _lastTable = code

    // Store tree on shared context for virtual:sierra
    sierraContext.tree = tree

    // Warning: frontmatter using a name the router owns on `page`
    if (warn) warnReservedFrontmatter(tree, PAGE_RESERVED, warn)

    // Warning 2: duplicate snippet props across layout chain
    if (warn && sierraContext.layoutPropMap.size > 0) {
      warnDuplicateSnippets(tree, sierraContext.layoutPropMap, warn)
    }

    // Build error: dynamic route with render:static but no getStaticPaths
    if (error) {
      await checkStaticPaths(tree, root, error, warn)
    }

    return { tree, tableChanged }
  }

  /**
   * Walk the tree and error on any dynamic route that has render:static
   * in its frontmatter but no getStaticPaths export in its companion.
   */
  async function checkStaticPaths(tree, root, error, warn) {
    const nodes = flattenTree(tree)
    for (const node of nodes) {
      if (!node.meta?.dynamic) continue
      if (node.meta?.render !== 'static') continue

      // Dynamic route with render:static — companion must export getStaticPaths
      if (!node.companion) {
        error(
          `[Sierra] Dynamic route '${node.path}' has render:static but no companion .meta.js.\n` +
          `Create ${node.file.replace(/\.(mesa|md)$/, '.meta.js')} and export getStaticPaths().`
        )
        continue
      }

      // Only the IMPORT is guarded. `error` is rollup's `this.error`, which
      // throws — inside the try it was caught here and reported as a companion
      // that would not import, so the refusal this check exists for was a
      // warning on a green build.
      let mod
      try {
        const { pathToFileURL } = await import('url')
        mod = await import(pathToFileURL(resolve(root, node.companion)).href)
      } catch (err) {
        // Can't import companion — warn but don't hard error (may be a new file).
        // The cause is in the message: without it this reads as the companion
        // being absent, when it is usually the companion's own imports throwing.
        if (warn) {
          warn(
            `[Sierra] Could not import companion '${node.companion}' to check getStaticPaths: ` +
            `${err?.message ?? err}`
          )
        }
        continue
      }

      if (typeof mod.getStaticPaths !== 'function') {
        error(
          `[Sierra] Dynamic route '${node.path}' has render:static but '${node.companion}' ` +
          `does not export getStaticPaths().\n` +
          `Add: export async function getStaticPaths() { return [{ slug: '...' }, ...] }`
        )
      }
    }
  }

  return {
    name: 'sierra:scanner',
    enforce: 'pre',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
      command = viteConfig.command ?? 'serve'
    },

    async buildStart() {
      // `command`, off configResolved — not `this.environment.mode`, which is
      // `dev` in a dev server rather than `serve`, so a `!== 'serve'` test made
      // every dev boot take the build branch (`FJS-473`).
      const isBuild = command === 'build'
      // Only enforce getStaticPaths during production builds — not dev server
      const errorFn = isBuild ? (msg) => this.error(msg) : null
      await runScan(root, (msg) => this.warn(msg), errorFn)
    },

    configureServer(server) {
      watcher = server.watcher

      const absRoutesDir = resolve(root, routesDir)

      // Watch routes directory for file system changes
      server.watcher.add(absRoutesDir)

      server.watcher.on('add', async (file) => {
        if (!file.startsWith(absRoutesDir)) return
        const rel = relative(root, file).replace(/\\/g, '/')
        const role = classify(rel)

        // Only rescan for route-relevant files
        if (role === 'ignored') return

        console.log(`[Sierra] New route file: ${rel}`)
        await runScan(root, (msg) => console.warn(msg), null)
        invalidateVirtualSierra(server)   // structural — always
      })

      server.watcher.on('unlink', async (file) => {
        if (!file.startsWith(absRoutesDir)) return
        const rel = relative(root, file).replace(/\\/g, '/')
        const role = classify(rel)

        if (role === 'ignored') return

        console.log(`[Sierra] Removed route file: ${rel}`)
        await runScan(root, (msg) => console.warn(msg), null)
        invalidateVirtualSierra(server)   // structural — always
      })

      // Re-scan when frontmatter changes in a route file
      server.watcher.on('change', async (file) => {
        if (!file.startsWith(absRoutesDir)) return
        const rel = relative(root, file).replace(/\\/g, '/')
        const role = classify(rel)

        if (role !== 'route' && role !== 'layout') return

        // A body edit leaves the tree identical, so the route table is unchanged
        // and there is nothing for virtual:sierra to pick up — mesa-plugin's
        // HMR boundary already handles the component. Only reload when the scan
        // actually produced a different table (frontmatter affecting routing,
        // a new layout, a changed redirect…).
        const { tableChanged } = await runScan(root, (msg) => console.warn(msg), null)
        if (tableChanged) invalidateVirtualSierra(server)
      })
    },
  }
}

function invalidateVirtualSierra(server) {
  const virtualModule = server.moduleGraph.getModuleById('\0virtual:sierra')
  if (virtualModule) {
    server.moduleGraph.invalidateModule(virtualModule)
    server.ws.send({ type: 'full-reload' })
  }
}

function flattenTree(node) {
  return [node, ...(node.children ?? []).flatMap(flattenTree)]
}
