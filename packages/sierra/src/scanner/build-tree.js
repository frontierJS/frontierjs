/**
 * build-tree.js — constructs the route node tree from scanned files
 *
 * Implements the Sierra routing spec:
 * - PascalCase and _ prefix files are co-located components, not routes
 * - _module.mesa files are layouts
 * - (group)/ folders are organizational — zero URL impact
 * - [param] → :param in URL, [...rest] → *
 * - index.mesa is the index route for a folder
 * - Both file.mesa AND file/ existing → build error
 * - Trailing slash always appended (configurable)
 */

import { dirname, basename, extname, join, relative, resolve } from 'path'
import { readFrontmatter } from './parse-frontmatter.js'
import {
  classify,
  isGroupSegment,
  isDynamicSegment,
  isSpreadSegment,
  extractParam,
} from './classify.js'

/**
 * @typedef {Object} RouteNode
 * @property {string} id        — dot-separated unique identifier, e.g. 'leads.[leadId]'
 * @property {string} path      — URL pattern, e.g. '/leads/:leadId/'
 * @property {string} file      — path relative to project root
 * @property {string|null} layout — resolved layout file path, null if reset
 * @property {Record<string, unknown>} meta — frontmatter + system flags
 * @property {string[]} params  — extracted param names
 * @property {RouteNode[]} children
 */

/**
 * Build the full route tree from a list of file paths.
 *
 * @param {string[]} files      — all files under routesDir, relative to project root
 * @param {string} routesDir    — e.g. 'src/routes'
 * @param {object} options
 * @param {string} [options.trailingSlash='always'] — 'always' | 'never' | 'preserve'
 * @returns {Promise<RouteNode>} — root node
 */
export async function buildTree(files, routesDir, options = {}) {
  const { trailingSlash = 'always', cwd = process.cwd() } = options

  // Separate routes, layouts, companions
  const routeFiles = []
  const layoutMap = new Map()    // dirPath → layout file path
  const companionMap = new Map() // base path (no ext) → companion file path

  for (const file of files) {
    const role = classify(file)
    if (role === 'route') {
      routeFiles.push(file)
    } else if (role === 'layout') {
      const dir = dirname(file)
      layoutMap.set(dir, file)
    } else if (role === 'companion') {
      const base = file.replace(/\.meta\.js$/, '')
      companionMap.set(base, file)
    }
  }

  // Build layout companion map:
  // dirPath → companion file path for _module.meta.js files
  // e.g. 'src/routes/leads' → 'src/routes/leads/_module.meta.js'
  const layoutCompanionMap = new Map()
  for (const [dir, layoutFile] of layoutMap) {
    const layoutBase = layoutFile.replace(/\.mesa$/, '')
    if (companionMap.has(layoutBase)) {
      layoutCompanionMap.set(dir, companionMap.get(layoutBase))
    }
  }

  // Pre-load meta exports from all companions upfront
  // companion file path → meta object (or {} if no meta export)
  const companionMetaCache = await loadAllCompanionMeta(
    [...companionMap.values()],
    cwd
  )

  // Pre-load frontmatter from all layout (_module.mesa) files
  // layout file path → frontmatter object
  const layoutFrontmatterCache = new Map()
  await Promise.all(
    [...layoutMap.values()].map(async (layoutFile) => {
      const absFm = resolve(cwd, layoutFile)
      const fm = await readFrontmatter(absFm)
      // Strip Sierra-internal fields that should not propagate to pages
      const { reset, ...publicFm } = fm
      if (Object.keys(publicFm).length > 0) {
        layoutFrontmatterCache.set(layoutFile, publicFm)
      }
    })
  )

  // Detect file + folder conflicts
  checkConflicts(routeFiles, routesDir)

  // Build flat list of parsed route entries
  const entries = await Promise.all(
    routeFiles.map(file => parseRouteFile(
      file, routesDir, layoutMap, companionMap,
      layoutCompanionMap, companionMetaCache,
      layoutFrontmatterCache,
      trailingSlash, cwd
    ))
  )

  // Sort: shorter paths first, alphabetically within same depth
  entries.sort((a, b) => {
    const depthDiff = a.path.split('/').length - b.path.split('/').length
    if (depthDiff !== 0) return depthDiff
    return a.path.localeCompare(b.path)
  })

  return buildTreeFromEntries(entries, routesDir, layoutMap, trailingSlash)
}

