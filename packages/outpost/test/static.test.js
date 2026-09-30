/*
 * static.test.js
 *
 * The inline-source half, against a REAL filesystem in a temp directory. There
 * is no injected fs and there must not be: what is asserted here is symlink
 * swapping, atomic rename and path containment, and every one of those is a
 * property of the kernel rather than of this code. A fake fs would pass all
 * three while the machine does none of them.
 *
 * The traversal cases are the reason the file exists. `/exec` is the route
 * everyone reads as dangerous; a publish that writes `../../etc/cron.d/x` is
 * the same power with none of the warning signs.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile, readFile, readlink, stat, symlink } from 'node:fs/promises'
import { tmpdir }                 from 'node:os'
import { join }                   from 'node:path'
import { createStatic, digestOfFiles, validRelativePath, LIMITS } from '../src/static.js'
import { createStaticServer }     from '../src/serve.js'
import { createOutpostServer }    from '../src/server.js'
import { signRequest }            from '@frontierjs/toolbelt/signature'

let dir
let statics

beforeEach(async () => {
  dir     = await mkdtemp(join(tmpdir(), 'outpost-static-'))
  statics = createStatic({ staticDir: dir, staticUrl: 'http://fleet.test:8181' })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const page  = (body = 'hello') => [{ path: 'index.html', content: `<!doctype html><h1>${body}</h1>` }]
/** The two calls a release is: write the bytes, then say they are the live ones. */
const release = async (opts) => {
  const out = await statics.publish(opts)
  await statics.activate({ appId: opts.appId, slug: opts.slug, digest: out.digest })
  return out
}
const serve = (host, path) => createStaticServer({ staticDir: dir }).handle(
  new Request(`http://${host}${path}`, { headers: { host } }))

