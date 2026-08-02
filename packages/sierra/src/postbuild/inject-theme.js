/**
 * inject-theme.js — inject theme flash-prevention script into index.html
 *
 * The script runs synchronously in <head> before body paint, reading
 * the persisted theme preference and setting the attribute on <html>
 * before any CSS is applied — preventing flash of wrong theme.
 *
 * Only runs when theme config is present in sierra.config.js.
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
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

  const indexPath = join(outDir, 'index.html')

  let html
  try {
    html = await readFile(indexPath, 'utf8')
  } catch {
    return null
  }

  // Don't inject twice
  if (html.includes('sierra-theme')) return null

  const script = `  <script id="sierra-theme">${buildThemeScript(themeConfig)}</script>`

  // Inject as the very first element inside <head> — must run before any CSS
  const injected = html.replace('<head>', `<head>\n${script}`)

  if (injected === html) return null

  await writeFile(indexPath, injected, 'utf8')
  return `Theme flash prevention → index.html (default: ${themeConfig.default ?? 'system'})`
}
