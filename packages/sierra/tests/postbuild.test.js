/**
 * tests/postbuild.test.js — post-build pipeline tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm, readFile, access } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

import { tmpDir } from './tmp.js'
import { move404 } from '../src/postbuild/move-404.js'
import { copyRobots } from '../src/postbuild/copy-robots.js'
import { generateRedirects } from '../src/postbuild/redirects.js'
import { generateSitemap } from '../src/postbuild/sitemap.js'
import { generateLlms } from '../src/postbuild/llms.js'
import { injectSpeculationRules } from '../src/postbuild/speculation.js'
import { deferJsLoading } from '../src/postbuild/defer-js.js'
import { injectThemeScript } from '../src/postbuild/inject-theme.js'
import { runPostBuild } from '../src/postbuild/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Unique per run, and swept by the suite's own root. A fixed path under
// tests/ meant two vitest runs in one checkout wrote the same fixtures and
// `afterAll`'s rm deleted the other one's, which reads as a random failure in
// whichever test happened to be reading a file at the time.
const TMP = tmpDir('postbuild-')

async function setup(subdir, files = {}) {
  const dir = join(TMP, subdir)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  return dir
}

function dirname2(p) {
  return join(p, '..')
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

// ─── injectThemeScript (FJS-501) ─────────────────────────────────────────────

describe('injectThemeScript', () => {
  const THEME = { themes: ['theme-a', 'theme-b'], default: 'theme-a', key: 'k' }
  const page  = '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>'

  test('injects into EVERY page, at any depth', async () => {
    // This used to write `join(outDir, "index.html")` and nothing else, which
    // is the whole output of an SPA and one page out of N on a static target.
    // A prerendered site got the script on its home page and every other page
    // flashed — which reads as an intermittent bug, not a missing step.
    const outDir = await setup('theme-many', {
      'index.html':               page,
      '404.html':                 page,
      'catalog/index.html':       page,
      'products/a-thing/index.html': page,
    })
    const result = await injectThemeScript(THEME, outDir)
    expect(result).toContain('4 pages')

    for (const f of ['index.html', '404.html', 'catalog/index.html', 'products/a-thing/index.html']) {
      const html = await readFile(join(outDir, f), 'utf8')
      expect(html).toContain('id="sierra-theme"')
      // Before any stylesheet — a script after one has already lost the race.
      expect(html.indexOf('sierra-theme')).toBeLessThan(html.indexOf('<title>'))
    }
  })

  test('names the file when there is one, rather than counting it', async () => {
    const outDir = await setup('theme-one', { 'index.html': page })
    expect(await injectThemeScript(THEME, outDir)).toContain('index.html')
  })

  test('does not stack on a re-run over an existing output directory', async () => {
    const outDir = await setup('theme-rerun', { 'index.html': page })
    await injectThemeScript(THEME, outDir)
    expect(await injectThemeScript(THEME, outDir)).toBe(null)
    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    expect(html.match(/sierra-theme/g)).toHaveLength(1)
  })

  test('skips assets/, which holds no pages', async () => {
    const outDir = await setup('theme-assets', {
      'index.html':        page,
      'assets/thing.html': page,
    })
    await injectThemeScript(THEME, outDir)
    const asset = await readFile(join(outDir, 'assets/thing.html'), 'utf8')
    expect(asset).not.toContain('sierra-theme')
  })

  test('no theme config is no injection', async () => {
    const outDir = await setup('theme-none', { 'index.html': page })
    expect(await injectThemeScript(null, outDir)).toBe(null)
  })
})

// ─── the sitemap on a static target (FJS-502) ────────────────────────────────

describe('runPostBuild — what counts as a page', () => {
  const page = '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>'

  // `indexed` drops every dynamic route, because an SPA cannot know which URLs
  // `/products/:slug/` stands for. A static build DOES know — getStaticPaths()
  // named them and the files are on disk — so a storefront's sitemap listed
  // four URLs for a thirteen-product catalogue, and nothing said so.
  const table = {
    all:       ['/', '/catalog/', '/products/:slug/', '/secret/', '/wip/'],
    indexed:   ['/', '/catalog/'],
    indexable: ['/', '/catalog/', '/products/:slug/'],   // /secret/ noindex, /wip/ draft
    redirects: [],
  }

  test('lists the pages a dynamic route produced', async () => {
    const outDir = await setup('sitemap-static', { 'index.html': page })
    await runPostBuild({ llms: false }, table, outDir,
      outDir, ['/', '/catalog/', '/products/a/', '/products/b/'])

    const xml = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(xml).toContain('<loc>/products/a/</loc>')
    expect(xml).toContain('<loc>/products/b/</loc>')
    expect(xml.match(/<loc>/g)).toHaveLength(4)
  })

  test('a noindex route stays out, even prerendered', async () => {
    // The dynamic exclusion is not a decision; draft and noindex are. Dropping
    // the first must not drop the second.
    const outDir = await setup('sitemap-noindex', { 'index.html': page })
    await runPostBuild({ llms: false }, table, outDir, outDir, ['/', '/secret/', '/wip/'])

    const xml = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(xml).not.toContain('/secret/')
    expect(xml).not.toContain('/wip/')
    expect(xml.match(/<loc>/g)).toHaveLength(1)
  })

  test('the empty 404/ directory does not survive into the published site', async () => {
    // `rename` takes the file and leaves the directory. Harmless where a host
    // answers 404 for it, a directory listing where one does not — either way
    // it is a URL nobody meant to publish.
    const outDir = await setup('move404-dir', {
      'index.html':      page,
      '404/index.html':  page,
    })
    await runPostBuild({ llms: false }, table, outDir, outDir, ['/'])
    await access(join(outDir, '404.html'))        // the page is where a host looks
    await expect(access(join(outDir, '404'))).rejects.toThrow()
  })

  test('the 404 page is not a URL the sitemap advertises (FJS-456)', async () => {
    /*
     * `move404` relocates `404/index.html` to `404.html`, so by the time the
     * sitemap is written `/404/` is not a page — the entry advertised a URL
     * that answers 404, which is a worse thing than indexing a not-found page.
     * Asserted on both branches, because the prerendered list and the route
     * table's own `indexed` are two different answers to *what are this site's
     * pages* and only one of them is filtered.
     */
    const outDir = await setup('sitemap-404', { 'index.html': page })
    await runPostBuild({ llms: false }, { ...table, indexed: ['/', '/404/'] },
      outDir, outDir, ['/', '/404/', '/catalog/'])

    const xml = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(xml).not.toContain('/404/')
    // The control: dropping one URL must not drop the rest.
    expect(xml).toContain('<loc>/</loc>')
    expect(xml).toContain('<loc>/catalog/</loc>')
  })

  test('…and on an SPA, where the route table is the whole answer', async () => {
    const outDir = await setup('sitemap-404-spa', { 'index.html': page })
    await runPostBuild({ llms: false }, { ...table, indexed: ['/', '/404/', '/catalog/'] },
      outDir, outDir, null)

    const xml = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(xml).not.toContain('/404/')
    expect(xml).toContain('<loc>/catalog/</loc>')
  })

  test('an SPA is unchanged — the route table is still the whole answer', async () => {
    const outDir = await setup('sitemap-spa', { 'index.html': page })
    await runPostBuild({ llms: false }, table, outDir, outDir, null)

    const xml = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(xml).toContain('<loc>/catalog/</loc>')
    expect(xml).not.toContain(':slug')
    expect(xml.match(/<loc>/g)).toHaveLength(2)
  })

  test('prefetch rules see the same set', async () => {
    const outDir = await setup('spec-static', { 'index.html': page })
    await runPostBuild({ llms: false }, table, outDir, outDir, ['/', '/products/a/'])

    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain('"/products/a/"')
  })

  // The FOUR tests below are about the CALL and not the unit. Every
  // `generateSitemap`, `generateMarkdownPages` and `copyRobots` case in this
  // file passes forever against a call site that never hands them the argument
  // — which is `FJS-473`'s lesson, and was true of all of these (`FJS-822`).
  // The robots one was measured: with `siteUrl` dropped at the call site, every
  // unit case for it still passed and only this row went red.

  test('siteUrl reaches copyRobots, so the Sitemap line is absolute', async () => {
    const outDir = await setup('wiring-robots', { 'index.html': page })
    await runPostBuild({ llms: false, siteUrl: 'https://shop.example' },
      table, outDir, outDir, ['/'])
    const robots = await readFile(join(outDir, 'robots.txt'), 'utf8')
    expect(robots).toContain('Sitemap: https://shop.example/sitemap.xml')
  })

  test('the route\u2019s own sitemap frontmatter reaches generateSitemap', async () => {
    const outDir = await setup('wiring-sitemap', { 'index.html': page })
    const withTree = {
      ...table,
      tree: { path: '/', meta: { sitemap: { priority: '0.42', changefreq: 'hourly' } }, children: [] },
    }
    await runPostBuild({ llms: false }, withTree, outDir, outDir, ['/'])
    const xml = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(xml).toContain('<priority>0.42</priority>')
    expect(xml).toContain('<changefreq>hourly</changefreq>')
  })

  test('a route that declares nothing still gets the depth heuristic', async () => {
    // The negative control: a wiring that handed every route the same meta
    // would satisfy the row above.
    const outDir = await setup('wiring-sitemap-default', { 'index.html': page })
    await runPostBuild({ llms: false }, table, outDir, outDir, ['/'])
    const xml = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(xml).toContain('<priority>1.0</priority>')
  })

  test('markdownPages gets the PRERENDERED pages, not the route table', async () => {
    // `generateMarkdownPages` re-derived `routeTable.indexed` and filtered out
    // anything with a `:`, so a storefront emitted index.md for its static
    // pages and for none of its products — the pages the feature exists for.
    const outDir = await setup('wiring-md', {
      'index.html':             page.replace('<body>', '<body><main><h1>Home</h1></main>'),
      'products/a/index.html':  page.replace('<body>', '<body><main><h1>Product A</h1></main>'),
    })
    await runPostBuild({ llms: false, markdownPages: true }, table, outDir, outDir,
      ['/', '/products/a/'])
    await access(join(outDir, 'products/a/index.md'))
    expect(await readFile(join(outDir, 'products/a/index.md'), 'utf8')).toContain('Product A')
  })
})

