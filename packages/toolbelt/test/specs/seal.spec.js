/*
 * seal.spec.js
 *
 * A seal fails silently: the host stores whatever it is given and cannot tell
 * ciphertext that opens from ciphertext that never will. So every case here
 * OPENS — the round trip is the acceptance, and each refusal sits one change
 * away from it: a flipped byte, another member's key, a cut value.
 *
 * The construction is RFC 9180's base mode, checked against an independent
 * HPKE implementation when it was written; these rows guard the behavior, not
 * the standard.
 */

import { seal, open, generateSealingKeys } from '../../src/seal/seal.js'

const DECODER = new TextDecoder()
const read    = (bytes) => bytes && DECODER.decode(bytes)

async function rejects(fn, pattern) {
  try { await fn() } catch (e) { return assert.match(e.message, pattern) }
  throw new Error('expected a rejection matching ' + pattern)
}

// One character of the base64url body moved to another, which flips bits in
// the enc or the ciphertext depending on where it lands.
function flip(sealed, at) {
  const c = sealed[at]
  return sealed.slice(0, at) + (c === 'A' ? 'B' : 'A') + sealed.slice(at + 1)
}

test('seal: what is sealed to a key opens with its private half', async function () {
  const me = await generateSealingKeys()
  const sealed = await seal(me.publicKey, 'DATABASE_URL=postgres://x')
  assert.equal(read(await open(me.privateKey, sealed)), 'DATABASE_URL=postgres://x')
})

test('seal: bytes go in as bytes and come out unchanged', async function () {
  const me = await generateSealingKeys()
  const data = Uint8Array.from({ length: 300 }, (_, i) => i % 256)
  const opened = await open(me.privateKey, await seal(me.publicKey, data))
  assert.deepEqual(Array.from(opened), Array.from(data))
})

test('seal: an empty value seals and opens as empty, which is not a refusal', async function () {
  const me = await generateSealingKeys()
  const opened = await open(me.privateKey, await seal(me.publicKey, ''))
  assert.ok(opened instanceof Uint8Array)
  assert.equal(opened.length, 0)
})

test('seal: the value carries no plaintext and two seals of one value differ', async function () {
  const me = await generateSealingKeys()
  const a = await seal(me.publicKey, 'the-secret-value')
  const b = await seal(me.publicKey, 'the-secret-value')
  assert.match(a, /^v1\.[A-Za-z0-9_-]+$/)
  assert.ok(!a.includes('secret'), 'no plaintext in the sealed value')
  assert.ok(!a.includes(btoa('the-secret-value').slice(0, 12)), 'no base64 of it either')
  assert.ok(a !== b, 'an ephemeral key per seal')
})

test('seal: another member\'s private key opens nothing, and its own key still does', async function () {
  const me    = await generateSealingKeys()
  const other = await generateSealingKeys()
  const sealed = await seal(me.publicKey, 'for me')
  assert.equal(await open(other.privateKey, sealed), null)
  assert.equal(read(await open(me.privateKey, sealed)), 'for me')
})

test('seal: a flipped byte anywhere is refused', async function () {
  const me = await generateSealingKeys()
  const sealed = await seal(me.publicKey, 'a letter of some length')
  // 3 is inside the ephemeral key, the middle and the end are the ciphertext
  // and the tag.
  for (const at of [3, 20, Math.floor(sealed.length / 2) + 10, sealed.length - 2]) {
    assert.equal(await open(me.privateKey, flip(sealed, at)), null, `flipped at ${at}`)
  }
})

test('seal: a cut, a missing version and another version are refused', async function () {
  const me = await generateSealingKeys()
  const sealed = await seal(me.publicKey, 'whole')
  assert.equal(await open(me.privateKey, sealed.slice(0, -4)), null, 'truncated tag')
  assert.equal(await open(me.privateKey, sealed.slice(0, 40)), null, 'shorter than a key and a tag')
  assert.equal(await open(me.privateKey, sealed.slice(3)), null, 'no version')
  assert.equal(await open(me.privateKey, 'v2.' + sealed.slice(3)), null, 'another version')
  assert.equal(await open(me.privateKey, ''), null)
  assert.equal(await open(me.privateKey, null), null)
  assert.equal(await open(me.privateKey, 'v1.!!!not base64!!!'), null)
  assert.equal(read(await open(me.privateKey, sealed)), 'whole')
})

test('seal: a public key that is not 32 bytes throws before anything is sealed', async function () {
  const me = await generateSealingKeys()
  await rejects(() => seal(me.publicKey.slice(0, 20), 'x'), /32 bytes/)
  await rejects(() => seal('', 'x'), /32 bytes/)
})

test('seal: a private key that does not parse is the caller\'s own and throws', async function () {
  const me = await generateSealingKeys()
  const sealed = await seal(me.publicKey, 'x')
  await rejects(() => open('not-a-key', sealed), /PKCS#8 X25519/)
  // A signing key is the likeliest wrong key to hand over: key.json holds both.
  const { generateSigningKeys } = await import('../../src/signature/signature.js')
  const signing = await generateSigningKeys()
  await rejects(() => open(signing.privateKey, sealed), /PKCS#8 X25519/)
})

test('seal: keys are base64url, a 32-byte public half and a PKCS#8 private half', async function () {
  const me = await generateSealingKeys()
  assert.match(me.publicKey, /^[A-Za-z0-9_-]{43}$/)
  assert.match(me.privateKey, /^[A-Za-z0-9_-]+$/)
  assert.ok(me.publicKey !== (await generateSealingKeys()).publicKey)
})
