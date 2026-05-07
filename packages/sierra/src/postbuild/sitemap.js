/**
 * sitemap.js — Generate sitemap.xml from indexed routes
 *
 * Uses manifest.indexed — already filtered to exclude:
 *   - draft routes (status: draft)
 *   - noindex routes (robots: noindex)
 *   - dynamic routes (/:param/)
 *
 * Each <url> includes lastmod (today's date) and a default changefreq.
 * Per-route priority and changefreq can be set in frontmatter:
 *   sitemap:
 *     priority: 0.8
 *     changefreq: weekly
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'

/**
 * @param {string[]} indexed   — indexed route paths from manifest
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
      `    <loc>${base}${path}</loc>`,
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
