// storage-sigv4.test.ts — the object-store signer, graded by AWS rather than by itself.
//
// A wrong signature fails as `403 SignatureDoesNotMatch`, which reads as bad
// credentials, so nothing in production points at this file. Two oracles, and
// neither was written here:
//
//   · AWS's own signing test suite (`fixtures/sigv4/`, see its README) — the
//     spaces, the non-ASCII path, the query order, the header whitespace. Its
//     cases use `service: "service"`.
//   · the worked examples on AWS's S3 SigV4 documentation pages — the same
//     signer with `service: "s3"`, where it adds `x-amz-content-sha256` and
//     presigns with `UNSIGNED-PAYLOAD`. Every one is an ASCII key, which is the
//     shape the signer always got right, so these are the half that must stay
//     green while the first half is fixed.
//
// The clock is `setSystemTime` rather than a parameter: the signer reads the
// time once per call, and a test seam on a signing function is an option every
// production caller would have to ignore.
//
// The provider half runs a real S3Provider against a local server, because
// what reaches the wire is a property of the URL the provider BUILDS, and a key
// carrying `#` or `?` never reaches the signer intact if that URL is wrong.

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { setSystemTime } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { signRequest, presignUrl, canonicalUri, canonicalQuery } from '../src/storage/sigv4.js'
import { S3Provider } from '../src/storage/providers/s3.js'

const FIXTURES = new URL('./fixtures/sigv4/', import.meta.url).pathname
const read     = (c: string, f: string) => readFileSync(join(FIXTURES, c, f), 'utf8')

type Case = {
  name: string
  method: string
  url: string
  headers: Record<string, string>
  opts: { accessKeyId: string, secretAccessKey: string, region: string, service: string }
  at: Date
  expires: number
}

/** A fixture's `request.txt` → what the signer is called with. Host goes into the URL. */
function loadCase(name: string): Case {
  const [line, ...rest] = read(name, 'request.txt').split('\n')
  const m = /^(\S+) (.*) HTTP\/1\.1$/.exec(line)
  if (!m) throw new Error(`${name}: unreadable request line ${JSON.stringify(line)}`)
  const headers: Record<string, string> = {}
  let host = ''
  for (const h of rest) {
    if (!h.trim()) continue
    const i = h.indexOf(':')
    const key = h.slice(0, i), value = h.slice(i + 1)
    if (key.toLowerCase() === 'host') host = value.trim()
    else headers[key] = value
  }
  const ctx = JSON.parse(read(name, 'context.json'))
  return {
    name,
    method:  m[1],
    url:     `https://${host}${m[2]}`,
    headers,
    opts:    { accessKeyId: ctx.credentials.access_key_id, secretAccessKey: ctx.credentials.secret_access_key,
               region: ctx.region, service: ctx.service },
    at:      new Date(ctx.timestamp),
    expires: ctx.expiration_in_seconds,
  }
}

