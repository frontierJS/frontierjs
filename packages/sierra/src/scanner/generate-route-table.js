/**
 * generate-route-table.js — writes config/routes.js from the route tree
 *
 * Produces:
 *   export const tree      — boot-time metadata tree (no component imports)
 *   export const components — lazy component factory map { id → () => import(...) }
 *   export const layouts    — lazy layout factory map { filePath → () => import(...) }
 *   export const all       — flat array of all route paths
 *   export const published — after draft/status filtering
 *   export const indexed   — after noindex + dynamic exclusion
 *   export const redirects — [[from, to], ...] pairs
 *   export default tree
 */

import { writeFile, readFile, mkdir } from 'fs/promises'
import { dirname, relative, resolve } from 'path'

/**
 * Generate and write the route table.
 *
 * @param {import('./build-tree.js').RouteNode} tree — root node from buildTree()
 * @param {string} outputPath — e.g. 'config/routes.js'
 * @param {string} [projectRoot] — for generating relative import paths
 */
export async function generateRouteTable(tree, outputPath, projectRoot = '.', opts = {}) {
  // Compute the route table's path relative to projectRoot for import path calculation
  const tableOutput = relative(resolve(projectRoot), resolve(outputPath)).replace(/\\/g, '/')
  const code = renderRouteTable(tree, projectRoot, tableOutput, opts)

  // Skip the write when nothing changed. The route table is inside the Vite root
  // and imported by virtual:sierra, so rewriting identical bytes still fires the
  // watcher and invalidates the whole app. Combined with the removal of the
  // generation timestamp below, an unchanged route tree now produces no write
  // and therefore no HMR churn.
  const abs = resolve(outputPath)
  const existing = await readFile(abs, 'utf8').catch(() => null)
  if (existing === code) return code

  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, code, 'utf8')

  return code
}

/**
 * Render the route table as a JS string (without writing to disk).
 * Useful for testing and for virtual:sierra.
 *
 * @param {import('./build-tree.js').RouteNode} tree
 * @param {string} projectRoot
 * @param {string} tableOutput  — path of the route table file relative to projectRoot
 */
