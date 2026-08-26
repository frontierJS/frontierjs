/*
 * tests/site-serve.test.js — the prerendered-site origin.
 *
 * `serveSite` exists because the three answers a static host gives for free are
 * the three a hand-rolled `createServer` in a test harness forgets, and then the
 * harness proves the site works under rules nothing in production applies. So
 * every case here is one of those answers, asked over a real socket against a
 * real directory.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { serveSite } from '../src/site/serve.js'

let DIR
let server

/** What `target: 'static'` emits: a directory per route, hashed assets beside. */
const FILES = {
  'index.html':                    '<h1>home</h1>',
  'about/index.html':              '<h1>about</h1>',
  'products/navy-tee/index.html':  '<h1>Navy Tee</h1>',
  'assets/index-A1b2C3d4.js':      'console.log(1)',
  'assets/style-99887766.css':     'body{}',
  // A real Vite name. The hash is base64url, so it may contain a `-`, and a
  // pattern that reads the hash as *no hyphens* calls this one unhashed.
  'assets/island-CatalogList-C_TQPJ-f.js': 'console.log(2)',
  // Not hashed, and eight characters of its name sit before the extension —
  // the shape that must NOT be cached for a year.
  'assets/my-file-name.js':        'console.log(3)',
  'robots.txt':                    'User-agent: *',
  '404.html':                      '<h1>no such page</h1>',
}

const get = async (path, init) => fetch(`${server.url}${path}`, init)

beforeAll(async () => {
  DIR = mkdtempSync(join(tmpdir(), 'sierra-site-'))
  for (const [rel, body] of Object.entries(FILES)) {
    const full = join(DIR, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  server = await serveSite({ dir: DIR })
})

afterAll(async () => {
  await server?.close()
  rmSync(DIR, { recursive: true, force: true })
})

describe('the directory index', () => {
  test('a trailing-slash URL resolves to that directory index', async () => {
    // `trailingSlash: 'always'` emits about/index.html and every link says
    // `/about/`. A server that does not do this 404s every page but the root,
    // and the build looks broken when it is not.
    const res = await get('/about/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('about')
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
  })

  test('the root is the root index', async () => {
    expect(await (await get('/')).text()).toContain('home')
  })

  test('a nested route resolves too', async () => {
    expect(await (await get('/products/navy-tee/')).text()).toContain('Navy Tee')
  })

  test('the same URL without its slash is the same page', async () => {
    // The commonest thing in a hand-typed or hand-written URL. A static host
    // redirects or serves the index; 404 is the one answer nobody expects.
    expect(await (await get('/about')).text()).toContain('about')
  })

  test('an exact file wins over treating its name as a directory', async () => {
    const res = await get('/robots.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
  })
})

describe('the cache answer', () => {
  test('HTML is revalidated — its URL is permanent and its bytes are a build artefact', async () => {
    const res = await get('/about/')
    expect(res.headers.get('cache-control')).toMatch(/max-age=0|no-cache|must-revalidate/)
    expect(res.headers.get('cache-control')).not.toMatch(/immutable/)
  })

  test('a hashed asset is immutable, because its name changes when it does', async () => {
    const res = await get('/assets/index-A1b2C3d4.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/immutable/)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
  })

  test('a hash containing a hyphen is still a hash', async () => {
    // Measured in `example`: the asset a build happened to put first in the
    // directory carried `C_TQPJ-f`, and the site served it must-revalidate.
    const res = await get('/assets/island-CatalogList-C_TQPJ-f.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/immutable/)
  })

  test('a name that merely has hyphens in it is not', async () => {
    // The direction that costs something: a name wrongly called hashed is
    // cached for a year, and the only way back is to rename the file.
    const res = await get('/assets/my-file-name.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).not.toMatch(/immutable/)
  })

  test('getting the two backwards is the failure this pairs against', async () => {
    // Stated as one assertion so a change that makes both answers identical
    // fails here rather than in a browser a week later.
    const html  = (await get('/')).headers.get('cache-control')
    const asset = (await get('/assets/style-99887766.css')).headers.get('cache-control')
    expect(html).not.toBe(asset)
  })
})

describe('the miss', () => {
  test("a miss gets the site's own 404 page, with a 404 status", async () => {
    // Both halves. A 404 page served with a 200 is a soft 404 — a crawler
    // indexes it, and every dead link becomes a page in the search results.
    const res = await get('/nope/')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('no such page')
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
  })

  test('a site with no 404.html still answers 404, rather than hanging or 500ing', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sierra-site-bare-'))
    writeFileSync(join(bare, 'index.html'), '<h1>only</h1>')
    const s = await serveSite({ dir: bare })
    try {
      const res = await fetch(`${s.url}/missing/`)
      expect(res.status).toBe(404)
    } finally {
      await s.close()
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('what it refuses', () => {
  test('a path cannot walk out of the directory', async () => {
    // Served to the open internet by definition. `fetch` normalises `..` out of
    // a URL, so the traversal is sent encoded — which is how it arrives in a
    // real attempt.
    const res = await fetch(`${server.url}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('root:')
  })

  test('a write verb is refused', async () => {
    const res = await get('/', { method: 'POST' })
    expect(res.status).toBe(405)
  })

  test('HEAD answers the headers and no body', async () => {
    const res = await get('/about/', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(res.headers.get('content-length')).toBe(String(FILES['about/index.html'].length))
  })

  test('a query string is not part of the path', async () => {
    expect((await get('/about/?utm_source=x')).status).toBe(200)
  })
})

describe('what it does NOT send', () => {
  test('no CORS — this origin serves documents, not another origin’s resources', async () => {
    // Deliberate, and the opposite of the widget origin. A page's islands call
    // the API, and CORS is that server's answer to give. Sending `*` here would
    // be a header nobody needs, on the one surface a browser navigates to.
    const res = await get('/about/')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('but it does refuse content sniffing', async () => {
    expect((await get('/about/')).headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('the port it answers on', () => {
  test('asking for 0 gives a real port back, so parallel drives cannot collide', async () => {
    const s = await serveSite({ dir: DIR, port: 0 })
    try {
      expect(s.port).toBeGreaterThan(0)
      expect(s.url).toContain(String(s.port))
    } finally {
      await s.close()
    }
  })
})
