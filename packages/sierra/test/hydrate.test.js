/**
 * test/hydrate.test.js — the `hydratable: true` half a unit test can decide:
 * where the flag may go, what a flagged page carries, and what it refuses.
 *
 * Adoption itself needs a build and a browser: `bun run test:hydrate` drives
 * `test/fixtures/hydrate-site/` in Chrome.
 */

import { describe, test, expect } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'

import { createSierraViteConfig } from '../src/build/index.js'
import { prerenderRoutes, wrapDocument, hydrateJson, HYDRATE_ROOT_STYLE } from '../src/build/prerender.js'
import { hydrateEntrySource } from '../src/build/island-bundle.js'
import { tmpDir } from './tmp.js'

describe('the flag', () => {
  test('mesa.hydratable is refused, pointing at the top-level key', () => {
    expect(() => createSierraViteConfig({ target: 'static', mesa: { hydratable: true } }))
      .toThrow(/mesa\.hydratable.*top-level `hydratable: true`/s)
  })

  test('a target that prerenders nothing is refused', () => {
    expect(() => createSierraViteConfig({ target: 'spa', hydratable: true })).toThrow(/hydratable.*spa/)
  })
})

describe('prerenderRoutes under the flag', () => {
  function fixture(meta = '', companion = null) {
    const root = tmpDir('sierra-hydrate-')
    mkdirSync(join(root, 'src/routes'), { recursive: true })
    writeFileSync(join(root, 'src/routes/index.mesa'), `---\nrender: static\n${meta}---\n<p>x</p>`)
    if (companion) writeFileSync(join(root, 'src/routes/index.meta.js'), companion)
    return root
  }
  const tree = (companion) => ({
    id: '/', path: '/', file: 'src/routes/index.mesa',
    ...(companion ? { companion: 'src/routes/index.meta.js' } : {}),
    meta: { render: 'static', title: 'Home' }, children: [],
  })
  const renderer = (seen) => async (src, opts) => {
    seen.push({ src, opts })
    return { html: '<p>page</p>', css: '', islands: [], exports: {} }
  }

  test('the render is flagged and writes no island markers', async () => {
    const root = fixture()
    const seen = []
    const res = await prerenderRoutes({ tree: tree(), root, outDir: 'dist', hydratable: true, renderComponent: renderer(seen) })
    expect(seen[0].opts.hydratable).toBe(true)
    expect(res.hydrate).toEqual([{ rel: 'index.html', wrapper: seen[0].src }])

    const html = readFileSync(join(root, 'dist/index.html'), 'utf8')
    expect(html).toContain('<div data-sierra-root><p>page</p></div>')
    expect(html).toContain(HYDRATE_ROOT_STYLE)
    const json = JSON.parse(html.match(/<script type="application\/json" data-sierra-data>(.*?)<\/script>/)[1])
    expect(json).toEqual({
      data: null,
      staticPage: { node: { id: '/', path: '/', meta: { render: 'static', title: 'Home' } }, pathname: '/', params: {} },
      state: {},
    })
  })

  test("the render's settled {#await} values travel in the same block", async () => {
    const root = fixture()
    const render = async () => ({ html: '<p>page</p>', css: '', islands: [], exports: {}, state: { '0 5h': { n: 7 } } })
    await prerenderRoutes({ tree: tree(), root, outDir: 'dist', hydratable: true, renderComponent: render })
    const html = readFileSync(join(root, 'dist/index.html'), 'utf8')
    expect(html.match(/data-sierra-data/g)).toHaveLength(1)
    const json = JSON.parse(html.match(/<script type="application\/json" data-sierra-data>(.*?)<\/script>/)[1])
    expect(json.state).toEqual({ '0 5h': { n: 7 } })
  })

  test('an {#await} value JSON would change is refused by route and key path', async () => {
    const root = fixture()
    const render = async () => ({ html: '<p>page</p>', css: '', islands: [], exports: {}, state: { '0 5h': { at: new Map() } } })
    await expect(prerenderRoutes({ tree: tree(), root, outDir: 'dist', hydratable: true, renderComponent: render }))
      .rejects.toThrow(/\/ \(\/\) — props\.state\.0 5h\.at is a Map/)
  })

  test('unflagged, the render and the page are what they were', async () => {
    const root = fixture()
    const seen = []
    const res = await prerenderRoutes({ tree: tree(), root, outDir: 'dist', renderComponent: renderer(seen) })
    expect('hydratable' in seen[0].opts).toBe(false)
    expect(res.hydrate).toEqual([])
    const html = readFileSync(join(root, 'dist/index.html'), 'utf8')
    expect(html).not.toMatch(/data-sierra-(root|data)|sierra-root/)
  })

  test('a load() value JSON would change is refused by route and key path', async () => {
    const root = fixture('', 'export const load = () => ({ rows: [{ at: new Map() }] })\n')
    await expect(prerenderRoutes({ tree: tree(true), root, outDir: 'dist', hydratable: true, renderComponent: renderer([]) }))
      .rejects.toThrow(/\/ \(\/\) — props\.data\.rows\[0\]\.at is a Map/)
  })

  test('a page the static-safety check refuses is not written, so its data is not embedded', async () => {
    // A schema is present and no client is, so a route whose load() reads data
    // cannot be proven publishable (FJS-081).
    const root = fixture('', 'export const load = () => ({ secret: 1 })\n')
    const undeclared = { ...tree(true), meta: { title: 'Home' } }
    const res = await prerenderRoutes({
      tree: undeclared, root, outDir: 'dist', hydratable: true, renderComponent: renderer([]),
      schemaDefs: {}, schemaModels: [],
    })
    expect(res.fallback.map((f) => f.route)).toEqual(['/'])
    expect(res.hydrate).toEqual([])
    expect(existsSync(join(root, 'dist/index.html'))).toBe(false)
  })
})

