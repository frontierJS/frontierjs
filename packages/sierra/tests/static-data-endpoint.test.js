/**
 * tests/static-data-endpoint.test.js — `/__sierra/static-data`, executed
 *
 * A `render: static` route's `load()` runs in Node at build time and is where
 * an app reads its own database. In dev, this middleware runs it — so what
 * reaches it is what reaches the database, and until now **nothing in this
 * suite executed the middleware at all**: it was reviewed and never run.
 *
 * A REAL Vite dev server on a real port, not the plugin's `configureServer`
 * called by hand. The two things asserted here — that a cross-origin POST is
 * refused, and that an edited companion is picked up — are both about what
 * arrives over HTTP and what the module cache does with a file on disk, and a
 * hand-driven middleware answers neither.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'vite'
import { createServer as createHttpServer } from 'node:http'

import { createSierraViteConfig } from '../src/build/index.js'

// Inside the package, like every other dev-server test here: a Vite root in
// the system temp directory has no node_modules above it, and the dep scan
// walks until it runs out of heap.
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, 'tmp-staticdata')

let server
let http
let origin

const COMPANION = (mark) => `
export const meta = { render: 'static' }
export async function load({ params }) {
  return { mark: '${mark}', got: params }
}
export function head() { return { title: '${mark}' } }
`

beforeAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await mkdir(join(root, 'src/routes/items'), { recursive: true })
  await writeFile(join(root, 'src/routes/index.mesa'), '---\nrender: static\n---\n<h1>x</h1>\n', 'utf8')
  await writeFile(join(root, 'src/routes/index.meta.js'), COMPANION('FIRST'), 'utf8')
  await writeFile(join(root, 'src/routes/items/[id].mesa'), '---\nrender: static\n---\n<h1>i</h1>\n', 'utf8')
  await writeFile(join(root, 'src/routes/items/[id].meta.js'), COMPANION('ITEM'), 'utf8')
  // An ORDINARY route with a companion. Its loader is in the browser graph
  // already, so this endpoint has no business running it.
  await writeFile(join(root, 'src/routes/spa.mesa'), '<h1>s</h1>\n', 'utf8')
  await writeFile(join(root, 'src/routes/spa.meta.js'),
    "export async function load() { return { mark: 'SPA' } }\n", 'utf8')
  // A companion whose head() throws — the build skips the page for this and a
  // skipped page fails the build (`FJS-439`).
  await writeFile(join(root, 'src/routes/bad.mesa'), '---\nrender: static\n---\n<h1>b</h1>\n', 'utf8')
  await writeFile(join(root, 'src/routes/bad.meta.js'),
    "export const meta = { render: 'static' }\n"
    + "export async function load() { return { ok: true } }\n"
    + "export function head() { throw new Error('head blew up') }\n", 'utf8')

  const config = createSierraViteConfig({
    target: 'static',
    vite: {
      root,
      logLevel: 'silent',
      // Middleware mode, and its own http server on a port the OS picks.
      // Vite's own listener crawls the root for an entry HTML and a dep graph
      // this fixture does not have; what is under test is the middleware, and
      // this is the same connect stack it is mounted in.
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
      // Nothing here imports a dependency, and the scan that looks for them
      // walks a directory tree this fixture does not own.
      optimizeDeps: { noDiscovery: true, include: [] },
    },
  })

  server = await createServer(config)
  http = createHttpServer(server.middlewares)
  await new Promise(done => http.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${http.address().port}`
}, 120_000)

afterAll(async () => {
  await new Promise(done => http?.close(done))
  await server?.close()
  // Vite writes node_modules/.vite under the root while shutting down, so a
  // single rmdir races it.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const ask = (qs, init) => fetch(`${origin}/__sierra/static-data?${qs}`, init)

describe('/__sierra/static-data', () => {
  test('answers a GET with the loader’s data and its head', async () => {
    const res = await ask('route=root&url=/&params=%7B%7D')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.mark).toBe('FIRST')
    expect(body.head.title).toBe('FIRST')
  })

  // The refusal. A cross-origin `<form>` POST is a SIMPLE request — no
  // preflight, so nothing asks this server whether it wants the call — and
  // what it reached was the app's build-time `load()` (`FJS-821`).
  test('refuses a POST', async () => {
    const res = await ask('route=root&url=/&params=%7B%7D', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    expect(res.status).not.toBe(200)
  })

  test('refuses every other verb too', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await ask('route=root&url=/&params=%7B%7D', { method })
      expect(res.status, method).not.toBe(200)
    }
  })

  // `params` is caller-supplied JSON, and *the router already matched the URL*
  // is not a reason to hand a `load()` an arbitrary object.
  test('passes only the params the route declares', async () => {
    const params = encodeURIComponent(JSON.stringify({ id: '7', smuggled: 'x' }))
    const res = await ask(`route=items.[id]&url=/items/7/&params=${params}`)
    const body = await res.json()
    expect(body.data.got).toEqual({ id: '7' })
  })

  test('a __proto__ key in params does not reach the loader', async () => {
    const params = encodeURIComponent(JSON.stringify({ __proto__: { polluted: 1 }, id: '7' }))
    const res = await ask(`route=items.[id]&url=/items/7/&params=${params}`)
    const body = await res.json()
    expect(body.data.got.polluted).toBeUndefined()
    expect({}.polluted).toBeUndefined()
  })

  test('a route id that is not in the tree is a 404, not a path', async () => {
    const res = await ask('route=../../../../etc/passwd&url=/&params=%7B%7D')
    expect(res.status).toBe(404)
  })

  // `FJS-806`. The header promised an edit was picked up on the next
  // navigation, keyed on the companion's mtime — and under `bun --bun vite`,
  // the runtime a static surface's dev server is required to be, a query
  // string is not part of the module cache key, so it never was. Measured
  // A/B before the fix: node answered MARK-B, bun answered MARK-A.
  test('an edited companion is read again', async () => {
    const first = await (await ask('route=root&url=/&params=%7B%7D')).json()
    expect(first.data.mark).toBe('FIRST')

    await writeFile(join(root, 'src/routes/index.meta.js'), COMPANION('SECOND'), 'utf8')

    const second = await (await ask('route=root&url=/&params=%7B%7D')).json()
    expect(second.data.mark).toBe('SECOND')
  })

  // The negative control for the row above: a companion that has NOT changed
  // must not be re-imported, or every page view rebuilds the app's database
  // client. Asserted through module identity — the loader closes over a
  // counter that only a fresh evaluation resets.
  test('an unchanged companion is served from the cache', async () => {
    await writeFile(
      join(root, 'src/routes/items/[id].meta.js'),
      `let calls = 0
export const meta = { render: 'static' }
export async function load() { return { calls: ++calls } }
`,
      'utf8'
    )
    const one = await (await ask('route=items.[id]&url=/items/1/&params=%7B%7D')).json()
    const two = await (await ask('route=items.[id]&url=/items/1/&params=%7B%7D')).json()
    expect(two.data.calls).toBe(one.data.calls + 1)
  })
})

describe('what it refuses (FJS-822 · static-10)', () => {
  test('a cross-site GET is refused, which the verb check cannot cover', async () => {
    // `<img src>`, `<script src>` and a top-level form GET are all simple GETs
    // and send no `Origin` to read. The browser sets `Sec-Fetch-Site` and a
    // page can neither forge nor suppress it.
    const res = await ask('route=root&url=/&params=%7B%7D', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
  })

  test('…and same-origin, same-site-none and a header-less caller still work', async () => {
    /*
     * Three controls, and they are the test. A check that refused whenever the
     * header was not exactly `same-origin` would break every curl, every test
     * here, and a bookmark — and would satisfy the row above. `none` is a typed
     * URL; an absent header is a caller that is not a browser, which is not the
     * threat this refuses.
     */
    for (const headers of [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      {},
    ]) {
      const res = await ask('route=root&url=/&params=%7B%7D', { headers })
      expect(res.status, JSON.stringify(headers)).toBe(200)
    }
  })

  test('a route that does not declare render: static is refused', async () => {
    // This endpoint exists because a static route's companion never enters the
    // browser graph. An ordinary route's loader is in the graph already, so
    // running it here is a second way into code the route table imports
    // differently.
    const res = await ask('route=spa&url=/spa/&params=%7B%7D')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toContain('not a render: static route')
  })

  test('…and a static route beside it still answers', async () => {
    // The control: refusing every route would satisfy the row above and make
    // the endpoint useless, which is the whole feature.
    const res = await ask('route=root&url=/&params=%7B%7D')
    expect(res.status).toBe(200)
  })
})

describe('a throwing head() (FJS-822 · static-10)', () => {
  test('fails the request rather than answering head: null', async () => {
    /*
     * The build skips the page when head() throws, and a skipped page fails
     * the build (`FJS-439`). Dev swallowed it to `head: null`, so one question
     * had two answers and the dev one hid the failure until deploy — the wrong
     * way round for the half a person is actually looking at.
     */
    const res = await ask('route=bad&url=/bad/&params=%7B%7D')
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('head blew up')
  })

  test('…and a companion whose head() returns is unaffected', async () => {
    // Asserted against the loader's own answer rather than a literal: an
    // earlier case in this file edits this companion on disk to prove the
    // cache re-reads it, so the mark is whatever that left behind. What must
    // hold is that head() ran and came back with it.
    const res = await ask('route=root&url=/&params=%7B%7D')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.head.title).toBe(body.data.mark)
  })
})
