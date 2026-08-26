/**
 * tests/prerender.test.js — the static-render emitter.
 *
 * `target: 'static'` accepted the config, threw a helpful error on an unknown
 * target, and then produced a plain SPA: one index.html, no prerendered route,
 * no warning. The declaration layer around it was real — `render: static`
 * frontmatter, `getStaticPaths()` companions, and a scanner check that fails
 * the build when a dynamic static route lacks one — but nothing consumed any
 * of it.
 *
 * These cover the pieces that decide what lands on disk.
 */

import { describe, test, expect } from 'vitest'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'

import {
  fillPath, outputFileFor, composeWrapper, layoutChainFor,
  pathsForRoute, wrapDocument, prerenderRoutes,
} from '../src/build/prerender.js'
import { tmpDir } from './tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('fillPath', () => {
  test('substitutes a single param', () => {
    expect(fillPath('/blog/:slug/', { slug: 'hello' })).toBe('/blog/hello/')
  })

  test('substitutes several params', () => {
    expect(fillPath('/:a/x/:b/', { a: '1', b: '2' })).toBe('/1/x/2/')
  })

  test('throws when a param is missing rather than emitting a literal ":slug" path', () => {
    expect(() => fillPath('/blog/:slug/', {})).toThrow(/missing param 'slug'/)
  })

  test('leaves a static path alone', () => {
    expect(fillPath('/about/', {})).toBe('/about/')
  })
})

describe('outputFileFor', () => {
  test('maps a directory path to index.html', () => {
    expect(outputFileFor('/about/')).toBe('about/index.html')
  })

  test('maps root to the top-level index.html', () => {
    expect(outputFileFor('/')).toBe('index.html')
  })

  test('handles a nested path', () => {
    expect(outputFileFor('/blog/hello-world/')).toBe('blog/hello-world/index.html')
  })

  test('tolerates a missing trailing slash', () => {
    expect(outputFileFor('/about')).toBe('about/index.html')
  })
})

describe('composeWrapper', () => {
  test('renders the page directly when there is no layout', () => {
    const out = composeWrapper('/app/routes/index.mesa', [])
    expect(out).toContain('import Page from "/app/routes/index.mesa"')
    expect(out).toContain('<Page {data} />')
    expect(out).not.toContain('{#snippet')
  })

  test('passes children BOTH ways, because layouts read one protocol or the other', () => {
    // Mesa's native <slot /> reads the third argument (element children); a
    // layout written as {@render children?.()} reads the `children` prop.
    // Nothing bridges them, and no slot-rewrite runs on the prerender path, so
    // the wrapper cannot know which one a given layout speaks. Supplying both
    // renders correctly either way; the element children render the same
    // snippet, so the page is instantiated exactly once.
    const out = composeWrapper('/app/routes/index.mesa', ['/app/routes/_module.mesa'])
    expect(out).toContain('{#snippet s0()}')
    expect(out).toContain('<L0 children={s0}>{@render s0()}</L0>')
  })

  test('does not repeat the wrapped body — element children re-render the snippet', () => {
    const out = composeWrapper('/app/routes/index.mesa', ['/app/routes/_module.mesa'])
    expect(out.match(/<Page \{data\} \/>/g)).toHaveLength(1)
  })

  test('nests one snippet per layout, innermost declared first', () => {
    const out = composeWrapper('/app/routes/a/index.mesa', [
      '/app/routes/_module.mesa',
      '/app/routes/a/_module.mesa',
    ])
    expect(out).toContain('import L0 from "/app/routes/_module.mesa"')
    expect(out).toContain('import L1 from "/app/routes/a/_module.mesa"')
    // L1 (inner) wraps the page; L0 (outer) wraps L1.
    expect(out).toContain('<L0 children={s0}>{@render s0()}</L0>')
    // s0's body references s1, so s1 must be declared first — the other order
    // compiles and then throws "s1 is not defined" at render time.
    expect(out.indexOf('{#snippet s1()}')).toBeLessThan(out.indexOf('{#snippet s0()}'))
    expect(out.indexOf('{#snippet s0()}')).toBeLessThan(out.indexOf('<L0 children={s0}>'))
  })

  test('declares the data prop the page receives', () => {
    expect(composeWrapper('/p.mesa', [])).toContain('export let data = null')
  })
})

