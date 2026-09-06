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
 */

import { readdir, stat, realpath } from 'fs/promises'
import { join, relative } from 'path'

/**
 * @param {string} dir   — absolute path to walk
 * @param {string} root  — absolute path to relativize results against
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.warn] — where a skipped cycle is reported
 * @returns {Promise<string[]>} — relative file paths, forward-slash separated
 */
export async function walk(dir, root, opts = {}) {
  const warn = opts.warn ?? (msg => console.warn(`[Sierra] ${msg}`))
  const results = []
  const seen = new Set()
  await _walk(dir, root, results, seen, warn)
  return results.sort()
}

async function _walk(dir, root, results, seen, warn) {
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
      await _walk(fullPath, root, results, seen, warn)
    } else {
      // Normalize to forward slashes for cross-platform consistency
      const rel = relative(root, fullPath).replace(/\\/g, '/')
      results.push(rel)
    }
  }
}
