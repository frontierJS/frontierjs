/**
 * speculation.js — Inject Speculation Rules into every page of a static build.
 *
 * A link the reader hovers (~200ms on desktop, pointerdown on touch) is
 * prerendered in a background browsing context, so the click lands on a page
 * that is already painted. Unsupported browsers ignore the block.
 *
 * ── Why a document rule, and not a list of routes ─────────────────────────
 *
 * This shipped every static route as a `source: 'list'` rule with no
 * eagerness, which means `immediate`: each page load prerendered the first
 * ten routes whether the reader went near them or not, and a dynamic route's
 * pages were never in the list at all. A document rule matches the links that
 * are actually on the page, and `moderate` spends the prerender only on the
 * one the reader is reaching for.
 *
 * `rel="nofollow"` opts a link out — the convention the web already has for
 * a link nothing should visit on the reader's behalf.
 *
 * ── Why a static build only ───────────────────────────────────────────────
 *
 * An SPA's router intercepts the click and renders client-side, so a
 * prerendered document is never navigated to; its hover prefetch is the
 * router's `prefetch="hover"`.
 *
 * ── Why it walks, and does not name a file ────────────────────────────────
 *
 * Speculation rules make the SECOND navigation instant, so a rule only on
 * `index.html` is on the one page a reader arrives on and on no page reached
 * by a link (`FJS-822`).
 *
 * Disable with: speculationRules: false in sierra.config.js
 */

import { readFile, writeFile } from 'fs/promises'
import { relative } from 'path'
import { htmlFiles } from './html-files.js'

export const SPECULATION_RULES = {
  prerender: [
    {
      source: 'document',
      where: {
        and: [
          { href_matches: '/*' },
          { not: { selector_matches: '[rel~=nofollow]' } },
        ],
      },
      eagerness: 'moderate',
    },
  ],
}

/**
 * @param {string} outDir
 * @returns {Promise<string|null>}
 */
export async function injectSpeculationRules(outDir) {
  const json = JSON.stringify(SPECULATION_RULES, null, 4)

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

  // Named rather than counted where there is one, because "1 page(s)" reads
  // like something was missed.
  const where = touched.length === 1 ? touched[0] : `${touched.length} pages`
  return `Speculation Rules → ${where} (prerender on hover)`
}
