/**
 * tests/postbuild.test.js — post-build pipeline tests
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm, readFile, access } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

import { move404 } from '../src/postbuild/move-404.js'
import { copyRobots } from '../src/postbuild/copy-robots.js'
import { generateRedirects } from '../src/postbuild/redirects.js'
import { generateSitemap } from '../src/postbuild/sitemap.js'
import { generateLlms } from '../src/postbuild/llms.js'
import { injectSpeculationRules } from '../src/postbuild/speculation.js'
import { deferJsLoading } from '../src/postbuild/defer-js.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-postbuild')

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
    const result = await copyRobots(root, outDir)
    expect(result).toBe('robots.txt (default)')
    const content = await readFile(join(outDir, 'robots.txt'), 'utf8')
    expect(content).toContain('User-agent: *')
    expect(content).toContain('Allow: /')
    expect(content).toContain('Sitemap:')
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
})
