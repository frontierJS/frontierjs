// check/context.js — everything a rule reads, loaded once: the site as the
// build resolves it (resolveSite), its content files, and for the built and
// live stages the rendered pages.
//
// The check reads the SAME resolved site the build is made from, so the
// directories the components rule searches and the siteUrl the sitemap rule
// compares against are the build's, never a restatement of them (FJS-D962).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSite } from '../config/vite.js'
import { makePage } from './html.js'

export const UA = 'site-kit-check/1.0 (+https://frontierjs.com)'

/** site-kit's root: a change under its src/ or config/ is a change to every site. */
export const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The site's settings, when it has them: front-matter keys, each bound bare in every page. */
export const SETTINGS = 'content/settings/site.md'
// NOTE: site-kit's publicDir — a site is its content/ folder, so its public files are in it
export const PUBLIC = 'content/public'

// NOTE: site-kit hands Sierra `outDir: 'dist'` and `trailingSlash: 'always'`
export const DIST = 'dist'
export const TRAILING_SLASH = true

/**
 * Splits `---` front-matter off a Markdown file, parsed the way Sierra parses
 * a route's (YAML). `bodyBegin` is the body's first line, 1-based.
 */
export function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return { attributes: {}, body: text, bodyBegin: 1 }
  const bodyBegin = m[0].split('\n').length + (m[0].endsWith('\n') ? 0 : 1)
  return { attributes: Bun.YAML.parse(m[1]) || {}, body: text.slice(m[0].length), bodyBegin }
}

/* ── content ─────────────────────────────────────────────────────────────── */

export function walk(dir, test, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const f = join(dir, name)
    if (statSync(f).isDirectory()) walk(f, test, out)
    else if (test(name)) out.push(f)
  }
  return out
}

/** content/routes/blog/index.md → /blog/, about-us.md → /about-us/ */
export function routeOf(rel) {
  const p = rel.replace(/^content\/routes/, '').replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')
  return norm(p || '/')
}

/** Paths compared with a trailing slash, the way the sitemap writes them. */
export const norm = (p) => {
  const clean = String(p || '/').split(/[?#]/)[0]
  return clean.endsWith('/') || /\.[a-z0-9]+$/i.test(clean) ? clean : clean + '/'
}

function loadContent(root) {
  return walk(join(root, 'content'), (n) => n.endsWith('.md')).map((abs) => {
    const rel = relative(root, abs)
    const text = readFileSync(abs, 'utf8')
    /** @type {{ attributes: any, body: string, bodyBegin: number, error?: string }} */
    let parsed = { attributes: {}, body: text, bodyBegin: 1 }
    try {
      parsed = frontMatter(text)
    } catch (e) {
      parsed.error = e.message
    }
    const isPage = rel.startsWith('content/routes/') && !/(^|\/)_/.test(rel.replace('content/routes/', ''))
    // NOTE: Sierra builds neither a draft nor a redirect's source; each is a route and not a page
    const attrs = parsed.attributes || {}
    const published = attrs.status !== 'draft' && !attrs.redirect
    return {
      abs,
      rel,
      text,
      attrs,
      body: parsed.body,
      bodyBegin: parsed.bodyBegin,
      fmError: parsed.error,
      route: isPage && published && !rel.includes('[') ? routeOf(rel) : null,
      redirectFrom: isPage && attrs.redirect ? routeOf(rel) : null
    }
  })
}

/* ── rendered pages ──────────────────────────────────────────────────────── */

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  return res.text()
}
const locs = (xml) =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
const pathOf = (loc) => {
  try {
    return new URL(loc).pathname
  } catch {
    return loc
  }
}

// NOTE: Build output that isn't a page
export const NOT_PAGES = new Set(['assets', 'media', 'theme', 'g', 'cdn-cgi'])

async function loadLive(ctx) {
  const notes = []
  let urls = locs(await fetchText(ctx.base + '/sitemap.xml'))
  // NOTE: A sitemap index lists sitemaps, not pages
  if (urls.length && urls.every((u) => /\.xml(\?|$)/.test(u)))
    urls = (await Promise.all(urls.map((u) => fetchText(u).then(locs)))).flat()
  const pages = []
  const failed = []
  const queue = [...urls]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const url = queue.shift()
        try {
          pages.push(makePage(pathOf(url), url, await fetchText(url)))
        } catch (e) {
          failed.push(`${pathOf(url)} (${e.message})`)
        }
      }
    })
  )
  if (failed.length)
    notes.push(`${failed.length} pages couldn't be fetched: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''}`)
  for (const p of pages) p.inSitemap = true
  return { source: 'live', pages, sitemap: urls, notes }
}