export function renderRouteTable(tree, projectRoot = '.', tableOutput = 'config/routes.js', opts = {}) {
  const allNodes = flattenTree(tree)

  const routeNodes = allNodes.filter(n => n.file !== null)
  const all        = routeNodes.map(n => n.path)
  const published  = routeNodes.filter(n => n.meta?.status !== 'draft').map(n => n.path)
  const indexed    = routeNodes
    .filter(n => n.meta?.status !== 'draft')
    .filter(n => n.meta?.robots !== 'noindex')
    .filter(n => !n.meta?.dynamic)
    .map(n => n.path)

  const redirects = routeNodes
    .filter(n => n.meta?.redirect)
    .map(n => [n.path, n.meta.redirect])

  // Build clean tree
  const cleanTree = renderNode(tree, 0)

  // Compute the directory containing the route table file
  const tableDir = dirname(resolve(projectRoot, tableOutput))

  // Build components map with paths relative to the route table file location
  const componentEntries = routeNodes
    .filter(n => n.file)
    .map(n => {
      const absFile = resolve(projectRoot, n.file)
      let relPath = relative(tableDir, absFile).replace(/\\/g, '/')
      if (!relPath.startsWith('.')) relPath = './' + relPath
      return `  ${jsString(n.id)}: () => import(${jsString(relPath)}),`
    })
    .join('\n')

  // Build loaders map — only routes with a .meta.js companion.
  //
  // EMPTY on a static BUILD, and that is a security property rather than a size
  // one. A companion runs at build time: the prerenderer imports it off disk
  // (`importCompanion`), never through the bundle, and a prerendered page ships
  // HTML plus its islands and calls no loader. Keeping the imports here made
  // rolldown follow every `.meta.js` into the client graph — and a storefront's
  // companion imports the app's own Litestone client, so the published
  // directory carried `db.js`, the DDL emitter and the migration engine as
  // fetchable files on a public origin. Nothing linked them, which is why it
  // went unnoticed: a static host serves a file whether a page links it or not.
  //
  // Dev is not untouched, and the sentence that used to be here said it was.
  // `vite dev` on a static target IS a client-routed app — but a route that
  // declares `render: static` never calls `load()` in a browser at all: that
  // function runs at BUILD time, in Node, and is where a storefront reads its
  // own database. Kept in the table, the dev router imported it, called it, and
  // got `Module "fs" has been externalized for browser compatibility` — caught,
  // downgraded to a console warning, and rendered as a page with nothing on it.
  // Vite followed the same import into the browser graph on the way, so the
  // terminal filled with un-analyzable-dynamic-import warnings about the
  // migration engine and the service autoloader (`FJS-543`).
  //
  // So the rule is per ROUTE and not per target: a prerendered route's loader
  // is build-time by definition, and a route on a static target that is NOT
  // prerendered is an ordinary client-routed page whose `load()` does run in
  // the browser and must stay.
  //
  // `omitLoaders` above it is the whole-table switch the static BUILD sets, and
  // it stays: this narrows what dev ships, never what the build does.
  const loaderNodes = opts.omitLoaders
    ? []
    : routeNodes.filter(n => n.companion && n.meta?.render !== 'static')
  const loaderEntries = loaderNodes
    .map(n => {
      const absFile = resolve(projectRoot, n.companion)
      let relPath = relative(tableDir, absFile).replace(/\\/g, '/')
      if (!relPath.startsWith('.')) relPath = './' + relPath
      return `  ${jsString(n.id)}: () => import(${jsString(relPath)}),`
    })
    .join('\n')

  // ── Static routes in dev ─────────────────────────────────────────────────
  //
  // A prerendered route's `load()` is build-time by definition and its
  // companion may never enter the browser graph — that is the paragraph above
  // and it does not move. What it leaves is a dev server showing nothing, which
  // is the correct answer to the wrong question: the page is not empty because
  // the query found nothing, it is empty because nobody asked.
  //
  // So the loader runs where it already runs — in NODE, on the dev server, at
  // `/__sierra/static-data` (build/static-data-plugin.js) — and the browser
  // gets JSON. The shim below is a `fetch`, deliberately not an `import`: an
  // import is what published a storefront's database client (`FJS-543`), and a
  // fetch cannot, whatever the companion pulls in.
  //
  // Dev only, and doubly so: these entries are emitted only when the scanner is
  // running under `serve`, and each is guarded by `import.meta.env.DEV` as well,
  // so a table written by a dev run and then bundled by a build carries nothing.
  const devStaticNodes = opts.devStaticData
    ? routeNodes.filter(n => n.companion && n.meta?.render === 'static')
    : []
  const devStaticEntries = devStaticNodes
    .map(n => `  ${jsString(n.id)}: () => __sierraDevStatic(${jsString(n.id)}),`)
    .join('\n')

  // `head()` lives in the companion too, and the router asks for it AFTER
  // load() — so the one response carries both and the shim hands back what it
  // was told. A navigation that took the prefetch cache never calls load(),
  // so head is null there and the title falls back to frontmatter, which is
  // what a route with no head() gets anyway.
  const devStaticShim = devStaticNodes.length
    ? `
function __sierraDevStatic(routeId) {
  let answered = null
  return Promise.resolve({
    async load({ params, url }) {
      const q = new URLSearchParams({ route: routeId, url, params: JSON.stringify(params ?? {}) })
      const res = await fetch('/__sierra/static-data?' + q)
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error ?? ('static-data ' + res.status))
      answered = body
      return body.data
    },
    head: () => answered?.head ?? null,
  })
}
`
    : ''

  // Build layouts map — unique layout files used across all routes.
  // Keyed by file path (same value as node.layout in the tree).
  // Loaded eagerly on initRouter so resolveChain() can always find layout components.
  const uniqueLayoutPaths = [...new Set(
    allNodes.map(n => n.layout).filter(Boolean)
  )]
  const layoutEntries = uniqueLayoutPaths
    .map(layoutPath => {
      const absFile = resolve(projectRoot, layoutPath)
      let relPath = relative(tableDir, absFile).replace(/\\/g, '/')
      if (!relPath.startsWith('.')) relPath = './' + relPath
      return `  ${JSON.stringify(layoutPath)}: () => import(${jsString(relPath)}),`
    })
    .join('\n')

  const lines = [
    `// config/routes.js — auto-generated by Sierra — do not edit`,
    // No generation timestamp: it would make the file differ on every scan even
    // when the route tree is byte-identical, invalidating every importer.
    ``,
    `// Boot-time tree — metadata only, no component or loader imports`,
    `// Component factories are in the 'components' map below`,
    `// Loader factories are in the 'loaders' map below`,
    `export const tree = ${cleanTree}`,
    ``,
    `// Component factory map — resolved lazily by the router on navigation`,
    `export const components = {`,
    componentEntries,
    `}`,
    ``,
    devStaticShim,
    `// Loader factory map — routes with a .meta.js companion`,
    `// Only populated for routes that have a companion file`,
    `export const loaders = {`,
    loaderEntries,
    devStaticEntries,
    `}`,
    ``,
    `// Layout factory map — keyed by file path (same as node.layout in the tree).`,
    `// All layouts are loaded eagerly by initRouter on boot so resolveChain()`,
    `// always has the component factory available when rendering the chain.`,
    `export const layouts = {`,
    layoutEntries,
    `}`,
    ``,
    `// Flat URL arrays for route table consumers (sitemap, llms.txt, deploys)`,
    `export const all = ${JSON.stringify(all, null, 2)}`,
    ``,
    `export const published = ${JSON.stringify(published, null, 2)}`,
    ``,
    `export const indexed = ${JSON.stringify(indexed, null, 2)}`,
    ``,
    `export const redirects = ${JSON.stringify(redirects, null, 2)}`,
    ``,
    `// Default export is the full tree — what the router consumes`,
    `export default tree`,
  ]

  return lines.join('\n')
}

