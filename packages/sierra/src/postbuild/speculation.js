/**
 * speculation.js — Inject Speculation Rules into index.html
 *
 * Speculation Rules API enables near-instant navigation by pre-rendering
 * pages in a background browsing context. Falls back gracefully in
 * unsupported browsers.
 *
 * Only static (non-dynamic) routes are included — dynamic routes
 * like /leads/:leadId/ cannot be speculatively prefetched without a list.
 *
 * Sierra auto-injects these rules for SPA builds when static routes exist.
 * Disable with: speculationRules: false in sierra.config.js
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * @param {string[]} staticRoutes — non-dynamic indexed route paths
 * @param {string}   outDir
 * @returns {Promise<string|null>}
 */
export async function injectSpeculationRules(staticRoutes, outDir) {
  const indexPath = join(outDir, 'index.html')

  let html
  try {
    html = await readFile(indexPath, 'utf8')
  } catch {
    return null  // no index.html — nothing to inject into
  }

  // Don't inject if already present
  if (html.includes('speculationrules')) return null

  const rules = {
    prerender: [
      {
        source: 'list',
        urls: staticRoutes,
      },
    ],
  }

  const script = [
    `  <script type="speculationrules">`,
    `    ${JSON.stringify(rules, null, 4).split('\n').join('\n    ')}`,
    `  </script>`,
  ].join('\n')

  // Inject before </head>
  const injected = html.replace('</head>', `${script}\n</head>`)

  if (injected === html) return null  // </head> not found — skip

  await writeFile(indexPath, injected, 'utf8')
  return `Speculation Rules → index.html (${staticRoutes.length} route${staticRoutes.length === 1 ? '' : 's'})`
}
