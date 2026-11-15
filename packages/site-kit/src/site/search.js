// src/site/search.js — what the visitor's palette asks of `dist/search.json`.
//
// The index is fetched once, on first open: a page that never opens search
// never pays for it. `pages` are the palette's items to rank by title and
// address (`rank()` runs inside CommandPalette); `results(query)` is the other
// half, whole-word matches in a page's headings and words with an excerpt. The
// two are separate because a fuzzy run of letters through a page's whole text
// matches almost anything (FJS-D2188).

const MAX_RESULTS = 20
const PER_PAGE    = 3

// \b is ASCII-only, so a word beside an accented letter would count as whole.
const WORD = '[\\p{L}\\p{N}]'

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words of a query, each as a whole-word pattern. Empty for blank input. */
export function patternsOf(query) {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
    .map((w) => new RegExp(`(?<!${WORD})${escape(w)}(?!${WORD})`, 'iu'))
}

/** A short run of `text` around the first matched word, cut at word edges. */
export function excerptOf(text, patterns, { before = 50, after = 110 } = {}) {
  const at = Math.min(...patterns.map((p) => text.search(p)).filter((i) => i >= 0))
  if (!Number.isFinite(at)) return ''
  let from = Math.max(0, at - before)
  let to   = Math.min(text.length, at + after)
  // Back up to a space so the cut never lands mid-word, unless it is the start.
  if (from > 0) from = text.indexOf(' ', from) + 1 || from
  if (to < text.length) to = text.lastIndexOf(' ', to) > at ? text.lastIndexOf(' ', to) : to
  return `${from > 0 ? '… ' : ''}${text.slice(from, to).trim()}${to < text.length ? ' …' : ''}`
}

/**
 * Hits over an index: a heading hit links to `url#id`, a body hit to the page.
 * Every word of the query must be in the heading, or in the page's words.
 *
 * @param {Array<{url: string, title: string, headings: Array<{id: string, text: string}>, text: string}>} pages
 * @param {string} query
 * @returns {Array<{id: string, url: string, label: string, sub: string}>}
 */
export function searchPages(pages, query) {
  const patterns = patternsOf(query)
  if (!patterns.length) return []
  const all = (text) => patterns.every((p) => p.test(text))
  const hits = []
  for (const page of pages) {
    const title = page.title || page.url
    const sections = page.headings.filter((h) => all(h.text)).slice(0, PER_PAGE)
    for (const h of sections) {
      hits.push({ id: `section:${page.url}#${h.id}`, url: `${page.url}#${h.id}`, label: h.text, sub: title })
    }
    // The page's own words, or its title with the rest of the words in its text.
    if (all(`${page.title} ${page.text}`)) {
      hits.push({ id: `text:${page.url}`, url: page.url, label: title, sub: excerptOf(page.text, patterns) || page.url })
    }
  }
  return hits.slice(0, MAX_RESULTS)
}

/**
 * @param {object} [opts]
 * @param {string} [opts.base] — the site's Sierra `base`; Vite's `BASE_URL` by default
 * @param {typeof fetch} [opts.fetch]
 */
export function createSearch({ base = import.meta.env?.BASE_URL ?? '/', fetch: get = globalThis.fetch } = {}) {
  const prefix = base.replace(/\/$/, '')
  const withBase = (url) => `${prefix}${url}`
  let loading = null

  // One fetch, kept, including a failed one: a missing index is a build that
  // never wrote it, and asking again on every keystroke finds the same 404.
  const load = () => loading ??= get(`${prefix}/search.json`)
    .then((r) => { if (!r.ok) throw new Error(`search.json ${r.status}`); return r.json() })

  return {
    withBase,
    load,
    /** Palette items for the Pages group, which the palette ranks itself. */
    async pages(go) {
      return (await load()).map((p) => ({
        id: `page:${p.url}`, group: 'Pages', label: p.title || p.url, sub: p.url, action: () => go(withBase(p.url)),
      }))
    },
    /** The palette's `search` hook: whole-word hits, drawn as given. */
    async results(query, go) {
      return searchPages(await load(), query).map((h) => ({
        id: h.id, group: 'Results', label: h.label, sub: h.sub, action: () => go(withBase(h.url)),
      }))
    },
  }
}
