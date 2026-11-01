/*
 * share.spec.js — page state in a link (FJS-3771).
 *
 * The three questions every page answered alone: a length a browser opens, an
 * inflate cap, and a state from someone else read field by field.
 */

import { SHARE_MAX, encodeShare, decodeShare, shareParam, readFields } from '../../src/share/share.js'

async function rejects(fn, pattern) {
  try { await fn() } catch (e) { return assert.match(e.message, pattern) }
  throw new Error('expected a rejection matching ' + pattern)
}

const deflateText = async (text) => {
  const bytes = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

test('share: a state round-trips, and the text is URL-safe', async () => {
  const state = { v: 1, search: 'ünï ✓', rows: [1, 2, { a: null }] }
  const text = await encodeShare(state)
  assert.ok(/^[\w-]+$/.test(text), text)
  assert.equal(JSON.stringify(await decodeShare(text)), JSON.stringify(state))
})

test('share: a link past the limit is refused with a sentence, not answered', async () => {
  const noisy = Array.from({ length: 4000 }, (_, i) => Math.sin(i * 7919).toString(36))
  await rejects(() => encodeShare(noisy, { max: 100 }), /characters as a link.*at most 100/)
  assert.ok((await encodeShare(noisy)).length < SHARE_MAX)
})

test('share: a small link that inflates past the cap is null', async () => {
  const text = await encodeShare({ blob: 'a'.repeat(200_000) })
  assert.ok(text.length < 2000, 'the repro is tiny: ' + text.length)
  assert.equal(await decodeShare(text, { inflatedMax: 1000 }), null)
  assert.equal((await decodeShare(text)).blob.length, 200_000)
})

test('share: what is not a link is null', async () => {
  assert.equal(await decodeShare('not a link!'), null)
  assert.equal(await decodeShare(''), null)
  assert.equal(await decodeShare(await deflateText('{oops')), null)
})

test('share: shareParam reads the named part of a hash', () => {
  assert.equal(shareParam('#s=abc-_'), 'abc-_')
  assert.equal(shareParam('#x=1&s=abc'), 'abc')
  assert.equal(shareParam('#x=1'), null)
  assert.equal(shareParam('#t=zz', 't'), 'zz')
})

test('share: readFields keeps what a reader accepts and drops the rest', () => {
  const isString = (v) => (typeof v === 'string' ? v : undefined)
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined)
  const got = readFields({ search: 'x', frozen: -1, extra: 'y', boom: 1 }, { search: isString, frozen: count, boom: () => { throw new Error('bad') }, missing: isString })
  assert.equal(JSON.stringify(got), '{"search":"x"}')
  assert.equal(readFields([1], { a: isString }), null)
  assert.equal(readFields('s', { a: isString }), null)
  assert.equal(readFields(null, {}), null)
})

test('share: a __proto__ member is a field, not a prototype', async () => {
  const foreign = await decodeShare(await deflateText('{"__proto__":{"polluted":true},"name":"n"}'))
  const got = readFields(foreign, { name: (v) => v, __proto__: undefined })
  assert.equal(got.polluted, undefined)
  assert.equal(({}).polluted, undefined)
  assert.equal(got.name, 'n')
})
