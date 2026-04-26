// storage/providers/s3.js — S3-compatible provider
// Handles Cloudflare R2, AWS S3, Backblaze B2, MinIO — all use the S3 API.

import { signRequest, presignUrl } from '../sigv4.js'

// ─── Provider map ─────────────────────────────────────────────────────────────

const REGION_DEFAULTS = {
  r2:    'auto',
  s3:    'us-east-1',
  b2:    'us-west-002',
  minio: 'us-east-1',
}

// ─── S3Provider ───────────────────────────────────────────────────────────────

export class S3Provider {
  constructor(config) {
    this._bucket     = config.bucket
    this._endpoint   = config.endpoint?.replace(/\/$/, '')
    this._region     = config.region ?? REGION_DEFAULTS[config.provider] ?? 'auto'
    this._access     = config.accessKeyId
    this._secret     = config.secretAccessKey
    this._publicBase = config.publicBase ?? null  // optional CDN/public URL base
    this._service    = 's3'
  }

  _objectUrl(key) {
    if (this._endpoint) return `${this._endpoint}/${this._bucket}/${key}`
    return `https://${this._bucket}.s3.${this._region}.amazonaws.com/${key}`
  }

  _opts() {
    return {
      accessKeyId:     this._access,
      secretAccessKey: this._secret,
      region:          this._region,
      service:         this._service,
    }
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  async put(key, body, { contentType = 'application/octet-stream', size } = {}) {
    const url     = this._objectUrl(key)
    const headers = { 'content-type': contentType }
    if (size != null) headers['content-length'] = String(size)

    const signed = await signRequest('PUT', url, headers, body, this._opts())

    const res = await fetch(url, {
      method:  'PUT',
      headers: { ...headers, ...signed },
      body,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 PUT failed (${res.status}): ${text}`)
    }
  }

  // ── Download ──────────────────────────────────────────────────────────────

  async get(key) {
    const url    = this._objectUrl(key)
    const signed = await signRequest('GET', url, {}, null, this._opts())

    const res = await fetch(url, { headers: signed })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`S3 GET failed (${res.status}): ${text}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(key) {
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

  async sign(key, { expiresIn = 3600 } = {}) {
    const url = this._objectUrl(key)
    return presignUrl('GET', url, this._opts(), expiresIn)
  }

  // ── Public URL ────────────────────────────────────────────────────────────

  publicUrl(key) {
    if (this._publicBase) return `${this._publicBase.replace(/\/$/, '')}/${key}`
    return this._objectUrl(key)
  }
}
