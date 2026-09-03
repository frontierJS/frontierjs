/*
 * signature.spec.js
 *
 * The property under test is that a verifier written from this module agrees
 * with a signer written from it, and refuses everything else. `FJS-349` is what
 * happens without one: conduit signed every outbound request to an Outpost and
 * the endpoints an Outpost calls took no credential at all, because the signing
 * half existing read as the scheme being enforced.
 *
 * Each refusal below is a real attack on the shape, not a spelling check.
 */

import { canonicalRequest, canonicalQuery, signRequest, verifyRequest, sha256Hex } from '../../src/signature/signature.js'

const SECRET = 'a-fleet-secret'
const BODY   = JSON.stringify({ outpost_version: '0.4.1' })

// Stated, never generated: this kit is pure, so a clock and a nonce are things
// a caller brings. It also makes every case below deterministic.
const NOW    = 1_700_000_000
let   nonces = 0
const sign   = (opts) => signRequest({ timestamp: NOW, nonce: `n-${++nonces}`, ...opts })
const verify = (opts) => verifyRequest({ now: NOW, ...opts })

test('signature: a signed request verifies', async function () {
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/servers/7', body: BODY })
  const result  = await verify({ secret: SECRET, method: 'POST', path: '/servers/7', body: BODY, headers })
  assert.ok(result.ok, JSON.stringify(result))
})

