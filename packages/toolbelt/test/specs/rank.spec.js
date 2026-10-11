/*
 * rank.spec.js
 *
 * The property under test is ORDER: every key minted between two others sorts
 * between them by a plain `<`, which is SQLite's BINARY collation, and is itself
 * a key something can later be minted beside. A key that breaks either is a row
 * a drag cannot place.
 */

import { DIGITS, isRankKey, between, after, jittered, spread } from '../../src/rank/rank.js'

// A seeded generator, so a failing walk names the step that broke it.
function lcg(seed) {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

test('rank: the digits ascend in byte order, which is the order SQLite sorts', function () {
  for (let i = 1; i < DIGITS.length; i++) assert.ok(DIGITS[i - 1] < DIGITS[i], `${DIGITS[i - 1]} !< ${DIGITS[i]}`)
  assert.ok('V' < 'a', 'byte order')
  assert.ok('a'.localeCompare('V') < 0, 'and a locale disagrees, which is why nothing here uses one')
})

test('rank: a key is base-62, non-empty, and never ends in 0', function () {
  for (const k of ['1', 'V', 'z', 'a0V', 'zz1']) assert.ok(isRankKey(k), k)
  for (const k of ['', '0', 'V0', 'a-b', 'é', ' V', null, 3]) assert.ok(!isRankKey(k), JSON.stringify(k))
})

test('rank: between lands strictly inside the gap, at every depth', function () {
  // Half the drops go into the first gap, so one spot is split hundreds deep.
  const rnd = lcg(7)
  const keys = []
  for (let i = 0; i < 2000; i++) {
    const at = rnd() < 0.5 ? Math.min(1, keys.length) : Math.floor(rnd() * (keys.length + 1))
    const [a, b] = [keys[at - 1] ?? null, keys[at] ?? null]
    const k = between(a, b)
    assert.ok(isRankKey(k), `step ${i}: ${k} is not a key`)
    assert.ok((a == null || a < k) && (b == null || k < b), `step ${i}: ${a} < ${k} < ${b}`)
    keys.splice(at, 0, k)
  }
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i], `${keys[i - 1]} !< ${keys[i]}`)
})

test('rank: between refuses a gap that is not one, and a value that is not a key', function () {
  assert.throws(() => between('V', 'V'), /no key between/)
  assert.throws(() => between('W', 'V'), /no key between/)
  assert.throws(() => between('V0', null), /not a rank key/)
  assert.throws(() => between('', 'V'), /not a rank key/)
})

test('rank: after is always later and grows a digit only after about sixty appends', function () {
  let k = null
  for (let i = 0; i < 1000; i++) {
    const next = after(k)
    assert.ok(isRankKey(next) && (k == null || k < next), `${k} → ${next}`)
    k = next
  }
  assert.ok(k.length <= 20, `1000 appends made a key ${k.length} long`)
  // A long key in the middle of the list, the far end of a drag, comes back short.
  assert.equal(after('VzzzzV'), 'W')
  assert.equal(after(null), between(null, null))
})

test('rank: the gap between two appends still has room', function () {
  const a = after(null), b = after(a)
  const k = between(a, b)
  assert.ok(a < k && k < b)
})

test('rank: jittered stays inside the gap and two devices rarely agree', function () {
  const rnd = lcg(11)
  const seen = new Set()
  for (let i = 0; i < 50; i++) {
    const k = jittered('V', 'W', 20, rnd)
    assert.ok('V' < k && k < 'W' && isRankKey(k), k)
    seen.add(k)
  }
  assert.equal(seen.size, 50, 'fifty drags into one gap made a tie')
  // The midpoint is the collision jitter exists for: every device lands on it.
  assert.equal(jittered('V', 'W', 0), between('V', 'W'))
  assert.throws(() => jittered('W', 'V'), /no key between/)
})

test('rank: spread answers n ordered keys of one width', function () {
  assert.deepEqual(spread(0), [])
  assert.deepEqual(spread(1), ['V'])
  for (const n of [2, 30, 31, 61, 62, 500, 4000]) {
    const keys = spread(n)
    assert.equal(keys.length, n)
    const w = keys[0].length
    for (let i = 0; i < n; i++) {
      assert.ok(isRankKey(keys[i]), `${n}: ${keys[i]}`)
      assert.equal(keys[i].length, w, `${n}: widths differ`)
      if (i) assert.ok(keys[i - 1] < keys[i], `${n}: ${keys[i - 1]} !< ${keys[i]}`)
    }
    // Room before the first and after the last, so a drag to either end is one write.
    between(null, keys[0])
    between(keys[n - 1], null)
  }
  assert.equal(spread(4000)[0].length, 3)
  assert.throws(() => spread(-1), /takes a count/)
})
