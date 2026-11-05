// @ts-check
// storage/providers/s3.js — S3-compatible provider
// Handles Cloudflare R2, AWS S3, Backblaze B2, MinIO — all use the S3 API.

import { uriEncode } from '@frontierjs/toolbelt/sigv4'
import { signRequest, presignUrl } from '../sigv4.js'
import { refUrl } from '../ref-url.js'

// ─── Provider map ─────────────────────────────────────────────────────────────

const REGION_DEFAULTS = /** @type {Record<string, string>} */ ({
  r2:    'auto',
  s3:    'us-east-1',
  b2:    'us-west-002',
  minio: 'us-east-1',
})

// ─── Multipart ────────────────────────────────────────────────────────────────

const SINGLE_PUT_MAX = 5 * 1024 ** 3   // S3's ceiling for one PUT
const PART_SIZE      = 8 * 1024 ** 2   // every part but the last must be at least 5 MiB
const MAX_PARTS      = 10000

// A stream as parts of exactly `partSize` bytes, the last one shorter. Closing
// the generator early cancels the stream, so a failed upload stops its source.
async function* partsOf(/** @type {ReadableStream} */ stream, /** @type {number} */ partSize) {
  const reader = stream.getReader()
  const join   = (/** @type {Uint8Array[]} */ chunks, /** @type {number} */ held) => {
    if (chunks.length === 1) return chunks[0]
    const all = new Uint8Array(held)
    let at = 0
    for (const c of chunks) { all.set(c, at); at += c.length }
    return all
  }
  let chunks = /** @type {Uint8Array[]} */ ([])
  let held   = 0
  let ended  = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) { ended = true; break }
      chunks.push(value); held += value.length
      while (held >= partSize) {
        const all  = join(chunks, held)
        const rest = all.subarray(partSize)
        chunks = rest.length ? [rest] : []
        held   = rest.length
        yield all.subarray(0, partSize)
      }
    }
    if (held > 0) yield join(chunks, held)
  } finally {
    if (!ended) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// ─── S3Provider ───────────────────────────────────────────────────────────────

export class S3Provider {
  constructor(/** @type {any} */ config) {
    this._provider   = config.provider ?? 'r2'
    this._bucket     = config.bucket
    this._endpoint   = config.endpoint?.replace(/\/$/, '')
    this._region     = config.region ?? REGION_DEFAULTS[config.provider] ?? 'auto'
    this._access     = config.accessKeyId
    this._secret     = config.secretAccessKey
    this._publicBase = config.publicBase ?? null  // optional CDN/public URL base
    this._service    = 's3'
  }

  // The key is encoded here, per segment. Joined in raw, a `?` or `#` in it ends
  // the path, so the object written is a prefix of the one asked for, and the
  // signature agrees with the truncated request, so nothing refuses it.
  _objectUrl(/** @type {string} */ key) {
    if (this._endpoint) return /** @type {string} */ (refUrl({ endpoint: this._endpoint, bucket: this._bucket, key }))
    const path = key.split('/').map(uriEncode).join('/')
    return `https://${this._bucket}.s3.${this._region}.amazonaws.com/${path}`
  }

  // Over plain http the signature covers every byte, so the bytes must all be
  // in hand before the request starts; a caller holding a Blob reads it once.
  get signsPayload() { return !this._objectUrl('k').startsWith('https:') }

  _opts() {
    return {
      accessKeyId:     this._access,
      secretAccessKey: this._secret,
      region:          this._region,
      service:         this._service,
    }
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  async put(/** @type {string} */ key, /** @type {any} */ body, { contentType = 'application/octet-stream', size } = /** @type {{ contentType?: string, size?: number }} */ ({})) {
    const url     = this._objectUrl(key)
    const headers = /** @type {Record<string, string>} */ ({ 'content-type': contentType })
    if (size != null) headers['content-length'] = String(size)

    // A plain S3 PUT carries Content-Length and a chunked body has none, so only
    // a stream of stated size under the single-PUT ceiling, over https, goes as
    // one PUT. Any other stream is a multipart upload, which buffers one part at
    // a time and so can be signed over plain http (FJS-D1808, FJS-3905).
    const streamed = body instanceof ReadableStream
    if (streamed && !(size != null && size <= SINGLE_PUT_MAX && url.startsWith('https:')))
      return this._putMultipart(key, body, { contentType, size })

    // A signed payload is a hash of every byte, so a Blob would cost its size in
    // heap to send. Over https it goes unsigned and fetch streams it; over plain
    // http the body stays in the signature, because there TLS is not covering it.
    const unsignedPayload = (streamed || body instanceof Blob) && url.startsWith('https:')
    if (body instanceof Blob && !unsignedPayload) body = new Uint8Array(await body.arrayBuffer())

    const signed = await signRequest('PUT', url, headers, body, { ...this._opts(), unsignedPayload })

    const res = await fetch(url, {
      method:  'PUT',
      headers: { ...headers, ...signed },
      body,
      ...(streamed ? { duplex: 'half' } : {}),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 PUT failed (${res.status}): ${text}`)
    }
  }

  // A stream of unknown length, or past the single-PUT ceiling. One part is held
  // in heap at a time; a stream that ends inside its first part is an ordinary
  // PUT of those bytes, since an upload of one small part is only extra requests.
  // A failure after the upload began aborts it, so no parts are left billing.
  /** @returns {Promise<void>} */
  async _putMultipart(/** @type {string} */ key, /** @type {ReadableStream} */ body, /** @type {{ contentType: string, size?: number }} */ { contentType, size }) {
    const partSize = Math.max(PART_SIZE, Math.ceil((size ?? 0) / MAX_PARTS))
    const parts    = partsOf(body, partSize)
    const first    = await parts.next()
    if (first.done) return this.put(key, new Uint8Array(0), { contentType, size: 0 })
    const second = await parts.next()
    if (second.done) return this.put(key, first.value, { contentType, size: first.value.length })

    const url      = this._objectUrl(key)
    const created  = await this._send('POST', `${url}?uploads`, { 'content-type': contentType }, null, 'multipart create')
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await created.text())?.[1]
    if (!uploadId) throw new Error(`S3 multipart create returned no UploadId for ${key}`)
    const upload = `uploadId=${encodeURIComponent(uploadId)}`
    const etags  = /** @type {string[]} */ ([])
    try {
      let part = /** @type {IteratorResult<Uint8Array, void>} */ (first)
      for (;;) {
        const number = etags.length + 1
        if (number > MAX_PARTS)
          throw new Error(`fromStream to provider ${this._provider} passed ${MAX_PARTS} parts of ${partSize} bytes -- state its size so the parts can be larger`)
        const res = await this._send('PUT', `${url}?partNumber=${number}&${upload}`, {}, /** @type {Uint8Array} */ (part.value), `multipart part ${number}`)
        const etag = res.headers.get('etag')
        if (!etag) throw new Error(`S3 multipart part ${number} returned no ETag for ${key}`)
        etags.push(etag)
        part = number === 1 ? second : await parts.next()
        if (part.done) break
      }
      const xml = etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('')
      const done = await this._send('POST', `${url}?${upload}`, { 'content-type': 'application/xml' },
        new TextEncoder().encode(`<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`), 'multipart complete')
      // Complete can answer 200 and carry the failure in its body.
      const text = await done.text()
      if (/<Error>/.test(text)) throw new Error(`S3 multipart complete failed: ${text}`)
    } catch (err) {
      await parts.return(undefined)
      await this._send('DELETE', `${url}?${upload}`, {}, null, 'multipart abort').catch(() => {})
      throw err
    }
  }

  // One signed request whose body is already in hand.
  async _send(/** @type {string} */ method, /** @type {string} */ url, /** @type {Record<string, string>} */ headers, /** @type {Uint8Array | null} */ body, /** @type {string} */ what) {
    const signed = await signRequest(method, url, headers, body, this._opts())
    const res    = await fetch(url, { method, headers: { ...headers, ...signed }, ...(body ? { body: /** @type {BodyInit} */ (body) } : {}) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 ${what} failed (${res.status}): ${text}`)
    }
    return res
  }

  // ── Download ──────────────────────────────────────────────────────────────

  async get(/** @type {string} */ key) {
    const url    = this._objectUrl(key)
    const signed = await signRequest('GET', url, {}, null, this._opts())

    const res = await fetch(url, { headers: signed })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 GET failed (${res.status}): ${text}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  // The response body unread, so a large object is never held whole in heap.
  async stream(/** @type {string} */ key) {
    const url    = this._objectUrl(key)
    const signed = await signRequest('GET', url, {}, null, this._opts())

    const res = await fetch(url, { headers: signed })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 GET failed (${res.status}): ${text}`)
    }
    if (!res.body) throw new Error(`S3 GET returned no body for ${key}`)
    return res.body
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(/** @type {string} */ key) {
    const url    = this._objectUrl(key)
    const signed = await signRequest('DELETE', url, {}, null, this._opts())

    const res = await fetch(url, { method: 'DELETE', headers: signed })
    // 204 No Content or 404 (already gone) are both fine
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 DELETE failed (${res.status}): ${text}`)
    }
  }

  // ── Presigned URL ─────────────────────────────────────────────────────────

  async sign(/** @type {string} */ key, { expiresIn = 3600 } = {}) {
    const url = this._objectUrl(key)
    return presignUrl('GET', url, this._opts(), expiresIn)
  }

  // ── Public URL ────────────────────────────────────────────────────────────

  publicUrl(/** @type {string} */ key) {
    if (this._publicBase) return refUrl({ publicBase: this._publicBase, key })
    return this._objectUrl(key)
  }
}
