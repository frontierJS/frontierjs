/**
 * speculation.js — Inject Speculation Rules into every page.
 *
 * Speculation Rules API enables near-instant navigation by pre-rendering
 * pages in a background browsing context. Falls back gracefully in
 * unsupported browsers.
 *
 * Only static (non-dynamic) routes are included — dynamic routes
 * like /leads/:leadId/ cannot be speculatively prefetched without a list.
 *
 * ── Why it walks, and does not name a file ────────────────────────────────
 *
 * This wrote `join(outDir, 'index.html')` and nothing else, which is `FJS-501`
 * one file along from where that was fixed (`FJS-822`) — and here it defeats
 * the feature rather than degrading it: speculation rules exist to make the
 * SECOND navigation instant, so the only page carrying them was the one a
 * reader arrives on and no page reached by a link had them at all.
 *
 * Disable with: speculationRules: false in sierra.config.js
 */

import { readFile, writeFile } from 'fs/promises'
import { relative } from 'path'
import { htmlFiles } from './html-files.js'

/**
 * @param {string[]} staticRoutes — non-dynamic indexed route paths
 * @param {string}   outDir
 * @returns {Promise<string|null>}
 */
export async function injectSpeculationRules(staticRoutes, outDir) {
  const rules = {
    prerender: [
      {
        source: 'list',
        urls: staticRoutes,
      },
    ],
  }

  // `<` escaped out of the JSON: a route path containing `</script` would
  // otherwise close the block from inside a string the browser never parses.
  // The same URLs are XML-escaped for the sitemap, and for the same reason.
  const json = JSON.stringify(rules, null, 4).replace(/</g, '\\u003c')

  const script = [
    `  <script type="speculationrules">`,
    `    ${json.split('\n').join('\n    ')}`,
    `  </script>`,
  ].join('\n')

  const pages   = await htmlFiles(outDir)
  const touched = []

  for (const path of pages) {
    let html
    try { html = await readFile(path, 'utf8') } catch { continue }

    // Re-running a build over an existing output directory must not stack two.
    if (html.includes('speculationrules')) continue

    const injected = html.replace('</head>', `${script}\n</head>`)
    if (injected === html) continue   // </head> not found — skip

    await writeFile(path, injected, 'utf8')
    touched.push(relative(outDir, path))
  }

  if (!touched.length) return null

  // Named rather than counted where there is one, because an SPA has exactly
  // one page and "1 page(s)" reads like something was missed.
  const where = touched.length === 1 ? touched[0] : `${touched.length} pages`
  return `Speculation Rules → ${where} (${staticRoutes.length} route${staticRoutes.length === 1 ? '' : 's'})`
}