/**
 * Parse a single route file into a route entry.
 */
async function parseRouteFile(
  file, routesDir, layoutMap, companionMap,
  layoutCompanionMap, companionMetaCache,
  layoutFrontmatterCache,
  trailingSlash, cwd
) {
  const absFile = resolve(cwd, file)
  const frontmatter = await readFrontmatter(absFile)

  const relToRoutes = relative(routesDir, file).replace(/\\/g, '/')
  const { id, path, params } = fileToRoute(relToRoutes, trailingSlash)

  // Resolve layout
  const layout = frontmatter.reset
    ? null
    : resolveLayout(file, routesDir, layoutMap)

  // Resolve route companion
  const companionKey = file.replace(/\.(mesa|md)$/, '')
  const companion = companionMap.get(companionKey) ?? null

  // Build inherited meta from layout chain (outermost first)
  // Merges _module.mesa frontmatter AND _module.meta.js exports, innermost wins
  const inheritedMeta = buildInheritedMeta(
    file, routesDir, layoutMap, layoutCompanionMap, companionMetaCache, layoutFrontmatterCache
  )

  // Route companion meta (one level above frontmatter)
  const companionMeta = companion ? (companionMetaCache.get(companion) ?? {}) : {}

  // System-derived meta flags — highest priority
  const systemMeta = {}
  if (params.length > 0) systemMeta.dynamic = true
  if (isSpreadFile(file)) systemMeta.spread = true
  if (isIndexFile(relToRoutes)) systemMeta.isIndex = true

  // Merge order (rightmost wins):
  // layout inherited → route companion meta → frontmatter → system flags
  return {
    id,
    path,
    file,
    companion,
    layout,
    meta: { ...inheritedMeta, ...companionMeta, ...frontmatter, ...systemMeta },
    params,
    children: [],
  }
}

/**
 * Load the `meta` export from all companion files upfront.
 * Returns a Map: companion file path → meta object.
 *
 * Uses dynamic import() so companion files can use any JS syntax.
 * Failures are silently swallowed — missing/broken meta = {}
 *
 * @param {string[]} companionFiles — companion file paths (relative to cwd)
 * @param {string} cwd
 * @returns {Promise<Map<string, Record<string, unknown>>>}
 */
async function loadAllCompanionMeta(companionFiles, cwd) {
  const cache = new Map()

  await Promise.all(
    companionFiles.map(async (file) => {
      try {
        const { pathToFileURL } = await import('url')
        const absPath = resolve(cwd, file)
        const mod = await import(pathToFileURL(absPath).href)
        cache.set(file, mod.meta ?? {})
      } catch {
        cache.set(file, {})
      }
    })
  )

  return cache
}

/**
 * Build inherited meta for a route by walking up the directory tree
 * and merging _module.meta.js meta exports, outermost layout first.
 *
 * @param {string} file               — route file path
 * @param {string} routesDir          — routes root
 * @param {Map<string, string>} layoutCompanionMap — dir → _module.meta.js path
 * @param {Map<string, object>} companionMetaCache — companion path → meta object
 * @returns {Record<string, unknown>}
 */
function buildInheritedMeta(
  file, routesDir, layoutMap, layoutCompanionMap, companionMetaCache, layoutFrontmatterCache
) {
  // Collect all ancestor dirs from routesDir down to this file's dir
  // e.g. for 'src/routes/leads/[leadId].mesa':
  //   dirs = ['src/routes', 'src/routes/leads']
  const fileDirParts = dirname(file).split('/')
  const routesDirParts = routesDir.split('/')

  const ancestorDirs = []
  for (let i = routesDirParts.length; i <= fileDirParts.length; i++) {
    ancestorDirs.push(fileDirParts.slice(0, i).join('/'))
  }

  // Merge meta from outermost to innermost — closer layout wins.
  // Per dir: _module.mesa frontmatter first, then _module.meta.js (meta.js wins on conflict).
  const inherited = {}
  for (const dir of ancestorDirs) {
    // 1. Layout file frontmatter (_module.mesa front matter)
    const layoutFile = layoutMap.get(dir)
    if (layoutFile) {
      const layoutFm = layoutFrontmatterCache?.get(layoutFile)
      if (layoutFm) Object.assign(inherited, layoutFm)
    }
    // 2. Layout companion meta (_module.meta.js) — wins over .mesa frontmatter
    const companionFile = layoutCompanionMap.get(dir)
    if (companionFile) {
      const meta = companionMetaCache.get(companionFile)
      if (meta) Object.assign(inherited, meta)
    }
  }

  return inherited
}

