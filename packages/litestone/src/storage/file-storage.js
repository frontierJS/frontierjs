// storage/file-storage.js — FileStorage plugin
//
// Extends ExternalRefPlugin — @file fields store a JSON ref in SQLite,
// actual bytes live in object storage (R2, S3, B2, MinIO, or local filesystem).
//
// ─── Setup ─────────────────────────────────────────────────────────────────────
//
//   import { FileStorage } from '@frontierjs/litestone/storage'
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
//   model User {
//     avatar  File?
//     resume  File?  @keepVersions
//     photos  File[]
//     docs    File[] @accept("application/pdf")
//   }

import { ExternalRefPlugin } from '../plugins/external-ref.js'
import { createProvider }     from './index.js'
import { contentTypeFor, sniff, baseType, extensionFor, sameType } from '@frontierjs/toolbelt/mime'
import { buildWhere }         from '../core/query.js'
import { extname, basename }  from 'path'
import { existsSync, readFileSync } from 'fs'

// ─── MIME type matching ───────────────────────────────────────────────────────

function mimeMatches(mime, pattern) {
  if (pattern === '*' || pattern === '*/*') return true
  if (pattern.endsWith('/*')) return mime.startsWith(pattern.slice(0, -1))
  // Not an equality: one container can carry two registered types, and since
  // the evidence is the bytes rather than the name, a HEIF photo whose `ftyp`
  // brand reads `image/heif` was refused by `@accept("image/heic")`.
  return sameType(mime, pattern)
}

/**
 * What these bytes ARE, preferring evidence over the caller's word.
 *
 * Every `mime` reaching here is a CLAIM: a browser `File` carries whatever
 * `type` the client set on it, and a path carries whatever its extension says.
 * `@accept` graded that claim, so any bytes at all satisfied
 * `@accept("image/png")` provided they arrived named `.png` (`FJS-1184`).
 *
 * `sniff` answers `null` for anything it does not recognize — most text formats
 * have no magic number — and null is *no evidence*, never *safe*, so the claim
 * stands where there is nothing to check it against.
 */
function resolveType(claimed, bytes) {
  // The claim is reduced to a bare type before anything compares it. A browser
  // hands `File.type` back with its parameters attached — a plain-text upload
  // arrives as `text/plain;charset=utf-8` — and `mimeMatches` is an equality,
  // so `@accept("text/plain")` refused the exact thing it was written to allow.
  const evidence = sniff(bytes)
  return { type: evidence ?? baseType(claimed) ?? claimed, evidence }
}

function checkAccept(mime, accept, model, field, claimed) {
  if (!accept) return
  const patterns = accept.split(',').map(s => s.trim().toLowerCase())
  const m = mime.toLowerCase()
  if (!patterns.some(p => mimeMatches(m, p))) {
    // The second sentence is only true when the bytes were RECOGNIZED. Where
    // `sniff` answered nothing the type being reported IS the claim, and saying
    // *the bytes are text/plain* about bytes nothing identified is the kind of
    // false precision an error is read as fact.
    const err = new Error(
      `${model}.${field}: file type "${mime}" not allowed — accepted: ${accept}` +
      (claimed && baseType(claimed) !== mime
        ? `\n  The name claimed "${claimed}"; the bytes are ${mime}.`
        : '')
    )
    err.name  = 'ValidationError'
    err.field = field
    err.model = model
    throw err
  }
}

// ─── Uploading from disk ──────────────────────────────────────────────────────

// A string is never read as a path: Junction types a File column `any`, so a
// JSON body naming `/etc/hostname` would upload the server's own file, and a
// system import of untrusted rows carries the same `./x` (FJS-2061). The class
// instance is the authority, and JSON cannot construct one.
class FromPath {
  constructor(path) {
    if (typeof path !== 'string' || !path) throw new Error('fromPath(path): path must be a non-empty string')
    this.path = path
    Object.freeze(this)
  }
}

/** Upload a file from the server's disk into a File column. Code only — a request body cannot spell it. */
export function fromPath(path) { return new FromPath(path) }

// ─── Detect a file value (vs. an already-stored JSON ref or null) ─────────────

// A string that is not a stored ref answers true so that serialize() refuses
// it by name; answering false would store it as the column's ref.
function isFileValue(v) {
  if (v == null) return false
  if (typeof File !== 'undefined' && v instanceof File) return true
  if (v instanceof Blob)        return true
  if (v instanceof Buffer)      return true
  if (v instanceof Uint8Array)  return true
  if (v instanceof ArrayBuffer) return true
  if (v instanceof FromPath)    return true
  if (typeof v === 'string' && !v.trimStart().startsWith('{')) return true
  return false
}

// ─── Extract bytes from any file value ───────────────────────────────────────

