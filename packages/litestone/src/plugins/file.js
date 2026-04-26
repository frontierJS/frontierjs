// plugins/file.js — FileStorage plugin
//
// Extends ExternalRefPlugin — @file fields store a JSON ref in SQLite,
// actual bytes live in object storage (R2, S3, B2, MinIO, or local filesystem).
//
// ─── Setup ─────────────────────────────────────────────────────────────────────
//
//   import { FileStorage } from '@frontierjs/litestone'
//
//   const db = await createClient({
//     schema: './schema.lite', db: './app.db',
//     plugins: [FileStorage({
//       provider:        'r2',
//       bucket:          'my-app',
//       endpoint:        process.env.S3_ENDPOINT,
//       accessKeyId:     process.env.S3_KEY,
//       secretAccessKey: process.env.S3_SECRET,
//       keyPattern:      ':model/:id/:field/:uuid.:ext',
//       dev:             'local',
//     })]
//   })
//
// ─── Schema ────────────────────────────────────────────────────────────────────
//
//   model users {
//     avatar  File?
//     resume  File?  @keepVersions
//     photos  File[]
//     docs    File[] @accept("application/pdf")
//   }

import { ExternalRefPlugin } from './external-ref.js'
import { createProvider }     from '../storage/index.js'
import { extname, basename }  from 'path'
import { existsSync, readFileSync } from 'fs'

// ─── MIME type matching ───────────────────────────────────────────────────────

function mimeMatches(mime, pattern) {
  if (pattern === '*' || pattern === '*/*') return true
  if (pattern.endsWith('/*')) return mime.startsWith(pattern.slice(0, -1))
  return mime === pattern
}

function checkAccept(mime, accept, model, field) {
  if (!accept) return
  const patterns = accept.split(',').map(s => s.trim().toLowerCase())
  const m = mime.toLowerCase()
  if (!patterns.some(p => mimeMatches(m, p))) {
    const err = new Error(
      `${model}.${field}: file type "${mime}" not allowed — accepted: ${accept}`
    )
    err.name  = 'ValidationError'
    err.field = field
    err.model = model
    throw err
  }
}

// ─── Detect a file value (vs. an already-stored JSON ref or null) ─────────────

function isFileValue(v) {
  if (v == null) return false
  if (typeof File !== 'undefined' && v instanceof File) return true
  if (v instanceof Blob)        return true
  if (v instanceof Buffer)      return true
  if (v instanceof Uint8Array)  return true
  if (v instanceof ArrayBuffer) return true
  if (typeof v === 'string' && !v.trimStart().startsWith('{') && (
    v.startsWith('/') || v.startsWith('./') || v.startsWith('../') || v.startsWith('~/')
  )) return true
  return false
}

// ─── Extract bytes from any file value ───────────────────────────────────────

async function readValue(value, fieldName) {
  if (typeof File !== 'undefined' && value instanceof File) {
    const bytes = new Uint8Array(await value.arrayBuffer())
    return { bytes, mime: value.type || 'application/octet-stream', filename: value.name || fieldName, size: bytes.length }
  }
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer())
    return { bytes, mime: value.type || 'application/octet-stream', filename: fieldName, size: bytes.length }
  }
  if (value instanceof Buffer || value instanceof Uint8Array) {
    const bytes = value instanceof Buffer ? value : Buffer.from(value)
    return { bytes, mime: 'application/octet-stream', filename: fieldName, size: bytes.length }
  }
  if (value instanceof ArrayBuffer) {
    const bytes = Buffer.from(value)
    return { bytes, mime: 'application/octet-stream', filename: fieldName, size: bytes.length }
  }
  if (typeof value === 'string') {
    if (!existsSync(value)) throw new Error(`@file: file not found: ${value}`)
    const bytes = readFileSync(value)
    return { bytes, mime: guessMime(value), filename: basename(value), size: bytes.length }
  }
  throw new Error(`@file: unsupported value type for field "${fieldName}"`)
}

// ─── Key pattern resolution ───────────────────────────────────────────────────

