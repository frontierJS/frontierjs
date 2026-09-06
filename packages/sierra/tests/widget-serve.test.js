/*
 * tests/widget-serve.test.js — the widget origin.
 *
 * `serveWidgets` is the module `sierra widgets --serve` runs, the one the
 * generated `widgets/deploy/` container runs, and the one the widget drive
 * loads its bundles through. The drive covers what a browser does with what it
 * serves; this file covers what it answers to a request nobody sane sends —
 * which is the whole of its exposure, because this origin is public by
 * definition: it is the URL a stranger's CMS holds.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { serveWidgets } from '../src/widget/serve.js'

let DIR, OUTSIDE, server

// Roughly the size of a real built widget, and compressible the way one is.
const BIG = ('export const label = "add to basket"; // ' + 'x'.repeat(60) + '\n').repeat(200)

const get = async (path, init) => fetch(`${server.url}${path}`, init)

beforeAll(async () => {
  OUTSIDE = mkdtempSync(join(tmpdir(), 'sierra-w-outside-'))
  writeFileSync(join(OUTSIDE, 'secret.txt'), 'OUTSIDE-SECRET')

  DIR = mkdtempSync(join(tmpdir(), 'sierra-widgets-'))
  mkdirSync(join(DIR, 'assets'))
  writeFileSync(join(DIR, 'buy-button.js'), 'console.log(1)')
  writeFileSync(join(DIR, 'big.js'), BIG)
  writeFileSync(join(DIR, 'logo.png'), Buffer.alloc(4096, 7))
  // One file per type a widget bundle can legitimately reference and that
  // the table used to answer `application/octet-stream` for.
  for (const ext of ['woff', 'ico', 'gif', 'avif', 'wasm'])
    writeFileSync(join(DIR, `asset.${ext}`), Buffer.alloc(64, 3))
  writeFileSync(join(DIR, 'assets', 'chunk-A1b2C3d4.js'), 'console.log(2)')
  writeFileSync(join(DIR, 'assets', 'chunk-A1b2C3d4.js.map'), '{"version":3}')
  writeFileSync(join(DIR, 'assets', 'my-file-name.js.map'), '{"version":3}')
  symlinkSync(join(OUTSIDE, 'secret.txt'), join(DIR, 'assets', 'link.txt'))

  server = await serveWidgets({ dir: DIR })
})

afterAll(async () => {
  await server?.close()
  rmSync(DIR, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

describe('what it serves', () => {
  test('the entry, with CORS and a short cache', async () => {
    const res = await get('/buy-button.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).not.toMatch(/immutable/)
  })

  // FJS-825. `nosniff` is set on every response here, so an octet-stream is not
  // a guess a browser recovers from: a `.wasm` served that way cannot be
  // `instantiateStreaming`'d at all, and a font is simply not applied.
  test('a widget asset gets its real type, not octet-stream', async () => {
    const want = {
      'asset.woff': 'font/woff',
      'asset.ico':  'image/x-icon',
      'asset.gif':  'image/gif',
      'asset.avif': 'image/avif',
      'asset.wasm': 'application/wasm',
    }
    for (const [file, type] of Object.entries(want)) {
      const res = await get(`/${file}`)
      expect(res.status, file).toBe(200)
      expect(res.headers.get('content-type'), file).toBe(type)
    }
  })

  // The control: the fallback still exists and is still guarded. A table that
  // answered a real type for everything would satisfy the row above.
  test('an extension nobody declared is still octet-stream, with nosniff', async () => {
    writeFileSync(join(DIR, 'thing.bin'), 'x')
    const res = await get('/thing.bin')
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('a hashed chunk is immutable', async () => {
    expect((await get('/assets/chunk-A1b2C3d4.js')).headers.get('cache-control'))
      .toMatch(/immutable/)
  })

  test('…and so is its sourcemap, which carries the same hash', async () => {
    // The pattern anchored on the FINAL extension, so the eight characters
    // before `.map` were `3d4.js` — which holds a `.` — and a sourcemap for a
    // content-addressed file was revalidated on every load while the file
    // beside it was cached for a year.
    expect((await get('/assets/chunk-A1b2C3d4.js.map')).headers.get('cache-control'))
      .toMatch(/immutable/)
  })

  test('…and an unhashed name is still not immutable, compound extension or not', async () => {
    // The control, and it is the direction that matters: a name wrongly called
    // hashed is cached for a year and the only way back is to rename the file.
    // Repeating the extension segment must not loosen that — `my-file-name` is
    // refused on the same eight characters either way.
    for (const path of ['/buy-button.js', '/assets/my-file-name.js.map']) {
      expect((await get(path)).headers.get('cache-control'), path)
        .not.toMatch(/immutable/)
    }
  })
})

describe('what it refuses', () => {
  test('a URL that is not a URL is a 400, and the origin is still up (FJS-784)', async () => {
    // The decode sat outside the try, in an async handler: under node the
    // unhandled rejection exited the process, under bun the response was never
    // written and the socket was held until the client gave up. The last
    // assertion is the half that says the process survived.
    expect((await get('/%')).status).toBe(400)
    expect((await get('/%zz')).status).toBe(400)
    expect((await get('/buy-button.js')).status).toBe(200)
  })

  test('a NUL byte is refused rather than truncating the path', async () => {
    expect((await get('/buy-button.js%00.png')).status).toBe(400)
  })

  test('a path cannot walk out of the directory', async () => {
    expect((await get('/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).status).toBe(404)
  })

  test('a symlink out of the root is not served, and answers 404 (FJS-783)', async () => {
    // 404 rather than 403, matching junction's answer for the same rule: a 403
    // confirms to the caller that they found a way out of the root.
    const res = await get('/assets/link.txt')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('OUTSIDE-SECRET')
  })

  test('the ordinary chunk beside it is still served', async () => {
    // The negative control: a check that refused everything under `assets/`
    // would satisfy the assertion above and ship a dead widget (`FJS-351`).
    expect((await get('/assets/chunk-A1b2C3d4.js')).status).toBe(200)
  })

  test('a named directory IS published — the escape is declared, not global', async () => {
    const open = await serveWidgets({ dir: DIR, allowOutside: [OUTSIDE] })
    try {
      const res = await fetch(`${open.url}/assets/link.txt`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('OUTSIDE-SECRET')
    } finally {
      await open.close()
    }
  })

  test('a write verb is refused and OPTIONS is answered', async () => {
    expect((await get('/buy-button.js', { method: 'POST' })).status).toBe(405)
    expect((await get('/buy-button.js', { method: 'OPTIONS' })).status).toBe(204)
  })

  test('…and the 405 says what IS allowed', async () => {
    // A 405 with no `Allow` tells a caller only that they were wrong. `FJS-753`
    // settled the shape for junction; a static origin owes the same answer.
    const res = await get('/buy-button.js', { method: 'POST' })
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
  })
})

describe('what it costs the host page', () => {
  test('a compressible body travels gzipped, and says so', async () => {
    // 12 KB on somebody else's page, on every visit. The bytes on the wire are
    // what this asserts — a `Content-Encoding` with an uncompressed body would
    // pass any header-only check.
    const res = await get('/big.js', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(Number(res.headers.get('content-length'))).toBeLessThan(BIG.length / 2)
    // …and it is still the file. Compression is not truncation.
    expect(await res.text()).toBe(BIG)
  })

  test('a caller that did not ask gets the bytes whole', async () => {
    const res = await get('/big.js', { headers: { 'accept-encoding': 'identity' } })
    expect(res.headers.get('content-encoding')).toBe(null)
    expect(Number(res.headers.get('content-length'))).toBe(BIG.length)
  })

  test('a small file is not compressed — the header would cost more than it saves', async () => {
    const res = await get('/buy-button.js', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe(null)
  })

  test('an image is not compressed either', async () => {
    const res = await get('/logo.png', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe(null)
  })

  test('a preflight is cached, so a widget does not pay two round trips per call', async () => {
    const res = await get('/buy-button.js', { method: 'OPTIONS' })
    expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThan(0)
  })
})
