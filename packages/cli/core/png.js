// ─── png ──────────────────────────────────────────────────────────────────────
// An RGBA buffer to PNG bytes, with no dependency. Two callers want different
// things from the deflate: the desktop icon is compared byte for byte against
// `example/desktop/`, so it is STORED and its bytes cannot move with the zlib a
// runtime carries; a tile map is thousands of pixels and is compressed.

import { deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  width × height × 4 bytes, rows top to bottom
 * @param {{ stored?: boolean }} [opts]
 */
export function encodePng(width, height, rgba, { stored = false } = {}) {
  if (rgba.length !== width * height * 4)
    throw new Error(`encodePng: expected ${width * height * 4} bytes for ${width}×${height}, got ${rgba.length}`)

  // Every scanline opens with its filter type; 0 is none.
  const stride = width * 4
  const raw    = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)

  const idat = stored ? storedZlib(raw) : deflateSync(raw)
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// A zlib header, STORED deflate blocks of at most 65535 bytes, then adler32.
function storedZlib(raw) {
  const parts = [Buffer.from([0x78, 0x01])]
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const block = raw.subarray(at, at + 65535)
    const len   = block.length
    const final = at + 65535 >= raw.length ? 1 : 0
    parts.push(Buffer.from([final, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff]), block)
    if (!raw.length) break
  }
  let a = 1, b = 0
  for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521 }
  parts.push(u32((b << 16) | a))
  return Buffer.concat(parts)
}

function u32(n) {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(n >>> 0)
  return out
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let c = ~0
  for (const byte of body) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return Buffer.concat([u32(data.length), body, u32(~c)])
}
