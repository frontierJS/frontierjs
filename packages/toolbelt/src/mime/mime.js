/*
 * mime.js — what a file's bytes are, and what may be said about them on a wire.
 *
 * Four packages kept their own extension table and they disagreed: junction's
 * static transport (27 entries, keyed `js`), litestone's FileStorage (16, keyed
 * `.js`), and sierra's two static origins (19 and 16, with `; charset=utf-8`
 * baked into the value). 24 of the 32 extensions across them appeared in some
 * and not others.
 *
 * The cost is not tidiness. `FJS-825` records that a `.wasm` served as
 * `application/octet-stream` cannot be `instantiateStreaming`'d at all, fixed it
 * in one of sierra's two servers, and the sibling file gained `.avif` in the
 * same pass and never gained `.wasm`. One fix, four tables, three still carrying
 * the old answer.
 *
 * ─── The five questions, which is why this is a kit and not a table ─────────
 *
 * Every caller asks some subset and each was answering differently:
 *
 *   1. what type are these bytes served as        `contentTypeFor`
 *   2. does that type need a charset               `isTextType`
 *   3. is it worth compressing                     `isCompressible`
 *   4. may it be served INLINE, or `attachment`    `isInlineSafe`
 *   5. what do the BYTES say, rather than the name `sniff`
 *
 * The fifth is the one with no owner anywhere. `@accept("image/png")` grades a
 * string the uploader supplied (`FJS-1184`), and an SVG served inline because it
 * arrived named `.png` is stored XSS (`FJS-692`). A name is a claim; only the
 * bytes are evidence.
 *
 * ─── What it refuses to decide ─────────────────────────────────────────────
 *
 * Whether a response may be CACHED is policy, not type: junction's `CACHEABLE`
 * and sierra's `isHashedAsset` answer it from a URL and a build, and neither is
 * a fact about the bytes. They stay where they are.
 *
 * `sniff` answers `null` for anything it does not recognize, and **null is not a
 * verdict of safe** — it is *ask something else*, the same shape `/match` uses.
 * A caller that reads an unknown as a pass has written the check backwards.
 */

// ─── the table ────────────────────────────────────────────────────────────────
//
// Keyed by extension WITHOUT a leading dot, valued WITHOUT a charset. Both
// choices are so that one entry has one spelling: the dot is punctuation a
// caller strips or supplies, and a charset is question 2's answer rather than
// part of the type. The four tables this replaces disagreed on both.

export const DEFAULT_TYPE = 'application/octet-stream'

export const CONTENT_TYPES = {
  // documents and text
  html: 'text/html',
  htm:  'text/html',
  css:  'text/css',
  js:   'text/javascript',
  mjs:  'text/javascript',
  cjs:  'text/javascript',
  json: 'application/json',
  // A sourcemap is JSON and is served as JSON. It is listed rather than derived
  // because `isHashedAsset` reads the FINAL extension and `.js.map` has caught
  // this file's callers out once already (`FJS-825`).
  map:  'application/json',
  webmanifest: 'application/manifest+json',
  xml:  'application/xml',
  txt:  'text/plain',
  md:   'text/markdown',
  csv:  'text/csv',

  // images
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico:  'image/x-icon',
  bmp:  'image/bmp',
  tif:  'image/tiff',
  tiff: 'image/tiff',

  // fonts
  woff:  'font/woff',
  woff2: 'font/woff2',
  ttf:   'font/ttf',
  otf:   'font/otf',
  eot:   'application/vnd.ms-fontobject',

  // audio and video
  mp4:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  ogg:  'audio/ogg',
  flac: 'audio/flac',

  // archives and binaries
  pdf:  'application/pdf',
  zip:  'application/zip',
  gz:   'application/gzip',
  wasm: 'application/wasm',
}

// ─── naming ───────────────────────────────────────────────────────────────────

/**
 * The extension of a path or filename, lower-cased, with no dot.
 *
 * Written out rather than taken from `node:path`: substrate imports nothing
 * (`FJS-D26`), and this has to run in a browser worker beside litestone's
 * client anyway. Both separators are cut because a Windows path reaches the
 * FileStorage plugin as a caller-supplied string.
 */
