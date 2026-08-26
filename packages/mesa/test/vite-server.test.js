// @vitest-environment node
//
// A real Vite dev server is a Node program. It also has to be the ONLY thing in
// this file that owns a DOM-shaped global, since happy-dom's `URL` breaks the
// plugin's own devtools-path resolution (see vite-devtools.test.js).

/**
 * vite-server.test.js — the plugin inside a real Vite dev server.
 *
 * Everything else about this plugin is tested by calling its hooks directly,
 * which is fast and precise and cannot see the class of failure that has
 * actually bitten it: hooks that are never reached. `enforce: 'pre'` deciding
 * who transforms a `.mesa` file first, a middleware installed behind Vite's own
 * SPA fallback, a virtual id another plugin resolves first, `configResolved`
 * reading a field that moved — none of it is visible from a hand-rolled plugin
 * context, and all of it is what an app hits on `bun run dev`.
 *
 * So this starts the server for real, over real HTTP, and asks for the same
 * things a browser asks for. It runs in middleware mode against a fixture app
 * under `test/fixtures/vite-app/`, on port 0 — the OS picks, so this cannot
 * collide with a dev server someone is running (root CLAUDE.md § Ports).
 *
 * The runtime import in compiled output is aliased to this package's own source
 * rather than resolved by name: `bun install` copies a workspace dep, so a
 * by-name resolution would serve a stale snapshot of the runtime (root
 * CLAUDE.md § Live hazards).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { parse }             from 'acorn'
import http                  from 'node:http'
import { fileURLToPath }     from 'node:url'

import mesaPlugin from '../mesa-vite/index.js'

const here    = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const ROOT    = here('./fixtures/vite-app')
const RUNTIME = here('../src/runtime.js')

let server, listener, origin

beforeAll(async () => {
  const { createServer } = await import('vite')

  server = await createServer({
    root:      ROOT,
    logLevel:  'silent',
    configFile: false,
    server:    { middlewareMode: true, hmr: false },
    resolve:   { alias: { '@frontierjs/mesa/runtime.js': RUNTIME } },
    plugins:   [mesaPlugin()],
  })

  listener = http.createServer(server.middlewares)
  await new Promise((r) => listener.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${listener.address().port}`
}, 30_000)

afterAll(async () => {
  await server?.close()
  await new Promise((r) => listener?.close(r) ?? r())
})

const GET = async (path) => {
  const res = await fetch(origin + path)
  return { status: res.status, headers: res.headers, body: await res.text() }
}

const parses = (js) =>
  expect(() => parse(js, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()

// ─── the module a browser actually receives ───────────────────────────────────

describe('a .mesa module over HTTP', () => {
  test('is served as JavaScript the browser can parse', async () => {
    const res = await GET('/src/Counter.mesa?import')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    parses(res.body)
  })

  test('is compiled, not served as source', async () => {
    const { body } = await GET('/src/Counter.mesa?import')

    expect(body).toContain('$$runtime.template')
    expect(body).not.toContain('<style>')
  })

  // FJS-291: the styles arrive INSIDE this module, and there is no second
  // request for them. A browser that fetched the module and got no rules would
  // render the component unstyled with nothing failing anywhere.
  test('carries its scoped styles, and asks for no stylesheet', async () => {
    const { body } = await GET('/src/Counter.mesa?import')

    expect(body).toContain('$$runtime.addStyles(')
    expect(body).toContain('color: red')
    expect(body).not.toContain('mesa-css')
  })

  test('carries the HMR boundary and its client import', async () => {
    const { body } = await GET('/src/Counter.mesa?import')

    expect(body).toContain('__mesaHMRWrap')
    // Vite rewrote the bare virtual id into something the browser can fetch, so
    // the assertion is on the registry key rather than the import specifier.
    expect(body).toContain(`__mesa_register('/src/Counter.mesa'`)
    expect(body).toContain('mesa-client')
  })

  // The one import in the boundary is to a virtual module this plugin serves.
  // An id Vite cannot resolve is a 404 in the browser and a blank page.
  test('the HMR client it imports is itself served', async () => {
    const res = await GET('/@id/__x00__@frontierjs/mesa-client')

    expect(res.status).toBe(200)
    expect(res.body).toContain('__mesa_register')
    expect(res.body).toContain('__mesa_hot_update')
    parses(res.body)
  })

  test('the module graph resolves the whole chain from the entry', async () => {
    // transformRequest runs import analysis, which is where an unresolvable
    // import fails — a hook-level test never gets that far.
    const entry = await server.transformRequest('/src/main.js')
    expect(entry.code).toContain('Counter.mesa')

    const mod = await server.moduleGraph.getModuleByUrl('/src/Counter.mesa')
    expect(mod).toBeTruthy()
  })
})

// ─── the pages the plugin adds to a dev server ────────────────────────────────

describe('the dev server surface', () => {
  test('/__mesa/devtools serves the panel', async () => {
    const res = await GET('/__mesa/devtools')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.body).toContain('<title>Mesa DevTools</title>')
  })

  // Vite's SPA fallback answers 200 with index.html for anything unclaimed, so
  // "the route works" has to be told apart from "everything works".
  test('and does not swallow the app', async () => {
    const res = await GET('/some/app/route')
    expect(res.body).toContain('Mesa vite fixture')
    expect(res.body).not.toContain('Mesa DevTools')
  })

  test('the dev client is injected into the page and is fetchable', async () => {
    const page = await GET('/')

    expect(page.body).toContain('/@frontierjs/mesa-dev-client')

    const client = await GET('/@id/__x00__@frontierjs/mesa-dev-client')
    expect(client.status).toBe(200)
    expect(client.body).toContain('mesa-devtools')
    parses(client.body)
  })
})
