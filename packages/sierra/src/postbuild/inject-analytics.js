/**
 * inject-analytics.js — the vendor's analytics tag, on every prerendered page.
 *
 * On an SPA `virtual:sierra` boots `initAnalytics`, which loads the tag after
 * idle. A static page never loads `virtual:sierra`, and a page with no island
 * loads no script at all, so `analytics:` in sierra.config.js did nothing on
 * that target and said nothing (`FJS-2058`). Each prerendered page is a full
 * load, so the vendor's own script counts the pageview; nothing of the router
 * ships with it.
 *
 * Static target only: on an SPA this tag would load beside the runtime's and
 * count every visit twice.
 */

import { readFile, writeFile } from 'fs/promises'
import { relative } from 'path'
import { htmlFiles, placeInHead } from './html-files.js'
// tag.js and not the subpath's index.js: this runs in Node during the build,
// and index.js is the browser runtime.
import { vendorTagHtml } from '../analytics/tag.js'

/**
 * @param {object} analyticsConfig — sierra.config.js `analytics`
 * @param {string} outDir
 * @returns {Promise<string|null>}
 */
export async function injectAnalyticsTag(analyticsConfig, outDir) {
  if (!analyticsConfig?.provider) return null

  const tag     = `  ${vendorTagHtml(analyticsConfig)}`
  const pages   = await htmlFiles(outDir)
  const touched = []

  for (const path of pages) {
    let html
    try { html = await readFile(path, 'utf8') } catch { continue }

    // Re-running a build over an existing output directory must not stack two.
    if (html.includes('id="sierra-analytics"')) continue

    // At the end of the head, so the charset declaration stays inside the
    // first 1024 bytes the parser sniffs. A deferred vendor script loses
    // nothing by coming last.
    const end = /<\/head\s*>/i.exec(html)
    const out = end ? html.slice(0, end.index) + tag + '\n' + html.slice(end.index) : placeInHead(html, tag)
    await writeFile(path, out, 'utf8')
    touched.push(relative(outDir, path))
  }

  if (!touched.length) return null
  return `Analytics (${analyticsConfig.provider}) → ${touched.length} page(s)`
}