describe('layoutChainFor', () => {
  function fixture() {
    const dir = tmpDir('sierra-layouts-')
    const routes = resolve(dir, 'src/routes')
    mkdirSync(resolve(routes, 'leads'), { recursive: true })
    writeFileSync(resolve(routes, '_module.mesa'), '<slot />')
    writeFileSync(resolve(routes, 'leads/_module.mesa'), '<slot />')
    writeFileSync(resolve(routes, 'leads/index.mesa'), '<h1>x</h1>')
    writeFileSync(resolve(routes, 'index.mesa'), '<h1>home</h1>')
    return routes
  }

  test('collects every layout up the tree, outermost first', () => {
    const routes = fixture()
    const chain = layoutChainFor(resolve(routes, 'leads/index.mesa'), routes)
    // The node's own `layout` field carries only the NEAREST layout; using it
    // alone would drop the root chrome from every nested prerendered page.
    expect(chain).toHaveLength(2)
    expect(chain[0]).toContain('routes/_module.mesa')
    expect(chain[1]).toContain('routes/leads/_module.mesa')
  })

  test('returns just the root layout for a top-level route', () => {
    const routes = fixture()
    expect(layoutChainFor(resolve(routes, 'index.mesa'), routes)).toHaveLength(1)
  })

  test('returns an empty chain when there are no layouts', () => {
    const dir = tmpDir('sierra-nolayout-')
    const routes = resolve(dir, 'src/routes')
    mkdirSync(routes, { recursive: true })
    writeFileSync(resolve(routes, 'index.mesa'), '<h1>x</h1>')
    expect(layoutChainFor(resolve(routes, 'index.mesa'), routes)).toEqual([])
  })
})

describe('wrapDocument', () => {
  test('emits a complete document', () => {
    const out = wrapDocument('<h1>hi</h1>', { title: 'Page' })
    expect(out).toMatch(/^<!DOCTYPE html>/)
    expect(out).toContain('<title>Page</title>')
    expect(out).toContain('<h1>hi</h1>')
  })

  test('inlines scoped CSS', () => {
    expect(wrapDocument('<p></p>', { css: '.a{color:red}' })).toContain('<style>.a{color:red}</style>')
  })

  test('omits the style block when there is no CSS', () => {
    expect(wrapDocument('<p></p>', {})).not.toContain('<style>')
  })

  test('a description is emitted as a meta tag, escaped', () => {
    const out = wrapDocument('', { description: 'Tees & mugs for "shippers"' })
    expect(out).toContain('<meta name="description" content="Tees &amp; mugs for &quot;shippers&quot;">')
  })

  test('no description means no tag at all', () => {
    // Not an empty one. `content=""` is a page telling a crawler it has no
    // description, which is worse than saying nothing and letting it read the
    // page.
    expect(wrapDocument('<p></p>', { title: 'x' })).not.toContain('name="description"')
  })

  test('a class goes on <html>, which is where the theme switcher writes (FJS-501)', () => {
    const out = wrapDocument('<p></p>', { htmlClass: 'theme-elite', lang: 'en' })
    expect(out).toContain('<html lang="en" class="theme-elite">')
  })

  test('<html> carries no class attribute when none was asked for', () => {
    expect(wrapDocument('<p></p>', {})).toContain('<html lang="en">')
  })

  test('the two classes are independent — <body> keeps its own', () => {
    // They are not alternatives. An app class belongs on <body>; the THEME has
    // to be on <html> or the switcher, which writes <html>, is shadowed for
    // every token both of them define.
    const out = wrapDocument('<p></p>', { htmlClass: 'theme-dark', bodyClass: 'app' })
    expect(out).toContain('class="theme-dark"')
    expect(out).toContain('<body class="app">')
  })

  test('escapes the title', () => {
    expect(wrapDocument('', { title: 'a<b>&"' })).toContain('<title>a&lt;b&gt;&amp;&quot;</title>')
  })

  // A prerendered page is assembled here, not by Vite's HTML transform, so the
  // app's own stylesheet had no way in: `target: 'static'` shipped pages
  // carrying every @frontierjs/css class name and none of the rules behind
  // them. The <body> class is the other half — a theme is one class on an
  // ancestor, and index.html is where the SPA states it.
  test('links the stylesheets the build emitted', () => {
    const out = wrapDocument('<p></p>', { stylesheets: ['/assets/style-abc.css'] })
    expect(out).toContain('<link rel="stylesheet" href="/assets/style-abc.css">')
  })

  test('app stylesheets come before the page\'s own scoped styles', () => {
    const out = wrapDocument('<p></p>', {
      stylesheets: ['/assets/style-abc.css'],
      styles: [{ id: 'mhash', css: '.a{color:red}' }],
    })
    expect(out.indexOf('style-abc.css')).toBeLessThan(out.indexOf('<style id="mhash">'))
  })

  test('carries the configured body class', () => {
    expect(wrapDocument('<p></p>', { bodyClass: 'app theme-default' }))
      .toContain('<body class="app theme-default">')
  })

  test('a page with neither keeps a bare body and no link', () => {
    const out = wrapDocument('<p></p>', {})
    expect(out).toContain('<body>')
    expect(out).not.toContain('<link')
  })
})

describe('pathsForRoute', () => {
  const ROOT = resolve(__dirname, 'fixtures/static-site')

  test('a static route contributes exactly its own path', async () => {
    const out = await pathsForRoute({ path: '/about/', meta: {} }, ROOT)
    expect(out).toEqual([{ path: '/about/', params: {} }])
  })

  test('a dynamic route expands via getStaticPaths()', async () => {
    const out = await pathsForRoute({
      path: '/blog/:slug/',
      meta: { dynamic: true },
      companion: 'src/routes/blog/[slug].meta.js',
    }, ROOT)

    expect(out.map(p => p.path)).toEqual(['/blog/hello-world/', '/blog/second-post/'])
    expect(out[0].params).toEqual({ slug: 'hello-world' })
  })

  test('a dynamic route with no getStaticPaths yields nothing to emit', async () => {
    // scanner-plugin already fails the build for this; emitting a second,
    // worse error here would bury the useful one.
    const out = await pathsForRoute({
      path: '/blog/:tag/',
      meta: { dynamic: true },
      companion: 'src/routes/blog/[tag].meta.js',
    }, ROOT)
    expect(out).toEqual([])
  })
})

