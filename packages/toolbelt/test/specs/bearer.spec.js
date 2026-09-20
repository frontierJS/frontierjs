/*
 * bearer.spec.js
 *
 * A bearer secret's whole security model is that the holder is the proof, so
 * what is asserted here is the two ways that model is lost: a digest that is
 * reversible (it is not — the token never appears in it), and a digest that is
 * the SAME in two places, which turns a row from the table with the weaker gate
 * into a credential for the one with the stronger.
 *
 * Every refusal is paired with the acceptance one argument away, because a
 * check that refuses the legitimate call too proves nothing about the mistake.
 */

import { readFileSync } from 'node:fs'
import { fingerprint, matchesFingerprint, timingSafeEqual } from '../../src/bearer/bearer.js'

const KEY  = 'app-secret-key'
const WHAT = 'PortalLink.tokenHash'

// ─── the digest ───────────────────────────────────────────────────────────────

test('bearer: a fingerprint is 64 hex characters and carries no trace of the token', async function () {
  const token = 'c0123456789abcdefghijklmn'
  const digest = await fingerprint(token, { key: KEY, purpose: WHAT })

  assert.equal(digest.length, 64)
  assert.ok(/^[0-9a-f]{64}$/.test(digest), 'lower-case hex')
  assert.ok(!digest.includes(token.slice(1, 8)), 'the token is not in its own digest')
})

test('bearer: the same token under the same key and purpose digests identically', async function () {
  // The whole of the lookup: a column holds this, and the next request has to
  // produce the same string or the row is unreachable.
  const a = await fingerprint('tok', { key: KEY, purpose: WHAT })
  const b = await fingerprint('tok', { key: KEY, purpose: WHAT })
  assert.equal(a, b)
})

test('bearer: a different PURPOSE is a different digest', async function () {
  // Domain separation, and the reason `purpose` is required. Without it a
  // portal link's stored digest is a legal API key digest.
  const link = await fingerprint('tok', { key: KEY, purpose: 'PortalLink.tokenHash' })
  const apiKey = await fingerprint('tok', { key: KEY, purpose: 'ApiKey.value' })
  assert.ok(link !== apiKey, 'one token, two purposes, two digests')
})

test('bearer: a different KEY is a different digest', async function () {
  const mine = await fingerprint('tok', { key: KEY, purpose: WHAT })
  const theirs = await fingerprint('tok', { key: 'another-app', purpose: WHAT })
  assert.ok(mine !== theirs, 'the key is what an exfiltrated column still lacks')
})

// ─── what it refuses ──────────────────────────────────────────────────────────

test('bearer: an empty secret is refused rather than digested', async function () {
  // `fingerprint('')` has a perfectly good answer, and a column holding it
  // matches every caller who presents nothing.
  let threw = false
  try { await fingerprint('', { key: KEY, purpose: WHAT }) } catch { threw = true }
  assert.ok(threw, 'empty secret throws')

  // Paired with the acceptance one character away.
  assert.equal((await fingerprint('t', { key: KEY, purpose: WHAT })).length, 64)
})

test('bearer: a missing key or purpose is refused by name', async function () {
  for (const opts of [{ purpose: WHAT }, { key: KEY }, {}]) {
    let message = ''
    try { await fingerprint('tok', opts) } catch (e) { message = e.message }
    assert.ok(/`key`|`purpose`/.test(message), `names what is missing: ${message}`)
  }
})

// ─── recognizing a presented secret ───────────────────────────────────────────

test('bearer: the right secret matches and a near-miss does not', async function () {
  const stored = await fingerprint('correct-horse', { key: KEY, purpose: WHAT })

  assert.equal(await matchesFingerprint(stored, 'correct-horse', { key: KEY, purpose: WHAT }), true)
  assert.equal(await matchesFingerprint(stored, 'correct-horsf', { key: KEY, purpose: WHAT }), false)
})

test('bearer: a digest made for another purpose does not match here', async function () {
  const stored = await fingerprint('tok', { key: KEY, purpose: 'ApiKey.value' })
  assert.equal(await matchesFingerprint(stored, 'tok', { key: KEY, purpose: WHAT }), false)
})

test('bearer: a malformed presentation is a no, not a throw', async function () {
  // A caller is asking *is this the secret*, and nothing is a legitimate no —
  // where a missing key is a programming error either way.
  const stored = await fingerprint('tok', { key: KEY, purpose: WHAT })

  for (const bad of ['', null, undefined, 42, {}])
    assert.equal(await matchesFingerprint(stored, bad, { key: KEY, purpose: WHAT }), false)

  let threw = false
  try { await matchesFingerprint(stored, 'tok', { purpose: WHAT }) } catch { threw = true }
  assert.ok(threw, 'a missing key throws')
})

// ─── the comparison ───────────────────────────────────────────────────────────

test('bearer: timingSafeEqual answers the same as === for equal-length strings', async function () {
  assert.equal(timingSafeEqual('abcd', 'abcd'), true)
  assert.equal(timingSafeEqual('abcd', 'abce'), false)
  // Differing in the FIRST character is the case an early return leaks on, and
  // it must answer exactly as the last-character case does.
  assert.equal(timingSafeEqual('zbcd', 'abcd'), false)
  assert.equal(timingSafeEqual('abcd', 'abcde'), false)
  assert.equal(timingSafeEqual('abcd', null), false)
})

// ─── the import hazard ────────────────────────────────────────────────────────

test('bearer: names no node builtin', async function () {
  // `node:crypto` parses on a server and kills a browser bundle, and this kit
  // is reachable from both — junction resolves a link, and a jetty island may
  // hold one.
  const src = readFileSync(new URL('../../src/bearer/bearer.js', import.meta.url), 'utf8')
  assert.ok(!/from ['"]node:/.test(src), 'no node: import')
  assert.ok(!/require\(/.test(src), 'no require')
})
