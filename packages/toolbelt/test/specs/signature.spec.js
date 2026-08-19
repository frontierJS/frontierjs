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

import { canonicalRequest, signRequest, verifyRequest, sha256Hex } from '../../src/signature/signature.js'

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

test('signature: the canonical string is what conduit has always signed', async function () {
  // Byte-for-byte the string `conduit/src/transports/base.ts` built by hand, so
  // adopting this changes nothing on the wire for an already-deployed target.
  const line = canonicalRequest({
    method: 'POST', path: '/exec', timestamp: '1700000000', nonce: 'n-1', bodyHash: await sha256Hex(''),
  })
  assert.equal(line, [
    'POST', '/exec', '1700000000', 'n-1',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'))
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
