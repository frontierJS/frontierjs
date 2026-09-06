/**
 * html-files.js — every page a build emitted.
 *
 * Three steps in this pipeline rewrite HTML, and each one used to name
 * `index.html`. That is the whole output of an SPA and one page out of N on a
 * static target, where a build emits one HTML file per route — so the theme
 * script reached the home page and every other page flashed, which reads as an
 * intermittent bug rather than a missing file (`FJS-501`).
 *
 * The fix was applied to `inject-theme.js` and to neither of the two steps
 * beside it in the same function (`FJS-822`). The walk lives here so the class
 * is retired rather than the third instance: a step that rewrites pages asks
 * this what the pages are.
 */

import { readdir } from 'fs/promises'
import { join } from 'path'

/**
 * Every `.html` under `dir`, at any depth.
 *
 * `assets/` holds hashed bundles and no pages; `node_modules` cannot be output
 * and is skipped because a build run against a source tree by mistake would
 * otherwise walk it.
 *
 * @param {string} dir
 * @returns {Promise<string[]>} absolute paths
 */
export async function htmlFiles(dir) {
  const out = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'assets' || e.name === 'node_modules') continue
      out.push(...await htmlFiles(full))
    } else if (e.name.endsWith('.html')) {
      out.push(full)
    }
  }
  return out
}