describe('the embedded data', () => {
  test('cannot close its script, and line separators are escaped', () => {
    const out = hydrateJson({ s: '</script><!-- \u2028\u2029' }, 'x')
    expect(out).not.toMatch(/<|\u2028|\u2029/)
    expect(JSON.parse(out)).toEqual({ s: '</script><!-- \u2028\u2029' })
  })

  test.each([
    [{ n: NaN }, /props\.n is NaN/],
    [{ f: () => 1 }, /props\.f is a function/],
    [{ u: undefined }, /props\.u is a undefined/],
    [{ m: new Map() }, /props\.m is a Map/],
    [{ b: 1n }, /props\.b is a bigint/],
  ])('refuses %o', (value, message) => {
    expect(() => hydrateJson(value, 'r')).toThrow(message)
  })

  test('a Date travels as its ISO string with its key path in datePaths', () => {
    const at = new Date('2026-11-21T15:04:00.000Z')
    const out = JSON.parse(hydrateJson({
      data:  { post: { publishedAt: at, 'a.b': [at] } },
      state: { '0.1k': { '3f': at } },
    }, 'r'))
    expect(out.data.post.publishedAt).toBe('2026-11-21T15:04:00.000Z')
    expect(out.datePaths).toEqual([
      ['data', 'post', 'publishedAt'], ['data', 'post', 'a.b', 0], ['state', '0.1k', '3f'],
    ])
  })

  test('a page with no Date carries no datePaths key, and an Invalid Date is refused', () => {
    expect(JSON.parse(hydrateJson({ data: { n: 1 } }, 'r'))).toEqual({ data: { n: 1 } })
    expect(() => hydrateJson({ data: { at: new Date('nope') } }, 'r'))
      .toThrow(/props\.data\.at is an Invalid Date/)
  })

  test('a value that contains itself is refused, a shared one is not', () => {
    const shared = { a: 1 }
    expect(() => hydrateJson({ x: shared, y: shared }, 'r')).not.toThrow()
    const loop = {}
    loop.self = loop
    expect(() => hydrateJson(loop, 'r')).toThrow(/props\.self is a value that contains itself/)
  })

  test('the root holds the render alone; the skip link and the data sit outside it', () => {
    const doc = wrapDocument('<main>m</main>', { hydrateJson: '{}', bodyEnd: '<i>end</i>' })
    expect(doc).toMatch(/<a class="skip-link"[^]*<div data-sierra-root><main>m<\/main><\/div>\n<script type="application\/json" data-sierra-data>\{\}<\/script>\n<i>end<\/i>/)
  })
})

describe('the entry', () => {
  test('adopts the root with the page data and the route stub', () => {
    const src = hydrateEntrySource('/app/node_modules/.sierra/hydrate/route-x.mesa', { prefix: 'app' })
    expect(src).toContain(`import Wrapper from "/app/node_modules/.sierra/hydrate/route-x.mesa"`)
    expect(src).toContain(`setPrefix("app")`)
    expect(src).toContain('hydrate(root, Wrapper, { data, staticPage: { ...staticPage, data } }, { state })')
  })

  test('turns each path in datePaths back into a Date before the route runs', () => {
    const src = hydrateEntrySource('/w.mesa')
    const revive = src.slice(src.indexOf('const page = '), src.indexOf('const { data, staticPage, state } = page'))
    const json = hydrateJson({ data: { at: new Date('2026-11-21T15:04:00.000Z'), rows: [{ at: new Date(0) }] } }, 'r')
    const page = new Function('json', `${revive}; return page`)({ textContent: json })
    expect(page.data.at).toBeInstanceOf(Date)
    expect(page.data.at.toISOString()).toBe('2026-11-21T15:04:00.000Z')
    expect(page.data.rows[0].at.getTime()).toBe(0)
  })
})
