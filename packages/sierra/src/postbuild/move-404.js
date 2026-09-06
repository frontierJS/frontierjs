/**
 * move-404.js — Move 404/index.html → 404.html
 *
 * Vite generates a 404 page at dist/client/404/index.html when a
 * catch-all route exists. Cloudflare Pages and Netlify expect 404.html
 * at the root of the output directory.
 */

import { rename, access, rmdir } from 'fs/promises'
import { join } from 'path'

/**
 * The URL this page stops being reachable at.
 *
 * Exported so `runPostBuild` can drop it from the site's page list rather than
 * naming the string twice: the rename below takes the only file out of `404/`,
 * so `/404/` is not a page afterwards and a sitemap listing it advertises a URL
 * that answers 404 — a slightly worse thing than indexing a not-found page, and
 * what the build actually shipped.
 */
export const NOT_FOUND_URL = '/404/'

/**
 * @param {string} outDir — absolute path to Vite build output
 * @returns {Promise<string|null>} — result message, or null if nothing to do
 */
export async function move404(outDir) {
  const src  = join(outDir, '404', 'index.html')
  const dest = join(outDir, '404.html')

  // Check if source exists
  try {
    await access(src)
  } catch {
    return null  // no 404/index.html — nothing to do
  }

  await rename(src, dest)

  // The rename leaves `404/` behind, empty. Harmless on a host that answers 404
  // for it and a directory listing on one that does not, which is the whole of
  // why it goes: an empty directory in a published site is a URL nobody meant
  // to publish. Failure is ignored — a non-empty directory is somebody else's
  // file and not this step's to delete.
  await rmdir(join(outDir, '404')).catch(() => {})

  return '404.html ← 404/index.html'
}
