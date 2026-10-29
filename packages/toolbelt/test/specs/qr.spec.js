/*
 * qr.spec.js
 *
 * No decoder lives in this tree, so the rows grade what the spec fixes and pin
 * the output a phone has already read: the matrix for two fixed strings as
 * sha-256 digests, taken the day the encoder moved here from cli with a phone
 * on the other end of `fli tell:upload --qr`. A change that alters a digest
 * must be re-read by a phone before the row is updated.
 */

import { createHash } from 'node:crypto'
import { qrMatrix, qrSvg, qrTerminal } from '../../src/qr/qr.js'

const LINK = 'https://ntfy.sh/acme-critical-abc123def456'
const flat   = (m) => m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('\n')
const digest = (t) => createHash('sha256').update(flat(qrMatrix(t))).digest('hex').slice(0, 16)

test('qr: the matrix is square and sized by version (21 + 4 per version)', function () {
  const m = qrMatrix('hello')
  assert.equal(m.length, 21)
  for (const row of m) assert.equal(row.length, 21)
  assert.equal(qrMatrix(LINK).length, 29)
})

test('qr: the three finder patterns are drawn', function () {
  const m = qrMatrix('hello')
  const n = m.length
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const edge = x === 0 || x === 6 || y === 0 || y === 6
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4
      assert.equal(m[oy + y][ox + x], edge || core, `finder at ${ox},${oy} module ${x},${y}`)
    }
  }
})

test('qr: a fixed text encodes to the matrix a phone has read', function () {
  assert.equal(digest('hello'), '8f290f882c94ccf8')
  assert.equal(digest(LINK),    '8b97ed8879e7b2e4')
})

test('qr: the two projections are the one matrix read out', function () {
  const m = qrMatrix('hello')
  const dark = m.flat().filter(Boolean).length
  const svg  = qrSvg('hello')
  assert.equal((svg.match(/<rect x=/g) || []).length, dark)
  assert.ok(svg.includes('viewBox="0 0 25 25"'))        // 21 + two modules of quiet zone a side
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'))
  const lines = qrTerminal('hello').split('\n')
  assert.equal(lines.length, 13)                         // 25 rows, two a line
})

test('qr: a text too long for level L is refused by size, not truncated', function () {
  const err = (() => { try { qrMatrix('x'.repeat(3000)) } catch (e) { return e.message } })()
  assert.ok(err && err.includes('at most'))
})