export function extensionOf(name) {
  if (typeof name !== 'string') return ''
  const cut  = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = cut === -1 ? name : name.slice(cut + 1)
  const dot  = base.lastIndexOf('.')
  // A dotfile is not an extension: `.gitignore` is a name, not a `gitignore`
  // file, and reading it as one is how a config file gets a content type.
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * The content type for a filename, a path, or a bare extension.
 *
 * `charset: true` appends `; charset=utf-8` where the type needs one, which is
 * question 2 and not a property of the string — sierra baked the charset into
 * its table and junction did not, so the same `.css` left two servers with two
 * different headers.
 */
export function contentTypeFor(name, { charset = false, fallback = DEFAULT_TYPE } = {}) {
  const raw = typeof name === 'string' ? name.trim() : ''
  // A bare extension is accepted in both spellings, so a caller holding `png`
  // and one holding `.png` does not need to know which this wants — and that is
  // why a bare one cannot go through `extensionOf`, whose dotfile rule would
  // read `.png` as a NAME. A string with no separator and no interior dot is an
  // extension; everything else is a path. `.gitignore` lands on the bare side
  // and answers the fallback either way, which is the same answer.
  const hasSep = raw.includes('/') || raw.includes('\\')
  const bare   = !hasSep && raw.lastIndexOf('.') <= 0
  const ext    = bare ? raw.replace(/^\./, '').toLowerCase() : extensionOf(raw)
  const type = CONTENT_TYPES[ext]
  if (!type) return fallback
  return charset && isTextType(type) ? `${type}; charset=utf-8` : type
}

/**
 * The extension to WRITE a file of this type under — `null` for a type the
 * table does not name.
 *
 * `extensionsFor` answers every spelling and a caller storing bytes needs one,
 * so the preference is declared rather than taken from the table's key order,
 * which is an implicit fact a reorder would silently change.
 */
export function extensionFor(type) {
  const t = baseType(type)
  if (PREFERRED[t]) return PREFERRED[t]
  const all = extensionsFor(t)
  return all.length === 1 ? all[0] : null
}

// Only the types with more than one spelling need a row. A second entry added
// to the table for a type listed here does not change what this answers.
const PREFERRED = {
  'image/jpeg':  'jpg',
  'image/tiff':  'tif',
  'text/html':   'html',
  'text/javascript': 'js',
  'application/json': 'json',
}

/** Every extension this table maps to a type. For a caller building its own index. */
export function extensionsFor(type) {
  const want = baseType(type)
  return Object.keys(CONTENT_TYPES).filter((ext) => CONTENT_TYPES[ext] === want)
}

/** `text/html; charset=utf-8` → `text/html`. A parameter is not part of the type. */
export function baseType(type) {
  if (typeof type !== 'string') return ''
  const semi = type.indexOf(';')
  return (semi === -1 ? type : type.slice(0, semi)).trim().toLowerCase()
}

// ─── what may be said about a type ───────────────────────────────────────────

const TEXT_TYPES = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/manifest+json',
])

/**
 * Does this type need `; charset=utf-8`?
 *
 * `image/svg+xml` is deliberately NOT one, matching what sierra's servers do
 * today: it is served as an image, and its own XML declaration carries the
 * encoding. It IS compressible, which is why that is a separate question.
 */
export function isTextType(type) {
  const t = baseType(type)
  return t.startsWith('text/') || TEXT_TYPES.has(t)
}

/**
 * Is it worth compressing?
 *
 * Two implementations disagreed here as well — junction holds an exact-match map
 * of ten types, sierra a regex — so `text/markdown` compressed on one server and
 * not on the other. Already-compressed formats are the ones that matter: gzip
 * over a JPEG spends CPU to add bytes.
 */
export function isCompressible(type) {
  const t = baseType(type)
  if (!t) return false
  // An event stream is never finished, and a compressor holds bytes until it
  // has enough to encode — every frame arrives late or at close (FJS-1416).
  if (t === 'text/event-stream') return false
  if (t.startsWith('text/')) return true
  if (t === 'image/svg+xml') return true
  if (t.startsWith('application/')) {
    // Everything textual under `application/`, named rather than pattern-matched:
    // `application/zip` and `application/pdf` live here too and must not match.
    return TEXT_TYPES.has(t) || t.endsWith('+json') || t.endsWith('+xml') || t === 'application/wasm'
  }
  return false
}

const INLINE_SAFE_IMAGES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/avif', 'image/heic', 'image/heif', 'image/bmp',
  'image/x-icon', 'image/tiff',
])

/**
 * May a response of this type be served INLINE, or must it be `attachment`?
 *
 * `FJS-692` is the reason this is a function and not a guess: an upload named
 * `x.svg` was served `image/svg+xml` inline, which is stored XSS, because an SVG
 * is a document that may carry script and runs in the serving origin. So the
 * rule is an allow-list rather than a deny-list, and an UNKNOWN type is refused
 * — a deny-list is wrong the first time somebody uploads a format nobody listed.
 *
 * `text/html` is absent for the same reason as SVG, and that is not an oversight
 * a caller should route around: a server that means to send HTML is not asking
 * this question about an upload.
 */
export function isInlineSafe(type) {
  const t = baseType(type)
  if (INLINE_SAFE_IMAGES.has(t)) return true
  if (t.startsWith('video/') || t.startsWith('audio/')) return true
  return t === 'application/pdf' || t === 'text/plain'
}

// ─── what the bytes say ──────────────────────────────────────────────────────
//
// A name is a claim and only the bytes are evidence. Signatures are compared at
// a fixed offset against a byte sequence, which is why they are held as arrays
// rather than as a string: a magic number is not text and decoding it as text
// loses every byte above 0x7F.

