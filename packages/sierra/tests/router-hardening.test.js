/**
 * tests/router-hardening.test.js — the second door into each room
 *
 * Every case here is a path the router already handled correctly at one
 * entrance and not at the other, and every one of them was green in the 1146
 * tests that preceded this file. The shape to avoid repeating is
 * `navigation.test.js`'s `page.route.id === 'login'` after a `goto` — true
 * whether or not the guard ran, because the guard's own redirect and the boot
 * navigation both produce it. Each test below is written so that reverting the
 * one source change it names turns it red.
 *
 * Ids: FJS-789 (guards on Back), FJS-790 (relative/fragment hrefs),
 * FJS-791 (an abandoned load winning the race), FJS-792 (a malformed escape),
 * FJS-793 (the click eaten before the match), FJS-794 (no default export),
 * FJS-795 (a redirect ping-pong), FJS-820 (the popstate fragment, isActive's
 * word boundary, double init, a refused redirect, an SVG link, the scroll map).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'

import {
  initRouter, goto, beforeNavigate, isActive, page, _resetPage,
} from '../src/router/index.js'
import { matchRoute } from '../src/router/match.js'
import { _resetInternals } from '../src/router/internals.js'
import { _resetPrefetch } from '../src/router/prefetch.js'

// ─── environment ──────────────────────────────────────────────────────────────
// A real listener registry, so popstate and click can actually be FIRED. The
// mock in navigation.test.js swallows registrations, which is why nothing there
// could ever ask what the Back button does.

const S = {
  path: '/', index: 0, win: {}, doc: {},
  go: [], scrolledTo: [], lookedUp: [], reported: [],
}

function install(initialPath = '/') {
  S.path = initialPath
  S.index = 0
  S.win = {}
  S.doc = {}
  S.go = []
  S.scrolledTo = []
  S.lookedUp = []
  S.reported = []

  globalThis.window = {
    history: {
      scrollRestoration: 'auto',
      state: { index: 0 },
      replaceState(st, _, path) { if (path) S.path = path; this.state = { ...st } },
      pushState(st, _, path) { if (path) S.path = path; S.index++; this.state = { ...st, index: S.index } },
      back() {}, forward() {},
      go(delta) { S.go.push(delta) },
    },
    location: {
      origin: 'http://localhost',
      get href() { return 'http://localhost' + S.path },
      get pathname() { return S.path.split('#')[0].split('?')[0] },
      get search() { const b = S.path.split('#')[0]; return b.includes('?') ? '?' + b.split('?')[1] : '' },
      get hash() { return S.path.includes('#') ? '#' + S.path.split('#')[1] : '' },
    },
    scrollY: 0,
    scrollTo() {},
    addEventListener(ev, fn) { (S.win[ev] ??= []).push(fn) },
    // The dev overlay's hook. _reportError prefers it, so this is how a test
    // reads a diagnosis the router made rather than a console line.
    __sierraReportError(data) { S.reported.push(data) },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.document = {
    title: 'App',
    addEventListener(ev, fn) { (S.doc[ev] ??= []).push(fn) },
    getElementById(id) {
      S.lookedUp.push(id)
      return { scrollIntoView() { S.scrolledTo.push(id) } }
    },
    querySelectorAll() { return [] },
    body: { querySelectorAll: () => [], addEventListener() {} },
  }
}

const tick = (n = 5) => new Promise(r => setTimeout(r, n))

function firePopstate() { for (const fn of S.win.popstate ?? []) fn({ state: window.history.state }) }

function clickLink(href, attrs = {}, { svg = false } = {}) {
  // `svg: true` reproduces what Chrome actually reports for an inline SVG
  // anchor, measured rather than assumed: `tagName` keeps its lowercase
  // qualified name, and `.href` is an SVGAnimatedString — truthy, and not a
  // string. Both facts are why the router walked past it.
  const el = svg
    ? {
      tagName: 'a',
      href: { baseVal: href, animVal: href },
      getAttribute: (k) => (k === 'href' ? href : null),
      hasAttribute: (k) => !!attrs[k],
    }
    : {
      tagName: 'A',
      getAttribute: (k) => (k === 'href' ? href : null),
      hasAttribute: (k) => !!attrs[k],
    }
  const ev = {
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    button: 0, defaultPrevented: false,
    composedPath: () => [el],
    prevented: false,
    preventDefault() { this.prevented = true },
  }
  for (const fn of S.doc.click ?? []) fn(ev)
  return ev
}

// ─── fixture ──────────────────────────────────────────────────────────────────

function makeTree() {
  const n = (id, path, extra = {}) => ({
    id, path, file: `src/routes/${id}.mesa`, companion: null, layout: null,
    meta: {}, params: [], children: [], ...extra,
  })
  return {
    id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
    layout: null, meta: { title: 'Home' }, params: [], children: [
      n('admin', '/admin/', { meta: { title: 'Admin' } }),
      n('login', '/login/', { meta: { title: 'Login' } }),
      n('leads', '/leads/'),
      n('leads-archive', '/leads-archive/'),
      n('slow', '/slow/', { companion: 'src/routes/slow.meta.js' }),
      n('fast', '/fast/', { companion: 'src/routes/fast.meta.js' }),
      n('blog', '/blog/', { children: [n('blog.[slug]', '/blog/:slug/', { params: ['slug'] })] }),
      n('[...404]', '/*', { meta: { title: 'Not Found', spread: true }, params: ['404'] }),
    ],
  }
}

function makeComponents(tree) {
  const map = {}
  ;(function walk(node) {
    if (node.file) map[node.id] = () => Promise.resolve({ default: function () {}, _name: node.id })
    node.children?.forEach(walk)
  })(tree)
  return map
}

const unsubs = []
function guard(fn) { unsubs.push(beforeNavigate(fn)) }

async function boot(path = '/', { loaders = {}, components, options = {} } = {}) {
  install(path)
  const tree = makeTree()
  initRouter(tree, components ?? makeComponents(tree), loaders, { trailingSlash: 'always', ...options })
  await tick(10)
  return tree
}

beforeEach(() => {
  _resetInternals()
  _resetPrefetch()
  _resetPage()
})

afterEach(() => {
  while (unsubs.length) unsubs.pop()()
  delete globalThis.window
  delete globalThis.document
})

// ─── FJS-789 — the Back button walks past every guard ────────────────────────

describe('guards and the Back button (FJS-789)', () => {
  // The count is the assertion. `page.route === 'login'` alone is true against
  // the broken code too — the boot navigation already left it there.
  test('a guard is consulted on popstate, not only on goto', async () => {
    await boot('/login/')
    const seen = []
    guard(({ to }) => {
      seen.push(to.path)
      return to.path.startsWith('/admin/') ? '/login/' : true
    })
    const before = seen.length

    S.path = '/admin/'
    firePopstate()
    await tick(10)

    expect(seen.length).toBeGreaterThan(before)
    expect(seen).toContain('/admin/')
    expect(page.route?.id).toBe('login')
  })

  // A refusal that does not put the address bar back leaves the URL naming the
  // page the guard just declined, which is the same lie as not guarding at all.
  test('a cancelled popstate puts the address bar back', async () => {
    await boot('/login/')
    guard(({ to }) => !to.path.startsWith('/admin/'))

    window.history.state = { index: 3 }
    S.path = '/admin/'
    firePopstate()
    await tick(10)

    expect(page.route?.id).toBe('login')
    expect(S.go.length).toBe(1)
    expect(S.go[0]).toBeLessThan(0)   // back to where the reader was
  })

  // The asymmetry that made this a bug rather than a policy: meta.redirect sat
  // BELOW the same fence and always fired on Back. It must still.
  test('meta.redirect still fires on popstate', async () => {
    install('/')
    const tree = makeTree()
    tree.children.find(n => n.id === 'admin').meta.redirect = '/login/'
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await tick(10)

    S.path = '/admin/'
    firePopstate()
    await tick(10)
    expect(page.route?.id).toBe('login')
  })

  // HMR keeps its exemption — that half of the condition was always justified.
  test('a guard does not run on the HMR re-navigation', async () => {
    const tree = await boot('/leads/')
    const { hmrReload } = await import('../src/router/index.js')
    let calls = 0
    guard(() => { calls++; return true })
    await hmrReload('src/routes/leads.mesa', [tree.children.find(n => n.id === 'leads')])
    await tick(10)
    expect(calls).toBe(0)
  })
})

// ─── FJS-790 — relative and fragment hrefs ───────────────────────────────────

describe('href resolution (FJS-790)', () => {
  // The route and the param are the assertion. A test asserting only the
  // resulting hash passes against `new URL(href, location.origin)` too.
  test('a fragment href stays on the current page', async () => {
    await boot('/blog/my-post/')
    expect(page.route?.id).toBe('blog.[slug]')

    clickLink('#comments')
    await tick(10)

    expect(page.route?.id).toBe('blog.[slug]')
    expect(page.params.slug).toBe('my-post')
    expect(S.path).toBe('/blog/my-post/#comments')
    expect(S.scrolledTo).toContain('comments')
  })

  test('a relative href resolves under the current path', async () => {
    await boot('/blog/my-post/')
    clickLink('../other-post/')
    await tick(10)
    expect(page.route?.id).toBe('blog.[slug]')
    expect(page.params.slug).toBe('other-post')
    expect(S.path).toBe('/blog/other-post/')
  })

  test('a bare query href keeps the path', async () => {
    await boot('/blog/my-post/')
    clickLink('?draft=1')
    await tick(10)
    expect(page.params.slug).toBe('my-post')
    expect(page.query.draft).toBe(1)
    expect(S.path).toBe('/blog/my-post/?draft=1')
  })

  // A table of contents re-fetching the page it is a table of contents for.
  test('a same-document fragment does not re-run load()', async () => {
    let runs = 0
    await boot('/blog/', {
      loaders: { blog: () => Promise.resolve({ load: async () => { runs++; return { n: runs } } }) },
    })
    expect(runs).toBe(1)

    clickLink('#section-2')
    await tick(10)

    expect(runs).toBe(1)
    expect(S.path).toBe('/blog/#section-2')
  })
})

// ─── FJS-791 — the abandoned route's load() ──────────────────────────────────

describe('navigation supersession (FJS-791)', () => {
  // Awaiting only the second goto — which is what the suite did — passes
  // against the broken code. The slow promise has to be awaited too.
  test('a slow load from an abandoned route does not commit over the current one', async () => {
    await boot('/', {
      loaders: {
        slow: () => Promise.resolve({ load: () => new Promise(r => setTimeout(() => r({ who: 'SLOW' }), 60)) }),
        fast: () => Promise.resolve({ load: async () => ({ who: 'FAST' }) }),
      },
    })

    const slow = goto('/slow/')
    await tick(5)
    await goto('/fast/')
    expect(page.route?.id).toBe('fast')

    await slow
    await tick(120)

    expect(page.route?.id).toBe('fast')
    expect(page.data).toEqual({ who: 'FAST' })
    expect(page.path).toBe('/fast/')
    expect(S.path).toBe('/fast/')   // the address bar was pushed back too
  })
})

// ─── FJS-792 — a malformed percent-escape ────────────────────────────────────

describe('a segment that will not decode (FJS-792)', () => {
  // A test asserting only "the router did not crash" would pass if the fix were
  // "swallow the whole navigation", which is the wrong fix — hence the node.
  test('matchRoute answers the dynamic route rather than throwing', () => {
    const tree = makeTree()
    expect(matchRoute('/blog/%/', tree, {}).node.id).toBe('blog.[slug]')
    expect(matchRoute('/blog/%/', tree, {}).params.slug).toBe('%')
    expect(matchRoute('/blog/%E0%A4%A/', tree, {}).node.id).toBe('blog.[slug]')
  })

  test('an app booted on a malformed URL still renders', async () => {
    await boot('/blog/%25%/')
    expect(page.route).not.toBeNull()
    expect(page.route?.id).toBe('blog.[slug]')
  })

  // Confirmed and deliberate: an encoded slash is data, not a path.
  test('an encoded slash decodes into the param and goes no further', () => {
    const tree = makeTree()
    expect(matchRoute('/blog/a%2Fb/', tree, {}).params.slug).toBe('a/b')
  })
})

// ─── FJS-793 — the click eaten before the match ──────────────────────────────

describe('link interception (FJS-793)', () => {
  // Against a tree that HAS a catch-all — asserting only that page.route did
  // not change passes against the broken code, because the catch-all is what
  // changed it.
  test('a same-origin URL the app does not route keeps its click', async () => {
    await boot('/blog/')
    const ev = clickLink('/downloads/report.csv')
    await tick(10)
    expect(ev.prevented).toBe(false)
    expect(page.route?.id).toBe('blog')
  })

  test('a routed link is still intercepted', async () => {
    await boot('/blog/')
    const ev = clickLink('/leads/')
    await tick(10)
    expect(ev.prevented).toBe(true)
    expect(page.route?.id).toBe('leads')
  })

  test('a cross-origin link keeps its click', async () => {
    await boot('/blog/')
    const ev = clickLink('https://example.com/x')
    await tick(10)
    expect(ev.prevented).toBe(false)
  })
})

// ─── FJS-794 — a route module with no default export ─────────────────────────

describe('a route that registered no component (FJS-794)', () => {
  // A fix that only guarded ChainRenderer goes green while still rendering a
  // blank page — so the assertion is that the navigation was REFUSED and that
  // the diagnosis names the FILE.
  test('the navigation is refused and the file is named', async () => {
    const tree = makeTree()
    const comps = makeComponents(tree)
    comps.admin = () => Promise.resolve({ someNamedExport: 1 })
    install('/')
    initRouter(tree, comps, {}, { trailingSlash: 'always' })
    await tick(10)
    expect(page.route?.id).toBe('root')

    await goto('/admin/')
    await tick(10)

    expect(page.route?.id).toBe('root')       // not committed
    expect(page.pending).toBeNull()           // and not left mid-flight
    expect(S.reported.map(r => r.file)).toContain('src/routes/admin.mesa')
  })

  test('a route with a default export still commits', async () => {
    await boot('/')
    await goto('/admin/')
    await tick(10)
    expect(page.route?.id).toBe('admin')
    expect(S.reported).toEqual([])
  })
})

// ─── FJS-795 — a redirect ping-pong ──────────────────────────────────────────

describe('redirect loops (FJS-795)', () => {
  // Removing the counter turns this red as a TIMEOUT, so the hop count is
  // asserted explicitly rather than "it finished".
  test('two guards redirecting to each other are stopped and named', async () => {
    await boot('/')
    let hops = 0
    guard(({ to }) => {
      hops++
      if (hops > 100) return true   // breaker, so a regression fails rather than hangs
      if (to.path.startsWith('/admin/')) return '/login/'
      if (to.path.startsWith('/login/')) return '/admin/'
      return true
    })

    await goto('/admin/')
    await tick(10)

    expect(hops).toBeLessThan(20)
    expect(S.reported.some(r => /Redirect loop/.test(r.message))).toBe(true)
    expect(page.pending).toBeNull()
  })

  test('a legitimate redirect still lands', async () => {
    await boot('/')
    guard(({ to }) => (to.path.startsWith('/admin/') ? '/login/' : true))
    await goto('/admin/')
    await tick(10)
    expect(page.route?.id).toBe('login')
    expect(S.reported).toEqual([])
  })
})

// ─── FJS-820 — the cheap halves ──────────────────────────────────────────────

describe('the popstate fragment (FJS-820 / sibling of FJS-447)', () => {
  test('Back to an anchored URL scrolls to the anchor', async () => {
    await boot('/blog/')
    S.path = '/blog/#intro'
    S.lookedUp.length = 0
    S.scrolledTo.length = 0
    firePopstate()
    await tick(10)
    expect(S.lookedUp).toContain('intro')
    expect(S.scrolledTo).toContain('intro')
  })
})

describe('isActive prefix matching (FJS-820)', () => {
  // Run under BOTH settings: the 'always' row passes against the bare
  // startsWith, because the trailing slash was supplying the boundary by
  // accident. That is why it survived.
  test("a prefix has to end at a segment boundary under 'never'", async () => {
    await boot('/leads-archive', { options: { trailingSlash: 'never' } })
    expect(isActive('/leads')).toBe(false)
    expect(isActive('/leads/')).toBe(false)
    expect(isActive('/leads-archive')).toBe(true)
  })

  test("and under 'always'", async () => {
    await boot('/leads-archive/')
    expect(isActive('/leads')).toBe(false)
    expect(isActive('/leads-archive/')).toBe(true)
  })

  test('a real parent is still active', async () => {
    await boot('/blog/my-post/')
    expect(isActive('/blog/')).toBe(true)
    expect(isActive('/blog/', { exact: true })).toBe(false)
  })
})

describe('initRouter is idempotent (FJS-820 / Invariant 11)', () => {
  test('three inits give one click listener and one popstate listener', async () => {
    install('/')
    const tree = makeTree()
    for (let i = 0; i < 3; i++) initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await tick(15)
    expect(S.doc.click?.length).toBe(1)
    expect(S.win.popstate?.length).toBe(1)
    expect(S.doc.mouseover?.length).toBe(1)
    // and the boot navigation still runs, which is what the suite relies on
    expect(page.route?.id).toBe('root')
  })
})

describe('a redirect target the browser would refuse (FJS-820)', () => {
  // Asserting only that `location` did not change passes today — the browser
  // already guarantees that. The stuck spinner is the finding.
  test('a guard returning an off-origin target is refused by name', async () => {
    await boot('/')
    guard(({ to }) => (to.path.startsWith('/blog/') ? '//evil.example.com/' : true))

    await goto('/blog/')
    await tick(10)

    expect(page.pending).toBeNull()
    expect(S.path).toBe('/')
    expect(S.reported.some(r => r.message.includes('evil.example.com'))).toBe(true)
  })

  test('a history write that throws clears pending', async () => {
    await boot('/')
    window.history.pushState = () => { throw new Error('SecurityError') }
    await goto('/leads/')
    await tick(10)
    expect(page.pending).toBeNull()
    expect(S.reported.some(r => r.type === 'navigation')).toBe(true)
  })
})

// ─── FJS-820 — what was left ─────────────────────────────────────────────────

describe('an inline SVG link (FJS-820)', () => {
  // Measured in Chrome, not inferred: an SVG <a> reports tagName 'a', so
  // `=== 'A'` walks past it and the click falls through to a full page load —
  // every time, on a nav icon that is a link rather than a link around an icon.
  test('is intercepted and routed, not left to the browser', async () => {
    await boot('/')
    const ev = clickLink('/leads/', {}, { svg: true })
    await tick(10)

    expect(ev.prevented).toBe(true)
    expect(page.route?.id).toBe('leads')
  })

  test('…and an HTML link is still intercepted', async () => {
    // The control. A matcher loosened to catch everything would satisfy the row
    // above and quietly change what else the router now swallows.
    await boot('/')
    const ev = clickLink('/leads/')
    await tick(10)
    expect(ev.prevented).toBe(true)
    expect(page.route?.id).toBe('leads')
  })

  test('…and something that is not a link is still ignored', async () => {
    // The other control: `linkHrefOf` answers null for a non-anchor AND for an
    // anchor with no href, so neither is intercepted.
    await boot('/')
    const el = { tagName: 'DIV', getAttribute: () => '/leads/', hasAttribute: () => false }
    const ev = {
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      button: 0, defaultPrevented: false,
      composedPath: () => [el],
      prevented: false,
      preventDefault() { this.prevented = true },
    }
    for (const fn of S.doc.click ?? []) fn(ev)
    await tick(10)
    expect(ev.prevented).toBe(false)
    expect(page.route?.id).toBe('root')
  })

  test('an anchor carrying no href is ignored', async () => {
    await boot('/')
    const ev = clickLink(null)
    await tick(10)
    expect(ev.prevented).toBe(false)
  })
})

describe('the scroll map is bounded (FJS-820)', () => {
  // One entry per navigation for the life of the tab, and nothing emptied it.
  // Reading the size is the only way to see this — every behavioral assertion
  // about scrolling passes with the map unbounded.
  test('a long session does not grow it without limit', async () => {
    await boot('/')
    const { _scrollMemorySize } = await import('../src/router/index.js')

    for (let i = 0; i < 120; i++) {
      await goto(i % 2 ? '/leads/' : '/admin/')
      await tick(2)
    }

    expect(_scrollMemorySize()).toBeLessThanOrEqual(50)
  })

  test('…and every entry inside the cap survives', async () => {
    /*
     * The control that keeps the cap honest: a map emptied on every navigation
     * is bounded too, and breaks the Back button — which is the whole feature.
     * It has to span MORE THAN ONE navigation to see that. Checking the entry
     * just written passes against `clear()` followed by `set()`, which is
     * exactly the stub this row exists to catch (measured: it did).
     */
    await boot('/')
    const { _scrollMemoryHas } = await import('../src/router/index.js')

    for (let i = 0; i < 5; i++) {
      window.scrollY = 100 + i
      await goto(i % 2 ? '/leads/' : '/admin/')
      await tick(2)
    }

    ;[0, 1, 2, 3, 4].forEach(i => {
      expect(_scrollMemoryHas(i), 'entry ' + i).toBe(true)
    })
  })
})
