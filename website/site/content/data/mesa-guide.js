// site/content/data/mesa-guide.js — the Mesa guide at /docs/mesa/, read from
// the markdown in packages/mesa/docs/guide/ and rendered at build time.
//
// The markdown stays the one source. `README.md` there is the only source of
// page order (`## Section` headings over `- [Title](dir/page.md)` bullets); a
// page it does not list is not published. This module parses that index, renders
// one page, and works out previous/next across section boundaries, and nothing
// else on the site knows the guide's layout.
//
// The guide directory comes from this module's own location. A cwd-relative path
// resolves in `bun run build` and nowhere else (the drive and the dev server
// start from other directories).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { posix } from 'node:path'
import { markdown } from '@frontierjs/toolbelt/markdown'

const GUIDE_DIR  = fileURLToPath(new URL('../../../../packages/mesa/docs/guide/', import.meta.url))
const GUIDE_REPO = 'packages/mesa/docs/guide'
const BLOB       = 'https://github.com/frontierjs/frontierjs/blob/main'
export const BASE = '/docs/mesa/'

const read = (file) => readFileSync(GUIDE_DIR + file, 'utf8')

// ─── the index ────────────────────────────────────────────────────────────

let cache = null

/** [{ section, slug, pages: [{ title, slug, dir, file, href }] }], in README order. */
export function loadGuide() {
  if (cache) return cache
  const sections = []
  for (const line of read('README.md').split('\n')) {
    const h = /^## (.+?)\s*$/.exec(line)
    if (h) { sections.push({ section: h[1], slug: '', pages: [] }); continue }
    const m = /^- \[(.+)\]\(([a-z0-9-]+)\/([a-z0-9-]+)\.md\)\s*$/.exec(line)
    if (!m || !sections.length) continue
    const [, title, dir, slug] = m
    sections.at(-1).pages.push({
      title: title.replace(/`/g, ''), slug, dir, file: `${dir}/${slug}.md`, href: `${BASE}${dir}/${slug}/`,
    })
  }
  // The URL's section segment is the directory the pages live in, so a section
  // whose pages disagree would publish a page at a path its file is not at.
  for (const s of sections) {
    const dirs = new Set(s.pages.map((p) => p.dir))
    if (dirs.size !== 1) throw new Error(`guide section "${s.section}" spans directories: ${[...dirs].join(', ') || 'none'}`)
    s.slug = s.pages[0].dir
  }
  return (cache = sections.filter((s) => s.pages.length))
}

const flat = () => loadGuide().flatMap((s) => s.pages.map((p) => ({ ...p, section: s.section })))

// ─── one page ─────────────────────────────────────────────────────────────

const decode = (s) => s.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

// GitHub's heading slug, because the guide's own cross-links were written
// against it (`VISION.md#21-let--mutable-reactive-state` keeps the double hyphen
// where an em dash was). The counter runs over every heading, as GitHub's does.
const slugger = () => {
  const seen = new Map()
  return (text) => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

const addHeadingIds = (html) => {
  const slug = slugger()
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (all, level, inner) => {
    const id = slug(decode(inner))
    return level === '1' ? all : `<h${level} id="${id}">${inner}</h${level}>`
  })
}

// A link in the guide is relative to the file it is written in. A page the
// guide publishes becomes a site path; anything else relative, the spec and
// the other docs, becomes the file on GitHub, because the site has no copy of it.
const rewriteLinks = (html, file) => {
  const published = new Set(flat().map((p) => `${GUIDE_REPO}/${p.file}`))
  return html.replace(/href="([^"]*)"/g, (all, raw) => {
    const href = raw.replace(/&amp;/g, '&')
    if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return all
    const [path, hash = ''] = href.split('#')
    const target = posix.normalize(posix.join(GUIDE_REPO, posix.dirname(file), path))
    if (target.startsWith('..')) throw new Error(`${file}: link ${href} leaves the repository`)
    const anchor = hash ? `#${hash}` : ''
    if (published.has(target)) {
      return `href="${BASE}${target.slice(GUIDE_REPO.length + 1).replace(/\.md$/, '')}/${anchor}"`
    }
    return `href="${BLOB}/${target}${anchor}"`
  })
}

const firstParagraph = (md) => {
  const body = md.replace(/```[\s\S]*?```/g, '').split(/\n{2,}/)
    .map((b) => b.trim()).find((b) => b && !/^(#|\||[-*>] |\d+\. )/.test(b)) ?? ''
  const text = body.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ')
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, '')}...` : text
}

/** One page's data: its rendered body, head text and previous/next. */
export function loadPage(dir, slug) {
  const pages = flat()
  const i = pages.findIndex((p) => p.dir === dir && p.slug === slug)
  if (i < 0) throw new Error(`the guide README does not list ${dir}/${slug}`)
  const page = pages[i]
  const md = read(page.file)
  const h1 = /^# (.+)$/m.exec(md)
  if (!h1) throw new Error(`${page.file} has no H1`)
  const link = (p) => (p ? { title: p.title, href: p.href, section: p.section } : null)
  return {
    title:       h1[1].replace(/`/g, ''),
    description: firstParagraph(md.slice(h1.index + h1[0].length)),
    section:     page.section,
    href:        page.href,
    html:        rewriteLinks(addHeadingIds(markdown(md, { classes: { table: 'table' } })), page.file)
                   .replace(/<pre>/g, '<pre class="code">'),
    prev:        link(pages[i - 1]),
    next:        link(pages[i + 1]),
    guide:       loadGuide(),
  }
}
