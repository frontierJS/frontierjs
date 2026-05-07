/**
 * defer-js.js — Add defer attribute to script tags in index.html
 *
 * When build.deferJS: true in sierra.config.js, Sierra adds `defer`
 * to all non-module script tags in index.html that don't already have
 * it. Module scripts are already deferred by default.
 *
 * This is a simple post-build pass — it doesn't reorder or
 * otherwise modify the scripts.
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * @param {string} outDir
 * @returns {Promise<string|null>}
 */
export async function deferJsLoading(outDir) {
  const indexPath = join(outDir, 'index.html')

  let html
  try {
    html = await readFile(indexPath, 'utf8')
  } catch {
    return null
  }

  // Add defer to <script src="..."> tags that don't have type="module",
  // async, or defer already
  let count = 0
  const result = html.replace(
    /<script\b([^>]*)>/gi,
    (match, attrs) => {
      // Skip inline scripts (no src), module scripts, already-deferred
      if (!/\bsrc\b/i.test(attrs)) return match
      if (/\btype\s*=\s*["']module["']/i.test(attrs)) return match
      if (/\bdefer\b/i.test(attrs)) return match
      if (/\basync\b/i.test(attrs)) return match

      count++
      return `<script${attrs} defer>`
    }
  )

  if (count === 0) return null

  await writeFile(indexPath, result, 'utf8')
  return `Deferred ${count} script tag${count === 1 ? '' : 's'} in index.html`
}