function loadDist(ctx) {
  const { root } = ctx
  const dist = join(root, DIST)
  if (!existsSync(join(dist, 'index.html'))) return null
  const notes = []

  // NOTE: Checking a build older than the content is checking someone else's site
  const built = statSync(join(dist, 'index.html')).mtimeMs
  // NOTE: The kit and the preset render the content, so a change to either is a change to the site
  const engines = [KIT, ctx.preset.root].filter(Boolean)
  const newer = walk(join(root, 'content'), () => true)
    .concat(engines.flatMap((e) => walk(join(e, 'src'), (n) => /\.(mesa|js|scss|css)$/.test(n))))
    .concat(engines.flatMap((e) => walk(join(e, 'config'), (n) => /\.(js|ts)$/.test(n))))
    .filter((f) => statSync(f).mtimeMs > built)
  if (newer.length)
    notes.push(
      `dist/ is older than ${newer.length} source file(s) (e.g. ${relative(root, newer[0])}) — the built checks read old output. Rebuild first (\`site-kit build\`).`
    )

  // NOTE: A `[…]` directory is a dynamic route's template, not a page
  const files = walk(dist, (n) => n.endsWith('.html')).filter(
    (f) => !NOT_PAGES.has(relative(dist, f).split('/')[0]) && !relative(dist, f).includes('[')
  )
  const sitemapFile = join(dist, 'sitemap.xml')
  const sitemap = existsSync(sitemapFile) ? locs(readFileSync(sitemapFile, 'utf8')) : null
  const inSitemap = new Set((sitemap || []).map((u) => norm(pathOf(u))))

  const pages = files.map((f) => {
    const rel = relative(dist, f)
    const path = rel === '404.html' ? '/404.html' : '/' + rel.replace(/index\.html$/, '')
    const page = makePage(path, ctx.base + path, readFileSync(f, 'utf8'))
    page.file = relative(root, f)
    page.inSitemap = inSitemap.has(norm(path))
    return page
  })
  return { source: 'dist', dist, pages, sitemap, notes }
}

/* ── the context ─────────────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {string} opts.root — the site directory, the one holding content/
 * @param {string[]} opts.stages
 * @param {boolean} [opts.live]
 * @param {string} [opts.url]
 * @param {boolean} [opts.offline]
 * @param {Record<string, boolean>} [opts.flags] — a preset's own flags, as the command received them
 */
export async function createContext(opts) {
  const site = await resolveSite({ root: opts.root })
  const { root, settings, sierra, preset } = site
  const live = !!(opts.live || opts.url)
  // siteUrl is the Sierra key, whichever file states it: the site's site.js or
  // its preset from a setting of its own.
  const base = String(opts.url || sierra.siteUrl || '').replace(/\/+$/, '')
  const content = loadContent(root)
  const byRoute = new Map(content.filter((c) => c.route).map((c) => [c.route, c]))

  const ctx = {
    root,
    kit: KIT,
    /** content/settings/site.md's front-matter, `{}` for a site without one. */
    settings,
    /** The Sierra config the build runs with: siteUrl, description, autoImport, markdownLayouts, … */
    sierra,
    /** `{ name, root, rules, … }` — what the site's preset added, `{}` without one. */
    preset: site.presetName ? { ...preset, name: site.presetName } : {},
    base,
    live,
    opts: { ...opts, flags: opts.flags ?? {} },
    content,
    byRoute,
    notes: [],
    html: null,
    /** The content file a rendered path came from, if any. */
    contentFor: (path) => byRoute.get(norm(path)) || null
  }

  if (opts.stages.includes('built')) {
    if (!base && live) throw new Error(`the site states no siteUrl, so page URLs can’t be resolved. Pass --url.`)
    ctx.html = live ? await loadLive(ctx) : loadDist(ctx)
    if (ctx.html) {
      ctx.notes.push(...ctx.html.notes)
      // NOTE: What a search engine is invited to index: the sitemap, or failing that every
      // page not marked noindex
      ctx.html.indexable = ctx.html.pages.filter((p) =>
        ctx.html.sitemap ? p.inSitemap : !p.noindex && p.path !== '/404.html'
      )
      ctx.html.checked = ctx.html.indexable
    } else {
      ctx.notes.push(`No build in ${DIST}/ — the built checks were skipped. Run \`site-kit build\` first.`)
    }
  }
  return ctx
}