describe('publishing bytes', () => {

  test('a publish writes the files and makes them live', async () => {
    const out = await statics.publish({ appId: 'app-1', files: page() })

    expect(out.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(out.files).toBe(1)
    expect(await readFile(join(dir, 'apps/app-1', out.digest, 'index.html'), 'utf8')).toContain('hello')

    // Written is not live. Nothing points at it until `activate` says so.
    expect(await statics.currentDigest('app-1')).toBeNull()

    await statics.activate({ appId: 'app-1', slug: 'shop', digest: out.digest })
    // The symlink is relative, so the tree can be moved or bind-mounted whole.
    expect(await readlink(join(dir, 'apps/app-1/current'))).toBe(out.digest)
    expect(await readlink(join(dir, 'hosts/shop'))).toBe('../apps/app-1/current')
  })

  test('the same bytes are the same release — a redeploy that changed nothing mints no new one', async () => {
    const first  = await release({ appId: 'app-1', slug: 'shop', files: page() })
    const second = await release({ appId: 'app-1', slug: 'shop', files: page() })
    expect(second.digest).toBe(first.digest)

    const { digests } = await statics.releases({ appId: 'app-1' })
    expect(digests).toEqual([first.digest])
  })

  test('the order the files were listed in is not part of the identity', async () => {
    const a = digestOfFiles([{ path: 'index.html', bytes: Buffer.from('x') }, { path: 'a.js', bytes: Buffer.from('y') }])
    const b = digestOfFiles([{ path: 'a.js', bytes: Buffer.from('y') }, { path: 'index.html', bytes: Buffer.from('x') }])
    expect(a).toBe(b)
  })

  test('where a delimiter falls cannot collide two releases', async () => {
    // `{'a/b': 'x'}` and `{'a': 'b' + 'x'}` hash the same under naive
    // concatenation, and a collision is a rollback restoring the wrong bytes.
    const a = digestOfFiles([{ path: 'a/b', bytes: Buffer.from('x') }])
    const b = digestOfFiles([{ path: 'a',   bytes: Buffer.from('bx') }])
    expect(a).not.toBe(b)
  })

  test('a release with no index.html is refused, rather than serving a 404 at its own root', async () => {
    await expect(statics.publish({ appId: 'app-1', files: [{ path: 'app.js', content: 'x' }] }))
      .rejects.toThrow(/needs an index\.html/)
  })

  test('base64 content is written as bytes', async () => {
    const out = await statics.publish({ appId: 'app-1', files: [
      ...page(), { path: 'logo.png', content_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
    ] })
    const bytes = await readFile(join(dir, 'apps/app-1', out.digest, 'logo.png'))
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})

describe('what a publish refuses', () => {

  test('a path that walks out of the app directory', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', '/etc/passwd', 'a/./b', 'a//b', '..', 'x\0y', 'a\\b'])
      expect(validRelativePath(bad)).toBeTruthy()
    expect(validRelativePath('assets/app.js')).toBeNull()
  })

  test('and the store refuses it too, not merely the validator', async () => {
    await expect(statics.publish({ appId: 'app-1', files: [...page(), { path: '../escaped.html', content: 'x' }] }))
      .rejects.toThrow(/walks the directory tree/)
    expect(await stat(join(dir, 'escaped.html')).catch(() => null)).toBeNull()
  })

  test('an app id or a slug that is a path segment of its own', async () => {
    await expect(statics.publish({ appId: '../../root', files: page() })).rejects.toThrow(/not a plain name/)

    const out = await statics.publish({ appId: 'app-1', files: page() })
    await expect(statics.activate({ appId: 'app-1', slug: '../x', digest: out.digest }))
      .rejects.toThrow(/not a plain name/)
  })

  test('the same file twice — one of them would silently win', async () => {
    await expect(statics.publish({ appId: 'app-1', files: [...page(), { path: 'index.html', content: 'other' }] }))
      .rejects.toThrow(/listed twice/)
  })

  test('a file over the size this machine takes, named in the refusal', async () => {
    const big = 'x'.repeat(LIMITS.fileBytes + 1)
    await expect(statics.publish({ appId: 'app-1', files: [...page(), { path: 'big.js', content: big }] }))
      .rejects.toThrow(/big\.js/)
  })

  test('a file carrying no content at all', async () => {
    await expect(statics.publish({ appId: 'app-1', files: [{ path: 'index.html' }] }))
      .rejects.toThrow(/neither content nor content_base64/)
  })
})

describe('activating what is already here', () => {

  test('a rollback sends no bytes — the old digest is still on disk', async () => {
    const first = await release({ appId: 'app-1', slug: 'shop', files: page('one') })
    const next  = await release({ appId: 'app-1', slug: 'shop', files: page('two') })
    expect(next.digest).not.toBe(first.digest)

    const back = await statics.activate({ appId: 'app-1', slug: 'shop', digest: first.digest })
    expect(back.digest).toBe(first.digest)
    expect(await statics.currentDigest('app-1')).toBe(first.digest)
    expect((await serve('shop.fleet.test', '/').then(r => r.text()))).toContain('one')
  })

  test('the machine says where it put it, rather than a console guessing', async () => {
    const out = await statics.publish({ appId: 'app-1', files: page() })
    const on  = await statics.activate({ appId: 'app-1', slug: 'shop', digest: out.digest })
    expect(on.url).toBe('http://fleet.test:8181/shop/')
  })

  test('a digest this machine does not hold is named, not left dangling', async () => {
    await release({ appId: 'app-1', files: page() })
    const gone = 'sha256:' + 'cd'.repeat(32)
    await expect(statics.activate({ appId: 'app-1', digest: gone })).rejects.toThrow(/does not hold release/)
    // And the live release is untouched, which is the point of asking first.
    expect(await statics.currentDigest('app-1')).not.toBe(gone)
  })

  test('a string that is not a digest at all', async () => {
    await expect(statics.activate({ appId: 'app-1', digest: 'latest' })).rejects.toThrow(/is not a digest/)
  })

  test('old releases are pruned, and the live one never is', async () => {
    let live
    for (let i = 0; i < 5; i++) live = await release({ appId: 'app-1', files: page(`v${i}`), keep: 2 })
    const { current, digests } = await statics.releases({ appId: 'app-1' })
    expect(digests.length).toBe(2)
    expect(current).toBe(live.digest)
    expect(digests).toContain(live.digest)
  })
})

describe('health is read off the disk, not off the publish that just returned', () => {

  test('a published app is healthy at its own digest', async () => {
    const out = await release({ appId: 'app-1', files: page() })
    expect(await statics.healthCheck({ appId: 'app-1', digest: out.digest })).toMatchObject({ healthy: true })
  })

  test('an app that was never published is not healthy', async () => {
    expect(await statics.healthCheck({ appId: 'app-1' })).toMatchObject({ healthy: false, digest: null })
  })

  test('a digest that is not the live one is refused with both numbers', async () => {
    const first = await release({ appId: 'app-1', files: page('one') })
    await release({ appId: 'app-1', files: page('two') })
    const out = await statics.healthCheck({ appId: 'app-1', digest: first.digest })
    expect(out.healthy).toBe(false)
    expect(out.reason).toContain(first.digest)
  })

  test('a release whose index.html has gone is not healthy', async () => {
    const out = await release({ appId: 'app-1', files: page() })
    await rm(join(dir, 'apps/app-1', out.digest, 'index.html'))
    expect(await statics.healthCheck({ appId: 'app-1' })).toMatchObject({ healthy: false })
  })

  test('retiring takes the app off the air and keeps every release', async () => {
    const out = await release({ appId: 'app-1', slug: 'shop', files: page() })
    await statics.retire({ appId: 'app-1', slug: 'shop' })

    expect((await serve('shop.fleet.test', '/')).status).toBe(404)
    expect(await stat(join(dir, 'apps/app-1', out.digest, 'index.html')).then(s => s.isFile())).toBe(true)
  })
})

describe('the origin an inline app answers on', () => {

  beforeEach(async () => {
    await release({ appId: 'app-1', slug: 'shop', files: [
      { path: 'index.html', content: '<!doctype html><h1>shop</h1>' },
      { path: 'assets/app.js', content: 'console.log(1)' },
    ] })
  })

  test('by hostname label, and by path on a bare port', async () => {
    expect(await serve('shop.fleet.test', '/').then(r => r.text())).toContain('shop')
    expect(await serve('localhost:7181', '/shop/').then(r => r.text())).toContain('shop')
  })

  test('a machine with a domain name of its own still answers path routes', async () => {
    // `outpost.internal` reads as label `outpost`, which is no app. If the host
    // reading were the only one tried, this whole port would 404 on a box that
    // happens to have DNS.
    expect(await serve('outpost.internal', '/shop/assets/app.js').then(r => r.text())).toContain('console.log')
  })

  test('the content type comes off the extension, and nothing may sniff past it', async () => {
    const res = await serve('shop.fleet.test', '/assets/app.js')
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('a path with no extension is a client route and gets the entry point', async () => {
    expect(await serve('shop.fleet.test', '/orders/7').then(r => r.text())).toContain('shop')
  })

  test('a missing FILE is a 404 — a client route fallback would hide a typo forever', async () => {
    expect((await serve('shop.fleet.test', '/assets/missing.js')).status).toBe(404)
  })

  test('a traversal in the URL cannot leave the release', async () => {
    await writeFile(join(dir, 'secret.txt'), 'fleet secret')
    for (const path of ['/../secret.txt', '/..%2Fsecret.txt', '/assets/../../../secret.txt', '/%2e%2e/secret.txt'])
      expect((await serve('shop.fleet.test', path)).status).toBe(404)
  })

  test('a symlink planted inside a release cannot read the disk either', async () => {
    const digest = await statics.currentDigest('app-1')
    await symlink('/etc/passwd', join(dir, 'apps/app-1', digest, 'escape.txt'))
    // `stat` follows it, so the file resolves — containment is `realpath` on the
    // BASE plus prefix arithmetic on the resolved target, and this is the case
    // that tells the two apart.
    const res = await serve('shop.fleet.test', '/escape.txt')
    expect(res.status).toBe(404)
  })

  test('the etag is the release, so a republish invalidates every URL at once', async () => {
    const res  = await serve('shop.fleet.test', '/')
    const etag = res.headers.get('etag')
    expect(etag).toContain(await statics.currentDigest('app-1'))

    const again = await createStaticServer({ staticDir: dir }).handle(new Request('http://shop.fleet.test/', {
      headers: { host: 'shop.fleet.test', 'if-none-match': etag },
    }))
    expect(again.status).toBe(304)

    await release({ appId: 'app-1', slug: 'shop', files: [
      { path: 'index.html', content: '<!doctype html><h1>new</h1>' },
      { path: 'assets/app.js', content: 'console.log(1)' },
    ] })
    const after = await createStaticServer({ staticDir: dir }).handle(new Request('http://shop.fleet.test/', {
      headers: { host: 'shop.fleet.test', 'if-none-match': etag },
    }))
    expect(after.status).toBe(200)
  })

  test('nothing but GET and HEAD', async () => {
    const res = await createStaticServer({ staticDir: dir }).handle(
      new Request('http://shop.fleet.test/', { method: 'POST', headers: { host: 'shop.fleet.test' } }))
    expect(res.status).toBe(405)
  })

  test('a slug nobody published answers 404 rather than an error', async () => {
    expect((await serve('nothing.fleet.test', '/')).status).toBe(404)
  })
})

describe('the routes basecamp reaches these through', () => {

  const CONFIG = {
    serverId: 'srv-1', secret: 'fleet-secret', basecampUrl: 'http://basecamp.test',
    port: 7180, version: '0.1.0', publicUrl: 'https://outpost.test:7180',
    heartbeatMs: 30_000, reportMs: 300_000, workDir: '/tmp/outpost-test',
  }
  let nonce = 0

  const server = () => createOutpostServer(CONFIG, { statics, log: { warn() {}, error() {} } })

  async function post(path, body, { secret = CONFIG.secret } = {}) {
    const payload = JSON.stringify(body)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (secret) {
      const signed = await signRequest({
        secret, method: 'POST', path, body: payload,
        timestamp: Math.floor(Date.now() / 1000), nonce: `static-${++nonce}`,
      })
      for (const [k, v] of Object.entries(signed)) headers.set(k, v)
    }
    const res = await server().handle(new Request(`http://outpost.test${path}`, { method: 'POST', headers, body: payload }))
    return { status: res.status, body: await res.json() }
  }

  test('a publish takes a signature like every other command', async () => {
    const out = await post('/static/publish', { app_id: 'app-1', slug: 'shop', files: page() }, { secret: null })
    expect(out.status).toBe(401)
  })

  test('the body is snake_case on the wire and camelCase inside', async () => {
    // `app_id`, not `appId`. A route that passed the body straight through
    // would write a release for an app called `undefined`, which is a directory
    // that exists and serves nothing under any hostname.
    const out = await post('/static/publish', { app_id: 'app-1', files: page() })
    expect(out.status).toBe(200)
    await post('/static/activate', { app_id: 'app-1', slug: 'shop', digest: out.body.digest })
    expect(out.body.digest).toBe(await statics.currentDigest('app-1'))
  })

  test('a refusal answers the machine’s own words, not a bare 500', async () => {
    const out = await post('/static/publish', { app_id: 'app-1', files: [{ path: '../x.html', content: 'x' }] })
    expect(out.status).toBe(500)
    expect(out.body.error).toContain('walks the directory tree')
  })

  test('activate and health round-trip a release by digest alone', async () => {
    const first = await post('/static/publish', { app_id: 'app-1', files: page('one') })
    const next  = await post('/static/publish', { app_id: 'app-1', files: page('two') })
    await post('/static/activate', { app_id: 'app-1', slug: 'shop', digest: next.body.digest })

    expect((await post('/static/activate', { app_id: 'app-1', slug: 'shop', digest: first.body.digest })).body.digest)
      .toBe(first.body.digest)
    expect((await post('/static/health', { app_id: 'app-1', digest: first.body.digest })).body)
      .toMatchObject({ healthy: true })
  })
})
