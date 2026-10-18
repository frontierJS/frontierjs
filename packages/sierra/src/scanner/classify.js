/**
 * classify.js — determines the role of each file in the routes directory
 *
 * Roles:
 *   'route'      — navigable page (lowercase .mesa / .md)
 *   'layout'     — _module.mesa / _module.md (wraps descendant routes)
 *   'component'  — co-located component (PascalCase or _ prefix, not a route)
 *   'companion'  — .meta.js data file
 *   'ignored'    — everything else
 */

import { basename, extname } from 'path'
import { splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'

export const ROUTE_EXTENSIONS = new Set(['.mesa', '.md'])

/**
 * Whether a `_module` file wraps the routes beneath it (`FJS-D1240`).
 *
 * A `_module.md` holding front matter and nothing else is data for its
 * directory: the front matter cascades and the pages render unwrapped. Read as
 * a layout, it has no `<slot />`, so every page beneath it shipped an empty
 * `<main>` on a green build. One with a body and no slot is that same empty
 * page, and is refused by name rather than guessed at.
 *
 * @param {string} file   — the path named in a refusal
 * @param {string} source — the file's contents
 * @returns {'layout' | 'pass-through'}
 */
export function layoutRole(file, source) {
  if (extname(file) !== '.md') return 'layout'
  const { body } = splitFrontmatter(source)
  if (body.trim() === '') return 'pass-through'
  if (/<slot[\s/>]|\{@render\s+children\b/.test(body)) return 'layout'
  const err = new Error(
    `${file}: a _module.md with a body wraps every page beneath it, and this one has no <slot /> ` +
    'to put the page in, so each would render empty. Add <slot />, or delete the body to keep only the front matter.'
  )
  err.code = 'SIERRA_LAYOUT_NO_SLOT'
  throw err
}

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
