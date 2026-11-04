// test/static-root.test.ts — a file that stays inside the root, not a path
// that does.
//
// `sanitizePath` refuses `..` and a NUL byte, which is the whole of what a URL
// can say. A symlink INSIDE the root says the rest, and it was followed: a
// `link.css` pointing at `../../secret.txt` was served 200 with the contents
// (`FJS-746`). Every refusal here is paired with an ordinary file served from
// the same directory, because a containment check that refused everything
// would satisfy the refusals on its own.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { serveStatic } from '../src/transport/static.ts'
import { createApp } from '../index.ts'
import type { AppConfig } from '../src/config/index.ts'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'

let base: string, root: string, outside: string, shared: string

beforeAll(() => {
  // realpath: macOS puts /var/folders behind a symlink, so a root read from
  // mkdtemp is itself a link and every containment check would compare a
  // resolved file against an unresolved directory.
  base    = realpathSync(mkdtempSync(join(tmpdir(), 'fjs-static-')))
  root    = join(base, 'public')
  outside = join(base, 'private')
  shared  = join(base, 'shared')

  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(shared,  { recursive: true })

  writeFileSync(join(root, 'assets', 'real.css'),  'body { color: red }')
  writeFileSync(join(root, 'assets', 'index-B3kd9Qz2.js'), 'export {}')
  writeFileSync(join(outside, 'secret.txt'),       'TOP SECRET')
  writeFileSync(join(shared, 'logo.svg'),          '<svg/>')
  // An image and an unlisted type, for the two controls an allow-list needs.
  writeFileSync(join(root, 'assets', 'shot.png'),  'not really a png')
  writeFileSync(join(root, 'assets', 'thing.bin'), 'bytes')

  symlinkSync(join(outside, 'secret.txt'), join(root, 'assets', 'link.css'))
  symlinkSync(join(root, 'assets', 'real.css'), join(root, 'assets', 'inside.css'))
  symlinkSync(shared, join(root, 'brand'))
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const ask = (path: string, opts: Record<string, unknown> = {}) =>
  serveStatic(new Request(`http://x${path}`), path, { root, ...opts } as never)

describe('a symlink out of the root', () => {
  it('is refused', async () => {
    expect(await ask('/assets/link.css')).toBeNull()
  })

  it('while the ordinary file beside it is served', async () => {
    // The control. Without it, a check that refused every static file would
    // pass the assertion above.
    const res = await ask('/assets/real.css')
    expect(res?.status).toBe(200)
    expect(await res!.text()).toContain('color: red')
  })

  it('answers as not found rather than forbidden', async () => {
    // 403 would confirm the caller found a way out of the root. `..` still
    // answers 403, because that is a request nobody makes by accident.
    expect(await ask('/assets/link.css')).toBeNull()
    expect((await ask('/../private/secret.txt'))?.status).toBe(403)
  })
})

describe('a symlink that stays inside', () => {
  it('is served, because containment is about where it LANDS', async () => {
    const res = await ask('/assets/inside.css')
    expect(res?.status).toBe(200)
    expect(await res!.text()).toContain('color: red')
  })
})

describe('a directory the operator published on purpose', () => {
  it('is refused until it is named', async () => {
    expect(await ask('/brand/logo.svg')).toBeNull()
  })

  it('and served once it is', async () => {
    const res = await ask('/brand/logo.svg', { allowOutside: [shared] })
    expect(res?.status).toBe(200)
    expect(await res!.text()).toBe('<svg/>')
  })

  it('which does not widen it to everything else outside', async () => {
    expect(await ask('/assets/link.css', { allowOutside: [shared] })).toBeNull()
  })
})

describe('no root is not a root', () => {
  it('serves a path the application named itself', async () => {
    // `ctx.file('/var/data/report.pdf')` — the app chose the file and there is
    // nothing for it to be inside of. Containment is about a directory an
    // operator published.
    const res = await serveStatic(
      new Request('http://x/x'), join(outside, 'secret.txt'), { root: '' },
    )
    expect(res?.status).toBe(200)
    expect(await res!.text()).toBe('TOP SECRET')
  })
})

// ─── the declared type binds ─────────────────────────────────────────────────
//
// This root serves an app's own bundle and, wherever a `File` column's local
// provider points at it, bytes a stranger uploaded — and the handler cannot tell
// them apart ([FJS-1187](../../../ISSUES.md#fjs-1187)). Measured against a
// running `example` before this: a served upload answered `Content-Type` and
// `Cache-Control` and nothing else, so a browser was free to sniff its way to a
// different type than the one declared.
//
// `nosniff` is the half that is safe for BOTH populations. It is not the whole
// answer and the rows below say which half is still missing.

describe('what a cache may keep', () => {
  it('a content-hashed bundle file is immutable for a year', async () => {
    const res = await ask('/assets/index-B3kd9Qz2.js')
    expect(res?.status).toBe(200)
    expect(res!.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('an unhashed file keeps the short, revalidating default', async () => {
    const res = await ask('/assets/real.css')
    expect(res!.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate')
  })
})

describe('the declared content type binds', () => {
  it('every served response carries nosniff', async () => {
    const res = await ask('/assets/real.css')
    expect(res?.status).toBe(200)
    expect(res!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res!.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('a range response too, because it is the same bytes', async () => {
    // A partial response declares the same type, so leaving it off here would
    // hand back a sniffable copy of exactly the file the full response bound.
    const res = await serveStatic(
      new Request('http://x/assets/real.css', { headers: { range: 'bytes=0-2' } }),
      '/assets/real.css', { root } as never,
    )
    expect(res?.status).toBe(206)
    expect(res!.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('an unmarked root serves an SVG inline, because it is the app\'s own', async () => {
    // The default, and it stays the default: a root holding an app's bundle is
    // most roots, and `isInlineSafe` refuses `text/javascript`, so inverting
    // this would break the app it is meant to protect (`FJS-D314`).
    const res = await ask('/brand/logo.svg', { allowOutside: [shared] })
    expect(res?.status).toBe(200)
    expect(res!.headers.get('content-type')).toBe('image/svg+xml')
    expect(res!.headers.get('content-disposition')).toBeNull()
  })
})

// ─── a root the app says holds strangers' bytes ──────────────────────────────

describe('untrusted: true', () => {
  it('answers an SVG as an attachment, which is the whole point', async () => {
    // An SVG is a document that may carry script and it runs in the origin that
    // served it. `nosniff` binds the type and is what makes this decidable; the
    // disposition is what stops the browser rendering it.
    const res = await ask('/brand/logo.svg', { allowOutside: [shared], untrusted: true })
    expect(res?.status).toBe(200)
    expect(res!.headers.get('content-type')).toBe('image/svg+xml')
    expect(res!.headers.get('content-disposition')).toBe('attachment; filename="logo.svg"')
  })

  it('and leaves a photograph inline, so marking an uploads root costs nothing', async () => {
    // The control that decides whether this is usable: every `File` column in
    // the repo holds images, and an attachment rule that reached them would
    // turn every product photograph into a download.
    const res = await ask('/assets/shot.png', { untrusted: true })
    expect(res?.status).toBe(200)
    expect(res!.headers.get('content-disposition')).toBeNull()
  })

  it('an unknown type is an attachment, because the allow-list is an allow-list', async () => {
    const res = await ask('/assets/thing.bin', { untrusted: true })
    expect(res?.status).toBe(200)
    expect(res!.headers.get('content-type')).toBe('application/octet-stream')
    expect(res!.headers.get('content-disposition')).toContain('attachment')
  })

  it('a range response carries the same disposition as the full one', async () => {
    // Computed once and shared. A 206 declares the same type, so an attachment
    // rule reaching one and not the other hands back an inline copy of exactly
    // the file the full response refused to inline.
    const res = await serveStatic(
      new Request('http://x/brand/logo.svg', { headers: { range: 'bytes=0-2' } }),
      '/brand/logo.svg', { root, allowOutside: [shared], untrusted: true } as never,
    )
    expect(res?.status).toBe(206)
    expect(res!.headers.get('content-disposition')).toBe('attachment; filename="logo.svg"')
  })
})

describe('the config type names what serveStatic reads (FJS-1303)', () => {
  it('http.static accepts untrusted, so the documented spelling typechecks', () => {
    // Pinned by `bun run typecheck`: the key missing from AppConfig is TS2353.
    const block: NonNullable<AppConfig['http']['static']> = { root: '/srv/uploads', maxAge: 3600, untrusted: true }
    expect(block.untrusted).toBe(true)
  })
})

// FJS-3543 — a reload on a client route (`/admin/items`) names no file, and an
// app served with no proxy in front has no `try_files` to hand it index.html.
describe('spa fallback', () => {
  const html = { headers: { accept: 'text/html,application/xhtml+xml' } }
  const spaAsk = (path: string, init: RequestInit = html, opts: Record<string, unknown> = { spa: true }) =>
    serveStatic(new Request(`http://x${path}`, init), path, { root, ...opts } as never)

  beforeAll(() => writeFileSync(join(root, 'index.html'), '<html>shell</html>'))

  it('answers a document request for a client route with the index', async () => {
    const res = await spaAsk('/admin/items')
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe('<html>shell</html>')
  })

  it('leaves a missing client route null when spa is off', async () => {
    expect(await spaAsk('/admin/items', html, {})).toBeNull()
  })

  it('does not answer a missing file (has an extension) with the index', async () => {
    expect(await spaAsk('/assets/missing.js')).toBeNull()
  })

  it('does not answer a non-document request (fetch, no text/html) with the index', async () => {
    expect(await spaAsk('/admin/items', { headers: { accept: 'application/json' } })).toBeNull()
  })

  it('still serves a real file as itself', async () => {
    const res = await spaAsk('/assets/real.css')
    expect(await res?.text()).toBe('body { color: red }')
  })

  it('does not turn a refused path into the index', async () => {
    expect((await spaAsk('/a/../../etc'))?.status).not.toBe(200)
  })
})

// ─── ctx.file with the route's own identity (FJS-3915) ───────────────────────
//
// A raw route serving a row's bytes by its content hash and stored mime must not
// re-derive Range: the etag, type and cache policy are the route's to state, and
// the 206 / 416 / 304 arithmetic is the static handler's.

describe('ctx.file(path, { etag, type, cacheControl })', () => {
  let app: any
  const SHA = '"sha256-abc"'

  beforeAll(async () => {
    app = createApp({ logLevel: 'silent', config: { port: 0 } })
    app.get('/blob', (ctx: any) => ctx.file(join(root, 'assets', 'thing.bin'), {
      etag: SHA, type: 'image/png', cacheControl: 'private, max-age=31536000, immutable',
    }))
    app.get('/named', (ctx: any) => ctx.file(join(root, 'assets', 'real.css'), { download: 'report.css' }))
    await app.start()
  })
  afterAll(async () => { await app?.stop?.() })

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.http.fetch(new Request(`http://localhost${path}`, { headers }))

  it('a full response carries the route\'s etag, type and cache policy', async () => {
    const res = await get('/blob')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe(SHA)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('a range is a 206 under the same identity', async () => {
    const res = await get('/blob', { range: 'bytes=1-2' })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('yt')
    expect(res.headers.get('content-range')).toBe('bytes 1-2/5')
    expect(res.headers.get('etag')).toBe(SHA)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('a range past the end is a 416 naming the size', async () => {
    const res = await get('/blob', { range: 'bytes=9-12' })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */5')
  })

  it('a matching If-None-Match is a 304 on the route\'s etag', async () => {
    const res = await get('/blob', { 'if-none-match': SHA })
    expect(res.status).toBe(304)
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('a download name reaches the response of a file that exists', async () => {
    const res = await get('/named')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename*=utf-8''report.css`)
  })
})