// ─── move404 ─────────────────────────────────────────────────────────────────

describe('move404', () => {
  test('moves 404/index.html to 404.html', async () => {
    const outDir = await setup('move404', {
      '404/index.html': '<h1>Not Found</h1>',
    })
    const result = await move404(outDir)
    expect(result).toBe('404.html ← 404/index.html')
    const content = await readFile(join(outDir, '404.html'), 'utf8')
    expect(content).toBe('<h1>Not Found</h1>')
  })

  test('returns null when no 404/index.html', async () => {
    const outDir = await setup('move404-empty')
    const result = await move404(outDir)
    expect(result).toBeNull()
  })
})

// ─── copyRobots ───────────────────────────────────────────────────────────────

describe('copyRobots', () => {
  test('copies public/robots.txt when present', async () => {
    const root = await setup('robots-root', {
      'public/robots.txt': 'User-agent: *\nDisallow: /private/',
    })
    const outDir = await setup('robots-out')
    const result = await copyRobots(root, outDir)
    expect(result).toBe('robots.txt ← public/robots.txt')
    const content = await readFile(join(outDir, 'robots.txt'), 'utf8')
    expect(content).toContain('Disallow: /private/')
  })

  test('generates default robots.txt when none exists', async () => {
    const root = await setup('robots-root-empty')
    const outDir = await setup('robots-out-default')
    const result = await copyRobots(root, outDir, 'https://shop.example')
    expect(result).toBe('robots.txt (default)')
    const content = await readFile(join(outDir, 'robots.txt'), 'utf8')
    expect(content).toContain('User-agent: *')
    expect(content).toContain('Allow: /')
    // ABSOLUTE. `Sitemap:` takes a full URL, and a relative one is not a
    // sitemap a crawler fails to fetch — it is a line every crawler discards,
    // so the old default advertised nothing while looking like it had.
    expect(content).toContain('Sitemap: https://shop.example/sitemap.xml')
  })

  test('a trailing slash on siteUrl does not double up', async () => {
    const root = await setup('robots-root-slash')
    const outDir = await setup('robots-out-slash')
    await copyRobots(root, outDir, 'https://shop.example/')
    const content = await readFile(join(outDir, 'robots.txt'), 'utf8')
    expect(content).toContain('Sitemap: https://shop.example/sitemap.xml')
  })

  test('with no siteUrl the line is omitted, and the result says so', async () => {
    /*
     * Rather than written relative. The two are worth exactly the same to a
     * crawler and only one of them says so — and a missing config value is the
     * operator's to fix, which nothing else in the build would mention.
     */
    const root = await setup('robots-root-nosite')
    const outDir = await setup('robots-out-nosite')
    const result = await copyRobots(root, outDir)
    const content = await readFile(join(outDir, 'robots.txt'), 'utf8')
    expect(content).not.toContain('Sitemap:')
    expect(content).toContain('Allow: /')   // the rest is still written
    expect(result).toContain('siteUrl')
  })
})

