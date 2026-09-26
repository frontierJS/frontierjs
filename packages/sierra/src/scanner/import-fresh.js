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
 *
 * A process killed mid-import never reaches its `finally`, so its copies stay
 * in the app's source tree. The first import into a directory sweeps copies
 * whose writing process is gone. Only a DEAD pid is swept: two dev servers or
 * a drive beside one share a routes directory, and deleting a live process's
 * copy before its import resolves fails that import.
 */

import { copyFile, readdir, rm } from 'fs/promises'
import { dirname, join, basename, extname } from 'path'
import { pathToFileURL } from 'url'

const SIDECAR = /^\.sierra-fresh-(\d+)-/

let counter = 0
const swept = new Set()

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM is a live process owned by someone else.
    return err.code === 'EPERM'
  }
}

async function sweep(dir) {
  if (swept.has(dir)) return
  swept.add(dir)
  let names
  try { names = await readdir(dir) } catch { return }
  await Promise.all(names.map(name => {
    const pid = Number(SIDECAR.exec(name)?.[1])
    if (!pid || pid === process.pid || isAlive(pid)) return
    return rm(join(dir, name), { force: true }).catch(() => {})
  }))
}

/**
 * @param {string} abs — absolute path to the module
 * @returns {Promise<object>} the module namespace
 */
export async function importFresh(abs) {
  const ext = extname(abs) || '.js'
  await sweep(dirname(abs))
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
