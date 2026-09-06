/**
 * tests/analytics.test.js
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
    createElement: () => { const el = { dataset: {} }; return el },
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

    expect(provider.inits).toHaveLength(1)
    // The consequence, which is the half a caller actually sees: one handler,
    // so one pageview per navigation.
    globalThis.__afterNav.forEach(fn => fn({ to: { path: '/orders/', node: { meta: {} } } }))
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
    globalThis.__afterNav.forEach(fn => fn({ to: { path: '/orders/', node: { meta: { label: 'Orders' } } } }))
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
