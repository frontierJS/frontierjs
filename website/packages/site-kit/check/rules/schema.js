// check/rules/schema.js — the JSON-LD audit as one rule group. The checks are
// ../schema/, forked from site-auditor (see its README); this runs them per
// page and then across the site, and merges one finding per fact.
//
// A preset that knows where a fix goes (ksite: `site.md (company_type)`)
// replaces this rule by id and calls healthFindings() with its own fixFor.

import { extractSchema, extractMicrodata, parseJsonLdBlocks } from '../schema/schema.js'
import { schemaHealth } from '../schema/health.js'
import { htmlToText, decodeHtmlText } from '../schema/text.js'

const GROUP = 'Structured data'

// schemaHealth() validates only the node set it's handed as the homepage and
// uses the other rows for cross-page comparisons: once per page for the
// page-local findings, once over the whole site for the cross-page ones.
const SITE_LEVEL = new Set(['dangling-ref', 'empty-values', 'page-name-conflict', 'page-phone-conflict', 'feature-blocked', 'feature-ineligible', 'feature-thin'])
const IGNORED = new Set(['absent', 'static-fetch-only', 'coverage-capped', 'faq-unmarked', 'services-unmarked'])

/** A rendered page with its structured data pulled out, the shape every schema check reads. */
export function withSchema(p) {
  return {
    path: p.path,
    url: p.url,
    html: p.html,
    text: htmlToText(p.html),
    title: p.titles[0] || '',
    // Decoded: "Poppy &amp; Pine" is how "Poppy & Pine" is written in HTML, not
    // a different name. The content match stops at its own quote, so an
    // apostrophe in "Bob's Cleaning" doesn't cut it short.
    siteName: decodeHtmlText(p.html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=(["'])(.*?)\1/i)?.[2]).trim(),
    docs: parseJsonLdBlocks(p.html).docs,
    schema: extractSchema(p.html),
    microdata: extractMicrodata(p.html)
  }
}

/**
 * The forked auditor's findings over the site, one per fact with the pages it
 * shows on. `fixFor(key)` names where a finding is fixed; the kit knows no
 * settings vocabulary, so by default a finding carries none.
 */
export function healthFindings(pages, fixFor = () => undefined) {
  const home = pages.find((p) => p.path === '/') || pages[0]
  const merged = new Map()
  const add = (f, path) => {
    const k = `${f.key}\u0000${f.message}`
    const m = merged.get(k) || merged.set(k, { ...f, fix: fixFor(f.key), pages: [] }).get(k)
    if (path && !m.pages.includes(path)) m.pages.push(path)
  }
  for (const p of pages) {
    const brand = p.siteName ? { name: p.siteName, nameSource: 'og:site_name' } : null
    for (const f of schemaHealth({ schema: p.schema, microdata: p.microdata, brand }).findings)
      if (!SITE_LEVEL.has(f.key) && !IGNORED.has(f.key)) add(f, p.path)
  }
  const rows = pages.filter((p) => p !== home).map((p) => ({ url: p.url, schema: p.schema, type: '' }))
  for (const f of schemaHealth({ schema: home.schema, microdata: home.microdata }, rows).findings) if (SITE_LEVEL.has(f.key)) add(f)
  // "Organization rather than a LocalBusiness subtype" is about the site, not
  // the page: most pages carry only the Organization node by design.
  const siteHasLocal = pages.some(
    (p) => p.schema.business && ![].concat(p.schema.business['@type'] || []).every((t) => /^(?:https?:\/\/schema\.org\/)?(?:Organization|Corporation|NGO)$/.test(t))
  )
  return [...merged.values()].filter((f) => !(f.key === 'generic-type' && siteHasLocal))
}

function schema(ctx) {
  const pages = ctx.html.checked.map(withSchema)
  if (!pages.length) return []
  return healthFindings(pages)
}

export default [{ id: 'schema', group: GROUP, stage: 'built', run: schema }]
