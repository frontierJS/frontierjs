/**
 * serve/http-answers.js — the answers both static origins give the same way.
 *
 * `site/serve.js` and `widget/serve.js` are deliberately different servers: one
 * serves documents a browser navigates to, the other serves files a stranger's
 * page fetches cross-origin, and almost every header they send differs because
 * of it. What does NOT differ is what HTTP itself requires of any origin handing
 * back bytes, and that is what lives here — a wrong verb, a range, and whether
 * the body can travel compressed.
 *
 * It is here rather than in one of them because it was in neither: each had one
 * half of the method answer and neither had the other two.
 */

import { gzipSync } from 'node:zlib'

/** What a static origin does. Sent on a 405, which is what makes one useful. */
export const ALLOWED_METHODS = 'GET, HEAD, OPTIONS'

/**
 * The answer to a verb this origin does not serve, or null when it does.
 *
 * `FJS-753` settled the shape for junction and it is the same shape here: a
 * wrong verb is 405 **carrying `Allow`**, because a 405 that does not say what
 * IS allowed tells a caller only that they were wrong. An unclaimed `OPTIONS` is
 * 204 — a preflight, or a client asking what this URL does, and neither is an
 * error.
 */
export function methodAnswer(method) {
  if (method === 'GET' || method === 'HEAD') return null
  if (method === 'OPTIONS') return { status: 204, headers: { Allow: ALLOWED_METHODS } }
  return { status: 405, headers: { Allow: ALLOWED_METHODS } }
}

// A body is worth compressing when it is text and there is enough of it. Below
// roughly a packet the deflate header costs more than it saves, and an image or
// a font is already compressed — gzipping one spends CPU to grow the response.
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json)|image\/svg\+xml)/
const MIN_COMPRESS_BYTES = 1024

/**
 * Compress `body` when the caller asked and the type is worth it.
 *
 * Recompressed per request rather than cached, because these origins already
 * read the file per request and a cache here would be the only thing in either
 * of them holding state. Measured on `example`'s own built widget: 25,282 bytes
 * to 10,437, at 0.47 ms — a cost worth paying on the surface whose bytes cross
 * somebody else's page, and one a CDN in front of it pays once.
 *
 * @returns {{ body: Buffer, encoding: string }|null} null means send it as is.
 */
export function compressed(body, contentType, acceptEncoding) {
  if (!body || body.length < MIN_COMPRESS_BYTES) return null
  if (!COMPRESSIBLE.test(String(contentType ?? ''))) return null
  if (!/\bgzip\b/.test(String(acceptEncoding ?? ''))) return null
  return { body: gzipSync(body), encoding: 'gzip' }
}

/**
 * Parse a `Range` header against a known size.
 *
 * Only a single byte range is honored. A multipart answer is a different
 * response body and no client asks a static origin for one in practice, so it is
 * declined with the whole file rather than half-implemented.
 *
 * @returns {{start:number,end:number}|'unsatisfiable'|null} null means send it whole.
 */
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m

  let start, end
  if (rawStart === '') {
    // A suffix range: the LAST n bytes. `bytes=-0` asks for nothing.
    if (rawEnd === '') return null
    const n = Number(rawEnd)
    if (n === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end   = size - 1
  } else {
    start = Number(rawStart)
    end   = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * Turn a file's bytes into the status, headers and body to send.
 *
 * Both origins used to write `Content-Length` and hand back the whole buffer,
 * which is correct and is also every answer HTTP has for a body — so a font a
 * page seeks into, and 12 KB of JavaScript on somebody else's site, were both
 * served the only way this knew.
 *
 * A range and an encoding are never combined: the offsets a caller asks for are
 * into the identity representation, and a compressed slice answers a different
 * question from the one asked.
 *
 * @param {Buffer} body
 * @param {string} contentType
 * @param {{ range?: string, acceptEncoding?: string }} ask
 */
export function bodyAnswer(body, contentType, { range, acceptEncoding } = {}) {
  const headers = { 'Accept-Ranges': 'bytes' }

  const wanted = byteRange(range, body.length)
  if (wanted === 'unsatisfiable') {
    return {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${body.length}` },
      body: Buffer.alloc(0),
    }
  }
  if (wanted) {
    const slice = body.subarray(wanted.start, wanted.end + 1)
    return {
      status: 206,
      headers: {
        ...headers,
        'Content-Range':  `bytes ${wanted.start}-${wanted.end}/${body.length}`,
        'Content-Length': slice.length,
      },
      body: slice,
    }
  }

  const gz = compressed(body, contentType, acceptEncoding)
  if (gz) {
    return {
      status: 200,
      headers: {
        ...headers,
        // Required, and it is the half that is easy to leave off: without it a
        // shared cache can hand the gzipped bytes to a client that did not ask.
        'Vary':             'Accept-Encoding',
        'Content-Encoding': gz.encoding,
        'Content-Length':   gz.body.length,
      },
      body: gz.body,
    }
  }

  return { status: 200, headers: { ...headers, 'Content-Length': body.length }, body }
}
