/**
 * test/load-url.test.js — what a companion's `url` is (`FJS-2718`)
 *
 * `load({ url })` and `head({ url })` are handed a STRING, path plus search, in
 * the router and in the static build alike. `url.search` on a string is
 * String.prototype.search, a function, so a redirect built from it sent a path
 * made of function source and no query. The contract is stated in AGENTS.md; this
 * pins the value it describes.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { initRouter, page, _resetPage } from '../src/router/index.js'

const TREE = {
  id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
  layout: null, meta: {}, params: [], children: [
    {
      id: 'surveys', path: '/surveys/', file: 'src/routes/surveys/index.mesa',
      companion: 'src/routes/surveys/index.meta.js', layout: null,
      meta: {}, params: [], children: [],
    },
  ],
}

const components = () => ({
  root:    () => Promise.resolve({ default() {} }),
  surveys: () => Promise.resolve({ default() {} }),
})

function installWindowMock(path) {
  let _path = path
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
    title: '',
    addEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
    body: { addEventListener() {}, querySelectorAll: () => [] },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
}

const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => { _resetPage() })
afterEach(() => { delete globalThis.window; delete globalThis.document })

describe('the url a companion is handed', () => {
  test('load() and head() get path + search as one string, not a URL', async () => {
    installWindowMock('/surveys/?status=open')
    const seen = {}
    const loaders = {
      surveys: () => Promise.resolve({
        load: ({ url }) => { seen.load = url; return null },
        head: ({ url }) => { seen.head = url; return {} },
      }),
    }
    initRouter(TREE, components(), loaders, { trailingSlash: 'always' })
    await settle()
    expect(page.data).toBeNull()
    expect(seen.load).toBe('/surveys/?status=open')
    expect(seen.head).toBe('/surveys/?status=open')
    expect(typeof seen.load.search).toBe('function')
  })
})
