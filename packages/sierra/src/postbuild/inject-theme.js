/**
 * inject-theme.js — the theme flash-prevention script, on every page.
 *
 * The script runs synchronously in <head>, before any CSS is applied: it reads
 * the persisted preference and puts the theme class on <html>. Without it the
 * page paints in the app's default and then jumps.
 *
 * ── Why it walks, and does not name a file ────────────────────────────────
 *
 * This used to write `join(outDir, 'index.html')` and nothing else, which is
 * the whole output of an SPA and one page out of N on a static target — where
 * a build emits one HTML file per route. So a prerendered site got the script
 * on its home page and every other page flashed, which reads as an intermittent
 * bug rather than a missing file (`FJS-501`). The number of pages is not
 * something this step can know in advance, so it asks the directory — through
 * `html-files.js`, which the two steps beside it in the pipeline also ask.
 *
 * Only runs when theme config is present in sierra.config.js.
 */

import { readFile, writeFile } from 'fs/promises'
import { relative } from 'path'
import { htmlFiles } from './html-files.js'
// From theme/script.js, not theme/index.js: this runs in Node during the
// build, and theme/index.js pulls in the client signal runtime.
import { buildThemeScript } from '../theme/script.js'

/**
 * @param {object} themeConfig — sierra.config.js theme object
 * @param {string} outDir
 * @returns {Promise<string|null>}
 */
export async function injectThemeScript(themeConfig, outDir) {
  if (!themeConfig) return null

  // Built once: the script is the same on every page, and it is derived from
  // the config rather than from anything about the page it lands on.
  const script = `  <script id="sierra-theme">${buildThemeScript(themeConfig)}</script>`

  const pages   = await htmlFiles(outDir)
  const touched = []

  for (const path of pages) {
    let html
    try { html = await readFile(path, 'utf8') } catch { continue }

    // Re-running a build over an existing output directory must not stack two.
    if (html.includes('sierra-theme')) continue

    // First element inside <head> — it has to run before any stylesheet.
    const injected = html.replace('<head>', `<head>\n${script}`)
    if (injected === html) continue

    await writeFile(path, injected, 'utf8')
    touched.push(relative(outDir, path))
  }

  if (!touched.length) return null

  // Named rather than counted where there is one, because an SPA has exactly
  // one page and "1 page(s)" reads like something was missed.
  const where = touched.length === 1 ? touched[0] : `${touched.length} pages`
  return `Theme flash prevention → ${where} (default: ${themeConfig.default ?? 'system'})`
}
