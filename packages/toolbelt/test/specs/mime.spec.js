/*
 * mime.spec.js
 *
 * The kit exists because four tables disagreed (`FJS-1186`), so the rows here
 * are written against the two ways a type answer is wrong, and both are silent:
 *
 *   IT IS ABSENT  — an extension nobody listed answers `application/octet-stream`,
 *                   and a browser then refuses the bytes for a reason that names
 *                   neither the file nor the server. `.wasm` is the recorded
 *                   case (`FJS-825`), so every extension the four replaced tables
 *                   held between them is asserted here rather than sampled.
 *
 *   IT IS A LIE   — the name says `.png` and the bytes are an SVG. Nothing in the
 *                   tree could decide that (`FJS-1184`), and a sniffer that
 *                   guesses is worse than none, so every positive row has a
 *                   NEGATIVE control beside it: unknown answers null, and null is
 *                   never read as agreement.
 */

import {
  CONTENT_TYPES, DEFAULT_TYPE, extensionOf, baseType, contentTypeFor, extensionsFor,
  isTextType, isCompressible, isInlineSafe, sniff, sameType,
} from '../../src/mime/mime.js'

// ─── the table ────────────────────────────────────────────────────────────────

test('mime: every extension the four replaced tables held is answered', function () {
  // The union measured on 2026-09-19 across junction/transport/static.ts,
  // litestone/plugins/file.js and sierra's two static origins. A regression here
  // is one of those callers losing an answer it used to have.
  const union = {
    html: 'text/html',     css:  'text/css',        js:   'text/javascript',
    mjs:  'text/javascript', json: 'application/json', map: 'application/json',
    xml:  'application/xml', txt: 'text/plain',      md:   'text/markdown',
    csv:  'text/csv',      svg:  'image/svg+xml',   png:  'image/png',
    jpg:  'image/jpeg',    jpeg: 'image/jpeg',      gif:  'image/gif',
    webp: 'image/webp',    avif: 'image/avif',      ico:  'image/x-icon',
    woff: 'font/woff',     woff2:'font/woff2',      ttf:  'font/ttf',
    otf:  'font/otf',      eot:  'application/vnd.ms-fontobject',
    mp4:  'video/mp4',     webm: 'video/webm',      mp3:  'audio/mpeg',
    wav:  'audio/wav',     pdf:  'application/pdf', zip:  'application/zip',
    wasm: 'application/wasm',
  }
  for (const [ext, type] of Object.entries(union))
    assert.equal(contentTypeFor(`file.${ext}`), type, ext)
})

test('mime: the extension is accepted in every spelling a caller holds it in', function () {
  // The four tables keyed three different ways — `js`, `.js` and a full path —
  // which is most of why they were never merged.
  for (const spelling of ['png', '.png', 'logo.png', 'logo.PNG', '/a/b/logo.png', 'C:\\x\\logo.png'])
    assert.equal(contentTypeFor(spelling), 'image/png', spelling)
})

test('mime: an unknown extension answers the fallback, and the fallback is nameable', function () {
  assert.equal(contentTypeFor('x.nope'), DEFAULT_TYPE)
  assert.equal(contentTypeFor('x.nope', { fallback: null }), null)
  // A caller detecting *unlisted* needs null, not a string it has to compare
  // against a constant it also has to import.
  assert.equal(contentTypeFor('x.png', { fallback: null }), 'image/png')
})

test('mime: a dotfile has no extension', function () {
  // `.gitignore` is a NAME. Read as an extension it becomes a `gitignore` file,
  // which is how a config file acquires a content type.
  assert.equal(extensionOf('.gitignore'), '')
  assert.equal(extensionOf('/etc/.env'), '')
  assert.equal(contentTypeFor('.gitignore'), DEFAULT_TYPE)
  assert.equal(extensionOf('archive.tar.gz'), 'gz')
  assert.equal(extensionOf('bundle.js.map'), 'map')
})

test('mime: the table carries no charset and a parameter is not part of a type', function () {
  for (const type of Object.values(CONTENT_TYPES))
    assert.equal(type.includes(';'), false, type)
  assert.equal(baseType('text/html; charset=utf-8'), 'text/html')
  assert.equal(baseType('TEXT/HTML'), 'text/html')
})

