/**
 * import-fresh.js — import a module off disk, ignoring the module cache
 *
 * A `*.meta.js` companion is app source that the SCANNER executes, so an author
 * editing `meta` or `load()` expects the next scan to read what they wrote. The
 * usual trick is a cache-busting query — `import(href + '?t=' + mtime)` — and it
 * does not work here, because **bun does not include the query string in the
 * module cache key** and bun is the runtime a static surface's dev server is
 * required to be (`FJS-806`). Measured, same script both ways:
 *
 *   node  MARK-A -> MARK-B
 *   bun   MARK-A -> MARK-A
 *
 * So the cache is missed the one way both runtimes agree on: a different PATH.
 * The copy is written BESIDE the original — a dotfile, so the walker skips it
 * (`walk.js` ignores dotfiles) and the scanner cannot see it as a route — which
 * is what keeps the module's own relative imports resolving, and keeps THOSE
 * cached: a companion importing the app's Litestone client must not rebuild it
 * on every page view.
 */

import { copyFile, rm } from 'fs/promises'
import { dirname, join, basename, extname } from 'path'
import { pathToFileURL } from 'url'

let counter = 0

/**
 * @param {string} abs — absolute path to the module
 * @returns {Promise<object>} the module namespace
 */
export async function importFresh(abs) {
  const ext = extname(abs) || '.js'
  const sidecar = join(
    dirname(abs),
    `.sierra-fresh-${process.pid}-${counter++}-${basename(abs, ext)}${ext}`
  )

  await copyFile(abs, sidecar)
  try {
    return await import(pathToFileURL(sidecar).href)
  } finally {
    // Unlinked once the import has RESOLVED, so the module and everything it
    // pulls in at the top level are already evaluated. A lazy `import()` inside
    // one of its functions still resolves: those specifiers are relative to
    // this directory, and only the copy is gone.
    await rm(sidecar, { force: true }).catch(() => {})
  }
}
