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
//       keyPattern:      ':model/:field/:uuid.:ext',
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
import { refUrlUnder }        from './ref-url.js'
import { contentTypeFor, sniff, baseType, extensionFor, sameType } from '@frontierjs/toolbelt/mime'
import { buildWhere }         from '../core/query.js'
import { ValidationError }    from '../core/validate.js'
import { extname, basename }  from 'path'
import { existsSync, openAsBlob } from 'fs'

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
    throw refuse(model, field,
      `file type "${mime}" not allowed — accepted: ${accept}` +
      (claimed && baseType(claimed) !== mime
        ? `\n  The name claimed "${claimed}"; the bytes are ${mime}.`
        : ''))
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

// ─── A file over JSON ─────────────────────────────────────────────────────────

// JSON has no bytes, so a caller over a JSON body or /mcp sends them inline: a
// data URL, or `{ name, type, data }` with base64 `data` (FJS-D666). A stored
// ref is never taken from a caller. The server is its only author, and a ref
// naming another row's key would have that file deleted when this row's old
// refs are cleaned up. The bound is the request body's (`http.maxBodySize`).
const DATA_URL = /^data:([^,]*),/
const BASE64   = /^[A-Za-z0-9+/]*={0,2}$/

function isInlineFile(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  if (typeof v.data !== 'string') return false
  return Object.keys(v).every(k => k === 'name' || k === 'type' || k === 'data')
}

// A real ValidationError, so `errors` names the field and a form marks the box;
// a plain Error that only borrows the name carries no field list.
function refuse(model, field, message) {
  const err = new ValidationError([{ path: [field], message }])
  err.field = field
  err.model = model
  return err
}

// Buffer.from(s, 'base64') skips what it cannot read, so a value that is not
// base64 would be stored as whatever bytes survived. It is checked first.
function decodeBase64(data, model, field) {
  const clean = data.replace(/\s+/g, '')
  if (!BASE64.test(clean) || clean.length % 4 === 1)
    throw refuse(model, field, 'the file\'s data is not base64')
  return Buffer.from(clean, 'base64')
}

function readInline(value, fieldName, model) {
  let claimed, name, data
  if (typeof value === 'string') {
    const meta = DATA_URL.exec(value)[1].split(';')
    if (meta.at(-1) !== 'base64')
      throw refuse(model, fieldName, 'a data URL\'s bytes are read as base64 only: data:<type>;base64,<data>')
    claimed = meta[0] || undefined
    data    = value.slice(value.indexOf(',') + 1)
  } else {
    claimed = typeof value.type === 'string' ? value.type : undefined
    name    = value.name
    data    = value.data
  }
  const bytes = decodeBase64(data, model, fieldName)
  return {
    bytes,
    mime:     claimed || 'application/octet-stream',
    filename: displayName(name) ?? fieldName,
    name:     displayName(name),
    size:     bytes.length,
  }
}

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
  if (isInlineFile(v))          return true
  if (typeof v === 'string' && !v.trimStart().startsWith('{')) return true
  return false
}

// ─── Extract bytes from any file value ───────────────────────────────────────

// The name the bytes arrived under, kept on the ref for a Content-Disposition.
// The key cannot carry it (it keeps [a-z0-9_-]), and a name is the sender's
// string: a path or a control character in it would reach a download header.
function displayName(raw) {
  if (typeof raw !== 'string') return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this pattern removes or refuses
  const name = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return name || undefined
}

// A Blob is handed to the provider as itself and only this much of it is read,
// for `sniff`. Read whole it cost its size again in heap on top of the
// transport's copies: four 40 MB uploads took an API from 89 to 580 MB
// (FJS-3094). `body` is the Blob or the bytes; `head` is what the type is read from.
const SNIFF_HEAD = 4096

async function blobValue(blob, fields) {
  const head = new Uint8Array(await blob.slice(0, SNIFF_HEAD).arrayBuffer())
  return { body: blob, head, size: blob.size, ...fields }
}

function bytesValue(bytes, fields) {
  return { body: bytes, head: bytes, size: bytes.length, ...fields }
}

