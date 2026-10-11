/*
 * rank.js — the key behind `@rank(scope:)`: a position a person drags, minted
 * between two neighbors so a move writes ONE row (`FJS-D366`).
 *
 * Two callers mint with these functions and must agree byte for byte:
 * litestone, defaulting a create to the end of its scope and rebalancing one,
 * and sierra's `resource.move()`, minting from the rows a device read while it
 * may be offline. A copy each would drift on the one property that matters,
 * which is the comparison.
 *
 * A key is a string over base-62 digits, compared BYTE by byte: `0-9A-Za-z` is
 * ascending in ASCII, so SQLite's BINARY collation, a JS `<` and this file all
 * agree. A locale comparison does NOT (`'V' < 'a'` in bytes, `'a' < 'V'` in
 * `localeCompare`), so nothing ordering these keys may use one.
 *
 * No key ends in '0', so between any two distinct keys there is always a third.
 * Two EQUAL keys have nothing between them, which is what two devices produce
 * when they split one gap at its midpoint. `jittered()` makes that rare and the
 * reader's `(rank, id)` order makes what is left stable.
 */

export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/

/** Is `v` a key this kit could have minted — base-62, non-empty, no trailing '0'. */
export function isRankKey(v) {
  return typeof v === 'string' && KEY.test(v)
}

function check(k, end) {
  if (k == null) return end
  if (!isRankKey(k)) {
    throw new RangeError(`${JSON.stringify(k)} is not a rank key: base-62 digits (0-9, A-Z, a-z), non-empty, not ending in '0'`)
  }
  return k
}

/**
 * A key strictly between `a` and `b`, at the middle of the gap. `a` null is the
 * start of the list and `b` null the end. Throws when `a ≥ b`, because there is
 * no room between a key and itself.
 */
export function between(a, b) {
  a = check(a, '')
  b = check(b, null)
  if (b != null && a >= b) throw new RangeError(`no key between ${JSON.stringify(a)} and ${JSON.stringify(b)}`)
  return mid(a, b)
}

function mid(a, b) {
  if (b != null) {
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n))
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b != null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  if (b != null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + mid(a.slice(1), null)
}

/**
 * A key after `a` and as short as one can be. A create lands at the end of its
 * scope every time, and the midpoint to the end grows a digit every six or so
 * appends, which puts a seeded column of 300 past a 64-character bound; this
 * grows one about every sixty.
 */
export function after(a) {
  a = check(a, '')
  for (let i = 0; i < a.length; i++) {
    const d = DIGITS.indexOf(a[i])
    if (d < DIGITS.length - 1) return a.slice(0, i) + DIGITS[d + 1]
  }
  return a ? a + '1' : mid('', null)
}

/**
 * A key in the gap, chosen by `bits` coin flips rather than at its middle, so
 * two devices splitting one gap at the same moment rarely agree. `random` is a
 * parameter so a test can make the collision it wants to measure.
 */
export function jittered(a, b, bits = 20, random = Math.random) {
  let lo = check(a, ''), hi = check(b, null)
  if (hi != null && lo >= hi) throw new RangeError(`no key between ${JSON.stringify(lo)} and ${JSON.stringify(hi)}`)
  for (let i = 0; i < bits; i++) {
    const m = mid(lo, hi)
    if (random() < 0.5) lo = m; else hi = m
  }
  return mid(lo, hi)
}

/**
 * `n` keys in order, evenly spaced and all one width — what a rebalance writes.
 * Equal widths are the point: the next drag into any gap costs one digit, where
 * keys appended one after another would leave the far end of the list long.
 */
export function spread(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`spread(n) takes a count, got ${JSON.stringify(n)}`)
  let width = 1, room = DIGITS.length
  while (room < 2 * (n + 1)) { width++; room *= DIGITS.length }
  const step = Math.floor(room / (n + 1))
  const keys = []
  for (let i = 1; i <= n; i++) {
    let v = step * i
    if (v % DIGITS.length === 0) v++
    let k = ''
    for (let w = 0; w < width; w++) { k = DIGITS[v % DIGITS.length] + k; v = Math.floor(v / DIGITS.length) }
    keys.push(k)
  }
  return keys
}
