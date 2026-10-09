/*
 * audit-static.test.js — audit 1.3, the 8181 static origin.
 *
 * Against a real temp directory, as `static.test.js` is. A test that FAILS is
 * a finding; one that passes is a claim that held under attack.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, symlink, link, mkdir } from 'node:fs/promises'
import { tmpdir }             from 'node:os'
import { join }               from 'node:path'
import { createStatic }       from '../src/static.js'
import { createStaticServer } from '../src/serve.js'

let dir, statics

beforeEach(async () => {
  dir     = await mkdtemp(join(tmpdir(), 'outpost-audit-'))
  statics = createStatic({ staticDir: dir })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const release = async (appId, slug, files) => {
  const out = await statics.publish({ appId, files })
  await statics.activate({ appId, slug, digest: out.digest })
  return out
}
const serve = (host, path, headers = {}) => createStaticServer({ staticDir: dir }, { log: { error() {} } })
  .handle(new Request(`http://${host}${path}`, { headers: { host, ...headers } }))

describe('FINDING — another app answers under this app’s hostname', () => {

  beforeEach(async () => {
    await release('shop',  'shop',  [{ path: 'index.html', content: '<h1>shop</h1>' }, { path: 'app.js', content: 'shop()' }])
    await release('admin', 'admin', [{ path: 'index.html', content: '<h1>admin</h1>' }, { path: 'app.js', content: 'admin()' }])
  })

  test('shop.fleet.test/admin/index.html serves the admin app as origin shop.fleet.test', async () => {
    // The host already named an app (shop). The path reading is still tried
    // when shop has no such file, so admin's HTML — a stranger's script —
    // runs as same-origin with shop's.
    const res = await serve('shop.fleet.test', '/admin/index.html')
    expect(res.status).toBe(404)                       // FAILS: 200, body is admin's
  })

  test('…and its assets too', async () => {
    const res = await serve('shop.fleet.test', '/admin/app.js')
    expect(res.status).toBe(404)                       // FAILS: 200, 'admin()'
  })

  test('a host label that names no app still falls through to the path (FJS-D618)', async () => {
    const res = await serve('outpost.internal', '/admin/index.html')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>admin</h1>')
  })
})

describe('FINDING — a malformed percent-encoding throws out of handle()', () => {

  beforeEach(async () => {
    await release('shop', 'shop', [{ path: 'index.html', content: '<h1>shop</h1>' }])
  })

  test('GET /%E0 is a 4xx, not an unhandled URIError', async () => {
    // `candidates` maps every segment through `decodeURIComponent` with no
    // try/catch. Under Bun.serve an uncaught throw is a 500 with a stack in
    // the log, on a port with no authentication in front of it.
    const res = await serve('shop.fleet.test', '/%E0').catch(err => err)
    expect(res).toBeInstanceOf(Response)               // FAILS: URIError
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('HOLDS — containment on the serve side', () => {

  let digest
  beforeEach(async () => {
    ;({ digest } = await release('shop', 'shop', [
      { path: 'index.html', content: '<h1>shop</h1>' },
      { path: 'a/b.txt',    content: 'inside' },
    ]))
    await writeFile(join(dir, 'secret.txt'), 'fleet secret')
  })

  test('every traversal spelling on the path reading is a 404', async () => {
    for (const path of [
      '/shop/../secret.txt', '/shop/..%2fsecret.txt', '/shop/%2e%2e/secret.txt', '/shop/%2e%2e%2fsecret.txt',
      '/shop/a/%2e%2e/%2e%2e/secret.txt', '/shop/..%5csecret.txt', '/shop/a/..%2f..%2f..%2fsecret.txt',
      '/..%2fsecret.txt', '/%2e%2e%2f%2e%2e%2fsecret.txt',
    ]) {
      const res = await serve('localhost:7181', path)
      expect([res.status, path]).toEqual([404, path])
    }
  })

  test('a NUL in the path is a 404, not a throw', async () => {
    const res = await serve('shop.fleet.test', '/a/b.txt%00.html').catch(err => err)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(404)
  })

  test('a symlink to a directory outside the release does not serve its index', async () => {
    await mkdir(join(dir, 'outside'))
    await writeFile(join(dir, 'outside/index.html'), 'OUTSIDE')
    await symlink(join(dir, 'outside'), join(dir, 'apps/shop', digest, 'esc'))
    // `/esc/` has no extension, so the client-route fallback answers shop's
    // own index.html — a 200 whose body must not be the outside file.
    expect(await (await serve('shop.fleet.test', '/esc/')).text()).not.toContain('OUTSIDE')
    expect((await serve('shop.fleet.test', '/esc/index.html')).status).toBe(404)
  })

  test('a symlink to a sibling release (another digest of the same app) is refused too', async () => {
    const other = await statics.publish({ appId: 'shop', files: [{ path: 'index.html', content: 'OLD' }] })
    await symlink(join(dir, 'apps/shop', other.digest, 'index.html'), join(dir, 'apps/shop', digest, 'old.html'))
    expect((await serve('shop.fleet.test', '/old.html')).status).toBe(404)
  })

  test('a hosts/ entry pointing outside the static root is refused', async () => {
    await mkdir(join(dir, '..', 'outpost-audit-outside-' + process.pid), { recursive: true })
    const outside = join(dir, '..', 'outpost-audit-outside-' + process.pid)
    try {
      await writeFile(join(outside, 'index.html'), 'OUTSIDE')
      await symlink(outside, join(dir, 'hosts', 'evil'))
      expect((await serve('evil.fleet.test', '/')).status).toBe(404)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a hard link inside a release IS served — realpath cannot tell (needs same fs, documented lead)', async () => {
    // Not a finding on its own: planting it needs write access to the release
    // directory, which is the command half's. Recorded as evidence of the
    // boundary realpath cannot see past.
    const planted = await link(join(dir, 'secret.txt'), join(dir, 'apps/shop', digest, 'hard.txt')).then(() => true, () => false)
    if (!planted) return
    const res = await serve('shop.fleet.test', '/hard.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('fleet secret')
  })
})

describe('HOLDS — MIME and sniffing', () => {

  beforeEach(async () => {
    await release('shop', 'shop', [
      { path: 'index.html', content: '<h1>shop</h1>' },
      { path: 'page.txt',   content: '<script>alert(1)</script>' },
      { path: 'blob',       content: '<script>alert(1)</script>' },
      { path: 'x.svg',      content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
      { path: 'a.JS',       content: 'upper()' },
    ])
  })

  test('nosniff rides on every file, and an unknown extension is octet-stream', async () => {
    for (const [path, type] of [
      ['/page.txt', 'text/plain; charset=utf-8'],
      ['/blob',     'application/octet-stream'],
      ['/x.svg',    'image/svg+xml'],
      ['/a.JS',     'text/javascript; charset=utf-8'],
    ]) {
      const res = await serve('shop.fleet.test', path)
      expect([path, res.status]).toEqual([path, 200])
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-type')).toBe(type)
    }
  })

  test('no CSP, no frame-ancestors, no referrer policy — the page is a stranger’s and the origin is its own', async () => {
    // Evidence only: by FJS-D345 the pages are arbitrary script; what is
    // missing here is what the owner would want on a public port.
    const res = await serve('shop.fleet.test', '/')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('x-frame-options')).toBeNull()
  })
})
