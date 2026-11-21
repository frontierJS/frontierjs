// site/content/data/package-guide.js — a package's guide on the site (the Mesa
// guide at /docs/mesa/, the Litestone guide at /docs/litestone/), read from the
// markdown in packages/<pkg>/docs/guide/ and rendered at build time.
//
// The markdown stays the one source. `README.md` there is the only source of
// page order (`## Section` headings over `- [Title](dir/page.md)` bullets; every
// other line, a `<!-- from: -->` note included, is ignored); a page it does not
// list is not published. `packageGuide()` parses that index, renders one page,
// and works out previous/next across section boundaries, and nothing else on
// the site knows a guide's layout. A new package guide is an entry in GUIDES and
// a route folder, never a second parser.
//
// The guide directory comes from this module's own location. A cwd-relative path
// resolves in `bun run build` and nowhere else (the drive and the dev server
// start from other directories).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { posix } from 'node:path'
import { markdown } from '@frontierjs/toolbelt/markdown'

const BLOB = 'https://github.com/frontierjs/frontierjs/blob/main'

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

const firstParagraph = (md) => {
  const body = md.replace(/```[\s\S]*?```/g, '').split(/\n{2,}/)
    .map((b) => b.trim()).find((b) => b && !/^(#|\||[-*>] |\d+\. )/.test(b)) ?? ''
  const text = body.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ')
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, '')}...` : text
}

/**
 * One package's guide. `pkg` names packages/<pkg>/docs/guide/, `base` is the
 * URL it is served at, `name` the title the pages and head text carry, and
 * `heading`, `lede` and `description` the landing page's copy.
 */
export function packageGuide({ pkg, name, base, heading, lede, description }) {
  const dir  = fileURLToPath(new URL(`../../../../packages/${pkg}/docs/guide/`, import.meta.url))
  const repo = `packages/${pkg}/docs/guide`
  const read = (file) => readFileSync(dir + file, 'utf8')
  const info = { name, base, heading, lede, description }

  let cache = null

  /** [{ section, slug, pages: [{ title, slug, dir, file, href }] }], in README order. */
  function loadGuide() {
    if (cache) return cache
    const sections = []
    for (const line of read('README.md').split('\n')) {
      const h = /^## (.+?)\s*$/.exec(line)
      if (h) { sections.push({ section: h[1], slug: '', pages: [] }); continue }
      const m = /^- \[(.+)\]\(([a-z0-9-]+)\/([a-z0-9-]+)\.md\)\s*$/.exec(line)
      if (!m || !sections.length) continue
      const [, title, d, slug] = m
      sections.at(-1).pages.push({
        title: title.replace(/`/g, ''), slug, dir: d, file: `${d}/${slug}.md`, href: `${base}${d}/${slug}/`,
      })
    }
    // The URL's section segment is the directory the pages live in, so a section
    // whose pages disagree would publish a page at a path its file is not at.
    for (const s of sections) {
      const dirs = new Set(s.pages.map((p) => p.dir))
      if (dirs.size !== 1) throw new Error(`${name} section "${s.section}" spans directories: ${[...dirs].join(', ') || 'none'}`)
      s.slug = s.pages[0].dir
    }
    return (cache = sections.filter((s) => s.pages.length))
  }

  const flat = () => loadGuide().flatMap((s) => s.pages.map((p) => ({ ...p, section: s.section })))

  // A link in the guide is relative to the file it is written in. A page the
  // guide publishes becomes a site path; anything else relative, the spec and
  // the other docs, becomes the file on GitHub, because the site has no copy of it.
  const rewriteLinks = (html, file) => {
    const published = new Set(flat().map((p) => `${repo}/${p.file}`))
    return html.replace(/href="([^"]*)"/g, (all, raw) => {
      const href = raw.replace(/&amp;/g, '&')
      if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return all
      const [path, hash = ''] = href.split('#')
      const target = posix.normalize(posix.join(repo, posix.dirname(file), path))
      if (target.startsWith('..')) throw new Error(`${file}: link ${href} leaves the repository`)
      const anchor = hash ? `#${hash}` : ''
      if (published.has(target)) {
        return `href="${base}${target.slice(repo.length + 1).replace(/\.md$/, '')}/${anchor}"`
      }
      return `href="${BLOB}/${target}${anchor}"`
    })
  }

  /** One page's data: its rendered body, head text and previous/next. */
  function loadPage(section, slug) {
    const pages = flat()
    const i = pages.findIndex((p) => p.dir === section && p.slug === slug)
    if (i < 0) throw new Error(`the ${name} README does not list ${section}/${slug}`)
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
      guide:       info,
    }
  }

  return { ...info, info, loadGuide, loadPage }
}

export const mesaGuide = packageGuide({
  pkg:         'mesa',
  name:        'Mesa guide',
  base:        '/docs/mesa/',
  heading:     'The Mesa guide',
  lede:        'How to write Mesa, one short page per primitive. Each page ends by naming the rule in the spec it teaches.',
  description: 'How to write Mesa, one short page per primitive: reactivity, template syntax, styling, runtime and reference.',
})

export const litestoneGuide = packageGuide({
  pkg:         'litestone',
  name:        'Litestone guide',
  base:        '/docs/litestone/',
  heading:     'The Litestone guide',
  lede:        'What a schema and its client can do, one quick page per idea. Each page ends with a link to the full doc.',
  description: 'What a Litestone schema and client can do, one quick page per idea: models, queries, access, protected data, migrations and more.',
})

export const junctionGuide = packageGuide({
  pkg:         'junction',
  name:        'Junction guide',
  base:        '/docs/junction/',
  heading:     'The Junction guide',
  lede:        'What a service can do and how to add to it, one quick page per idea. Each page ends with a link to the full doc.',
  description: 'What a Junction service can do, one quick page per idea: services, hooks, transport, live updates, writes, protection and plugins.',
})