async function readValue(value, fieldName, model) {
  if (typeof File !== 'undefined' && value instanceof File)
    return blobValue(value, { mime: value.type || 'application/octet-stream', filename: value.name || fieldName, name: displayName(value.name) })
  if (value instanceof Blob)
    return blobValue(value, { mime: value.type || 'application/octet-stream', filename: fieldName })
  if (value instanceof Buffer || value instanceof Uint8Array)
    return bytesValue(value instanceof Buffer ? value : Buffer.from(value), { mime: 'application/octet-stream', filename: fieldName })
  if (value instanceof ArrayBuffer)
    return bytesValue(Buffer.from(value), { mime: 'application/octet-stream', filename: fieldName })
  if (value instanceof FromPath) {
    const { path } = value
    if (!existsSync(path)) throw new Error(`@file: file not found: ${path}`)
    return blobValue(await openAsBlob(path), { mime: guessMime(path), filename: basename(path), name: displayName(basename(path)) })
  }
  if (isInlineFile(value) || (typeof value === 'string' && DATA_URL.test(value))) {
    const { bytes, ...fields } = readInline(value, fieldName, model)
    return bytesValue(bytes, fields)
  }
  if (typeof value === 'string') {
    throw refuse(model, fieldName,
      'a File column takes bytes (a File, Blob or Buffer), a data URL (data:<type>;base64,<data>) or { name, type, data } ' +
      'with base64 data, and this string is none of them. A string is never read as a path; code uploading from the ' +
      'server\'s disk passes fromPath(path)')
  }
  throw new Error(`@file: unsupported value type for field "${fieldName}"`)
}

// ─── Key pattern resolution ───────────────────────────────────────────────────