describe('prerenderRoutes', () => {
  const ROOT = resolve(__dirname, 'fixtures/static-site')

  // Every test below compiles real .mesa files through Mesa and renders them in
  // happy-dom, off disk. Vitest's 5s default is not a budget for that: the
  // suite runs files in parallel, and this one intermittently tipped over it
  // while passing comfortably in isolation.
  const REAL_RENDER_TIMEOUT = 30_000

  async function run(outDir) {
    const { renderComponent } = await import('@frontierjs/mesa/render-component.js')
    const { scan } = await import('../src/scanner/index.js')
    const tree = await scan('src/routes', { cwd: ROOT })
    return prerenderRoutes({ tree, root: ROOT, outDir, renderComponent })
  }

  test('head() gives each emitted path its own title and description', async () => {
    // The reason it exists: frontmatter is static text, so without this every
    // page of a dynamic route shares one <title> — the single field a search
    // result is built from.
    const out = tmpDir('sierra-head-')
    await run(out)

    const first  = readFileSync(resolve(out, 'blog/hello-world/index.html'), 'utf8')
    const second = readFileSync(resolve(out, 'blog/second-post/index.html'), 'utf8')

    expect(first).toContain('<title>Read hello-world — the blog</title>')
    expect(second).toContain('<title>Read second-post — the blog</title>')
    expect(first).toContain('<meta name="description" content="Everything about hello-world.">')
    expect(first).not.toBe(second)
  }, REAL_RENDER_TIMEOUT)

  test('a route with no head() keeps its frontmatter title', async () => {
    // The fallback is not the loser: a route whose pages genuinely share a
    // title says it once, and only a route that needs to vary writes the
    // function.
    const out = tmpDir('sierra-head-fm-')
    await run(out)
    // /about/ declares `title: About us` and has no companion at all.
    expect(readFileSync(resolve(out, 'about/index.html'), 'utf8'))
      .toContain('<title>About us</title>')
  }, REAL_RENDER_TIMEOUT)

  test('writes one file per enumerated path', async () => {
    const out = tmpDir('sierra-pre-')
    const res = await run(out)

    expect(res.written).toContain('blog/hello-world/index.html')
    expect(res.written).toContain('blog/second-post/index.html')
    expect(existsSync(resolve(out, 'blog/hello-world/index.html'))).toBe(true)
  }, REAL_RENDER_TIMEOUT)

  test('the emitted page carries data from load()', async () => {
    const out = tmpDir('sierra-pre-')
    await run(out)
    const html = readFileSync(resolve(out, 'blog/hello-world/index.html'), 'utf8')

    expect(html).toContain('Post: hello-world')
    expect(html).toMatch(/^<!DOCTYPE html>/)
  }, REAL_RENDER_TIMEOUT)

  test('routes without render:static are not emitted', async () => {
    const out = tmpDir('sierra-pre-')
    const res = await run(out)
    // The fixture's '/' route declares no render mode.
    expect(res.written).not.toContain('index.html')
  }, REAL_RENDER_TIMEOUT)

  test('renders the page INSIDE its layout chain', async () => {
    // The regression this pins: the wrapper composed with the `children` prop
    // only, so a layout using Mesa's native <slot /> rendered with an empty
    // slot — the chrome appeared, the page vanished, and nothing errored. The
    // string assertions on composeWrapper could not see it, and this fixture
    // had no layout at all, so nothing did.
    const out = tmpDir('sierra-pre-')
    await run(out)
    const html = readFileSync(resolve(out, 'blog/hello-world/index.html'), 'utf8')

    expect(html).toContain('site-header')          // outer layout, native <slot />
    expect(html).toContain('blog-nav')             // inner layout, `children` prop
    expect(html).toContain('Post: hello-world')    // the page itself

    // …and nested in that order, page innermost.
    expect(html.indexOf('site-header')).toBeLessThan(html.indexOf('blog-nav'))
    expect(html.indexOf('blog-nav')).toBeLessThan(html.indexOf('Post: hello-world'))
  }, REAL_RENDER_TIMEOUT)

  test('renders the page exactly once when both protocols are supplied', async () => {
    const out = tmpDir('sierra-pre-')
    await run(out)
    const html = readFileSync(resolve(out, 'blog/hello-world/index.html'), 'utf8')
    expect(html.match(/Post: hello-world/g)).toHaveLength(1)
  }, REAL_RENDER_TIMEOUT)

  test('reports what it skipped instead of failing silently', async () => {
    const out = tmpDir('sierra-pre-')
    const res = await run(out)
    expect(res.skipped.some(s => /no paths to emit/.test(s.reason))).toBe(true)
  }, REAL_RENDER_TIMEOUT)
})