async function readValue(value, fieldName, model) {
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
  if (value instanceof FromPath) {
    const { path } = value
    if (!existsSync(path)) throw new Error(`@file: file not found: ${path}`)
    const bytes = readFileSync(path)
    return { bytes, mime: guessMime(path), filename: basename(path), size: bytes.length }
  }
  if (typeof value === 'string') {
    const err = new Error(
      `${model}.${fieldName}: a File column takes bytes (a File, Blob or Buffer) or a stored ref, and a string is neither. ` +
      'A string is never read as a path; code uploading from the server\'s disk passes fromPath(path)'
    )
    err.name  = 'ValidationError'
    err.field = fieldName
    err.model = model
    throw err
  }
  throw new Error(`@file: unsupported value type for field "${fieldName}"`)
}

// ─── Key pattern resolution ───────────────────────────────────────────────────

function resolveKey(pattern = ':model/:id/:field/:uuid.:ext', { model, id, field, filename, type }) {
  const now  = new Date()
  // UTC: `:date` becomes part of the stored KEY, so a host-local reading files
  // an upload made at 23:30 on the 31st under the next month or the previous
  // one depending on where the server is, and moving the server changes where
  // the next object lands while every key already written stays put.
  const date = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  // The extension follows the RESOLVED type and not the uploaded name. A static
  // origin serves by extension and has no ref to read, so a PNG stored under
  // `.txt` because that is what the upload was called leaves `ref.mime` and the
  // URL stating different things — the same defect one layer out. Only where
  // the type is one the table can spell; otherwise the caller's name stands.
  const named    = extname(filename) || ''
  const fromType = type ? extensionFor(type) : null
  const ext  = fromType ? `.${fromType}` : named
  const name = basename(filename, named).replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)
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

// The type table is `@frontierjs/toolbelt/mime` and is not restated here.
// Four packages kept one each and 24 of 32 extensions appeared in some and not
// others (`FJS-1186`); this one was missing `.avif` and `.heic`, which are what
// a phone uploads.
function guessMime(filename) {
  return contentTypeFor(filename)
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

  // serialize: Buffer/File/fromPath → upload → return ref object
  async serialize(value, { field, model, id, ctx }) {
    const fieldOpts = this._fieldMap[model]?.[field] ?? {}
    const { bytes, mime, filename, size } = await readValue(value, field, model)
    // The stored type is the evidence and never the claim: `mime` is what the
    // client or the filename SAID, and it is also what gets persisted on the ref
    // and handed to the provider as `contentType`, which is what a public bucket
    // later serves under. Both must be the same answer, so it is resolved once.
    const { type, evidence } = resolveType(mime, bytes)
    checkAccept(type, fieldOpts.accept, model, field, evidence ? mime : null)
    const key = resolveKey(this.config.keyPattern, { model, field, id, filename, type })
    await this._provider.put(key, bytes, { contentType: type, size })
    return {
      key,
      bucket:     this.config.bucket,
      provider:   this.config.provider ?? 'local',
      endpoint:   this.config.endpoint ?? null,
      publicBase: this.config.publicBase ?? null,
      size,
      mime: type,
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

    // Which fields carry incoming file values? An array is never a file value
    // itself, so a File[] field is picked by its items (FJS-2095).
    const rawFields = Object.entries(fields).filter(([field, opts]) => {
      const value = args.data[field]
      return opts.isArray && Array.isArray(value) ? value.some(isFileValue) : isFileValue(value)
    })
    if (!rawFields.length) return

    // Stash old refs for cleanup after write — ONE combined SELECT for all
    // fields that need it (keepVersions fields are excluded: no stash → no cleanup).
    const stashFields = rawFields.filter(([, opts]) => !opts.keepVersions)
    if (stashFields.length && ctx.readDb && args.where) {
      try {
        const params = []
        const whereSql = buildWhere(args.where, params)
        if (whereSql) {
          const colSql = stashFields.map(([f]) => `"${f}"`).join(', ')
          const oldRow = ctx.readDb.query(`SELECT ${colSql} FROM "${model}" WHERE ${whereSql}`).get(...params)
          for (const [field, opts] of stashFields) {
            if (opts.isArray) {
              // A ref the new array carries forward is still in use; cleaning it
              // up would delete the file an append keeps.
              const kept = new Set([].concat(args.data[field])
                .map(item => typeof item === 'string' ? this._parseRef(item) : item)
                .filter(item => item && !isFileValue(item) && item.key)
                .map(item => item.key))
              for (const oldRef of this._parseRefArray(oldRow?.[field])) {
                if (oldRef && !kept.has(oldRef.key)) this._stash(ctx, model, `${field}[${JSON.stringify(oldRef)}]`, oldRef)
              }
            } else {
              const oldRef = this._parseRef(oldRow?.[field])
              if (oldRef) this._stash(ctx, model, field, oldRef)
            }
          }
        }
      } catch {}
    }

    for (const [field, opts] of rawFields) {
      const value = args.data[field]
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
        args.data[field] = refs
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
