// check/rules/crawl.js — what crawlers are told: robots.txt, _redirects, the
// sitemap, canonicals.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, norm, PUBLIC, TRAILING_SLASH } from '../context.js'
import { finding, plural } from '../finding.js'

const GROUP = 'Crawling'
// NOTE: Vite copies the site's robots.txt into the build, and Sierra writes one only when there is none
const ROBOTS = `${PUBLIC}/robots.txt`

const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return null
  }
}

/* ── robots.txt ──────────────────────────────────────────────────────────── */

function robots(ctx) {
  const rel = [ROBOTS, `${DIST}/robots.txt`].find((f) => existsSync(join(ctx.root, f)))
  if (!rel) return []
  const out = []
  const lines = readFileSync(join(ctx.root, rel), 'utf8').split('\n')
  const at = (i) => ({ file: rel, line: i + 1 })
  const want = `${ctx.base}/sitemap.xml`

  const sitemaps = lines.map((l, i) => [l.match(/^\s*sitemap:\s*(\S+)/i)?.[1], i]).filter(([u]) => u)
  if (!sitemaps.length) out.push(finding('warn', 'robots-no-sitemap', `robots.txt has no Sitemap line. Add \`Sitemap: ${want}\`.`, { where: [at(0)] }))
  for (const [url, i] of sitemaps) {
    if (!/^https?:\/\//.test(url))
      out.push(finding('warn', 'robots-sitemap-relative', `Sitemap: ${url} is relative, and crawlers ignore a relative Sitemap line. Use ${want}.`, { where: [at(i)] }))
    else if (ctx.base && hostOf(url) !== hostOf(ctx.base))
      out.push(finding('error', 'robots-sitemap-host', `Sitemap: ${url} points at another site; siteUrl is ${ctx.base}. Use ${want}.`, { where: [at(i)] }))
  }

  // NOTE: Only the `User-agent: *` group decides what everyone may crawl
  let star = false
  lines.forEach((l, i) => {
    const ua = l.match(/^\s*user-agent:\s*(\S+)/i)
    if (ua) star = ua[1] === '*'
    else if (star && /^\s*disallow:\s*\/\s*$/i.test(l))
      out.push(finding('warn', 'robots-blocks-site', '`Disallow: /` under `User-agent: *` blocks the whole site from search.', { where: [at(i)] }))
  })
  return out
}

/* ── redirects ───────────────────────────────────────────────────────────────
 *
 * Sierra writes the build's _redirects: each page's `redirect: /to/` front-matter
 * first, then content/settings/_redirects, the client's campaign links, which
 * site-kit emits (FJS-D961). A redirect page builds no page.
 */

const REDIRECTS = 'content/settings/_redirects'

/** Every redirect the site declares: [{ from, to, status?, at }]. */
export function redirectRules(ctx) {
  const fromPages = ctx.content
    .filter((c) => c.redirectFrom)
    .map((c) => ({ from: c.redirectFrom, to: String(c.attrs.redirect), at: { file: c.rel, line: 1 } }))
  const file = join(ctx.root, REDIRECTS)
  const fromFile = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .map((l, i) => [l.replace(/#.*/, '').trim().split(/\s+/), i])
        .filter(([parts]) => parts[0])
        .map(([[from, to, status], i]) => ({ from, to, status, at: { file: REDIRECTS, line: i + 1 } }))
    : []
  return { fromPages, fromFile }
}

function redirects(ctx) {
  const { fromPages, fromFile } = redirectRules(ctx)
  const out = []
  const rules = [...fromPages, ...fromFile]
  const froms = new Map(rules.map((r) => [norm(r.from), r]))
  // A redirect may point at a file rather than a page (an old WordPress logo URL
  // → /media/images/logo.svg): public/ is served from the root.
  const isFile = (f) => existsSync(f) && statSync(f).isFile()
  const pageExists = (p) =>
    ctx.byRoute.has(norm(p)) ||
    isFile(join(ctx.root, PUBLIC, p)) ||
    (ctx.html?.source === 'dist' && ['', 'index.html', '.html'].some((s) => existsSync(join(ctx.html.dist, p + s))))

  for (const { from, to, status, at } of rules) {
    if (!to) {
      out.push(finding('error', 'redirect-malformed', `"${from}" has no target.`, { where: [at] }))
      continue
    }
    if (status && !/^(200|301|302|303|307|308)!?$/.test(status))
      out.push(finding('warn', 'redirect-status', `Status ${status} isn't a redirect code. Use 301 for a permanent move.`, { where: [at] }))
    if (from.includes('*') || from.includes(':')) continue
    if (ctx.byRoute.has(norm(from)))
      out.push(finding('warn', 'redirect-shadows-page', `${from} redirects away, but content/routes still has a page there, which nobody can reach.`, { where: [at] }))
    if (!to.startsWith('/') || to.includes('*') || to.includes(':')) continue
    const next = froms.get(norm(to))
    if (next)
      out.push(finding('warn', 'redirect-chain', `${from} → ${to} → another redirect (${next.at.file}:${next.at.line}). Point it at the final URL.`, { where: [at] }))
    else if (!pageExists(to.split(/[?#]/)[0]))
      out.push(finding('error', 'redirect-target-missing', `${from} redirects to ${to}, which isn't a page.`, { where: [at] }))
  }
  return out
}

/* ── sitemap ─────────────────────────────────────────────────────────────── */

function sitemap(ctx) {
  const { html } = ctx
  if (!html.sitemap) return [finding('error', 'sitemap-missing', 'The build has no sitemap.xml.')]
  const out = []
  const byPath = new Map(html.pages.map((p) => [norm(p.path), p]))
  const slash = TRAILING_SLASH
  /** @type {Record<string, string[]>} */
  const bad = { host: [], missing: [], noindex: [], slash: [] }
  for (const loc of html.sitemap) {
    let path
    try {
      path = new URL(loc).pathname
    } catch {
      bad.host.push(loc)
      continue
    }
    if (ctx.base && hostOf(loc) !== hostOf(ctx.base)) bad.host.push(loc)
    if (path !== '/' && path.endsWith('/') !== slash) bad.slash.push(path)
    const page = byPath.get(norm(path))
    if (!page) bad.missing.push(path)
    else if (page.noindex) bad.noindex.push(path)
  }
  if (bad.host.length) out.push(finding('error', 'sitemap-host', `Sitemap URLs not on ${ctx.base}: ${bad.host.length}.`, { pages: bad.host }))
  if (bad.missing.length) out.push(finding('error', 'sitemap-page-missing', `The sitemap lists ${plural(bad.missing.length, 'page')} the build doesn't have.`, { pages: bad.missing }))
  if (bad.noindex.length) out.push(finding('error', 'sitemap-noindex', `The sitemap lists ${plural(bad.noindex.length, 'page')} marked noindex. Search engines get contradictory instructions.`, { pages: bad.noindex }))
  if (bad.slash.length) out.push(finding('warn', 'sitemap-trailing-slash', `Sitemap URLs that don't end the way the build's routes do (trailing slash: ${slash}), so each one redirects: ${bad.slash.length}.`, { pages: bad.slash }))
  return out
}

/* ── canonical ───────────────────────────────────────────────────────────── */

function canonical(ctx) {
  const out = []
  /** @type {Record<string, string[]>} */
  const bad = { missing: [], many: [], relative: [], host: [], other: [] }
  for (const p of ctx.html.pages) {
    if (p.path === '/404.html' || p.noindex) continue
    const [href, ...rest] = p.canonicals
    if (!href) bad.missing.push(p.path)
    else if (rest.length) bad.many.push(p.path)
    else if (!/^https?:\/\//.test(href)) bad.relative.push(p.path)
    else if (ctx.base && hostOf(href) !== hostOf(ctx.base)) bad.host.push(`${p.path} → ${href}`)
    else if (norm(new URL(href).pathname) !== norm(p.path)) bad.other.push(`${p.path} → ${new URL(href).pathname}`)
  }
  if (bad.missing.length) out.push(finding('warn', 'canonical-missing', `Pages with no canonical link: ${bad.missing.length}.`, { pages: bad.missing }))
  if (bad.many.length) out.push(finding('error', 'canonical-multiple', `Pages declaring more than one canonical, so search engines ignore them all: ${bad.many.length}.`, { pages: bad.many }))
  if (bad.relative.length) out.push(finding('error', 'canonical-relative', `Pages with a relative canonical: ${bad.relative.length}.`, { pages: bad.relative }))
  if (bad.host.length) out.push(finding('error', 'canonical-host', `Canonicals pointing at a host other than ${ctx.base}: ${bad.host.length}.`, { pages: bad.host }))
  if (bad.other.length) out.push(finding('info', 'canonical-other-page', `Pages whose canonical is a different page: ${bad.other.length}. Fine for a duplicate; wrong for a page that should rank.`, { pages: bad.other }))

  const notFound = ctx.html.pages.find((p) => p.path === '/404.html')
  if (notFound?.canonicals.length)
    out.push(finding('warn', '404-canonical', `The 404 page declares canonical ${notFound.canonicals[0]}. A not-found page shouldn't claim a URL.`, { pages: ['/404.html'] }))
  return out
}

export default [
  { id: 'robots', group: GROUP, stage: 'source', run: robots },
  { id: 'redirects', group: GROUP, stage: 'source', run: redirects },
  { id: 'sitemap', group: GROUP, stage: 'built', run: sitemap },
  { id: 'canonical', group: GROUP, stage: 'built', run: canonical }
]
