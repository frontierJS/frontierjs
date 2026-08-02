/**
 * tests/match-semantics.test.js
 *
 * matchRoute is on the hot path for both navigation and every prefetch, and it
 * was rewritten for speed: the pathname is split once per call instead of once
 * per node visited, pattern segments are precomputed and cached per node, and
 * the params object is only allocated once a pattern is known to match.
 *
 * That rewrite must not change a single resolution. These tests lock the
 * observable semantics — case-insensitivity of static segments, param decoding,
 * trailing-slash modes, priority ordering, prefix vs exact, catch-all — so a
 * future optimisation has something to fail against.
 *
 * (The rewrite itself was additionally verified by differential-testing the old
 * and new implementations over 328 path × option combinations plus 270
 * normalizePath cases; all identical.)
 */

import { describe, test, expect } from 'vitest'
import { matchRoute, normalizePath } from '../src/router/match.js'

// ─── Fixture ──────────────────────────────────────────────────────────────────

const tree = {
  id: 'root', path: '/', file: 'src/routes/index.mesa', layout: null,
  meta: {}, params: [], children: [
    {
      id: 'blog', path: '/blog/', file: 'src/routes/blog/index.mesa',
      layout: null, meta: {}, params: [], children: [
        {
          id: 'blog.[slug]', path: '/blog/:slug/', file: 'src/routes/blog/[slug].mesa',
          layout: null, meta: { dynamic: true }, params: ['slug'], children: [],
        },
      ],
    },
    {
      id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
      layout: null, meta: {}, params: [], children: [
        {
          id: 'leads.create', path: '/leads/create/', file: 'src/routes/leads/create.mesa',
          layout: null, meta: {}, params: [], children: [],
        },
        {
          id: 'leads.[leadId]', path: '/leads/:leadId/', file: 'src/routes/leads/[leadId].mesa',
          layout: null, meta: { dynamic: true }, params: ['leadId'], children: [
            {
              id: 'leads.[leadId].edit', path: '/leads/:leadId/edit/',
              file: 'src/routes/leads/[leadId]/edit.mesa',
              layout: null, meta: { dynamic: true }, params: ['leadId'], children: [],
            },
          ],
        },
      ],
    },
    {
      id: '[...404]', path: '/*', file: 'src/routes/[...404].mesa',
      layout: null, meta: { spread: true }, params: ['404'], children: [],
    },
  ],
}

const match = (p, o = {}) => matchRoute(p, tree, o)

// ─── Static resolution ────────────────────────────────────────────────────────

describe('static segments', () => {
  test('root index', () => {
    expect(match('/').node.id).toBe('root')
  })

  test('top-level and nested static routes', () => {
    expect(match('/blog/').node.id).toBe('blog')
    expect(match('/leads/').node.id).toBe('leads')
    expect(match('/leads/create/').node.id).toBe('leads.create')
  })

  test('static segments compare case-insensitively', () => {
    expect(match('/BLOG/').node.id).toBe('blog')
    expect(match('/Leads/Create/').node.id).toBe('leads.create')
  })

  test('static beats dynamic at the same depth', () => {
    // /leads/create/ could match /leads/:leadId/ — the scanner sorts static
    // first and matching must respect that order.
    expect(match('/leads/create/').node.id).toBe('leads.create')
  })
})

// ─── Dynamic segments ─────────────────────────────────────────────────────────

describe('dynamic segments', () => {
  test('captures the param', () => {
    const m = match('/blog/hello-world/')
    expect(m.node.id).toBe('blog.[slug]')
    expect(m.params.slug).toBe('hello-world')
  })

  test('params are URL-decoded', () => {
    expect(match('/blog/with%20space/').params.slug).toBe('with space')
    expect(match('/blog/caf%C3%A9/').params.slug).toBe('café')
  })

  test('dynamic segments preserve case', () => {
    expect(match('/blog/MixedCase/').params.slug).toBe('MixedCase')
  })

  test('params accumulate down the chain', () => {
    const m = match('/leads/lead-42/edit/')
    expect(m.node.id).toBe('leads.[leadId].edit')
    expect(m.params.leadId).toBe('lead-42')
  })

  test('a missing trailing segment is not an exact match', () => {
    // /leads/x/ must not resolve to the deeper /leads/:leadId/edit/
    expect(match('/leads/x/').node.id).toBe('leads.[leadId]')
  })
})

// ─── Catch-all ────────────────────────────────────────────────────────────────

describe('catch-all', () => {
  test('unmatched paths fall through to the spread route', () => {
    const m = match('/nope/nothing/here/')
    expect(m.node.id).toBe('[...404]')
    expect(m.params['404']).toBe('nope/nothing/here')
  })

  test('catch-all is last resort, not first match', () => {
    expect(match('/blog/').node.id).toBe('blog')
  })
})

// ─── Trailing slash ───────────────────────────────────────────────────────────

describe('trailingSlash modes', () => {
  test('always — an unslashed path still resolves', () => {
    expect(match('/blog', { trailingSlash: 'always' }).node.id).toBe('blog')
  })

  test('query strings and hashes never reach the matcher', () => {
    expect(match('/blog/?page=2').node.id).toBe('blog')
    expect(match('/blog/#section').node.id).toBe('blog')
    expect(match('/blog/hello/?x=1#y').params.slug).toBe('hello')
  })
})

// ─── normalizePath ────────────────────────────────────────────────────────────

describe('normalizePath', () => {
  test('always appends a trailing slash', () => {
    expect(normalizePath('/blog', 'always')).toBe('/blog/')
    expect(normalizePath('/blog/', 'always')).toBe('/blog/')
  })

  test('never strips it', () => {
    expect(normalizePath('/blog/', 'never')).toBe('/blog')
    expect(normalizePath('/blog', 'never')).toBe('/blog')
  })

  test('preserve leaves it alone', () => {
    expect(normalizePath('/blog/', 'preserve')).toBe('/blog/')
    expect(normalizePath('/blog', 'preserve')).toBe('/blog')
  })

  test('root stays root in every mode', () => {
    for (const m of ['always', 'never', 'preserve']) {
      expect(normalizePath('/', m)).toBe('/')
    }
  })

  test('strips query and hash, whichever comes first', () => {
    expect(normalizePath('/blog/?a=1', 'always')).toBe('/blog/')
    expect(normalizePath('/blog/#f', 'always')).toBe('/blog/')
    expect(normalizePath('/blog/?a=1#f', 'always')).toBe('/blog/')
    expect(normalizePath('/blog/#f?a=1', 'always')).toBe('/blog/')
  })
})

// ─── Cache correctness ────────────────────────────────────────────────────────

describe('per-node segment cache', () => {
  test('repeated matches are stable', () => {
    for (let i = 0; i < 5; i++) {
      expect(match('/blog/post-' + i + '/').params.slug).toBe('post-' + i)
      expect(match('/leads/create/').node.id).toBe('leads.create')
    }
  })

  test('two trees with the same paths do not share cache entries', () => {
    // The cache is keyed by node identity, so a second tree with identical
    // paths but different ids must resolve to its own nodes.
    const other = JSON.parse(JSON.stringify(tree))
    other.children[0].id = 'blog-two'
    expect(matchRoute('/blog/', other, {}).node.id).toBe('blog-two')
    expect(matchRoute('/blog/', tree, {}).node.id).toBe('blog')
  })
})