test('mime: extensionsFor is the table read backwards', function () {
  const jpeg = extensionsFor('image/jpeg').sort()
  assert.equal(jpeg.join(','), 'jpeg,jpg')
  assert.equal(extensionsFor('image/jpeg; charset=utf-8').length, 2, 'a parameter is ignored')
  assert.equal(extensionsFor('application/never').length, 0)
})

// ─── charset, compression, inline ────────────────────────────────────────────

test('mime: charset is asked for, never baked in', function () {
  assert.equal(contentTypeFor('a.css'), 'text/css')
  assert.equal(contentTypeFor('a.css', { charset: true }), 'text/css; charset=utf-8')
  assert.equal(contentTypeFor('a.json', { charset: true }), 'application/json; charset=utf-8')
  // A binary type never takes one even when asked — this is what stops a caller
  // passing `charset: true` for its text files and corrupting its image headers.
  assert.equal(contentTypeFor('a.png', { charset: true }), 'image/png')
  assert.equal(contentTypeFor('a.woff2', { charset: true }), 'font/woff2')
})

test('mime: svg needs no charset and is still worth compressing', function () {
  // The two questions were one field in sierra's table, which is why they are
  // two functions: svg is served as an image and carries its own encoding
  // declaration, and it is also the most compressible thing on a page.
  assert.equal(isTextType('image/svg+xml'), false)
  assert.equal(isCompressible('image/svg+xml'), true)
})

test('mime: compression refuses what is already compressed', function () {
  for (const t of ['text/html', 'text/markdown', 'application/json', 'application/manifest+json', 'application/wasm'])
    assert.equal(isCompressible(t), true, t)
  // junction held an exact-match map of ten types and sierra a regex, so
  // `text/markdown` compressed on one server and not the other.
  for (const t of ['image/png', 'image/jpeg', 'application/zip', 'application/gzip', 'application/pdf', 'font/woff2', 'video/mp4'])
    assert.equal(isCompressible(t), false, t)
  assert.equal(isCompressible(''), false)
  assert.equal(isCompressible(undefined), false)
  // Buffered to gzip, an SSE stream reached the caller in one piece at close.
  assert.equal(isCompressible('text/event-stream; charset=utf-8'), false)
})

test('mime: inline is an allow-list, and svg and html are not on it', function () {
  // `FJS-692` — an upload named `x.svg` served `image/svg+xml` inline is stored
  // XSS, because an SVG is a document that runs in the serving origin.
  assert.equal(isInlineSafe('image/svg+xml'), false)
  assert.equal(isInlineSafe('text/html'), false)
  assert.equal(isInlineSafe('application/xml'), false)
  // An UNKNOWN type is refused rather than allowed. A deny-list is wrong the
  // first time somebody uploads a format nobody listed.
  assert.equal(isInlineSafe('application/octet-stream'), false)
  assert.equal(isInlineSafe('application/x-newly-invented'), false)
  for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain'])
    assert.equal(isInlineSafe(t), true, t)
})

// ─── what the bytes say ──────────────────────────────────────────────────────

const bytesOf = (...parts) => Uint8Array.from(parts.flatMap((p) =>
  typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p))

