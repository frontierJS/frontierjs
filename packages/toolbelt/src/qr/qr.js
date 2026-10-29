// ─── qr.js — a QR code for a link, as a matrix, an SVG or terminal text ───────
//
// Byte mode at error correction level L, the smallest version the text fits,
// and the mask the spec's penalty rules score lowest — the shape of Nayuki's
// generator, as unjs's uqr ports it. L because a screen is never scuffed, and a
// lower level is a smaller code: a post link fits version 5 at L and needs 6
// at M. One mode and one level are all a link needs; a second is a table to
// get wrong.
//
// One encoder, two projections. `fli tell:upload --qr` prints the terminal
// one, and Basecamp's Workspace card draws the SVG one so a phone subscribes to
// the push topic from the screen. Both are `qrMatrix` read out; neither
// re-encodes.
//
// A phone reads it only when the dark modules are dark on a light field, and
// a terminal's own background may be either, so `qrTerminal` paints both
// colors itself rather than leaving the field to the theme; `qrSvg` paints
// its own white field for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

/** Level L, indexed by version; 0 is unused. */
const ECC_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
const BLOCKS        = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25]
/** Level L's two format bits. */
const LEVEL_L = 1

const bit = (x, i) => ((x >>> i) & 1) !== 0

const rawModules = (ver) => {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}

const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver]

// ─── Reed-Solomon over GF(2^8), polynomial 0x11D ─────────────────────────────

const gfMul = (x, y) => {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

const rsDivisor = (degree) => {
  const out = new Array(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root)
      if (j + 1 < degree) out[j] ^= out[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return out
}

const rsRemainder = (data, divisor) => {
  const out = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ out.shift()
    out.push(0)
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor) })
  }
  return out
}

// ─── codewords ───────────────────────────────────────────────────────────────

const encode = (bytes, ver) => {
  const bits = []
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  put(0b0100, 4)
  put(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  const capacity = dataCodewords(ver) * 8
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - bits.length % 8) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const words = []
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0))
  return words
}

const interleave = (data, ver) => {
  const blocks = BLOCKS[ver]
  const eccLen = ECC_PER_BLOCK[ver]
  const raw    = Math.floor(rawModules(ver) / 8)
  const short  = blocks - raw % blocks
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLen)
  const all = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < short) dat.push(0)
    all.push([...dat, ...ecc])
  }
  // A short block's pad byte holds the long blocks' extra column and is not sent.
  const out = []
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => { if (i !== shortLen - eccLen || j >= short) out.push(block[i]) })
  }
  return out
}

// ─── the grid ────────────────────────────────────────────────────────────────

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
]

const alignmentPositions = (ver, size) => {
  if (ver === 1) return []
  const count = Math.floor(ver / 7) + 2
  const step  = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2
  const out = [6]
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos)
  return out
}

const grid = (ver) => {
  const size = ver * 4 + 17
  const dark = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true }

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, ring = Math.max(Math.abs(dx), Math.abs(dy))
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4)
    }
  }
  const align = alignmentPositions(ver, size)
  const last = align.length - 1
  align.forEach((ay, i) => align.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + i % 3, b = Math.floor(i / 3)
      set(a, b, bit(bits, i))
      set(b, a, bit(bits, i))
    }
  }
  return { size, dark, fixed, set }
}

const drawFormat = ({ size, set }, mask) => {
  const data = (LEVEL_L << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i))
  set(8, 7, bit(bits, 6))
  set(8, 8, bit(bits, 7))
  set(7, 8, bit(bits, 8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i))
  set(8, size - 8, true)
}

const drawCodewords = ({ size, dark, fixed }, words) => {
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = upward ? size - 1 - v : v
      if (fixed[y][x] || i >= words.length * 8) continue
      dark[y][x] = bit(words[i >>> 3], 7 - (i & 7))
      i++
    }
  }
}

const applyMask = ({ size, dark, fixed }, mask) => {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x]
  }
}

// ─── the penalty a mask is chosen by ─────────────────────────────────────────

const FINDER_LIKE = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]]

const penalty = ({ size, dark }) => {
  let score = 0
  const lines = [
    ...dark,
    ...dark.map((_, x) => dark.map(row => row[x])),
  ]
  for (const line of lines) {
    for (let i = 1, run = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) { run++; continue }
      if (run >= 5) score += run - 2
      run = 1
    }
    for (let i = 0; i + 11 <= size; i++) {
      if (FINDER_LIKE.some(p => p.every((b, k) => line[i + k] === (b === 1)))) score += 40
    }
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = dark[y][x]
    if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3
  }
  const total = dark.reduce((n, row) => n + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs(total * 20 - size * size * 10) / (size * size)) * 10
  return score
}

// ─── the public half ─────────────────────────────────────────────────────────

/** The QR code for `text` as rows of booleans, true where a module is dark; no quiet zone. */
export const qrMatrix = (text) => {
  const bytes = [...new TextEncoder().encode(String(text))]
  const ver = ECC_PER_BLOCK.findIndex((_, v) => v > 0 && dataCodewords(v) >= bytes.length + (v <= 9 ? 2 : 3))
  if (ver < 1) throw new Error(`A QR code at level L holds at most ${dataCodewords(40) - 3} bytes, and this text is ${bytes.length}.`)
  const words = interleave(encode(bytes, ver), ver)
  let best = null
  for (let mask = 0; mask < MASKS.length; mask++) {
    const g = grid(ver)
    drawFormat(g, mask)
    drawCodewords(g, words)
    applyMask(g, mask)
    const score = penalty(g)
    if (!best || score < best.score) best = { score, dark: g.dark }
  }
  return best.dark
}

const QUIET = 2

/**
 * The QR code for `text` as an SVG, one `<rect>` a dark module on a white field,
 * sized by its viewBox so CSS decides how big. Two modules of quiet zone, as
 * the terminal one: the field is painted, so the code never meets a dark page.
 */
export const qrSvg = (text) => {
  const m = qrMatrix(text)
  const size = m.length + QUIET * 2
  const rects = []
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) rects.push(`<rect x="${x + QUIET}" y="${y + QUIET}" width="1" height="1"/>`)
  }))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`
}

const PAINT = '\x1b[38;5;16;48;5;231m'
const RESET = '\x1b[0m'

/**
 * The QR code for `text` in half-block characters, two modules a line, black
 * on white whatever the terminal's theme. Two modules of quiet zone, not
 * the spec's four: the margin is painted white, so the code never meets a
 * dark field, and phone cameras read two.
 */
export const qrTerminal = (text) => {
  const m = qrMatrix(text)
  const size = m.length + QUIET * 2
  const at = (x, y) => m[y - QUIET]?.[x - QUIET] ?? false
  const lines = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x++) {
      const top = at(x, y), bottom = y + 1 < size && at(x, y + 1)
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ')
    }
    lines.push(PAINT + line + RESET)
  }
  return lines.join('\n')
}
