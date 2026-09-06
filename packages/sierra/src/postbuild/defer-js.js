/**
 * defer-js.js — Add defer attribute to script tags on every page.
 *
 * When build.deferJS: true in sierra.config.js, Sierra adds `defer`
 * to all non-module script tags that don't already have it. Module scripts
 * are already deferred by default.
 *
 * This is a simple post-build pass — it doesn't reorder or
 * otherwise modify the scripts.
 *
 * It named `index.html`, which is the whole output of an SPA and one page out
 * of N on a static target — `FJS-501` one file along from where that was fixed
 * (`FJS-822`). The pages come from `html-files.js`, which the other two
 * HTML-rewriting steps in this pipeline also ask.
 */

import { readFile, writeFile } from 'fs/promises'
import { relative } from 'path'
import { htmlFiles } from './html-files.js'

/** Add `defer` to one document's eligible script tags. */
function deferScripts(html) {
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
  return { result, count }
}

/**
 * @param {string} outDir
 * @returns {Promise<string|null>}
 */
export async function deferJsLoading(outDir) {
  const pages = await htmlFiles(outDir)
  let total = 0
  const touched = []

  for (const path of pages) {
    let html
    try { html = await readFile(path, 'utf8') } catch { continue }

    const { result, count } = deferScripts(html)
    if (count === 0) continue

    await writeFile(path, result, 'utf8')
    total += count
    touched.push(relative(outDir, path))
  }

  if (total === 0) return null

  const where = touched.length === 1 ? touched[0] : `${touched.length} pages`
  return `Deferred ${total} script tag${total === 1 ? '' : 's'} in ${where}`
}
