// config/search.js — the site's search index, written at build (FJS-D2188).
//
// `dist/search.json` is a list of `{ url, title, headings, text }`, one per built
// page, read from the pages themselves because that is where a route's Markdown,
// its blocks and a collection it lists have all become words. Static: no server
// answers a query, the visitor's browser ranks it (`src/site/search.js`).
//
// A page names its address without the site's `base`; the browser adds it, so
// one file serves a site mounted at `/` and a preview under a path.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { htmlFiles } from '@frontierjs/sierra/postbuild'

// A page's words, capped. The file is fetched whole on first open, so one long
// page must not make every visitor's search slow to start.
export const TEXT_LIMIT = 8000

// What a visitor does not search for: page chrome, and code that is not words.
const CHROME = 'script, style, noscript, template, nav, header, footer, [aria-hidden="true"]'

/** `/about/index.html` is `/about/`, `/about.html` is `/about`, `index.html` is `/`. */
export function urlOf(file, outDir) {
  const rel = relative(outDir, file).split(sep).join('/')
  if (rel === 'index.html') return '/'
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`
  return `/${rel.slice(0, -'.html'.length)}`
}

/**
 * One page as an index entry, or null for a page a visitor should not find: a
 * 404, or one that asks robots not to index it.
 *
 * @param {string} html
 * @param {string} url
 * @param {InstanceType<typeof import('happy-dom').DOMParser>} parser
 */
export function entryOf(html, url, parser) {
  const doc = parser.parseFromString(html, 'text/html')
  const robots = doc.querySelector('meta[name="robots" i]')?.getAttribute('content') ?? ''
  if (/noindex/i.test(robots)) return null

  const title = (doc.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const root = doc.querySelector('main') ?? doc.body
  if (!root) return null

  // Headings first: the chrome strip below would take a heading inside a
  // `<header>` the page opens its article with.
  const headings = [...root.querySelectorAll('h2, h3, h4')]
    .filter((h) => h.id && !h.closest('.ignore-toc'))
    .map((h) => ({ id: h.id, text: h.textContent.replace(/\s+/g, ' ').trim(), level: Number(h.tagName[1]) }))
    .filter((h) => h.text)

  for (const el of [...root.querySelectorAll(CHROME)]) el.remove()
  const text = root.textContent.replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT)

  return { url, title, headings, text }
}

/**
 * Every indexable page under outDir, in address order.
 *
 * @param {string} outDir
 */
export async function buildSearchIndex(outDir) {
  const { Window } = await import('happy-dom')
  // A built page names stylesheets and scripts; none of them is read here, and
  // happy-dom's parser would otherwise request each (FJS-2842 reads the same way).
  const win = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true } })
  const parser = new win.DOMParser()
  const pages = []
  try {
    for (const file of (await htmlFiles(outDir)).sort()) {
      if (relative(outDir, file) === '404.html') continue
      const page = entryOf(await readFile(file, 'utf8'), urlOf(file, outDir), parser)
      if (page) pages.push(page)
    }
  } finally {
    await win.happyDOM.close()
  }
  return pages
}

/**
 * The Sierra config plugin. Sierra calls a config plugin's closeBundle once the
 * pages are written, so the index is read after the dialect check and a
 * preset's steps have rewritten them. It sits ahead of `siteImages()`, which
 * stays last: the index holds words, never an `<img>`.
 */
export function siteSearch() {
  return {
    name: 'site-kit:search',
    async closeBundle({ outDir }) {
      const pages = await buildSearchIndex(outDir)
      await mkdir(outDir, { recursive: true })
      await writeFile(join(outDir, 'search.json'), JSON.stringify(pages))
      console.log(`    ✓ search → ${pages.length} pages`)
    },
  }
}
