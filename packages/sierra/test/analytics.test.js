/**
 * test/analytics.test.js
 *
 * `src/analytics/` had no test at all, which is how both of these lived:
 *
 *   · FJS-813 — two paths race to start the vendor, and whichever lost ran
 *     anyway. The interaction handler removed its listeners and left the 5 s
 *     hard fallback standing, and `doInit` had no guard, so any browser without
 *     `requestIdleCallback` (Safari before 16.4, every iOS WebView of that
 *     generation) got two vendor script tags, two `afterNavigate` handlers and
 *     two pageviews per navigation for the rest of the session. The symptom is
 *     inflated traffic in somebody else's dashboard, which nobody debugs as a
 *     framework bug.
 *   · FJS-824 — a pageview handed a custom provider `window.location.href`,
 *     search string included, so a `/reset?token=…&email=…` link went to the
 *     analytics vendor. And `trackLocalhost: false` suppressed nothing outside
 *     the exact string `localhost`, which misses `127.0.0.1` and
 *     `example.localhost` — how `fli proxy` names every dev surface here.
 *
 * The router is wrapped rather than replaced: `afterNavigate` is the real one,
 * and the wrapper only keeps a handle on what analytics registered, because the
 * hook list is module-private and a pageview cannot otherwise be fired without
 * booting a router.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/router/index.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    afterNavigate(fn) {
      ;(globalThis.__afterNav ??= []).push(fn)
      return real.afterNavigate(fn)
    },
  }
})

// ─── A browser ───────────────────────────────────────────────────────────────

let listeners, scripts

/**
 * @param {object} opts
 * @param {boolean} opts.idle      does this browser have requestIdleCallback?
 * @param {string}  opts.hostname
 * @param {string}  opts.href
 */
function installWindow({ idle = false, hostname = 'shop.example', href = 'https://shop.example/' } = {}) {
  listeners = {}
  scripts = []
  const win = {
    location: { hostname, href, origin: `https://${hostname}`, pathname: new URL(href).pathname },
    addEventListener(e, fn) { (listeners[e] ??= []).push(fn) },
    removeEventListener(e, fn) { listeners[e] = (listeners[e] ?? []).filter(f => f !== fn) },
  }
  if (idle) win.requestIdleCallback = (fn) => setTimeout(fn, 0)
  globalThis.window = win
  globalThis.document = {
    createElement: () => {
      const el = { dataset: {}, attrs: {} }
      el.setAttribute = (k, v) => { el.attrs[k] = v }
      return el
    },
    head: { appendChild: (el) => scripts.push(el) },
  }
}

function spyProvider() {
  const inits = [], pageviews = []
  return {
    inits, pageviews,
    init(cfg) { inits.push(cfg) },
    pageview(p) { pageviews.push(p) },
    track() {},
  }
}

async function freshAnalytics() {
  vi.resetModules()
  globalThis.__afterNav = []
  // Analytics reaches the router through a dynamic import. Loaded here first,
  // that import is a cache hit and `dynamicImportSettled` sees it land; cold,
  // the first test in the file read `__afterNav` before it had.
  await import('../src/router/index.js')
  return import('../src/analytics/index.js')
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  delete globalThis.window
  delete globalThis.document
  delete globalThis.__afterNav
})

// ─── FJS-813 ─────────────────────────────────────────────────────────────────

describe('a browser with no requestIdleCallback', () => {

  test('starts the vendor once, though both paths fire', async () => {
    installWindow({ idle: false })
    const provider = spyProvider()
    const A = await freshAnalytics()
    A.initAnalytics({ provider })

    // The person scrolls inside five seconds — i.e. almost everyone.
    listeners.scroll.forEach(f => f())
    // ...and the hard fallback lands anyway.
    vi.advanceTimersByTime(6000)
    await vi.dynamicImportSettled()

    expect(provider.inits).toHaveLength(1)
    // The consequence, which is the half a caller actually sees: one handler,
    // so one pageview per navigation.
    globalThis.__afterNav.forEach(fn => fn({ to: { pathname: '/orders/', node: { meta: {} } } }))
    expect(provider.pageviews).toHaveLength(1)
  })

  test('and starts it at all when nobody touches the page — the timer is still the fallback', async () => {
    installWindow({ idle: false })
    const provider = spyProvider()
    const A = await freshAnalytics()
    A.initAnalytics({ provider })

    vi.advanceTimersByTime(6000)
    expect(provider.inits).toHaveLength(1)
  })
})

describe('a browser with requestIdleCallback', () => {
  test('starts the vendor once', async () => {
    installWindow({ idle: true })
    const provider = spyProvider()
    const A = await freshAnalytics()
    A.initAnalytics({ provider })

    vi.advanceTimersByTime(6000)
    expect(provider.inits).toHaveLength(1)
  })
})

