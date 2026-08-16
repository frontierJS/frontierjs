/**
 * scanner/index.js — Sierra route scanner
 *
 * Scans a routes directory and produces the route table.
 *
 * Usage:
 *   import { scan } from 'sierra/scanner'
 *   const tree = await scan('src/routes', { trailingSlash: 'always' })
 */

import { resolve, join } from 'path'
import { walk } from './walk.js'
import { buildTree } from './build-tree.js'
import { generateRouteTable, renderRouteTable } from './generate-route-table.js'

/**
 * Scan a routes directory and return the route tree.
 *
 * @param {string} routesDir — path relative to cwd, e.g. 'src/routes'
 * @param {object} options
 * @param {string} [options.trailingSlash='always']
 * @param {string} [options.cwd=process.cwd()]
 * @returns {Promise<import('./build-tree.js').RouteNode>}
 */
export async function scan(routesDir, options = {}) {
  const { cwd = process.cwd(), trailingSlash = 'always' } = options

  const absRoutesDir = resolve(cwd, routesDir)
  const files = await walk(absRoutesDir, cwd)

  // Only pass files that are under the routes dir
  const routeFiles = files.filter(f => f.startsWith(routesDir.replace(/\\/g, '/')))

  const tree = await buildTree(routeFiles, routesDir, { trailingSlash, cwd })
  return tree
}

/**
 * Scan and write the route table to disk.
 *
 * @param {string} routesDir
 * @param {string} outputPath — e.g. 'config/routes.js'
 * @param {object} options
 */
export async function scanAndWrite(routesDir, outputPath, options = {}) {
  const tree = await scan(routesDir, options)
  await generateRouteTable(tree, outputPath, options.cwd ?? process.cwd())
  return tree
}

export { buildTree } from './build-tree.js'
export { walk } from './walk.js'
export { classify } from './classify.js'
export { parseFrontmatter, readFrontmatter } from './parse-frontmatter.js'
export { generateRouteTable, renderRouteTable } from './generate-route-table.js'