// ─── generateRedirects ───────────────────────────────────────────────────────

describe('generateRedirects', () => {
  test('generates _redirects file from redirect pairs', async () => {
    const outDir = await setup('redirects')
    const result = await generateRedirects(
      [['/old/', '/new/'], ['/legacy/', '/new-home/']],
      outDir
    )
    expect(result).toContain('2 rules')
    const content = await readFile(join(outDir, '_redirects'), 'utf8')
    expect(content).toContain('/old/  /new/  301')
    expect(content).toContain('/legacy/  /new-home/  301')
  })

  test('returns null when no redirects', async () => {
    const outDir = await setup('redirects-empty')
    const result = await generateRedirects([], outDir)
    expect(result).toBeNull()
  })
})

// ─── a real XML read ─────────────────────────────────────────────────────────
//
// This package has no XML parser in its dependency tree, and happy-dom's
// DOMParser is not one: measured, it accepts `<loc>x & y</loc>` as text/xml and
// reports no error. So the strictness a sitemap needs is written here — a raw
// `&`, a raw `<` in text, or a tag that does not close is what makes a crawler
// throw the whole file away, and every substring assertion in this file passes
// against a document carrying all three.

const ENTITY = /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/

/** Parse `xml` strictly and return the text of every `<tag>`. Throws if it is not XML. */
function parseXmlText(xml, tag) {
  const stack = []
  const out   = []
  let text    = ''
  let i       = 0

  while (i < xml.length) {
    const c = xml[i]

    if (c === '<') {
      const close = xml.indexOf('>', i)
      if (close === -1) throw new Error(`unterminated tag at ${i}`)
      const inner = xml.slice(i + 1, close)

      if (inner.startsWith('?') || inner.startsWith('!')) { i = close + 1; continue }

      if (inner.startsWith('/')) {
        const name = inner.slice(1).trim()
        if (stack.pop()?.name !== name) throw new Error(`</${name}> does not close the open element`)
        if (name === tag) out.push(text)
      } else if (!inner.endsWith('/')) {
        stack.push({ name: inner.split(/[\s]/)[0] })
      }
      text = ''
      i = close + 1
      continue
    }

    if (c === '>') throw new Error(`raw '>' in text at ${i}`)
    if (c === '&') {
      const m = ENTITY.exec(xml.slice(i))
      if (!m) throw new Error(`raw '&' in text at ${i}: ${JSON.stringify(xml.slice(i, i + 20))}`)
      text += ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[m[0]] ?? ''
      i += m[0].length
      continue
    }

    text += c
    i++
  }

  if (stack.length) throw new Error(`unclosed element <${stack[stack.length - 1].name}>`)
  return out
}

