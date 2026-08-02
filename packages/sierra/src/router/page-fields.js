/**
 * router/page-fields.js — the field names the router owns on `page`.
 *
 * Deliberately dependency-free, and separate from router/index.js, because the
 * build pipeline needs this list: the scanner warns when a route's frontmatter
 * uses one of these names, and that check runs in Node while vite.config.js is
 * being loaded.
 *
 * Importing it from router/index.js instead pulled the whole client router —
 * and through it @frontierjs/mesa/runtime — into config resolution, failing the
 * build with "Cannot find package '@frontierjs/mesa'" before compiling anything.
 * Same shape as theme/script.js; see that file's note.
 *
 * Keep this module free of imports.
 */

export const PAGE_RESERVED = Object.freeze([
  'path', 'params', 'meta', 'route', 'pending', 'data', 'error', 'slots',
])
