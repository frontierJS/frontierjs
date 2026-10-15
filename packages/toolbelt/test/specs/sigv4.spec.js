/*
 * sigv4.spec.js — the SigV4 signer, graded by AWS rather than by itself.
 *
 * A wrong signature fails as `403 SignatureDoesNotMatch`, which reads as bad
 * credentials, so nothing in production points at this file. Two oracles, and
 * neither was written here:
 *
 *   · AWS's own signing test suite (`fixtures/sigv4/`, see its README) — the
 *     spaces, the non-ASCII path, the query order, the header whitespace. Its
 *     cases use `service: "service"`.
 *   · the worked examples on AWS's S3 SigV4 documentation pages — the same
 *     signer with `service: "s3"`, where it adds `x-amz-content-sha256` and
 *     presigns with `UNSIGNED-PAYLOAD`. Every one is an ASCII key, the shape the
 *     signer always got right, so these are the half that must stay green while
 *     the first half is fixed.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signRequest, presignUrl, canonicalUri, canonicalQuery, deriveSigningKey, amzDate } from '../../src/sigv4/sigv4.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/sigv4/', import.meta.url))
const read     = (c, f) => readFileSync(join(FIXTURES, c, f), 'utf8')

// A fixture's `request.txt` → what the signer is called with. Host goes into the URL.
function loadCase(name) {
  const [line, ...rest] = read(name, 'request.txt').split('\n')
  const m = /^(\S+) (.*) HTTP\/1\.1$/.exec(line)
  if (!m) throw new Error(`${name}: unreadable request line ${JSON.stringify(line)}`)
  const headers = {}
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
    method:  m[1],
    url:     `https://${host}${m[2]}`,
    headers,
    opts:    { accessKeyId: ctx.credentials.access_key_id, secretAccessKey: ctx.credentials.secret_access_key,
               region: ctx.region, service: ctx.service, now: new Date(ctx.timestamp) },
    expires: ctx.expiration_in_seconds,
  }
}

const CASES = readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()

test('sigv4: the fixture directory holds the cases this file names — discovery alone fails open', () => {
  assert.deepEqual(CASES, [
    'get-header-value-trim', 'get-slashes-unnormalized', 'get-space-unnormalized', 'get-unreserved',
    'get-utf8', 'get-vanilla', 'get-vanilla-query-order-encoded', 'get-vanilla-query-order-key-case',
    'get-vanilla-query-unreserved', 'get-vanilla-utf8-query',
  ])
})

for (const name of CASES) {
  test(`sigv4: header-signed, AWS suite — ${name}`, async () => {
    const c         = loadCase(name)
    const canonical = read(name, 'header-canonical-request.txt').split('\n')
    const u         = new URL(c.url)

    // The two lines the defects lived on, compared as text so a failure says which.
    assert.equal(canonicalUri(u.pathname), canonical[1])
    assert.equal(canonicalQuery(u.searchParams), canonical[2])

    const signed = await signRequest(c.method, c.url, c.headers, null, c.opts)
    const auth   = /SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(signed.Authorization)
    assert.equal(auth[1], canonical[canonical.length - 2])
    assert.equal(auth[2], read(name, 'header-signature.txt').trim())
  })
}

for (const name of CASES.filter((n) => !n.startsWith('get-header'))) {
  test(`sigv4: presigned, AWS suite — ${name}`, async () => {
    const c   = loadCase(name)
    const url = new URL(await presignUrl(c.method, c.url, c.opts, c.expires))

    const canonical = read(name, 'query-canonical-request.txt').split('\n')
    const params    = new URLSearchParams(url.search)
    const signature = params.get('X-Amz-Signature')
    params.delete('X-Amz-Signature')
    assert.equal(canonicalQuery(params), canonical[2])
    assert.equal(signature, read(name, 'query-signature.txt').trim())
  })
}

// ─── AWS's S3 documentation examples ──────────────────────────────────────────

const S3 = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
             region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') }

test('sigv4: S3 GET Object, header-signed with a Range header', async () => {
  const signed = await signRequest('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', { Range: 'bytes=0-9' }, null, S3)
  assert.equal(signed.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
    'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
    'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
})

test('sigv4: S3 PUT Object, with a body and a `$` in the key', async () => {
  const signed = await signRequest('PUT', 'https://examplebucket.s3.amazonaws.com/test$file.text',
    { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, 'Welcome to Amazon S3.', S3)
  assert.equal(signed['x-amz-content-sha256'], '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072')
  assert.match(signed.Authorization, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/)
})

test('sigv4: S3 presigned GET, valid for a day', async () => {
  const url = new URL(await presignUrl('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', S3, 86400))
  assert.equal(url.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
})

// ─── the caller's half of the contract ────────────────────────────────────────

test('sigv4: a signing key the caller derived signs identically to one derived per call', async () => {
  const url    = 'https://examplebucket.s3.amazonaws.com/test.txt'
  const key    = await deriveSigningKey(S3.secretAccessKey, '20130524', 'us-east-1', 's3')
  const cached = await signRequest('GET', url, {}, null, { ...S3, signingKey: key })
  const fresh  = await signRequest('GET', url, {}, null, S3)
  assert.deepEqual(cached, fresh)
})

test('sigv4: no `now` is a refusal, not the host clock', async () => {
  const { now, ...noClock } = S3
  let threw = null
  try { await signRequest('GET', 'https://h.example/k', {}, null, noClock) } catch (e) { threw = e }
  assert.ok(threw, 'expected a throw')
  assert.match(threw.message, /opts\.now/)
  assert.throws(() => amzDate(undefined), /opts\.now/)
})

// ─── the canonical URI, one segment at a time ─────────────────────────────────

test('sigv4: each reserved character is encoded exactly once — the pair beside every unreserved one', () => {
  const cases = [
    ['/b/a b.png',     '/b/a%20b.png'],
    ['/b/ü.png',       '/b/%C3%BC.png'],
    ['/b/a+b&c=d.png', '/b/a%2Bb%26c%3Dd.png'],
    ["/b/!'()*.png",   '/b/%21%27%28%29%2A.png'],
    ['/b/-_.~az09',    '/b/-_.~az09'],
  ]
  for (const [raw, want] of cases) assert.equal(canonicalUri(new URL(`https://h${raw}`).pathname), want)
})

test('sigv4: a `%` that is not an escape is a literal percent, not a throw', () => {
  assert.equal(canonicalUri('/b/100%zz'), '/b/100%25zz')
})