// ─── generateSitemap ─────────────────────────────────────────────────────────

describe('generateSitemap', () => {
  test('generates valid XML sitemap', async () => {
    const outDir = await setup('sitemap')
    const result = await generateSitemap(
      ['/', '/about/', '/blog/'],
      outDir,
      'https://example.com'
    )
    expect(result).toContain('3 URLs')
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(content).toContain('<?xml version="1.0"')
    expect(content).toContain('<urlset')
    expect(content).toContain('<loc>https://example.com/</loc>')
    expect(content).toContain('<loc>https://example.com/about/</loc>')
  })

  test('home page gets priority 1.0', async () => {
    const outDir = await setup('sitemap-priority')
    await generateSitemap(['/'], outDir)
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(content).toContain('<priority>1.0</priority>')
  })

  test('top-level routes get priority 0.8', async () => {
    const outDir = await setup('sitemap-priority2')
    await generateSitemap(['/about/'], outDir)
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(content).toContain('<priority>0.8</priority>')
  })

  test('works without siteUrl (relative urls)', async () => {
    const outDir = await setup('sitemap-nobase')
    await generateSitemap(['/about/'], outDir)
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(content).toContain('<loc>/about/</loc>')
  })

  test('includes lastmod date', async () => {
    const outDir = await setup('sitemap-date')
    await generateSitemap(['/'], outDir)
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    const today = new Date().toISOString().split('T')[0]
    expect(content).toContain(`<lastmod>${today}</lastmod>`)
  })

  test('a slug with an & in it does not void the file (FJS-822)', async () => {
    // Asserted by PARSING, because every substring assertion above passes
    // against a sitemap.xml that is not XML. `tools-&-hardware` is not a
    // hostile string, it is a slug, and a raw `&` makes a crawler reject the
    // whole file and every URL in it.
    const outDir = await setup('sitemap-escaping')
    await generateSitemap(
      ['/', '/p/tools-&-hardware/', '/p/a<b>c/', '/p/q"uote/', '/p/a b/'],
      outDir, 'https://shop.example.com'
    )
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')

    const locs = parseXmlText(content, 'loc')
    expect(locs.length).toBe(5)

    // Each <loc> is a valid URL, which is the sitemap protocol's own
    // requirement and a second question from the XML one.
    for (const loc of locs) expect(() => new URL(loc)).not.toThrow()

    // And the URL decodes back to the path the build emitted a file for.
    expect(locs.map(l => decodeURIComponent(new URL(l).pathname))).toEqual(
      ['/', '/p/tools-&-hardware/', '/p/a<b>c/', '/p/q"uote/', '/p/a b/']
    )
  })

  test('an ordinary path is not mangled by the encoder', async () => {
    // The negative control: an encoder applied too eagerly turns every URL in
    // the sitemap into one no crawler matches against the site.
    const outDir = await setup('sitemap-plain')
    await generateSitemap(['/', '/about/', '/blog/post-one/'], outDir, 'https://example.com')
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(parseXmlText(content, 'loc')).toEqual([
      'https://example.com/', 'https://example.com/about/', 'https://example.com/blog/post-one/',
    ])
  })

  test('per-route sitemap frontmatter is read (FJS-822)', async () => {
    // Documented in this module's own header and unreachable: the one
    // production call site passed three arguments, so `routeMeta` was always
    // `{}` and every page got the depth heuristic.
    const outDir = await setup('sitemap-meta')
    await generateSitemap(['/about/'], outDir, '', {
      '/about/': { sitemap: { priority: '0.9', changefreq: 'hourly' } },
    })
    const content = await readFile(join(outDir, 'sitemap.xml'), 'utf8')
    expect(parseXmlText(content, 'priority')).toEqual(['0.9'])
    expect(parseXmlText(content, 'changefreq')).toEqual(['hourly'])
    // The control: a route the map says nothing about still gets the heuristic.
    expect(await generateSitemap(['/'], outDir, '', {})).toContain('1 URL')
  })
})

