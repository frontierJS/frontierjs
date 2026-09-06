/**
 * tests/prefetch-skip.test.js — the routes a hover must not warm.
 *
 * Prefetch is a second navigator: it matches a URL, imports a chunk and runs
 * `load()`. What it does not share with the first one is the two facts that
 * decide whether the router will ever render that node at that URL —
 * `meta.redirect`, which _navigate replaces before rendering, and `meta.spread`,
 * which _handleClick declines to intercept at all. Warming either spends a real
 * authenticated round trip on a page nobody lands on (`FJS-820` (f)).
 *
 * The guard chain is deliberately still not consulted, and the last test here
 * pins that as a stated boundary rather than leaving it to be rediscovered:
 * guards are app functions that may await and may redirect, so running them on
 * hover costs more than the fetch it would save.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import {
  prefetchHref, _prefetchCache, _resetPrefetch, initPrefetch,
} from '../src/router/prefetch.js'

let loadCalls = []
let chunkImports = []

function makeTree() {
  const leaf = (id, path, meta) => ({
    id, path, file: `src/routes/${id}.mesa`, companion: `src/routes/${id}.meta.js`,
    layout: null, meta, params: [], children: [],
  })
  return {
    id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
    layout: null, meta: {}, params: [], children: [
      leaf('docs',   '/docs/',   {}),
      leaf('old',    '/old/',    { redirect: '/docs/' }),
      leaf('files',  '/files/',  { spread: true }),
      leaf('admin',  '/admin/',  {}),
    ],
  }
}

const factories = (ids) => Object.fromEntries(ids.map(id => [id, () => {
  chunkImports.push(id)
  return Promise.resolve({ default() {} })
}]))

const loaders = (ids) => Object.fromEntries(ids.map(id => [id, () => Promise.resolve({
  load: async () => { loadCalls.push(id); return { id } },
})]))

const IDS = ['docs', 'old', 'files', 'admin']

function installDom() {
  globalThis.window = {
    location: { origin: 'http://localhost', href: 'http://localhost/', pathname: '/', search: '' },
    addEventListener() {},
  }
  globalThis.document = {
    addEventListener() {}, querySelectorAll() { return [] },
    body: { addEventListener() {}, querySelectorAll: () => [] },
  }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
}

const settle = () => new Promise(r => setTimeout(r, 5))

beforeEach(() => {
  loadCalls = []
  chunkImports = []
  installDom()
  _resetPrefetch()
  initPrefetch(makeTree(), factories(IDS), loaders(IDS), { trailingSlash: 'always' })
})

afterEach(() => {
  _resetPrefetch()
  delete globalThis.window
  delete globalThis.document
})

describe('prefetch skips routes the router would never render', () => {
  test('a meta.redirect route is not warmed — no load(), no chunk, no cache entry', async () => {
    await prefetchHref('http://localhost/old/')
    await settle()
    expect(loadCalls).toEqual([])
    expect(chunkImports).toEqual([])
    expect([..._prefetchCache.keys()]).toEqual([])
  })

  test('a meta.spread route is not warmed either — the click is a full page load', async () => {
    await prefetchHref('http://localhost/files/')
    await settle()
    expect(loadCalls).toEqual([])
    expect(_prefetchCache.size).toBe(0)
  })

  // The negative control. A skip that refused everything would satisfy both
  // assertions above and turn prefetch off (`FJS-351`).
  test('an ordinary route is still warmed', async () => {
    await prefetchHref('http://localhost/docs/')
    await settle()
    expect(loadCalls).toEqual(['docs'])
    expect(chunkImports).toEqual(['docs'])
    expect([..._prefetchCache.keys()]).toEqual(['docs:/docs/'])
  })

  test('a guard does NOT gate a prefetch — stated, so an app puts the check in load()', async () => {
    // There is no seam here to register a guard against on purpose: guards live
    // in the router and prefetch never reads them. The assertion is that the
    // authenticated round trip happens, which is what an app has to know.
    await prefetchHref('http://localhost/admin/')
    await settle()
    expect(loadCalls).toEqual(['admin'])
  })
})