test('mime: a magic number is read as bytes, not as text', function () {
  assert.equal(sniff(bytesOf([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniff(bytesOf([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniff(bytesOf('GIF89a')), 'image/gif')
  assert.equal(sniff(bytesOf('%PDF-1.7')), 'application/pdf')
  assert.equal(sniff(bytesOf([0x00], 'asm', [0x01, 0x00, 0x00, 0x00])), 'application/wasm')
  assert.equal(sniff(bytesOf([0x1f, 0x8b, 0x08])), 'application/gzip')
  assert.equal(sniff(bytesOf('PK', [0x03, 0x04])), 'application/zip')
})

test('mime: a shared prefix is resolved by its second field, not by its first', function () {
  // RIFF and ISO-BMFF are why the signature table cannot be one flat list:
  // `RIFF....WEBP` and `RIFF....WAVE` agree on four leading bytes.
  assert.equal(sniff(bytesOf('RIFF', [0, 0, 0, 0], 'WEBP')), 'image/webp')
  assert.equal(sniff(bytesOf('RIFF', [0, 0, 0, 0], 'WAVE')), 'audio/wav')
  assert.equal(sniff(bytesOf([0, 0, 0, 0x20], 'ftyp', 'avif')), 'image/avif')
  assert.equal(sniff(bytesOf([0, 0, 0, 0x20], 'ftyp', 'heic')), 'image/heic')
  // Every other ftyp brand is an mp4 profile, and answering the container is
  // what the question needs: is this upload a video.
  assert.equal(sniff(bytesOf([0, 0, 0, 0x20], 'ftyp', 'isom')), 'video/mp4')
  // A RIFF whose form is not one this knows is not guessed at.
  assert.equal(sniff(bytesOf('RIFF', [0, 0, 0, 0], 'NOPE')), null)
})

test('mime: markup is sniffed as text, and `<?xml` alone is not an svg', function () {
  // The case `FJS-692` turns on, and neither type announces itself in a prefix.
  assert.equal(sniff(bytesOf('<svg xmlns="http://www.w3.org/2000/svg">')), 'image/svg+xml')
  assert.equal(sniff(bytesOf('  \n  <svg>')), 'image/svg+xml', 'leading whitespace')
  assert.equal(sniff(bytesOf([0xef, 0xbb, 0xbf], '<svg>')), 'image/svg+xml', 'a BOM')
  assert.equal(sniff(bytesOf('<?xml version="1.0"?>\n<svg>')), 'image/svg+xml')
  // Most XML is not an SVG, so the declaration alone answers XML.
  assert.equal(sniff(bytesOf('<?xml version="1.0"?><rss></rss>')), 'application/xml')
  assert.equal(sniff(bytesOf('<!DOCTYPE html><html>')), 'text/html')
  assert.equal(sniff(bytesOf('<html lang="en">')), 'text/html')
})

test('mime: unknown is null, and null is not a verdict', function () {
  assert.equal(sniff(bytesOf('hello, plain text')), null)
  assert.equal(sniff(bytesOf('id,name\n1,a')), null, 'a csv has no magic number')
  assert.equal(sniff(null), null)
  assert.equal(sniff(undefined), null)
  assert.equal(sniff(Uint8Array.from([])), null)
  assert.equal(sniff('not bytes'), null)
  // A prefix shorter than the signature must not match on what it does have.
  assert.equal(sniff(Uint8Array.from([0x89, 0x50])), null)
})

// ─── one format, two spellings ───────────────────────────────────────────────

test('mime: heic and heif are one container read two ways', function () {
  // A HEIF `ftyp` brand decides the spelling — `heic`/`heix` read one way,
  // `mif1`/`msf1` the other — so an app declaring either must be answered by
  // both, or a photograph is refused for being the other reading of itself.
  assert.equal(sniff(bytesOf([0, 0, 0, 0x20], 'ftyp', 'mif1')), 'image/heif')
  assert.equal(sniff(bytesOf([0, 0, 0, 0x20], 'ftyp', 'heic')), 'image/heic')
  assert.equal(sameType('image/heic', 'image/heif'), true)
  assert.equal(sameType('image/heif', 'image/heic'), true, 'and in both directions')
})

test('mime: sameType is an equality everywhere else, which is the control', function () {
  // The negative control the equivalence table exists to be graded against: it
  // is a list of formats that ARE one thing, not a place to put near-enough.
  assert.equal(sameType('image/png', 'image/png'), true)
  assert.equal(sameType('image/png', 'image/jpeg'), false)
  assert.equal(sameType('image/svg+xml', 'image/png'), false)
  assert.equal(sameType('text/html', 'text/plain'), false)
  // A parameter is not part of the type, the same reduction `contentTypeFor`
  // makes — a browser hands `File.type` back with the charset attached.
  assert.equal(sameType('text/plain;charset=utf-8', 'text/plain'), true)
  assert.equal(sameType('', 'text/plain'), false)
})

