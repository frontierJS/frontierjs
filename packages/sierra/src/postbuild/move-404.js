/**
 * move-404.js — Move 404/index.html → 404.html
 *
 * Vite generates a 404 page at dist/client/404/index.html when a
 * catch-all route exists. Cloudflare Pages and Netlify expect 404.html
 * at the root of the output directory.
 */

import { rename, access } from 'fs/promises'
import { join } from 'path'

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
  return '404.html ← 404/index.html'
}