/**
 * Convert a route-relative file path to { id, path, params }.
 *
 * Examples:
 *   'index.mesa'                  → { id: 'root', path: '/' }
 *   'leads/index.mesa'            → { id: 'leads', path: '/leads/' }
 *   'leads/[leadId].mesa'         → { id: 'leads.[leadId]', path: '/leads/:leadId/' }
 *   '[...404].mesa'               → { id: '404', path: '/*' }
 *   '(auth)/login.mesa'           → { id: 'login', path: '/login/' }
 *   'account/settings/index.mesa' → { id: 'account.settings', path: '/account/settings/' }
 *
 * @param {string} relToRoutes — path relative to routesDir, e.g. 'leads/[leadId].mesa'
 * @param {string} trailingSlash
 */
function fileToRoute(relToRoutes, trailingSlash) {
  const ext = extname(relToRoutes)
  const withoutExt = relToRoutes.slice(0, -ext.length)  // 'leads/[leadId]'
  const rawSegments = withoutExt.split('/')

  const pathSegments = []
  const idSegments = []
  const params = []

  for (const segment of rawSegments) {
    // Skip organizational groups — (auth), (app) etc
    if (isGroupSegment(segment)) continue

    // Skip 'index' — it's the folder index, contributes no URL segment
    if (segment === 'index') continue

    if (isSpreadSegment(segment)) {
      const param = extractParam(segment)
      params.push(param)
      pathSegments.push('*')
      idSegments.push(`[...${param}]`)
    } else if (isDynamicSegment(segment)) {
      const param = extractParam(segment)
      params.push(param)
      pathSegments.push(`:${param}`)
      idSegments.push(`[${param}]`)
    } else {
      pathSegments.push(segment.toLowerCase())
      idSegments.push(segment.toLowerCase())
    }
  }

  // Build URL path
  let path
  if (pathSegments.length === 0) {
    path = '/'
  } else if (pathSegments[pathSegments.length - 1] === '*') {
    path = '/' + pathSegments.join('/') + (trailingSlash === 'always' ? '' : '')
  } else {
    path = '/' + pathSegments.join('/')
    if (trailingSlash === 'always') path += '/'
  }

  // Build ID
  const id = idSegments.length === 0 ? 'root' : idSegments.join('.')

  return { id, path, params }
}

/**
 * Resolve the layout file for a given route.
 * Walks up directory tree, returns nearest _module.mesa found.
 * Returns null if no layout found anywhere in the tree.
 *
 * @param {string} file       — route file path (relative to project root)
 * @param {string} routesDir  — e.g. 'src/routes'
 * @param {Map<string, string>} layoutMap
 */
function resolveLayout(file, routesDir, layoutMap) {
  let dir = dirname(file)

  while (true) {
    if (layoutMap.has(dir)) {
      return layoutMap.get(dir)
    }

    // Stop at the routes directory root
    if (dir === routesDir || dir === '.' || dir === '') break

    // Walk up one level
    const parent = dirname(dir)
    if (parent === dir) break  // filesystem root — shouldn't happen
    dir = parent
  }

  return null
}

/**
 * Build the nested tree from a flat sorted list of route entries.
 * Groups entries by their top-level segment and nests children.
 *
 * Returns a virtual root node whose children are the top-level routes.
 */
