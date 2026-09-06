/**
 * sitemap.js — Generate sitemap.xml from indexed routes
 *
 * Uses the route table's `indexed` — already filtered to exclude:
 *   - draft routes (status: draft)
 *   - noindex routes (robots: noindex)
 *   - dynamic routes (/:param/)
 *
 * Each <url> includes lastmod (today's date) and a default changefreq.
 * Per-route priority and changefreq can be set in frontmatter:
 *   sitemap:
 *     priority: 0.8
 *     changefreq: weekly
 *
 * ── Two encoders, and they are not the same one ───────────────────────────
 *
 * A prerendered URL comes from a `getStaticPaths()` param, so a slug decides
 * what reaches this file. `tools-&-hardware` is not a hostile string, and a
 * sitemap containing a raw `&` is not a partly-wrong sitemap — it is not XML,
 * so a crawler rejects the whole file and every URL in it (`FJS-822`).
 *
 *   • The PATH is percent-encoded per segment, because `<loc>` must be a valid
 *     URL and a space or a `<` is not one.
 *   • The RESULT is XML-escaped, because `&` is legal in a URL path and is not
 *     legal as itself in XML text.
 *
 * Doing either alone leaves a file a crawler refuses.
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'

/** XML text escaping. `<loc>` is text content, not an attribute. */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Percent-encode a URL path, segment by segment.
 *
 * Per segment rather than `encodeURI` over the whole thing: `encodeURI` leaves
 * `%` alone, so a slug containing one emits an invalid escape, and it leaves a
 * `/` inside a segment alone, which would change what the URL points at.
 */
function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/')
}

/**
 * @param {string[]} indexed   — indexed route paths from the route table
 * @param {string}   outDir
 * @param {string}   [siteUrl] — base URL e.g. 'https://example.com'
 * @param {object}   [routeMeta] — optional route id → meta map for per-route settings
 * @returns {Promise<string>}
 */
export async function generateSitemap(indexed, outDir, siteUrl = '', routeMeta = {}) {
  const today = new Date().toISOString().split('T')[0]
  const base = siteUrl.replace(/\/$/, '')

  const urls = indexed.map(path => {
    const meta = routeMeta[path] ?? {}
    const priority   = meta.sitemap?.priority   ?? defaultPriority(path)
    const changefreq = meta.sitemap?.changefreq ?? defaultChangefreq(path)

    return [
      `  <url>`,
      `    <loc>${xmlEscape(base + encodePath(path))}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      `    <changefreq>${changefreq}</changefreq>`,
      `    <priority>${priority}</priority>`,
      `  </url>`,
    ].join('\n')
  })

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...urls,
    `</urlset>`,
    ``,
  ].join('\n')

  await writeFile(join(outDir, 'sitemap.xml'), xml, 'utf8')
  return `sitemap.xml (${indexed.length} URL${indexed.length === 1 ? '' : 's'})`
}

/**
 * Heuristic default priority based on path depth.
 * Home page = 1.0, top-level = 0.8, deeper = 0.6, very deep = 0.4
 */
function defaultPriority(path) {
  if (path === '/') return '1.0'
  const depth = path.split('/').filter(Boolean).length
  if (depth === 1) return '0.8'
  if (depth === 2) return '0.6'
  return '0.4'
}

/**
 * Heuristic default changefreq based on path depth.
 */
function defaultChangefreq(path) {
  if (path === '/') return 'daily'
  const depth = path.split('/').filter(Boolean).length
  return depth === 1 ? 'weekly' : 'monthly'
}