function resolveKey(pattern = ':model/:id/:field/:uuid.:ext', { model, id, field, filename }) {
  const now  = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const ext  = extname(filename) || ''
  const name = basename(filename, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  return pattern
    .replace(':model',    model)
    .replace(':id',       String(id ?? 'new'))
    .replace(':field',    field)
    .replace(':date',     date)
    .replace(':filename', `${name}${ext}`)
    .replace(':uuid',     uuid)
    .replace(':ext',      ext.replace('.', ''))
}

const MIME = {
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg', '.png':  'image/png',
  '.gif':  'image/gif',  '.webp': 'image/webp', '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain', '.md':   'text/markdown',
  '.csv':  'text/csv',   '.json': 'application/json',
  '.zip':  'application/zip',
  '.mp4':  'video/mp4',  '.mp3':  'audio/mpeg',
  '.wasm': 'application/wasm',
}

function guessMime(filename) {
  return MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

// ─── FileStoragePlugin ────────────────────────────────────────────────────────

class FileStoragePlugin extends ExternalRefPlugin {
  fieldType = 'File'

  constructor(config) {
    super(config)
    this._provider = null
  }

  // Alias for test compatibility — _fieldMap is the canonical name in base class
  get _fileMap() { return this._fieldMap }

  // Extract per-field options from schema (keepVersions, accept)
  _fieldOptions(field) {
    const acceptAttr = field.attributes.find(a => a.kind === 'accept')
    return {
      keepVersions: !!field.attributes.find(a => a.kind === 'keepVersions'),
      accept:       acceptAttr ? acceptAttr.types : null,
    }
  }

  _isRawValue(v) { return isFileValue(v) }

  // ── Init ──────────────────────────────────────────────────────────────────

  onInit(schema, ctx) {
    super.onInit(schema, ctx)

    const cfg = { ...this.config }
    if (!cfg.provider && !cfg.endpoint) {
      if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
        cfg.provider = 'local'
      } else {
        throw new Error(
          'FileStorage: no provider or endpoint configured. ' +
          'Pass provider: \'r2\' | \'s3\' | \'local\' or set NODE_ENV=development to use local storage.'
        )
      }
    }
    this._provider = createProvider(cfg)
  }

  // ── ExternalRefPlugin contract ────────────────────────────────────────────

  // serialize: Buffer/File/path → upload → return ref object
  async serialize(value, { field, model, id, ctx }) {
    const fieldOpts = this._fieldMap[model]?.[field] ?? {}
    const { bytes, mime, filename, size } = await readValue(value, field)
    checkAccept(mime, fieldOpts.accept, model, field)
    const key = resolveKey(this.config.keyPattern, { model, field, id, filename })
    await this._provider.put(key, bytes, { contentType: mime, size })
    return {
      key,
      bucket:     this.config.bucket,
      provider:   this.config.provider ?? 'local',
      endpoint:   this.config.endpoint ?? null,
      publicBase: this.config.publicBase ?? null,
      size,
      mime,
      uploadedAt: new Date().toISOString(),
    }
  }

  // resolve: ref object → public URL string
  // autoResolve defaults to true — file fields return URLs directly on read.
  // Use asSystem() to get the raw ref object if needed.
  // fileUrl() still works for manual resolution of raw ref strings.
  async resolve(ref, { field, model, ctx }) {
    if (!ref) return null
    const base = ref.publicBase || ref.endpoint
    if (!base) return null
    return `${base.replace(/\/$/, '')}/${ref.key}`
  }

  // cleanup: delete the S3/R2 object
  async cleanup(ref, { field, model, ctx }) {
    if (!ref?.key) return
    await this._provider.delete(ref.key)
  }

  // cacheKey: null — URLs are deterministic, no cache needed
  cacheKey(ref) { return null }

  // ── Override onBeforeCreate to handle File[] arrays ───────────────────────
  // The base class handles arrays generically, but File[] needs the accept check
  // which is embedded in serialize() above — so the base class handles it correctly.
  // No override needed.

  // ── Override onBeforeUpdate to handle keepVersions ────────────────────────
  // keepVersions: skip stashing old ref (so cleanup won't run in onAfterWrite)

  async onBeforeUpdate(model, args, ctx) {
    const fields = this._fieldMap[model]
    if (!fields || !args.data) return

    for (const [field, opts] of Object.entries(fields)) {
      const value = args.data[field]
      if (!isFileValue(value)) continue

      // keepVersions: don't stash old ref → won't be cleaned up
      if (!opts.keepVersions && ctx.readDb && args.where) {
        try {
          const { buildWhere } = await import('../core/query.js')
          const params = []
          const whereSql = buildWhere(args.where, params)
          if (whereSql) {
            if (opts.isArray) {
              const oldRow = ctx.readDb.query(`SELECT "${field}" FROM "${model}" WHERE ${whereSql}`).get(...params)
              const oldRefs = this._parseRefArray(oldRow?.[field])
              for (const oldRef of oldRefs) {
                if (oldRef) this._stash(ctx, model, `${field}[${JSON.stringify(oldRef)}]`, oldRef)
              }
            } else {
              const oldRow = ctx.readDb.query(`SELECT "${field}" FROM "${model}" WHERE ${whereSql}`).get(...params)
              const oldRef = this._parseRef(oldRow?.[field])
              if (oldRef) this._stash(ctx, model, field, oldRef)
            }
          }
        } catch {}
      }

      const id = args.where?.id ?? 'upd'
      if (opts.isArray) {
        const items = Array.isArray(value) ? value : [value]
        if (!items.some(isFileValue)) continue
        const refs = await Promise.all(
          items.map((item, i) =>
            isFileValue(item)
              ? this.serialize(item, { field, model, id: `${id}-${i}`, ctx })
              : Promise.resolve(item)
          )
        )
        args.data[field] = JSON.stringify(refs)
        continue
      }
      const ref = await this.serialize(value, { field, model, id, ctx })
      args.data[field] = JSON.stringify(ref)
    }
  }
}

export function FileStorage(config) {
  return new FileStoragePlugin({ autoResolve: true, ...config })
}
