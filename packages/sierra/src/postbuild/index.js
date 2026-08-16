/**
 * src/postbuild/index.js — Sierra post-build pipeline
 *
 * Runs automatically after `vite build` via the Vite closeBundle hook.
 *
 * Always runs:
 *   1. move404       — 404/index.html → 404.html (Cloudflare/Netlify)
 *   2. copyRobots    — public/robots.txt → dist/robots.txt
 *   3. redirects     — generate _redirects from the route table
 *   4. sitemap       — generate sitemap.xml from indexed routes
 *
 * Conditional:
 *   5. llms          — generate llms.txt (if config.llms !== false)
 *   6. speculation   — inject Speculation Rules into index.html
 *   7. deferJS       — defer script tags in index.html
 *   8. plugins       — run user-supplied post-build plugin functions
 */

import { move404 } from './move-404.js'
import { copyRobots } from './copy-robots.js'
import { generateRedirects } from './redirects.js'
import { generateSitemap } from './sitemap.js'
import { generateLlms } from './llms.js'
import { injectSpeculationRules } from './speculation.js'
import { deferJsLoading } from './defer-js.js'
import { injectThemeScript } from './inject-theme.js'
import { generateMarkdownPages } from './markdown-pages.js'

/**
 * Run the full post-build pipeline.
 *
 * @param {object} config   — sierra.config.js config object
 * @param {object} routeTable — parsed config/routes.js (tree, all, indexed, redirects)
 * @param {string} outDir   — absolute path to Vite's build output directory
 * @param {string} root     — absolute path to project root
 */
export async function runPostBuild(config, routeTable, outDir, root) {
  const results = []

  // 1. 404 page
  const r404 = await move404(outDir)
  if (r404) results.push(r404)

  // 2. robots.txt
  const rRobots = await copyRobots(root, outDir)
  if (rRobots) results.push(rRobots)

  // 3. _redirects
  const rRedirects = await generateRedirects(routeTable.redirects ?? [], outDir)
  if (rRedirects) results.push(rRedirects)

  // 4. sitemap.xml
  const siteUrl = config.siteUrl ?? ''
  const rSitemap = await generateSitemap(routeTable.indexed ?? [], outDir, siteUrl)
  if (rSitemap) results.push(rSitemap)

  // 5. llms.txt (conditional)
  if (config.llms !== false) {
    const rLlms = await generateLlms(config, routeTable, outDir, root)
    if (rLlms) results.push(rLlms)
  }

  // 6. Markdown pages (conditional)
  if (config.markdownPages) {
    // Build path→meta map from tree for frontmatter extraction
    const routeMetaMap = {}
    const flattenTree = (node) => {
      if (node.path && node.meta) routeMetaMap[node.path] = node.meta
      for (const child of node.children ?? []) flattenTree(child)
    }
    if (routeTable.tree) flattenTree(routeTable.tree)

    const rMd = await generateMarkdownPages(config, routeTable, outDir, routeMetaMap)
    if (rMd) results.push(rMd)
  }

  // 7. Speculation Rules (conditional — when static routes exist)
  if (config.speculationRules !== false) {
    const staticRoutes = (routeTable.indexed ?? []).filter(
      p => !p.includes(':') && !p.includes('*')
    )
    if (staticRoutes.length > 0) {
      const rSpec = await injectSpeculationRules(staticRoutes, outDir)
      if (rSpec) results.push(rSpec)
    }
  }

  // 8. Defer JS (conditional)
  if (config.build?.deferJS) {
    const rDefer = await deferJsLoading(outDir)
    if (rDefer) results.push(rDefer)
  }

  // 9. Theme flash prevention script (conditional)
  if (config.theme) {
    const rTheme = await injectThemeScript(config.theme, outDir)
    if (rTheme) results.push(rTheme)
  }

  // 10. User plugins
  for (const plugin of config.plugins ?? []) {
    if (typeof plugin.closeBundle === 'function') {
      await plugin.closeBundle({ outDir, root, config, routeTable })
    }
  }

  return results
}
