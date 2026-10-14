// check/rules/meta.js — titles, descriptions, headings and social tags, on the
// pages the site asks search engines to index.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { finding } from '../finding.js'

const GROUP = 'Meta tags'
// NOTE: Where Google's result snippet truncates, roughly
const TITLE_MAX = 60
const DESCRIPTION_MAX = 160

/** Pages grouped by a value, keeping only values more than one page shares. */
function dupes(pages, get) {
  const by = new Map()
  for (const p of pages) {
    const v = get(p)?.trim()
    if (v) (by.get(v) || by.set(v, []).get(v)).push(p.path)
  }
  return [...by].filter(([, paths]) => paths.length > 1)
}

function titles(ctx) {
  const pages = ctx.html.checked
  const out = []
  const missing = pages.filter((p) => !p.titles[0]).map((p) => p.path)
  const long = pages.filter((p) => (p.titles[0] || '').length > TITLE_MAX)
  if (missing.length) out.push(finding('error', 'title-missing', `Pages with no <title>: ${missing.length}.`, { pages: missing }))
  if (long.length)
    out.push(
      finding('warn', 'title-long', `Titles over ${TITLE_MAX} characters, which get cut off in results: ${long.length}. Shorten the page's \`title:\` front-matter.`, {
        pages: long.map((p) => `${p.path} (${p.titles[0].length})`)
      })
    )
  for (const [title, paths] of dupes(pages, (p) => p.titles[0]))
    out.push(finding('warn', 'title-duplicate', `The title "${title}" is on ${paths.length} pages. Give each its own \`title:\` frontmatter.`, { pages: paths }))
  return out
}

function descriptions(ctx) {
  const pages = ctx.html.checked
  const out = []
  const missing = pages.filter((p) => !p.descriptions[0]?.trim()).map((p) => p.path)
  const long = pages.filter((p) => (p.descriptions[0] || '').length > DESCRIPTION_MAX)
  if (missing.length) out.push(finding('warn', 'description-missing', `Pages with no meta description: ${missing.length}.`, { pages: missing }))
  if (long.length)
    out.push(
      finding('warn', 'description-long', `Descriptions over ${DESCRIPTION_MAX} characters, which get cut off: ${long.length}.`, {
        pages: long.map((p) => `${p.path} (${p.descriptions[0].length})`)
      })
    )
  // Sierra's `description` is what a page without its own falls back to.
  const fallback = String(ctx.sierra.description || '').trim()
  for (const [text, paths] of dupes(pages, (p) => p.descriptions[0])) {
    const isDefault = text === fallback
    out.push(
      finding(
        'warn',
        'description-duplicate',
        isDefault
          ? `${paths.length} pages fall back to the site-wide description. Give each its own \`description:\` frontmatter.`
          : `${paths.length} pages share the description "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}".`,
        { pages: paths }
      )
    )
  }
  return out
}

function headings(ctx) {
  const out = []
  const none = ctx.html.checked.filter((p) => !p.h1s.length).map((p) => p.path)
  const many = ctx.html.checked.filter((p) => p.h1s.length > 1).map((p) => `${p.path} (${p.h1s.length})`)
  if (none.length) out.push(finding('warn', 'h1-missing', `Pages with no <h1>: ${none.length}.`, { pages: none }))
  if (many.length) out.push(finding('warn', 'h1-multiple', `Pages with more than one <h1>: ${many.length}.`, { pages: many }))
  return out
}

function social(ctx) {
  const out = []
  const missing = ctx.html.checked.filter((p) => !p.og.image).map((p) => p.path)
  if (missing.length) out.push(finding('warn', 'og-image-missing', `Pages with no og:image, so shared links show no picture: ${missing.length}.`, { pages: missing }))

  // NOTE: Only a build can be checked for the file itself; live, a broken image is a fetch away
  if (ctx.html.source !== 'dist') return out
  const broken = new Map()
  for (const p of ctx.html.checked) {
    if (!p.og.image) continue
    let path
    try {
      path = new URL(p.og.image, ctx.base || 'http://x').pathname
    } catch {
      continue
    }
    const f = join(ctx.html.dist, decodeURIComponent(path))
    if (!(existsSync(f) && statSync(f).isFile())) (broken.get(path) || broken.set(path, []).get(path)).push(p.path)
  }
  for (const [img, paths] of broken)
    out.push(finding('warn', 'og-image-broken', `og:image ${img} isn't in the build.`, { pages: paths }))
  return out
}

export default [
  { id: 'titles', group: GROUP, stage: 'built', run: titles },
  { id: 'descriptions', group: GROUP, stage: 'built', run: descriptions },
  { id: 'headings', group: GROUP, stage: 'built', run: headings },
  { id: 'social', group: GROUP, stage: 'built', run: social }
]
