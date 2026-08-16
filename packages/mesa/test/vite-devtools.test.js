// @vitest-environment node
//
// A Vite plugin runs in Node. Under this package's default happy-dom
// environment the global `URL` is happy-dom's, so `fileURLToPath(new URL(…,
// import.meta.url))` — how both copies of this route find devtools.html —
// throws `must be of scheme file` against a path that is perfectly fine in a
// real dev server.

/**
 * vite-devtools.test.js — the /__mesa/devtools route and the BroadcastChannel
 * relay it talks to.
 *
 * This is the half of the plugin nothing had ever executed: a middleware, a
 * virtual module of hand-written source, and a listener that prints a URL. All
 * three are silent when broken — a devtools page that 404s looks like a feature
 * nobody enabled.
 *
 * There are TWO implementations of it, which is the reason for the table below:
 * `mesaPlugin()` serves it, and `mesaDevtools()` serves it again for an app on
 * Sierra's plugin, which calls mesa's transform() but forwards no server hooks.
 * Every case runs against both, because a fix applied to one copy and not the
 * other is exactly what a second copy is for.
 *
 * The server is stood in: `s.middlewares.use(fn)` and a logger is the whole of
 * what these hooks touch. `test/vite-server.test.js` runs the same route through
 * a real Vite dev server over real HTTP.
 */

import { describe, test, expect } from 'vitest'
import { parse }                  from 'acorn'
import fs                         from 'fs'
import { fileURLToPath }          from 'url'

import mesaPlugin, { mesaDevtools } from '../mesa-vite/index.js'

const ROUTE       = '/__mesa/devtools'
const DEV_CLIENT  = '/@frontierjs/mesa-dev-client'
const DEVTOOLS_HTML = fs.readFileSync(
  fileURLToPath(new URL('../mesa-vite/devtools.html', import.meta.url)), 'utf8')

// Both plugins, configured for dev. The main one only serves the route in a
// dev server anyway — configureServer is not called for a build.
const PLUGINS = {
  'mesaPlugin()': () => {
    const p = mesaPlugin()
    p.configResolved({ root: '/app', command: 'serve' })
    return p
  },
  'mesaDevtools()': () => mesaDevtools(),
}

// ─── stand-ins ────────────────────────────────────────────────────────────────

/** Enough of a Vite dev server for configureServer to install itself into. */
function fakeServer() {
  const stack  = []
  const logged = []
  return {
    logged,
    middlewares: { use: (fn) => stack.push(fn) },
    config:      { logger: { info: (m) => logged.push(m) } },
    httpServer:  null,
    resolvedUrls: { local: ['http://localhost:8010/'] },
    /** Drive the installed middleware the way connect does. */
    async request(url) {
      const res = {
        statusCode: 200,
        headers:    {},
        body:       null,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v },
        end(b) { this.body = b ?? '' },
      }
      let nexted = false
      for (const fn of stack) {
        nexted = false
        await fn({ url }, res, () => { nexted = true })
        if (!nexted) break
      }
      return { ...res, nexted }
    }
  }
}

describe.each(Object.entries(PLUGINS))('%s devtools route', (_name, make) => {

  const served = async (url) => {
    const s = fakeServer()
    make().configureServer(s)
    return s.request(url)
  }

  test('serves the devtools page at the route', async () => {
    const res = await served(ROUTE)

    expect(res.nexted).toBe(false)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(DEVTOOLS_HTML)
    expect(res.body).toContain('<title>Mesa DevTools</title>')
  })

  test('the headers say HTML, and say do not cache it', async () => {
    const res = await served(ROUTE)

    // Without a charset a browser sniffs, and the panel is full of box-drawing.
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    // The page is read off disk per request; a cached copy survives an edit to
    // it for the life of the browser session.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  test('a trailing slash and a query string are the same route', async () => {
    expect((await served(ROUTE + '/')).body).toBe(DEVTOOLS_HTML)
    expect((await served(ROUTE + '?tab=signals')).body).toBe(DEVTOOLS_HTML)
  })

  // The middleware runs in front of Vite's entire pipeline, so anything it
  // swallows is a page that no longer loads.
  test('every other URL falls through untouched', async () => {
    for (const url of ['/', '/index.html', '/src/main.js', '/__mesa', '/__mesa/devtools-x']) {
      const res = await served(url)
      expect(res.nexted, url).toBe(true)
      expect(res.body, url).toBeNull()
    }
  })

  test('prints the URL once the server is listening', async () => {
    const s        = fakeServer()
    const listeners = []
    s.httpServer   = { once: (ev, fn) => listeners.push([ev, fn]), address: () => null }

    const post = make().configureServer(s)
    expect(typeof post).toBe('function')

    post()
    expect(listeners.map(([ev]) => ev)).toEqual(['listening'])

    // Nothing is printed before the port exists — the URL would be wrong.
    expect(s.logged).toHaveLength(0)
    listeners[0][1]()
    expect(s.logged.join('\n')).toContain(`http://localhost:8010${ROUTE}`)
  })

  test('falls back to the socket address when resolvedUrls is not ready', async () => {
    const s      = fakeServer()
    s.resolvedUrls = undefined
    s.httpServer = { once: (_ev, fn) => fn(), address: () => ({ address: '::', port: 8010 }) }

    make().configureServer(s)()
    expect(s.logged.join('\n')).toContain(`http://localhost:8010${ROUTE}`)
  })

  // In middleware mode there is no httpServer to wait on, and a listener
  // registered on nothing never fires.
  test('prints immediately in middleware mode', async () => {
    const s      = fakeServer()
    s.httpServer = null

    make().configureServer(s)()
    expect(s.logged.join('\n')).toContain(ROUTE)
  })
})

// ─── the relay the page talks to ──────────────────────────────────────────────

describe.each(Object.entries(PLUGINS))('%s dev client', (_name, make) => {

  test('injects itself into every HTML page', () => {
    expect(make().transformIndexHtml()).toEqual([{
      tag:      'script',
      attrs:    { type: 'module', src: DEV_CLIENT },
      injectTo: 'head',
    }])
  })

  test('resolves and serves valid JavaScript at that id', () => {
    const p        = make()
    const resolved = p.resolveId(DEV_CLIENT)

    expect(resolved).toBe('\0@frontierjs/mesa-dev-client')

    const js = p.load(resolved)
    expect(() => parse(js, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()

    // The two halves of the protocol the devtools page implements: it asks for a
    // snapshot when it opens, and the app announces itself in case it was
    // already open.
    expect(js).toContain("new BroadcastChannel('mesa-devtools')")
    expect(js).toContain("'request-snapshot'")
    expect(js).toContain("bc.postMessage({ type: 'online' })")

    // The runtime sets __MESA_DEV__ whenever it loads — which is after this
    // script in any real page, so the setter is the path that actually runs.
    expect(js).toContain('window.__MESA_DEV__')
    expect(js).toContain('set(dev)')
  })

  test('an id it does not own is left alone', () => {
    const p = make()
    expect(p.resolveId('/src/main.js') ?? null).toBeNull()
    expect(p.load('/src/main.js')).toBeNull()
  })
})