/**
 * A string as JS source.
 *
 * Route ids and import paths are derived from FILENAMES, and an apostrophe is
 * legal in one — `en's-guide.mesa` emitted a `config/routes.js` that does not
 * parse, and the `import('…')` value position alone is a syntactically valid
 * escape into generated source. Half this function already knew the rule: the
 * layouts map stringified its KEY and interpolated everything else bare
 * (`FJS-821`).
 *
 * Single quotes are kept where no escape is needed, which is every name any app
 * has, so a route table regenerated by this build is byte-identical to the one
 * before it (Invariant 12).
 */
function jsString(value) {
  const json = JSON.stringify(value)
  // JSON does not escape an apostrophe — it is the one character that needs no
  // escape inside double quotes and every escape inside single ones — so it is
  // tested for separately rather than inferred from the round trip.
  const plain = json === `"${value}"` && !value.includes("'")
  return plain ? `'${value}'` : json
}

/**
 * Render a single node as a JSON-like JS object string with proper indentation.
 */

function renderNode(node, depth) {
  const indent = '  '.repeat(depth)
  const inner  = '  '.repeat(depth + 1)

  // Serialize meta — omit internal-only fields that don't need to be in the route table
  const meta = { ...node.meta }

  const children = node.children.length === 0
    ? '[]'
    : `[\n${node.children.map(c => `${inner}${renderNode(c, depth + 2)}`).join(',\n')}\n${indent}  ]`

  return [
    `{`,
    `${inner}id: ${JSON.stringify(node.id)},`,
    `${inner}path: ${JSON.stringify(node.path)},`,
    `${inner}file: ${JSON.stringify(node.file)},`,
    `${inner}companion: ${JSON.stringify(node.companion ?? null)},`,
    `${inner}layout: ${JSON.stringify(node.layout)},`,
    // `JSON.parse` and not a bare literal. JSON is not a subset of a JS object
    // literal: `"__proto__": {…}` is an ordinary key to `JSON.parse` and a
    // prototype assignment to the literal. Emitted bare, a frontmatter block
    // carrying `__proto__: {render: static, publishes: 9}` reads as nothing at
    // build time — `node.meta?.render` is undefined, so the prerender check,
    // `checkStaticPaths` and the static-safety `publishes:` escape all see an
    // empty meta — while the browser reads both through the prototype. One
    // document, two meanings, and the build got the blind one (`FJS-801`).
    `${inner}meta: JSON.parse(${JSON.stringify(JSON.stringify(meta))}),`,
    `${inner}params: ${JSON.stringify(node.params)},`,
    `${inner}children: ${children},`,
    `${indent}}`,
  ].join('\n')
}

/**
 * Flatten the tree into a pre-order list of all nodes.
 */
function flattenTree(node) {
  const result = [node]
  for (const child of node.children) {
    result.push(...flattenTree(child))
  }
  return result
}
