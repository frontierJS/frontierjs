/**
 * walk.js — recursive directory walker
 *
 * Returns a flat list of all file paths under a directory,
 * relative to the given root. Ignores node_modules and dotfiles.
 *
 * A symlink is followed, and that is the whole of what is interesting here.
 * `entry.isDirectory()` is FALSE for a symlink pointing at a directory, so a
 * routes tree shared between two apps by `ln -s ../shared/routes marketing`
 * used to produce an empty branch with nothing said, while a symlinked route
 * FILE beside it was included — one mechanism, two answers (`FJS-821` (g)).
 *
 * Following costs a cycle check, which `readdir` alone cannot give: `loop -> .`
 * is one `stat` away from infinite recursion. Directories are therefore keyed
 * by REALPATH, and a repeat is skipped and named.
 *
 * A MOUNT is the other way in, and the one a package uses (`FJS-D282`):
 * `automations.mount.js` default-exports a directory — a `URL` or an absolute
 * path, normally re-exported from the package that owns it — and its files are
 * reported as if they sat in `automations/` beside the mount. The path reported
 * is that VIRTUAL one, since the URL, the layout chain and every conflict check
 * are computed from where a route appears; `opts.sources` receives the real
 * absolute path of each, which is what anything that reads or imports the file
 * must use. A symlink needs no such map because the operating system resolves
 * the virtual path; a mount has no link on disk to resolve.
 */

import { readdir, stat, realpath } from 'fs/promises'
import { join, relative, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { importFresh } from './import-fresh.js'

const MOUNT_SUFFIX = '.mount.js'

/**
 * @param {string} dir   — absolute path to walk
 * @param {string} root  — absolute path to relativize results against
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.warn] — where a skipped cycle is reported
 * @param {Map<string, string>} [opts.sources] — filled with virtual path → real
 *        absolute path, for every file reached through a mount
 * @param {Set<string>} [opts.mounts] — filled with every directory a mount names,
 *        for a dev server to watch
 * @returns {Promise<string[]>} — relative file paths, forward-slash separated
 */
export async function walk(dir, root, opts = {}) {
  const warn = opts.warn ?? (msg => console.warn(`[Sierra] ${msg}`))
  const results = []
  const seen = new Set()
  await _walk(dir, root, results, seen, warn, { at: dir, sources: opts.sources ?? new Map(), mounts: opts.mounts ?? new Set() })
  return results.sort()
}

// `at` is where `dir`'s entries appear: `dir` itself, or the mount's virtual
// directory when the walk is inside one.
async function _walk(dir, root, results, seen, warn, where) {
  // Keyed on what the directory IS rather than on what the path SAYS, so two
  // routes to one directory are one visit.
  let real
  try {
    real = await realpath(dir)
  } catch {
    return   // a broken symlink to a directory, or a directory removed mid-walk
  }
  if (seen.has(real)) {
    warn(`routes: ${relative(root, dir).replace(/\\/g, '/')} resolves to a directory already ` +
         `walked (${real}) — skipped, or the scan would not terminate.`)
    return
  }
  seen.add(real)

  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    // Skip dotfiles and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

    const fullPath = join(dir, entry.name)
    const shownPath = join(where.at, entry.name)

    // A symlink is neither a file nor a directory to `readdir` — it is a third
    // kind, and only stat() answers what it points at.
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = (await stat(fullPath)).isDirectory()
      } catch {
        continue   // dangling symlink: not a route, and not an error either
      }
    }

    if (isDir) {
      await _walk(fullPath, root, results, seen, warn, { ...where, at: shownPath })
    } else if (entry.name.endsWith(MOUNT_SUFFIX)) {
      const target = await mountTarget(fullPath, relative(root, shownPath).replace(/\\/g, '/'))
      const at     = join(where.at, entry.name.slice(0, -MOUNT_SUFFIX.length))
      where.mounts.add(target)
      await _walk(target, root, results, seen, warn, { ...where, at })
    } else {
      // Normalize to forward slashes for cross-platform consistency
      const rel = relative(root, shownPath).replace(/\\/g, '/')
      results.push(rel)
      if (shownPath !== fullPath) where.sources.set(rel, fullPath)
    }
  }
}

/**
 * The directory a mount names. Refused by name rather than skipped: a mount that
 * resolves to nothing would otherwise be a section of the app with no routes
 * and no message, which reads as a package that ships no screens.
 */
async function mountTarget(mountFile, shown) {
  let exported
  try {
    exported = (await importFresh(mountFile)).default
  } catch (err) {
    throw new Error(`[Sierra] routes: ${shown} could not be imported — ${err.message}`)
  }
  const path = exported instanceof URL ? fileURLToPath(exported)
    : typeof exported === 'string' && exported.startsWith('file:') ? fileURLToPath(exported)
    : exported
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(
      `[Sierra] routes: ${shown} must default-export the directory it mounts, as a URL or an absolute ` +
      `path — e.g. export { default } from '@frontierjs/orion/routes'. It exported ${JSON.stringify(exported)}.`
    )
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) {
    throw new Error(`[Sierra] routes: ${shown} mounts ${path}, which is not a directory.`)
  }
  return path
}
