// storage/providers/local.js — local filesystem provider.
// Stores files in a directory; junction serves it, and only to a URL this
// provider signed (FJS-D1703).

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, createWriteStream } from 'fs'
import { createHmac, timingSafeEqual } from 'crypto'
import { join, resolve, dirname } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { refUrl } from '../ref-url.js'

const HOUR = 3600

export class LocalProvider {
  // The config is held, not copied: junction sets publicBase and signingKey on
  // it after the client is built, when it knows the origin it serves from.
  constructor(config) {
    this._config  = config
    this._root    = resolve(config.localPath ?? './storage')
    this._urlBase = config.localUrl ?? `http://localhost:${config.localPort ?? 3001}/storage`
  }

  _filePath(key) {
    const abs = join(this._root, key)
    // Guard against path traversal
    if (!abs.startsWith(this._root)) throw new Error(`Invalid key: ${key}`)
    return abs
  }

  async put(key, body, { contentType } = {}) {
    const path = this._filePath(key)
    mkdirSync(dirname(path), { recursive: true })
    // A Blob is an upload or a file on disk, and is piped rather than read
    // whole -- an upload's size again in heap per concurrent request (FJS-3094).
    if (body instanceof Blob) return pipeline(Readable.fromWeb(body.stream()), createWriteStream(path))
    const buf = body instanceof Uint8Array ? body
      : body instanceof ArrayBuffer        ? Buffer.from(body)
      : typeof body === 'string'           ? Buffer.from(body, 'utf8')
      : body
    writeFileSync(path, buf)
  }

  async get(key) {
    const path = this._filePath(key)
    if (!existsSync(path)) throw new Error(`File not found: ${key}`)
    return readFileSync(path)
  }

  async delete(key) {
    const path = this._filePath(key)
    try { unlinkSync(path) } catch {}  // ignore if not found
  }

  // The expiry is rounded up to the hour, so every read within one hour prints
  // the same URL and a browser's cache of it holds. With no signingKey nothing
  // serves this directory, and the URL is the plain one.
  async sign(key, { expiresIn = HOUR, now = Date.now() } = {}) {
    const url    = this.publicUrl(key)
    const secret = this._config.signingKey
    if (!secret) return url
    const exp = Math.ceil((now / 1000 + expiresIn) / HOUR) * HOUR
    return `${url}?exp=${exp}&sig=${mac(secret, key, exp)}`
  }

  // True when `sig` is this store's signature of `key` and `exp` has not passed.
  verify(key, { exp, sig } = {}, now = Date.now()) {
    const secret = this._config.signingKey
    if (!secret || typeof sig !== 'string' || typeof exp !== 'string' || !/^\d{1,12}$/.test(exp)) return false
    if (Number(exp) * 1000 <= now) return false
    const want = Buffer.from(mac(secret, key, exp))
    const got  = Buffer.from(sig)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  publicUrl(key) {
    return refUrl({ publicBase: this._config.publicBase ?? this._urlBase, key })
  }
}

// A newline joins the parts, so ('a/b', 1) and ('a', '/b1') sign different strings.
function mac(secret, key, exp) {
  return createHmac('sha256', secret).update(`${key}\n${exp}`).digest('base64url')
}
