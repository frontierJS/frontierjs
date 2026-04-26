// storage/providers/local.js — local filesystem provider for dev
// Stores files in a directory, serves via a simple URL base.

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join, resolve, dirname } from 'path'

export class LocalProvider {
  constructor(config) {
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

  async sign(key, { expiresIn = 3600 } = {}) {
    // Local dev — just return the public URL (no real signing needed)
    return this.publicUrl(key)
  }

  publicUrl(key) {
    return `${this._urlBase}/${key}`
  }
}
