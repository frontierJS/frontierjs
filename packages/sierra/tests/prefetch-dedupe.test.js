/**
 * tests/prefetch-dedupe.test.js
 *
 * The dedupe gate used to be keyed by route id:
 *
 *   if (_prefetched.has(node.id)) return
 *   _prefetched.add(node.id)
 *
 * so a dynamic route prefetched exactly once per session — hovering
 * /blog/alpha/ permanently blocked /blog/beta/ and /blog/gamma/. Meanwhile the
 * cache it populated was keyed `${node.id}:${pathname}${search}`, per-URL. The
 * gate was coarser than the thing it gated, and the mismatch was invisible:
 * prefetch failures are silent by design, so the only symptom was that
 * navigation felt slow for every slug after the first.
 *
 * Also covers the cache bounds added at the same time — it was previously
 * unbounded with no expiry, so anything prefetched and never visited held its
 * full load() payload for the session.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  prefetchHref,
  _prefetchCache,
  _prefetchCacheHas,
  _prefetchCacheTake,
  _resetPrefetch,
  initPrefetch,
} from '../src/router/prefetch.js'

// ─── Fixture ──────────────────────────────────────────────────────────────────

function makeTree() {
  return {
    id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
    layout: null, meta: {}, params: [], children: [
      {
        id: 'blog', path: '/blog/', file: 'src/routes/blog/index.mesa',
        companion: null, layout: null, meta: {}, params: [], children: [
          {
            id: 'blog.[slug]', path: '/blog/:slug/',
            file: 'src/routes/blog/[slug].mesa',
            companion: 'src/routes/blog/[slug].meta.js',
            layout: null, meta: { dynamic: true }, params: ['slug'], children: [],
          },
        ],
      },
    ],
  }
}

let loadCalls = []
let chunkImports = []

function makeComponents() {
  return {
    'blog':        () => { chunkImports.push('blog');        return Promise.resolve({ default() {} }) },
    'blog.[slug]': () => { chunkImports.push('blog.[slug]'); return Promise.resolve({ default() {} }) },
  }
}

function makeLoaders() {
  return {
    'blog.[slug]': () => Promise.resolve({
      load: async ({ params }) => {
        loadCalls.push(params.slug)
        return { post: { slug: params.slug } }
      },
    }),
  }
}

function installDom() {
  globalThis.window = {
    location: { origin: 'http://localhost', pathname: '/', search: '' },
    addEventListener() {},
    fetch: () => Promise.resolve(new Response('{}')),
  }
  globalThis.document = {
    addEventListener() {},
    querySelectorAll() { return [] },
    body: { addEventListener() {}, querySelectorAll: () => [] },
  }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.requestIdleCallback = (fn) => setTimeout(fn, 0)
}

const settle = () => new Promise(r => setTimeout(r, 5))

beforeEach(() => {
  loadCalls = []
  chunkImports = []
  installDom()
  _resetPrefetch()
  initPrefetch(makeTree(), makeComponents(), makeLoaders(), { trailingSlash: 'always' })
})

afterEach(() => {
  _resetPrefetch()
  vi.useRealTimers()
  delete globalThis.window
  delete globalThis.document
})

// ─── Dedupe ───────────────────────────────────────────────────────────────────

describe('prefetch dedupe is keyed per URL', () => {
  test('every slug of a dynamic route prefetches', async () => {
    await prefetchHref('http://localhost/blog/alpha/')
    await prefetchHref('http://localhost/blog/beta/')
    await prefetchHref('http://localhost/blog/gamma/')
    await settle()

    // Previously this was ['alpha'] — the first slug blocked the rest.
    expect(loadCalls).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('the same URL twice only prefetches once', async () => {
    await prefetchHref('http://localhost/blog/alpha/')
    await prefetchHref('http://localhost/blog/alpha/')
    await settle()
    expect(loadCalls).toEqual(['alpha'])
  })

  test('query strings distinguish cache entries', async () => {
    await prefetchHref('http://localhost/blog/alpha/?page=1')
    await prefetchHref('http://localhost/blog/alpha/?page=2')
    await settle()
    expect(loadCalls).toEqual(['alpha', 'alpha'])
    expect(_prefetchCache.size).toBe(2)
  })

  test('the shared component chunk is still imported only once', async () => {
    await prefetchHref('http://localhost/blog/alpha/')
    await prefetchHref('http://localhost/blog/beta/')
    await settle()
    // Per-URL dedupe must not cause the same chunk to be re-imported per slug.
    expect(chunkImports.filter(c => c === 'blog.[slug]')).toHaveLength(1)
  })

  test('unmatched and external URLs are ignored', async () => {
    await prefetchHref('https://example.com/blog/alpha/')
    await prefetchHref('http://localhost/nope/nothing/here/')
    await settle()
    expect(loadCalls).toEqual([])
  })
})

// ─── Cache bounds ─────────────────────────────────────────────────────────────

describe('prefetch cache is bounded and expires', () => {
  test('cache does not grow past its cap', async () => {
    for (let i = 0; i < 50; i++) {
      await prefetchHref(`http://localhost/blog/post-${i}/`)
    }
    await settle()
    expect(loadCalls).toHaveLength(50)          // all 50 prefetched
    expect(_prefetchCache.size).toBeLessThanOrEqual(32)   // but only 32 retained
  })

  test('oldest entries are evicted first', async () => {
    for (let i = 0; i < 40; i++) {
      await prefetchHref(`http://localhost/blog/post-${i}/`)
    }
    await settle()
    expect(_prefetchCacheHas('blog.[slug]:/blog/post-0/')).toBe(false)
    expect(_prefetchCacheHas('blog.[slug]:/blog/post-39/')).toBe(true)
  })

  test('entries expire after the TTL', async () => {
    await prefetchHref('http://localhost/blog/alpha/')
    await settle()
    const key = 'blog.[slug]:/blog/alpha/'
    expect(_prefetchCacheHas(key)).toBe(true)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    expect(_prefetchCacheHas(key)).toBe(false)
    expect(_prefetchCacheTake(key)).toBeUndefined()
  })

  test('taking an entry consumes it', async () => {
    await prefetchHref('http://localhost/blog/alpha/')
    await settle()
    const key = 'blog.[slug]:/blog/alpha/'
    expect(_prefetchCacheTake(key)).toEqual({ post: { slug: 'alpha' } })
    expect(_prefetchCacheHas(key)).toBe(false)
  })

  test('an expired URL can be prefetched again', async () => {
    await prefetchHref('http://localhost/blog/alpha/')
    await settle()
    expect(loadCalls).toEqual(['alpha'])

    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000)
    _prefetchCacheHas('blog.[slug]:/blog/alpha/')   // expiry releases the gate

    await prefetchHref('http://localhost/blog/alpha/')
    await settle()
    expect(loadCalls).toEqual(['alpha', 'alpha'])
  })
})
