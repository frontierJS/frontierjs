/**
 * classify.js — determines the role of each file in the routes directory
 *
 * Roles:
 *   'route'      — navigable page (lowercase .mesa / .md)
 *   'layout'     — _module.mesa (wraps descendant routes)
 *   'component'  — co-located component (PascalCase or _ prefix, not a route)
 *   'companion'  — .meta.js data file
 *   'ignored'    — everything else
 */

import { basename, extname } from 'path'

const ROUTE_EXTENSIONS = new Set(['.mesa', '.md'])

/**
 * @param {string} relativePath — path relative to routesDir, e.g. 'leads/[leadId].mesa'
 * @returns {'route' | 'layout' | 'component' | 'companion' | 'ignored'}
 */
export function classify(relativePath) {
  const base = basename(relativePath)
  const ext = extname(base)
  const name = base.slice(0, base.length - ext.length)  // filename without extension

  // Companion data file
  if (relativePath.endsWith('.meta.js')) return 'companion'

  // Only process Mesa/Markdown files beyond this point
  if (!ROUTE_EXTENSIONS.has(ext)) return 'ignored'

  // Reserved layout name — always a layout regardless of other rules
  if (name === '_module') return 'layout'

  // Underscore prefix — co-located component or excluded file
  if (name.startsWith('_')) return 'component'

  // PascalCase first letter — co-located component
  if (/^[A-Z]/.test(name)) return 'component'

  // Everything else: lowercase name = route
  return 'route'
}

/**
 * Returns true if the path segment is an organizational group folder.
 * e.g. '(auth)', '(app)', '(marketing)'
 *
 * @param {string} segment
 */
export function isGroupSegment(segment) {
  return /^\(.+\)$/.test(segment)
}

/**
 * Returns true if the segment is a dynamic param.
 * e.g. '[leadId]', '[slug]'
 *
 * @param {string} segment
 */
export function isDynamicSegment(segment) {
  return /^\[(?!\.\.\.).+\]$/.test(segment)
}

/**
 * Returns true if the segment is a catch-all spread param.
 * e.g. '[...404]', '[...rest]'
 *
 * @param {string} segment
 */
export function isSpreadSegment(segment) {
  return /^\[\.\.\.(.+)\]$/.test(segment)
}

/**
 * Extracts param name from a dynamic or spread segment.
 * '[leadId]'  → 'leadId'
 * '[...rest]' → 'rest'
 *
 * @param {string} segment
 */
export function extractParam(segment) {
  return segment.replace(/^\[\.\.\./, '').replace(/^\[/, '').replace(/\]$/, '')
}
