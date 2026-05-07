/**
 * walk.js — recursive directory walker
 *
 * Returns a flat list of all file paths under a directory,
 * relative to the given root. Ignores node_modules and dotfiles.
 */

import { readdir } from 'fs/promises'
import { join, relative } from 'path'

/**
 * @param {string} dir   — absolute path to walk
 * @param {string} root  — absolute path to relativize results against
 * @returns {Promise<string[]>} — relative file paths, forward-slash separated
 */
export async function walk(dir, root) {
  const results = []
  await _walk(dir, root, results)
  return results.sort()
}

async function _walk(dir, root, results) {
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    // Skip dotfiles and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      await _walk(fullPath, root, results)
    } else {
      // Normalize to forward slashes for cross-platform consistency
      const rel = relative(root, fullPath).replace(/\\/g, '/')
      results.push(rel)
    }
  }
}