// ─── FJS-824 — what a pageview carries ───────────────────────────────────────

describe('the address a pageview reports', () => {

  async function pageviewFrom(href) {
    installWindow({ idle: true, hostname: new URL(href).hostname, href })
    const provider = spyProvider()
    const A = await freshAnalytics()
    A.initAnalytics({ provider })
    vi.advanceTimersByTime(10)
    await vi.dynamicImportSettled()
    globalThis.__afterNav.forEach(fn => fn({ to: { pathname: '/orders/', node: { meta: { label: 'Orders' } } } }))
    return provider.pageviews[0]
  }

  test('drops the query string, so a reset token does not reach the vendor', async () => {
    const p = await pageviewFrom('https://shop.example/reset?token=SECRET-RESET-TOKEN&email=a@b.c')
    expect(p.url).toBe('https://shop.example/reset')
    expect(JSON.stringify(p)).not.toContain('SECRET-RESET-TOKEN')
  })

  test('and still reports where the person is — a scrub that sent nothing would pass the row above', async () => {
    const p = await pageviewFrom('https://shop.example/reset?token=SECRET-RESET-TOKEN')
    expect(p.path).toBe('/orders/')
    expect(p.url).toContain('shop.example')
    expect(p.meta).toEqual({ label: 'Orders' })
  })
})

// ─── FJS-824 — trackLocalhost ────────────────────────────────────────────────

describe('trackLocalhost: false', () => {

  async function tracksOn(hostname) {
    installWindow({ idle: true, hostname, href: `http://${hostname}/` })
    const provider = spyProvider()
    const A = await freshAnalytics()
    A.initAnalytics({ provider, trackLocalhost: false })
    vi.advanceTimersByTime(10)
    return provider.inits.length > 0
  }

  test.each([
    'localhost',
    '127.0.0.1',
    'example.localhost',      // how `fli proxy` names every dev surface here
    'api.example.localhost',
  ])('suppresses %s', async (host) => {
    expect(await tracksOn(host)).toBe(false)
  })

  test.each([
    'shop.example',
    'localhost.evil.example', // a suffix match on the wrong end
  ])('and still tracks %s — a predicate that refused everything would pass the rows above', async (host) => {
    expect(await tracksOn(host)).toBe(true)
  })
})

// ─── FJS-2058 — the built-in providers read one tag ──────────────────────────

describe('the vendor tag', () => {

  test('plausible loads its script with the domain, after idle', async () => {
    installWindow({ idle: true })
    const A = await freshAnalytics()
    A.initAnalytics({ provider: 'plausible', domain: 'shop.example' })
    expect(scripts).toHaveLength(0)
    vi.advanceTimersByTime(10)
    expect(scripts).toHaveLength(1)
    expect(scripts[0].src).toBe('https://plausible.io/js/script.js')
    expect(scripts[0].attrs['data-domain']).toBe('shop.example')
    expect(scripts[0].defer).toBe(true)
  })

  test('gtm pushes its start event before the script, or no Page View trigger fires', async () => {
    installWindow({ idle: true })
    const A = await freshAnalytics()
    A.initAnalytics({ provider: 'gtm', containerId: 'GTM-ABC' })
    vi.advanceTimersByTime(10)
    expect(window.dataLayer[0]).toMatchObject({ event: 'gtm.js' })
    expect(typeof window.dataLayer[0]['gtm.start']).toBe('number')
    expect(scripts[0].src).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-ABC')
  })

  test('a named provider missing its id warns and loads nothing, rather than throwing at boot', async () => {
    installWindow({ idle: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const A = await freshAnalytics()
    A.initAnalytics({ provider: 'plausible' })
    vi.advanceTimersByTime(10)
    expect(scripts).toHaveLength(0)
    expect(warn.mock.calls[0][0]).toContain('needs a domain')
    warn.mockRestore()
  })
})

describe('configureAnalytics — a page whose tag is already in the HTML', () => {

  test('track() reaches the vendor and nothing is loaded', async () => {
    installWindow({ idle: true })
    const calls = []
    window.plausible = (...a) => calls.push(a)
    const A = await freshAnalytics()
    expect(A.configureAnalytics({ provider: 'plausible', domain: 'shop.example' })).toBe(true)
    A.track('Lead', { form: 'contact' })
    vi.advanceTimersByTime(6000)
    expect(calls).toEqual([['Lead', { props: { form: 'contact' } }]])
    expect(scripts).toHaveLength(0)
  })

  test('before it, track() is a no-op — the state an island page was in', async () => {
    installWindow({ idle: true })
    const calls = []
    window.plausible = (...a) => calls.push(a)
    const A = await freshAnalytics()
    A.track('Lead')
    expect(calls).toEqual([])
  })
})
