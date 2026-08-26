/**
 * tests/document-title.test.js — the title the tab shows (`FJS-389`)
 *
 * `title` is an ordinary frontmatter key, and the STATIC target has always done
 * the other half properly: `prerender.js` writes a real `<title>` into every
 * emitted file. The SPA wrote none at all, so every route of an app showed
 * whatever `index.html` hardcoded — one string for all of `example`, one for all
 * of basecamp.
 *
 * What that costs is not cosmetic: a bookmark, a history entry and a tab all
 * name the app instead of the page, and a screen reader announces the same
 * document name on every navigation, which is what a title is FOR once first
 * paint is over.
 *
 * The order under test is the static target's own — head(), then frontmatter,
 * then what the document booted with — because two halves of one feature that
 * disagree about where a title comes from is worse than the original bug.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { initRouter, goto, page, _resetPage } from '../src/router/index.js'

const TREE = {
  id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
  layout: null, meta: {}, params: [], children: [
    {
      id: 'orders', path: '/orders/', file: 'src/routes/orders/index.mesa',
      companion: null, layout: null, meta: { title: 'Orders' }, params: [], children: [
        {
          id: 'orders.[id]', path: '/orders/:id/', file: 'src/routes/orders/[id].mesa',
          companion: 'src/routes/orders/[id].meta.js', layout: null,
          meta: { title: 'An order' }, params: ['id'], children: [],
        },
      ],
    },
    {
      id: 'plain', path: '/plain/', file: 'src/routes/plain/index.mesa', companion: null,
      layout: null, meta: {}, params: [], children: [],
    },
  ],
}

const components = () => ({
  root:         () => Promise.resolve({ default() {} }),
  orders:       () => Promise.resolve({ default() {} }),
  'orders.[id]': () => Promise.resolve({ default() {} }),
  plain:        () => Promise.resolve({ default() {} }),
})

let _path = '/'

function installWindowMock(initial = '/', bootTitle = 'Kitchen sink') {
  _path = initial
  globalThis.window = {
    history: {
      scrollRestoration: 'auto',
      state: { index: 0 },
      replaceState(state, _, p) { if (p) _path = p; this.state = { ...state } },
      pushState(state, _, p)    { if (p) _path = p; this.state = { ...state } },
    },
    location: {
      get pathname() { return _path.split('?')[0] },
      get search()   { return _path.includes('?') ? '?' + _path.split('?')[1] : '' },
    },
    scrollY: 0,
    scrollTo() {},
    addEventListener() {},
  }
  globalThis.document = {
    title: bootTitle,
    addEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
    body: { addEventListener() {}, querySelectorAll: () => [] },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
}

const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => { _resetPage() })
afterEach(() => { delete globalThis.window; delete globalThis.document })

describe('a route puts its own title in the tab', () => {

  test('frontmatter title reaches document.title', async () => {
    installWindowMock('/orders/')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()
    expect(document.title).toBe('Orders')
  })

  test('it follows a client navigation, which is where a prerendered app goes stale', async () => {
    installWindowMock('/')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()
    await goto('/orders/')
    await settle()
    expect(document.title).toBe('Orders')
  })

  test('a route declaring none puts the document\'s own title back', async () => {
    // Not the previous page's. A per-navigation title has this failure and a
    // static one does not, so it is the one worth pinning.
    installWindowMock('/orders/')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()
    expect(document.title).toBe('Orders')
    await goto('/plain/')
    await settle()
    expect(document.title).toBe('Kitchen sink')
  })

  test('head() wins over frontmatter, and is answered per PATH', async () => {
    // The case the function exists for: thirteen product pages share one
    // frontmatter, and frontmatter is static text.
    installWindowMock('/orders/7/')
    const loaders = {
      'orders.[id]': () => Promise.resolve({
        load:  ({ params }) => ({ ref: `SO-${params.id}` }),
        head:  ({ data })   => ({ title: `Order ${data.ref}` }),
      }),
    }
    initRouter(TREE, components(), loaders, { trailingSlash: 'always' })
    await settle()
    expect(page.data).toEqual({ ref: 'SO-7' })
    expect(document.title).toBe('Order SO-7')
  })

  test('a head() that throws falls back to frontmatter rather than to nothing', async () => {
    installWindowMock('/orders/7/')
    const loaders = {
      'orders.[id]': () => Promise.resolve({
        head: () => { throw new Error('no') },
      }),
    }
    initRouter(TREE, components(), loaders, { trailingSlash: 'always' })
    await settle()
    expect(document.title).toBe('An order')
  })

  test('`title` stays an ordinary frontmatter key — {page.title} still renders', async () => {
    // Claiming it for the router would empty every heading in the docs.
    installWindowMock('/orders/')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()
    expect(page.title).toBe('Orders')
  })
})