function buildTreeFromEntries(entries, routesDir, layoutMap, trailingSlash) {
  // Root node — corresponds to the routes directory itself
  const rootLayout = layoutMap.get(routesDir) ?? null

  const root = {
    id: 'root',
    path: '/',
    file: null,
    layout: null,
    meta: {},
    params: [],
    children: [],
  }

  // Find the root index if it exists.
  //
  // The root is a SYNTHESISED node — it stands for the routes directory itself
  // — so the entry's fields are copied onto it rather than the entry being
  // used. `companion` was missing from that copy, which meant
  // `src/routes/index.meta.js` was found by the scan, parsed, and then dropped:
  // the home page's `load()` never ran, `data` was null, and the page rendered
  // its empty state with a green build. Every other route kept its companion,
  // so it looked like a bug in the one file somebody was writing.
  const rootIndex = entries.find(e => e.id === 'root')
  if (rootIndex) {
    root.file      = rootIndex.file
    root.meta      = rootIndex.meta
    root.layout    = rootIndex.layout
    root.companion = rootIndex.companion ?? null
  }

  // Group all non-root entries by their first ID segment
  // e.g. 'leads.[leadId]' groups under 'leads'
  // We build the tree by nesting entries under their parent segments

  // Use a map to collect nodes by id for efficient parent lookup
  const nodeMap = new Map()
  nodeMap.set('root', root)

  // Process entries in order (already sorted by depth)
  for (const entry of entries) {
    if (entry.id === 'root') continue  // already handled

    nodeMap.set(entry.id, entry)

    // Find parent: strip the last segment of the ID
    const lastDot = entry.id.lastIndexOf('.')
    if (lastDot === -1) {
      // Top-level route — parent is root
      root.children.push(entry)
    } else {
      const parentId = entry.id.slice(0, lastDot)
      const parent = nodeMap.get(parentId)
      if (parent) {
        parent.children.push(entry)
      } else {
        // Parent is a folder without its own index route — still attach to root
        // or to the nearest ancestor we can find
        attachToNearestAncestor(entry, nodeMap, root)
      }
    }
  }

  // Sort children within each node: static before dynamic, alphabetically within type
  sortChildren(root)

  return root
}

/**
 * Walk up the ID segments to find the nearest ancestor node to attach to.
 */
function attachToNearestAncestor(entry, nodeMap, root) {
  const segments = entry.id.split('.')
  for (let i = segments.length - 2; i >= 0; i--) {
    const ancestorId = segments.slice(0, i + 1).join('.')
    const ancestor = nodeMap.get(ancestorId)
    if (ancestor) {
      ancestor.children.push(entry)
      return
    }
  }
  // No ancestor found — attach to root
  root.children.push(entry)
}

/**
 * Sort children: static segments first, then dynamic, then catch-all.
 * Alphabetical within each category.
 */
function sortChildren(node) {
  node.children.sort((a, b) => {
    const aScore = routePriority(a)
    const bScore = routePriority(b)
    if (aScore !== bScore) return aScore - bScore
    return a.path.localeCompare(b.path)
  })

  for (const child of node.children) {
    sortChildren(child)
  }
}

function routePriority(node) {
  if (node.meta?.spread) return 2   // catch-all last
  if (node.meta?.dynamic) return 1  // dynamic middle
  return 0                          // static first
}

/**
 * Detect file + folder conflicts.
 * Both 'blog.mesa' and 'blog/' existing → build error.
 */
function checkConflicts(routeFiles, routesDir) {
  const fileNames = new Set()
  const folderNames = new Set()

  for (const file of routeFiles) {
    const rel = relative(routesDir, file).replace(/\\/g, '/')
    const parts = rel.split('/')
    const dir = parts.slice(0, -1).join('/')
    const name = parts[parts.length - 1].replace(/\.(mesa|md)$/, '').toLowerCase()

    if (name !== 'index') {
      const key = dir ? `${dir}/${name}` : name
      if (folderNames.has(key)) {
        throw new Error(
          `[Sierra] Route conflict: both '${key}.mesa' and '${key}/' exist. ` +
          `Remove one or rename the file to '${key}/index.mesa'.`
        )
      }
      fileNames.add(key)
    }

    if (parts.length > 1) {
      const folderKey = parts.slice(0, -1).join('/')
      if (fileNames.has(folderKey)) {
        throw new Error(
          `[Sierra] Route conflict: both '${folderKey}.mesa' and '${folderKey}/' exist. ` +
          `Remove one or rename the file to '${folderKey}/index.mesa'.`
        )
      }
      folderNames.add(folderKey)
    }
  }
}

function isIndexFile(relToRoutes) {
  const name = basename(relToRoutes, extname(relToRoutes))
  return name === 'index'
}

function isSpreadFile(file) {
  return /\[\.\.\./.test(basename(file))
}
