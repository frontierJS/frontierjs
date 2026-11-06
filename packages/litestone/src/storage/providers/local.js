// @ts-check
// storage/providers/local.js — local filesystem provider.
// Stores files in a directory; junction serves it, and only to a URL this
// provider signed (FJS-D1703).

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, createWriteStream, createReadStream } from 'fs'
import { rename, copyFile, unlink } from 'fs/promises'
import { createHmac, timingSafeEqual } from 'crypto'
import { join, resolve, dirname, sep } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { refUrl } from '../ref-url.js'

const HOUR = 3600

export class LocalProvider {
  // The config is held, not copied: junction sets publicBase and signingKey on
  // it after the client is built, when it knows the origin it serves from.
  constructor(/** @type {any} */ config) {
    this._config  = config
    this._root    = resolve(config.localPath ?? './storage')
    this._urlBase = config.localUrl ?? `http://localhost:${config.localPort ?? 3001}/storage`
  }

  _filePath(/** @type {string} */ key) {
    const abs = join(this._root, key)
    // The separator matters: /x/storage-evil begins with /x/storage.
    if (abs !== this._root && !abs.startsWith(this._root + sep)) throw new Error(`Invalid key: ${key}`)
    return abs
  }

  async put(/** @type {string} */ key, /** @type {any} */ body, { contentType } = /** @type {{ contentType?: string }} */ ({})) {
    const path = this._filePath(/** @type {string} */ key)
    mkdirSync(dirname(path), { recursive: true })
    // A Blob or a stream is an upload or a file on disk, and is piped rather
    // than read whole -- an upload's size again in heap per concurrent request
    // (FJS-3094). A stream that fails part-way leaves the bytes written so far;
    // FileStorage deletes them.
    if (body instanceof ReadableStream) return pipeline(Readable.fromWeb(/** @type {any} */ (body)), createWriteStream(path))
    if (body instanceof Blob) return pipeline(Readable.fromWeb(/** @type {any} */ (body.stream())), createWriteStream(path))
    const buf = body instanceof Uint8Array ? body
      : body instanceof ArrayBuffer        ? Buffer.from(body)
      : typeof body === 'string'           ? Buffer.from(body, 'utf8')
      : body
    writeFileSync(path, buf)
  }

  // A file already on this machine becomes the object. A rename keeps the inode
  // and writes nothing; across filesystems it is a copy and the source is
  // removed, since the caller handed the file over.
  async adopt(/** @type {string} */ key, /** @type {string} */ from) {
    const path = this._filePath(key)
    mkdirSync(dirname(path), { recursive: true })
    try {
      await rename(from, path)
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'EXDEV') throw err
      await copyFile(from, path)
      await unlink(from)
    }
  }

  async get(/** @type {string} */ key) {
    const path = this._filePath(/** @type {string} */ key)
    if (!existsSync(path)) throw new Error(`File not found: ${key}`)
    return readFileSync(path)
  }

  // The bytes as a stream, so a large object is never held whole in heap.
  async stream(/** @type {string} */ key) {
    const path = this._filePath(key)
    if (!existsSync(path)) throw new Error(`File not found: ${key}`)
    return /** @type {ReadableStream<Uint8Array>} */ (/** @type {unknown} */ (Readable.toWeb(createReadStream(path))))
  }

  // The file's absolute path, for a tool that reads a file by name (ffmpeg).
  path(/** @type {string} */ key) {
    return this._filePath(key)
  }

  async delete(/** @type {string} */ key) {
    const path = this._filePath(/** @type {string} */ key)
    try { unlinkSync(path) } catch {}  // ignore if not found
  }

  // The expiry is rounded up to the hour, so every read within one hour prints
  // the same URL and a browser's cache of it holds. With no signingKey nothing
  // serves this directory, and the URL is the plain one.
  async sign(/** @type {string} */ key, { expiresIn = HOUR, now = Date.now() } = {}) {
    const url    = this.publicUrl(/** @type {string} */ key)
    const secret = this._config.signingKey
    if (!secret) return url
    const exp = Math.ceil((now / 1000 + expiresIn) / HOUR) * HOUR
    return `${url}?exp=${exp}&sig=${mac(secret, key, exp)}`
  }

  // True when `sig` is this store's signature of `key` and `exp` has not passed.
  verify(/** @type {string} */ key, { exp, sig } = /** @type {{ exp?: string, sig?: string }} */ ({}), now = Date.now()) {
    const secret = this._config.signingKey
    if (!secret || typeof sig !== 'string' || typeof exp !== 'string' || !/^\d{1,12}$/.test(exp)) return false
    if (Number(exp) * 1000 <= now) return false
    const want = Buffer.from(mac(secret, key, exp))
    const got  = Buffer.from(sig)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  publicUrl(/** @type {string} */ key) {
    return refUrl({ publicBase: this._config.publicBase ?? this._urlBase, key })
  }
}

// A newline joins the parts, so ('a/b', 1) and ('a', '/b1') sign different strings.
function mac(/** @type {string} */ secret, /** @type {string} */ key, /** @type {string | number} */ exp) {
  return createHmac('sha256', secret).update(`${key}\n${exp}`).digest('base64url')
}