// ─── generateLlms ────────────────────────────────────────────────────────────

describe('generateLlms', () => {
  const routeTable = {
    indexed: ['/', '/about/', '/blog/'],
    tree: {
      id: 'root', path: '/', file: 'index.mesa',
      meta: { title: 'Home', description: 'Welcome' },
      children: [
        { id: 'about', path: '/about/', file: 'about.mesa',
          meta: { title: 'About' }, children: [] },
        { id: 'blog', path: '/blog/', file: 'blog/index.mesa',
          meta: { title: 'Blog', description: 'Latest posts' }, children: [] },
      ]
    }
  }

  test('generates llms.txt when config.llms = auto', async () => {
    const root = await setup('llms-auto')
    const outDir = await setup('llms-auto-out')
    const result = await generateLlms({ llms: 'auto', name: 'My Site' }, routeTable, outDir, root)
    expect(result).toBe('llms.txt (generated)')
    const content = await readFile(join(outDir, 'llms.txt'), 'utf8')
    expect(content).toContain('# My Site')
    expect(content).toContain('[Home](/)') 
    expect(content).toContain('[About](/about/)')
    expect(content).toContain('Generated by Sierra')
  })

  test('generates llms.txt when config.llms = true and file does not exist', async () => {
    const root = await setup('llms-true')
    const outDir = await setup('llms-true-out')
    await generateLlms({ llms: true }, routeTable, outDir, root)
    const exists = await access(join(outDir, 'llms.txt')).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  test('does not overwrite when config.llms = true and file exists', async () => {
    const root = await setup('llms-no-overwrite')
    const outDir = await setup('llms-no-overwrite-out', {
      'llms.txt': 'EXISTING CONTENT',
    })
    const result = await generateLlms({ llms: true }, routeTable, outDir, root)
    expect(result).toBeNull()
    const content = await readFile(join(outDir, 'llms.txt'), 'utf8')
    expect(content).toBe('EXISTING CONTENT')
  })

  test('returns null when config.llms = false', async () => {
    const root = await setup('llms-false')
    const outDir = await setup('llms-false-out')
    const result = await generateLlms({ llms: false }, routeTable, outDir, root)
    expect(result).toBeNull()
  })

  test('copies public/llms.txt when present and llms !== auto', async () => {
    const root = await setup('llms-public', {
      'public/llms.txt': '# Custom LLMs',
    })
    const outDir = await setup('llms-public-out')
    const result = await generateLlms({ llms: true }, routeTable, outDir, root)
    expect(result).toBe('llms.txt ← public/llms.txt')
    const content = await readFile(join(outDir, 'llms.txt'), 'utf8')
    expect(content).toBe('# Custom LLMs')
  })

  test('includes description in llms.txt', async () => {
    const root = await setup('llms-desc')
    const outDir = await setup('llms-desc-out')
    await generateLlms(
      { llms: 'auto', name: 'MySite', description: 'A great site' },
      routeTable, outDir, root
    )
    const content = await readFile(join(outDir, 'llms.txt'), 'utf8')
    expect(content).toContain('> A great site')
  })
})

// ─── injectSpeculationRules ───────────────────────────────────────────────────

describe('injectSpeculationRules', () => {
  test('injects speculation rules before </head>', async () => {
    const outDir = await setup('speculation', {
      'index.html': '<html><head><title>Test</title></head><body></body></html>',
    })
    const result = await injectSpeculationRules(['/', '/about/', '/blog/'], outDir)
    expect(result).toContain('Speculation Rules')
    expect(result).toContain('3 routes')
    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain('speculationrules')
    expect(html).toContain('"prerender"')
    expect(html).toContain('"/about/"')
  })

  test('does not inject if already present', async () => {
    const outDir = await setup('speculation-idempotent', {
      'index.html': '<html><head><script type="speculationrules">{}</script></head></html>',
    })
    const result = await injectSpeculationRules(['/'], outDir)
    expect(result).toBeNull()
  })

  test('returns null when no index.html', async () => {
    const outDir = await setup('speculation-empty')
    const result = await injectSpeculationRules(['/'], outDir)
    expect(result).toBeNull()
  })

  test('reaches every page, not only index.html (FJS-822)', async () => {
    // `FJS-501` is *the theme script reached the home page and every other page
    // flashed*, and its fix — walk outDir — was applied to inject-theme.js and
    // to neither of the two steps beside it in the same pipeline. Here it
    // defeats the feature: speculation rules make the SECOND navigation
    // instant, so the only page that had them was the one a reader arrives on.
    const page = '<html><head><title>t</title></head><body></body></html>'
    const outDir = await setup('speculation-walk', {
      'index.html':            page,
      'about/index.html':      page,
      'p/navy-tee/index.html': page,
      'assets/index-A1b2C3d4.js': 'console.log(1)',
    })
    const result = await injectSpeculationRules(['/', '/about/'], outDir)
    expect(result).toContain('3 pages')
    for (const rel of ['index.html', 'about/index.html', 'p/navy-tee/index.html'])
      expect(await readFile(join(outDir, rel), 'utf8')).toContain('speculationrules')
    // The control: a non-HTML file in the tree is untouched.
    expect(await readFile(join(outDir, 'assets/index-A1b2C3d4.js'), 'utf8')).toBe('console.log(1)')
  })

  test('a route path cannot close the script block it rides in', async () => {
    const outDir = await setup('speculation-escape', {
      'index.html': '<html><head></head><body></body></html>',
    })
    await injectSpeculationRules(['/p/</script><img src=x>/'], outDir)
    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    expect(html).not.toContain('</script><img')
    expect(html).toContain('\\u003c/script')
  })
})

// ─── deferJsLoading ──────────────────────────────────────────────────────────

describe('deferJsLoading', () => {
  test('adds defer to script tags with src', async () => {
    const outDir = await setup('defer', {
      'index.html': '<html><head><script src="/app.js"></script></head></html>',
    })
    const result = await deferJsLoading(outDir)
    expect(result).toContain('1 script tag')
    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain('defer')
  })

  test('does not add defer to module scripts', async () => {
    const outDir = await setup('defer-module', {
      'index.html': '<html><head><script type="module" src="/app.js"></script></head></html>',
    })
    const result = await deferJsLoading(outDir)
    expect(result).toBeNull()
  })

  test('does not add defer to inline scripts', async () => {
    const outDir = await setup('defer-inline', {
      'index.html': '<html><head><script>console.log("hi")</script></head></html>',
    })
    const result = await deferJsLoading(outDir)
    expect(result).toBeNull()
  })

  test('does not add defer if already present', async () => {
    const outDir = await setup('defer-already', {
      'index.html': '<html><head><script src="/app.js" defer></script></head></html>',
    })
    const result = await deferJsLoading(outDir)
    expect(result).toBeNull()
  })

  test('returns null when no index.html', async () => {
    const outDir = await setup('defer-nofile')
    const result = await deferJsLoading(outDir)
    expect(result).toBeNull()
  })

  test('reaches every page, not only index.html (FJS-822)', async () => {
    const page = '<html><head><script src="/app.js"></script></head></html>'
    const outDir = await setup('defer-walk', {
      'index.html':       page,
      'about/index.html': page,
    })
    const result = await deferJsLoading(outDir)
    expect(result).toContain('2 script tags')
    expect(await readFile(join(outDir, 'about/index.html'), 'utf8')).toContain('defer')
  })
})