const CASES = readdirSync(FIXTURES, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()

afterEach(() => { setSystemTime() })

// ─── the fixture set is what it claims to be ──────────────────────────────────

test('the fixture directory holds the cases this file names — discovery alone fails open', () => {
  expect(CASES).toEqual([
    'get-header-value-trim', 'get-slashes-unnormalized', 'get-space-unnormalized', 'get-unreserved',
    'get-utf8', 'get-vanilla', 'get-vanilla-query-order-encoded', 'get-vanilla-query-order-key-case',
    'get-vanilla-query-unreserved', 'get-vanilla-utf8-query',
  ])
})

// ─── AWS's signing test suite ─────────────────────────────────────────────────

describe('header-signed, against AWS\'s signing test suite', () => {
  for (const name of CASES) {
    test(name, async () => {
      const c         = loadCase(name)
      const canonical = read(name, 'header-canonical-request.txt').split('\n')
      const u         = new URL(c.url)

      // The two lines the defects lived on, compared as text so a failure says which.
      expect(canonicalUri(u.pathname)).toBe(canonical[1])
      expect(canonicalQuery(u.searchParams)).toBe(canonical[2])

      setSystemTime(c.at)
      const signed = await signRequest(c.method, c.url, c.headers, null, c.opts)
      const auth   = /SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(signed.Authorization)!
      expect(auth[1]).toBe(canonical[canonical.length - 2])
      expect(auth[2]).toBe(read(name, 'header-signature.txt').trim())
    })
  }
})

describe('presigned, against AWS\'s signing test suite', () => {
  for (const name of CASES.filter(n => !n.startsWith('get-header'))) {
    test(name, async () => {
      const c = loadCase(name)
      setSystemTime(c.at)
      const url = new URL(await presignUrl(c.method, c.url, c.opts, c.expires))

      const canonical = read(name, 'query-canonical-request.txt').split('\n')
      const params    = new URLSearchParams(url.search)
      const signature = params.get('X-Amz-Signature')
      params.delete('X-Amz-Signature')
      expect(canonicalQuery(params)).toBe(canonical[2])
      expect(signature).toBe(read(name, 'query-signature.txt').trim())
    })
  }
})

// ─── AWS's S3 documentation examples ──────────────────────────────────────────

describe('S3, against the worked examples in AWS\'s S3 SigV4 documentation', () => {
  const opts = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                 region: 'us-east-1' }
  beforeEach(() => { setSystemTime(new Date('2013-05-24T00:00:00Z')) })

  test('GET Object, header-signed with a Range header', async () => {
    const signed = await signRequest('GET', 'https://examplebucket.s3.amazonaws.com/test.txt',
      { Range: 'bytes=0-9' }, null, opts)
    expect(signed.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })

  test('PUT Object, with a body and a `$` in the key', async () => {
    const signed = await signRequest('PUT', 'https://examplebucket.s3.amazonaws.com/test$file.text',
      { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      'Welcome to Amazon S3.', opts)
    expect(signed['x-amz-content-sha256']).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072')
    expect(signed.Authorization).toMatch(/Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/)
  })

  test('a presigned GET, valid for a day', async () => {
    const url = new URL(await presignUrl('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', opts, 86400))
    expect(url.searchParams.get('X-Amz-Signature'))
      .toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
  })
})

// ─── the canonical URI, one segment at a time ─────────────────────────────────

describe('canonical URI', () => {
  // AWS's UriEncode: every byte outside A-Za-z0-9-_.~ is %XX, uppercase, once.
  test('each reserved character is encoded exactly once — the pair beside every unreserved one', () => {
    const cases: Array<[string, string]> = [
      ['/b/a b.png',     '/b/a%20b.png'],
      ['/b/ü.png',       '/b/%C3%BC.png'],
      ['/b/a+b&c=d.png', '/b/a%2Bb%26c%3Dd.png'],
      ["/b/!'()*.png",   '/b/%21%27%28%29%2A.png'],
      ['/b/-_.~az09',    '/b/-_.~az09'],
    ]
    for (const [raw, want] of cases) expect(canonicalUri(new URL(`https://h${raw}`).pathname)).toBe(want)
  })

  test('a `%` that is not an escape is a literal percent, not a throw', () => {
    expect(canonicalUri('/b/100%zz')).toBe('/b/100%25zz')
  })
})

// ─── the provider puts the key on the wire intact ─────────────────────────────

describe('S3Provider against a local server', () => {
  const seen: Array<{ method: string, path: string, auth: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      seen.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get('authorization') })
      return new Response(req.method === 'GET' ? 'bytes' : null, { status: req.method === 'PUT' ? 200 : 204 })
    },
  })
  afterAll(() => server.stop(true))

  const provider = () => new S3Provider({
    provider: 'minio', endpoint: `http://localhost:${server.port}`, bucket: 'shop',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret',
  })
  const decoded = (path: string) => path.split('/').map(decodeURIComponent).join('/')

  test('a key carrying `#`, `?`, a space and a non-ASCII letter arrives as that key', async () => {
    seen.length = 0
    const key = 'photos/a b/ü#1?v=2.png'
    await provider().put(key, 'x', { contentType: 'image/png', size: 1 })
    await provider().get(key)
    await provider().delete(key)

    expect(seen.map(s => s.method)).toEqual(['PUT', 'GET', 'DELETE'])
    for (const s of seen) {
      expect(s.path).not.toContain('?')
      expect(decoded(s.path)).toBe(`/shop/${key}`)
      expect(s.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/)
    }
  })

  test('an ordinary key arrives exactly as written', async () => {
    seen.length = 0
    await provider().put('Product/7/photo/0a1b2c.png', 'x', { contentType: 'image/png', size: 1 })
    expect(seen[0].path).toBe('/shop/Product/7/photo/0a1b2c.png')
  })
})
