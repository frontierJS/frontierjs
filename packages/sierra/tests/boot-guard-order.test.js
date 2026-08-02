/**
 * tests/boot-guard-order.test.js
 *
 * initRouter() kicks off the boot navigation during virtual:sierra's module
 * evaluation. Guards registered by app code that mounts afterwards — App.mesa's
 * <script> — were appended to _beforeGuards only after the guard loop had
 * already run over an empty array. _navigate then awaits the lazy component
 * import, which yields long enough for the app to mount, so by the time the
 * _afterHooks loop runs the after-hook IS registered.
 *
 * Net effect: afterNavigate saw the boot navigation, beforeNavigate never did.
 * An auth guard therefore protected client-side navigation to a route but not a
 * direct page load or refresh of it.
 *
 * Fixed by deferring the boot navigation one microtask. These tests assert the
 * fixed behaviour — flip the second expectation in the first test to reproduce
 * the original bug.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import {
  initRouter, goto, beforeNavigate, afterNavigate, page, _resetPage,
} from '../src/router/index.js'

let _currentPath = '/'

function installWindowMock(initialPath = '/') {
  _currentPath = initialPath
  globalThis.window = {
    history: {
      scrollRestoration: 'auto', state: { index: 0 },
      replaceState(st, _, path) { if (path) _currentPath = path; this.state = { ...st } },
      pushState(st, _, path) { if (path) _currentPath = path; this.state = { ...st } },
      back() {}, forward() {},
    },
    location: {
      get pathname() { return _currentPath.split('?')[0] },
      get search() { return _currentPath.includes('?') ? '?' + _currentPath.split('?')[1] : '' },
    },
    scrollY: 0, scrollTo() {}, addEventListener() {},
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.document = {
    addEventListener() {}, getElementById() { return null },
    querySelectorAll() { return [] },
    body: { querySelectorAll: () => [], addEventListener() {} },
  }
}

function teardownWindowMock() {
  delete globalThis.window
  delete globalThis.document
}

function makeTree() {
  return {
    id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
    layout: null, meta: {}, params: [], children: [
      { id: 'dashboard', path: '/dashboard/', file: 'src/routes/dashboard/index.mesa',
        companion: null, layout: null, meta: {}, params: [], children: [] },
      { id: 'login', path: '/login/', file: 'src/routes/login/index.mesa',
        companion: null, layout: null, meta: {}, params: [], children: [] },
    ],
  }
}

function makeComponents(tree) {
  const map = {}
  ;(function walk(n) {
    if (n.file) map[n.id] = () => Promise.resolve({ default: function () {} })
    n.children?.forEach(walk)
  })(tree)
  return map
}

const settle = () => new Promise(r => setTimeout(r, 10))

// The router keeps _beforeGuards / _afterHooks in module scope and never clears
// them, so every registration must be unsubscribed or it leaks into later tests.
let _unsubs = []
const onBefore = (fn) => { const u = beforeNavigate(fn); _unsubs.push(u); return u }
const onAfter  = (fn) => { const u = afterNavigate(fn);  _unsubs.push(u); return u }

beforeEach(() => {
  installWindowMock('/')
  _resetPage()
})

afterEach(() => {
  for (const u of _unsubs) u()
  _unsubs = []
  teardownWindowMock()
})

describe('boot navigation hook ordering', () => {

  test('both hooks fire for the boot navigation', async () => {
    installWindowMock('/dashboard/')
    const tree = makeTree()

    // Real boot order: virtual:sierra evaluates initRouter, then App mounts.
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, {})

    const before = []
    const after = []
    onBefore(({ to }) => { before.push(to.path); return true })
    onAfter(({ to }) => { after.push(to.path) })

    await settle()

    expect(after).toEqual(['/dashboard/'])
    expect(before).toEqual(['/dashboard/'])   // was [] before the fix
  })

  test('both hooks fire for a subsequent client-side navigation', async () => {
    installWindowMock('/dashboard/')
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, {})

    const before = []
    const after = []
    onBefore(({ to }) => { before.push(to.path); return true })
    onAfter(({ to }) => { after.push(to.path) })
    await settle()

    await goto('/login/')
    await settle()

    // Boot is included in both — that is the fix.
    expect(before).toEqual(['/dashboard/', '/login/'])
    expect(after).toEqual(['/dashboard/', '/login/'])
  })

  test('a redirecting guard protects a direct load of the guarded route', async () => {
    installWindowMock('/dashboard/')
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, {})

    onBefore(({ to }) => {
      if (to.path.startsWith('/dashboard/')) return '/login/'
    })
    await settle()

    // Boot consults the guard and lands on /login/ instead of /dashboard/.
    expect(page.route?.id).toBe('login')

    await goto('/dashboard/')
    await settle()
    expect(page.route?.id).toBe('login')
  })
})
