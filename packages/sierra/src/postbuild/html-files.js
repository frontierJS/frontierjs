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

/**
 * Put a script where the parser reads it as head content, ahead of every
 * stylesheet.
 *
 * `<head>` is optional in HTML and both apps in this repo leave it out, so
 * anchoring on the literal tag alone injected nothing into either and every
 * reader on a non-default theme saw the default first — with a build that
 * reported nothing wrong. Without the tag, after the charset declaration keeps
 * that within the first 1024 bytes where the parser looks for it.
 */
export function placeInHead(html, script) {
  for (const anchor of [/<head\b[^>]*>/i, /<meta\s+charset\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\s+html\s*>/i]) {
    const m = anchor.exec(html)
    if (m) return html.slice(0, m.index + m[0].length) + '\n' + script + html.slice(m.index + m[0].length)
  }
  return script + '\n' + html
}