// No `:id`: a create's row has none when the object is written, so the token
// filed every created object under `new` (FJS-2098). `:uuid` is the identity.
function resolveKey(pattern = ':model/:field/:uuid.:ext', { model, field, filename, type }) {
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

    if (/:id\b/.test(this.config.keyPattern ?? '')) {
      throw new Error(
        'FileStorage: keyPattern cannot name :id — a create has no id when the object is written, ' +
        'so every created object would land under "new". Use :uuid, or :date for grouping.'
      )
    }

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
    // Every provider but local signs its requests, and the signer reads the secret
    // on the first upload -- so a missing one surfaced there as a TypeError about
    // `secret.length`, long after the app built.
    if (cfg.provider !== 'local') {
      for (const option of ['accessKeyId', 'secretAccessKey']) {
        if (!cfg[option]) {
          throw new Error(
            `FileStorage: provider '${cfg.provider ?? 'r2'}' needs ${option}. ` +
            'Pass accessKeyId and secretAccessKey, or provider: \'local\' for files on disk.'
          )
        }
      }
    }
    this._provider = createProvider(cfg)
  }

  // ── ExternalRefPlugin contract ────────────────────────────────────────────

  // serialize: Buffer/File/fromPath → upload → return ref object
  async serialize(value, { field, model, id, ctx }) {
    const fieldOpts = this._maps(ctx).fieldMap[model]?.[field] ?? {}
    const { body, head, mime, filename, name, size } = await readValue(value, field, model)
    // The stored type is the evidence and never the claim: `mime` is what the
    // client or the filename SAID, and it is also what gets persisted on the ref
    // and handed to the provider as `contentType`, which is what a public bucket
    // later serves under. Both must be the same answer, so it is resolved once.
    const { type, evidence } = resolveType(mime, head)
    checkAccept(type, fieldOpts.accept, model, field, evidence ? mime : null)
    const key = resolveKey(this.config.keyPattern, { model, field, filename, type })
    await this._provider.put(key, body, { contentType: type, size })
    return {
      key,
      ...(name ? { name } : {}),
      bucket:     this.config.bucket,
      provider:   this.config.provider ?? 'local',
      endpoint:   this.config.endpoint ?? null,
      size,
      mime: type,
      uploadedAt: new Date().toISOString(),
    }
  }

  // resolve: ref object → public URL string
  // autoResolve defaults to true — file fields return URLs directly on read.
  // A ref with no publicBase and no endpoint has no address and resolves to null
  // for every client, asSystem() included. `select: { file: { resolve: false } }`
  // is how a caller allowed to see the ref reads it.
  // fileUrl() still works for manual resolution of raw ref strings.
  async resolve(ref, { field, model, ctx }) {
    if (!ref) return null
    return refUrlUnder(ref, this.config)
  }

  // cleanup: delete the S3/R2 object
  async cleanup(ref, { field, model, ctx }) {
    if (!ref?.key) return
    await this._provider.delete(ref.key)
  }

  // cacheKey: null — URLs are deterministic, no cache needed
  cacheKey(ref) { return null }

  // ── A File[] item that is not a file ──────────────────────────────────────

  // A File[] item that is not a file names a stored key, and a key this row
  // does not hold is another row's: replacing or deleting this row would have
  // the provider delete that row's file (FJS-2308). A ref is the server's to
  // write (FJS-D666), so a create takes none, and an update keeps one only when
  // every row it matches already holds that key, as the stored ref rather than
  // the caller's copy of it.
  _refuseRef(model, field, i) {
    return refuse(model, field,
      `item ${i} is not a file. A stored reference is written by the server, never sent, and an update keeps ` +
      `one only when the row already holds it. Send the bytes: a data URL (data:<type>;base64,<data>) or ` +
      `{ name, type, data } with base64 data`)
  }

  // A File column's ref text is what isFileValue passes through as stored, so
  // a principal's would name another row's key and this row's delete or
  // replace would remove that file (FJS-3114). asSystem() is the server, the
  // ref's author (FJS-D666), and writes one when it restores or seeds a row.
  _refuseRefText(model, row, fields, ctx) {
    if (ctx.isSystem || !row) return
    for (const [field, opts] of Object.entries(fields)) {
      const v = row[field]
      if (opts.isArray || typeof v !== 'string' || !v.trimStart().startsWith('{')) continue
      throw refuse(model, field,
        `${field} is a File column and was given a stored reference. A stored reference is written by the server, ` +
        `never sent. Send the bytes: a data URL (data:<type>;base64,<data>) or { name, type, data } with base64 data`)
    }
  }

  // The refs every row `where` matches holds under `field`, by key; null when
  // they cannot be read, so a ref is refused rather than kept on a guess.
  _heldRefs(model, field, where, ctx) {
    if (!ctx.readDb || !where) return null
    try {
      const params   = []
      const whereSql = buildWhere(where, params)
      if (!whereSql) return null
      const rows = ctx.readDb.query(`SELECT "${field}" FROM "${model}" WHERE ${whereSql}`).all(...params)
      const held = rows.map(row => new Map(this._parseRefArray(row[field]).filter(ref => ref?.key).map(ref => [ref.key, ref])))
      const [first = new Map(), ...rest] = held
      return new Map([...first].filter(([key]) => rest.every(m => m.has(key))))
    } catch { return null }
  }

  async onBeforeCreate(model, args, ctx) {
    const fields = this._maps(ctx).fieldMap[model]
    if (fields && args.data) {
      const many = Array.isArray(args.data)
      for (const row of [].concat(args.data)) {
        this._refuseRefText(model, row, fields, ctx)
        for (const [field, opts] of Object.entries(fields)) {
          if (!opts.isArray || row?.[field] == null) continue
          ;[].concat(row[field]).forEach((item, i) => {
            if (!isFileValue(item)) throw this._refuseRef(model, field, i)
            if (many) throw new Error(
              `${this.constructor.name}: createMany does not support raw values on field "${field}". ` +
              `Use create() individually.`
            )
          })
        }
      }
    }
    return super.onBeforeCreate(model, args, ctx)
  }

  // ── Override onBeforeUpdate to handle keepVersions ────────────────────────
  // keepVersions: skip stashing old ref (so cleanup won't run in onAfterWrite)

  async onBeforeUpdate(model, args, ctx) {
    const fields = this._maps(ctx).fieldMap[model]
    if (!fields || !args.data) return
    this._refuseRefText(model, args.data, fields, ctx)

    for (const [field, opts] of Object.entries(fields)) {
      if (!opts.isArray || args.data[field] == null) continue
      const items = [].concat(args.data[field])
      if (items.every(isFileValue)) continue
      const held = this._heldRefs(model, field, args.where, ctx)
      args.data[field] = items.map((item, i) => {
        if (isFileValue(item)) return item
        const key = (typeof item === 'string' ? this._parseRef(item) : item)?.key
        const ref = typeof key === 'string' ? held?.get(key) : undefined
        if (!ref) throw this._refuseRef(model, field, i)
        return ref
      })
    }

    // Which fields does this write replace? An array is never a file value
    // itself, so a File[] field is picked by being given at all: an update
    // that only drops refs carries no file, and the dropped ones still need
    // their cleanup stashed (FJS-2095, FJS-2315).
    const rawFields = Object.entries(fields).filter(([field, opts]) =>
      opts.isArray ? args.data[field] != null : isFileValue(args.data[field]))
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