const SIGNATURES = [
  { type: 'image/png',       offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg',      offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif',       offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/bmp',       offset: 0, bytes: [0x42, 0x4d] },
  { type: 'image/tiff',      offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { type: 'image/tiff',      offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { type: 'image/x-icon',    offset: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
  { type: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'application/wasm', offset: 0, bytes: [0x00, 0x61, 0x73, 0x6d] },
  { type: 'application/gzip', offset: 0, bytes: [0x1f, 0x8b] },
  { type: 'application/zip',  offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: 'audio/flac',      offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43] },
  { type: 'audio/mpeg',      offset: 0, bytes: [0x49, 0x44, 0x33] },
  { type: 'audio/ogg',       offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] },
]

// RIFF and ISO-BMFF both put the real format in a second field, so they cannot
// be one row above: `RIFF....WEBP` and `RIFF....WAVE` share four leading bytes,
// and every `ftyp` box shares four at offset 4.
const RIFF  = [0x52, 0x49, 0x46, 0x46]
const FTYP  = [0x66, 0x74, 0x79, 0x70]

const RIFF_FORMS = { WEBP: 'image/webp', WAVE: 'audio/wav' }

const FTYP_BRANDS = {
  avif: 'image/avif', avis: 'image/avif',
  heic: 'image/heic', heix: 'image/heic', hevc: 'image/heic',
  mif1: 'image/heif', msf1: 'image/heif',
  qt:   'video/quicktime',
}

function matches(bytes, sig, offset) {
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false
  return true
}

function ascii(bytes, offset, length) {
  let out = ''
  for (let i = 0; i < length; i++) {
    const b = bytes[offset + i]
    if (b === undefined) return out
    out += String.fromCharCode(b)
  }
  return out
}

/**
 * What ARE these bytes — `null` where this cannot say.
 *
 * Takes anything indexable by byte: a `Uint8Array`, a `Buffer`, or an array. A
 * caller needs only the first 64 bytes, which matters where the bytes come off a
 * provider's `get(key)` and reading the whole object to answer this would be the
 * expensive way to ask a cheap question.
 *
 * **`null` means unknown and never safe.** Most text formats have no magic
 * number at all, so a caller comparing a claim against this must treat an
 * unrecognized answer as *no evidence either way* rather than as a pass.
 */
export function sniff(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) return null

  for (const sig of SIGNATURES) {
    if (bytes.length >= sig.offset + sig.bytes.length && matches(bytes, sig.bytes, sig.offset)) return sig.type
  }

  if (bytes.length >= 12 && matches(bytes, RIFF, 0)) {
    const form = RIFF_FORMS[ascii(bytes, 8, 4)]
    if (form) return form
  }

  if (bytes.length >= 12 && matches(bytes, FTYP, 4)) {
    const brand = ascii(bytes, 8, 4).toLowerCase()
    if (FTYP_BRANDS[brand]) return FTYP_BRANDS[brand]
    // Every other `ftyp` brand in the wild is an MP4 profile — `isom`, `mp42`,
    // `M4V `. Answering the container is honest and is what the question needs:
    // the caller is asking whether an upload named `.png` is a video.
    return 'video/mp4'
  }

  // ── markup, which has no magic number and is the case that matters most ──
  //
  // `FJS-692`'s defect is exactly here: SVG and HTML are the two types that run
  // in the serving origin, and neither announces itself in a byte prefix. So
  // they are sniffed as text, over a bounded prefix, after a BOM and leading
  // whitespace — and `<?xml` alone is NOT svg, because most XML is not.
  const head = ascii(bytes, bomOffset(bytes), 256).toLowerCase()
  const lead = head.replace(/^\s+/, '')
  if (!lead.startsWith('<')) return null
  if (lead.startsWith('<svg') || /<svg[\s>]/.test(lead)) return 'image/svg+xml'
  if (lead.startsWith('<!doctype html') || lead.startsWith('<html')) return 'text/html'
  if (lead.startsWith('<?xml')) return 'application/xml'
  return null
}

function bomOffset(bytes) {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
}

/**
 * Are these two types one format spelled two ways?
 *
 * One container can hold more than one registered type: a HEIF file's `ftyp`
 * brand decides whether it reads as `image/heic` or `image/heif`, and both
 * spellings are things an app declares. An equality over the two refuses a
 * photograph for being the other reading of itself.
 *
 * A row here says the BYTES are one format, so a check written over either
 * spelling is answered by the other. It is not a synonym table for whatever a
 * caller finds convenient.
 */
export function sameType(a, b) {
  if (!a || !b) return false
  const x = baseType(a).toLowerCase()
  const y = baseType(b).toLowerCase()
  return x === y || EQUIVALENT[x] === y
}

const EQUIVALENT = {
  'image/heic': 'image/heif',
  'image/heif': 'image/heic',
}
