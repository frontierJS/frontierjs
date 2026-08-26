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
 * @param {string[]|null} [prerenderedUrls] — on a static target, the URLs the
 *   prerenderer actually emitted. Null on an SPA.
 */
export async function runPostBuild(config, routeTable, outDir, root, prerenderedUrls = null) {
  const results = []

  // What this site's pages ARE, for the steps that have to enumerate them.
  //
  // `routeTable.indexed` is the right answer for an SPA and the wrong one for a
  // static build: it drops every dynamic route, because an SPA cannot know
  // which URLs `/products/:slug/` stands for. A static build does know — the
  // pages are on disk, `getStaticPaths()` named them — so it hands over what it
  // emitted. Before this, a prerendered storefront's sitemap listed four URLs
  // for a thirteen-product catalogue and nothing said so (`FJS-502`).
  //
  // A prerendered page can still opt out: `indexed` has already dropped drafts
  // and `robots: noindex`, so anything the route table excluded is excluded
  // here too.
  const indexed = prerenderedUrls?.length
    ? prerenderedUrls.filter((u) => isIndexable(u, routeTable))
    : (routeTable.indexed ?? [])

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
  const rSitemap = await generateSitemap(indexed, outDir, siteUrl)
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
    // Same reason as the sitemap: on a static target the pages a dynamic route
    // produced are real URLs and belong here. The `:`/`*` filter still applies
    // — a prerendered URL is concrete by construction, so it removes nothing
    // there, and on an SPA it is doing the work it always did (`FJS-502`).
    const staticRoutes = indexed.filter(
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

/**
 * Is this emitted URL one the route table wanted indexed?
 *
 * A static page's URL is concrete (`/products/explorer-tee/`) while the entry
 * it came from is a pattern (`/products/:slug/`), so a set lookup misses every
 * page a dynamic route produced. `indexable` is the draft/noindex decision with
 * the dynamic exclusion left off, which is the list to ask.
 *
 * A URL matching nothing is KEPT: it was prerendered, so it exists, and a
 * pattern this cannot match is a gap in the matcher rather than a page somebody
 * asked to hide.
 */
function isIndexable(url, routeTable) {
  const ok = routeTable.indexable ?? routeTable.indexed ?? []
  if (!ok.length) return true
  if (ok.includes(url)) return true

  const known = (routeTable.all ?? []).some((p) => p === url || matchesPattern(url, p))
  if (!known) return true

  return ok.some((p) => p.includes(':') && matchesPattern(url, p))
}

/** `/products/explorer-tee/` against `/products/:slug/`, segment by segment. */
function matchesPattern(url, pattern) {
  const u = url.split('/').filter(Boolean)
  const p = pattern.split('/').filter(Boolean)
  if (u.length !== p.length) return false
  return p.every((seg, i) => seg.startsWith(':') || seg === u[i])
}