test('signature: the canonical string has six lines, and the query is the third', async function () {
  const line = canonicalRequest({
    method: 'POST', path: '/exec', timestamp: '1700000000', nonce: 'n-1', bodyHash: await sha256Hex(''),
  })
  assert.equal(line, [
    'POST', '/exec', '', '1700000000', 'n-1',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'))
})

test('signature: a query signs on its own line', async function () {
  const line = canonicalRequest({
    method: 'GET', path: '/echo', query: '?amount=1&to=alice',
    timestamp: '1700000000', nonce: 'n-1', bodyHash: await sha256Hex(''),
  })
  assert.equal(line.split('\n')[2], 'amount=1&to=alice')
})

test('signature: canonicalQuery is order-independent and RFC 3986 encoded', function () {
  // Nothing preserves parameter order across a proxy or a client library, so a
  // signature bound to the sender's order fails intermittently and looks like a
  // clock problem.
  assert.equal(canonicalQuery('to=alice&amount=1'), canonicalQuery('amount=1&to=alice'))
  // encodeURIComponent leaves these five alone and RFC 3986 reserves them —
  // two sides with different encoders 401 every request carrying one.
  assert.equal(canonicalQuery("note=a!b'c(d)e*f"), 'note=a%21b%27c%28d%29e%2Af')
  // A repeated key keeps both values; folding them loses the second.
  assert.equal(canonicalQuery('tag=b&tag=a'), 'tag=a&tag=b')
  assert.equal(canonicalQuery(''), '')
  assert.equal(canonicalQuery(undefined), '')
})

test('signature: canonicalQuery reads whatever a caller holds', function () {
  const expected = 'amount=1&to=alice'
  assert.equal(canonicalQuery('amount=1&to=alice'), expected)
  assert.equal(canonicalQuery(new URLSearchParams('amount=1&to=alice')), expected)
  assert.equal(canonicalQuery([['to', 'alice'], ['amount', 1]]), expected)
  assert.equal(canonicalQuery({ to: 'alice', amount: 1 }), expected)
  // An object holds a repeated key as an array — the only way one survives a parse.
  assert.equal(canonicalQuery({ tag: ['b', 'a'] }), 'tag=a&tag=b')
})

test('signature: a path carrying its own query is split, not signed whole', async function () {
  // A verifier reads the raw request URL and hands over one string; a signer
  // holds them apart. Both must reach the same canonical form or every request
  // from one of them 401s.
  const joined = canonicalRequest({
    method: 'GET', path: '/echo?to=alice', timestamp: '1', nonce: 'n', bodyHash: 'h',
  })
  const apart = canonicalRequest({
    method: 'GET', path: '/echo', query: 'to=alice', timestamp: '1', nonce: 'n', bodyHash: 'h',
  })
  assert.equal(joined, apart)
})

test('signature: the query is bound — a signed GET does not move to other parameters', async function () {
  // `FJS-678`. The signer excluded the query, so a captured `?amount=1&to=alice`
  // verified unchanged against `?amount=1000000&to=mallory` and the receiver had
  // no way to include it.
  const headers = await sign({ secret: SECRET, method: 'GET', path: '/echo', query: 'amount=1&to=alice' })

  const same = await verify({
    secret: SECRET, method: 'GET', path: '/echo', query: 'amount=1&to=alice', headers,
  })
  assert.ok(same.ok, JSON.stringify(same))

  const tampered = await verify({
    secret: SECRET, method: 'GET', path: '/echo', query: 'amount=1000000&to=mallory', headers,
  })
  assert.equal(tampered.ok, false)
  assert.match(tampered.reason, /does not match/)

  // And a query dropped entirely is not the same request either.
  const stripped = await verify({ secret: SECRET, method: 'GET', path: '/echo', headers })
  assert.equal(stripped.ok, false)
})

test('signature: key order does not decide whether a request verifies', async function () {
  const headers = await sign({ secret: SECRET, method: 'GET', path: '/echo', query: 'amount=1&to=alice' })
  const swapped = await verify({
    secret: SECRET, method: 'GET', path: '/echo', query: 'to=alice&amount=1', headers,
  })
  assert.ok(swapped.ok, JSON.stringify(swapped))
})

test('signature: a bodyless, queryless request still verifies', async function () {
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/reboot' })
  const result  = await verify({ secret: SECRET, method: 'POST', path: '/reboot', headers, query: '' })
  assert.ok(result.ok, JSON.stringify(result))
})

test('signature: a version-1 signature is refused BY NAME', async function () {
  // Every deployed Outpost signs v1. Refused as a mismatch it reads exactly like
  // a wrong secret, which is the wrong half to spend an outage looking at.
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/exec' })
  const v1 = { ...headers, 'X-Fjs-Signature': headers['X-Fjs-Signature'].replace(/^v2-/, '') }

  const result = await verify({ secret: SECRET, method: 'POST', path: '/exec', headers: v1 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /version 1 is no longer accepted/)
})

test('signature: the emitted signature carries its version', async function () {
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/exec' })
  assert.match(headers['X-Fjs-Signature'], /^v2-sha256=[0-9a-f]{64}$/)
})

test('signature: a part cannot swallow the separator', function () {
  // Joined with a newline, so a value carrying one could move the boundary
  // between two parts and make two different requests sign identically.
  assert.throws(() => canonicalRequest({
    method: 'POST', path: '/a\n/b', timestamp: '1', nonce: 'n', bodyHash: 'h',
  }), /newline/)
})

test('signature: a captured signature does not move to another endpoint', async function () {
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/health-check', body: '' })
  // The same headers, replayed at the endpoint that runs a shell command.
  const moved = await verify({ secret: SECRET, method: 'POST', path: '/exec', body: '', headers })
  assert.equal(moved.ok, false)
  assert.match(moved.reason, /does not match/)
})

test('signature: the body is bound, so a payload cannot be swapped under it', async function () {
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/servers/7', body: BODY })
  const swapped = await verify({
    secret: SECRET, method: 'POST', path: '/servers/7',
    body: JSON.stringify({ outpost_url: 'http://attacker.invalid' }), headers,
  })
  assert.equal(swapped.ok, false)
})

test('signature: a stale signature is refused, and the reason says so', async function () {
  const headers = await sign({
    secret: SECRET, method: 'POST', path: '/servers/7', body: '', timestamp: 1_000_000,
  })
  const result = await verifyRequest({
    secret: SECRET, method: 'POST', path: '/servers/7', body: '', headers, now: 1_000_600,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /600s out/)
})

test('signature: a nonce inside the window is refused the second time', async function () {
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/servers/7', body: '' })
  const seen = new Set()
  const seenNonce = n => { const had = seen.has(n); seen.add(n); return had }

  const first  = await verify({ secret: SECRET, method: 'POST', path: '/servers/7', body: '', headers, seenNonce })
  const second = await verify({ secret: SECRET, method: 'POST', path: '/servers/7', body: '', headers, seenNonce })
  assert.ok(first.ok)
  assert.equal(second.ok, false)
  assert.match(second.reason, /already been used/)
})

test('signature: the nonce store is only touched by a request that already verified', async function () {
  // A replay check that ran first would let anyone fill the store with nonces
  // they never held a signature for.
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/servers/7', body: '' })
  const asked = []
  await verify({
    secret: 'a-different-secret', method: 'POST', path: '/servers/7', body: '', headers,
    seenNonce: n => { asked.push(n); return false },
  })
  assert.equal(asked.length, 0)
})

test('signature: no secret on the receiving side is a refusal, never a pass', async function () {
  const headers = await sign({ secret: SECRET, method: 'POST', path: '/servers/7', body: '' })
  const result  = await verify({ secret: undefined, method: 'POST', path: '/servers/7', body: '', headers })
  assert.equal(result.ok, false)
  assert.match(result.reason, /no secret/)
})

test('signature: a request with no headers at all is refused by name', async function () {
  // The shape FJS-349 measured: a POST carrying nothing but a service method.
  const result = await verify({ secret: SECRET, method: 'POST', path: '/servers/7', body: '', headers: {} })
  assert.equal(result.ok, false)
  assert.match(result.reason, /missing/)
})

test('signature: headers are read case-insensitively, and a Headers object works', async function () {
  const signed = await sign({ secret: SECRET, method: 'POST', path: '/servers/7', body: '' })
  const lower  = Object.fromEntries(Object.entries(signed).map(([k, v]) => [k.toLowerCase(), v]))
  assert.ok((await verify({ secret: SECRET, method: 'POST', path: '/servers/7', body: '', headers: lower })).ok)
  assert.ok((await verify({
    secret: SECRET, method: 'POST', path: '/servers/7', body: '', headers: new Headers(signed),
  })).ok)
})

test('signature: the clock and the nonce are the caller\'s, and it is refused without them', async function () {
  // Not a style choice: this package is importable by litestone and mesa because
  // it depends on nothing and computes nothing it is not given, and CI fails a
  // `Date.now()` in this directory. Defaulting them here would also hide the
  // pair a receiver grades every request on.
  await assertRejects(() => signRequest({ secret: SECRET, method: 'POST', path: '/x', nonce: 'n' }), /timestamp is required/)
  await assertRejects(() => signRequest({ secret: SECRET, method: 'POST', path: '/x', timestamp: NOW }), /nonce is required/)

  const headers = await sign({ secret: SECRET, method: 'POST', path: '/x', body: '' })
  await assertRejects(
    () => verifyRequest({ secret: SECRET, method: 'POST', path: '/x', body: '', headers }),
    /now is required/)
})

/** The harness's `throws` is synchronous; a rejected promise needs its own. */
async function assertRejects(fn, pattern) {
  let threw = null
  try { await fn() } catch (e) { threw = e }
  assert.ok(threw, 'expected a rejection, got none')
  assert.match(threw.message, pattern)
}
