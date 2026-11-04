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
import { LocalProvider }      from './providers/local.js'
import { refUrlUnder }        from './ref-url.js'
import { contentTypeFor, sniff, baseType, extensionFor, sameType } from '@frontierjs/toolbelt/mime'
import { buildWhere }         from '../core/query.js'
import { ValidationError }    from '../core/validate.js'
import { extname, basename }  from 'path'
import { existsSync, openAsBlob, createReadStream } from 'fs'
import { rm } from 'fs/promises'
import { createHash }         from 'crypto'
import { Readable }           from 'stream'

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
//
// `move` hands the file over: a local store renames it into place after one
// read for the hash, and any other provider removes it once its copy is stored.
// A copy of a multi-GiB resumed upload is its size read and written again
// (FJS-3971).
class FromPath {
  constructor(path, { move = false } = {}) {
    if (typeof path !== 'string' || !path) throw new Error('fromPath(path): path must be a non-empty string')
    this.path = path
    this.move = move === true
    Object.freeze(this)
  }
}

/** Upload a file from the server's disk into a File column. Code only — a request body cannot spell it. */
export function fromPath(path, options) { return new FromPath(path, options) }

// ─── Uploading from a stream ──────────────────────────────────────────────────

// A request body larger than memory arrives as a stream and is never one Blob.
// `type` is a claim like any other and the head of the bytes wins (resolveType).
// `size` is what the sender says it will send: a remote provider needs it before
// the first byte, and the count of what arrived is checked against it
// (FJS-D1808).
class FromStream {
  constructor(readable, { name, type, size } = {}) {
    if (readable && typeof readable.getReader !== 'function' && typeof readable.pipe === 'function')
      readable = Readable.toWeb(readable)
    if (!readable || typeof readable.getReader !== 'function')
      throw new Error('fromStream(readable): readable must be a ReadableStream or a Node Readable')
    if (size != null && !(Number.isSafeInteger(size) && size >= 0))
      throw new Error('fromStream(readable, { size }): size must be a non-negative integer')
    this.readable = readable
    this.name     = name
    this.type     = type
    this.size     = size ?? null
    Object.freeze(this)
  }
}

/** Upload a stream (a request's `req.body`) into a File column. Code only — a request body cannot spell it. */
export function fromStream(readable, options) { return new FromStream(readable, options) }

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
  if (v instanceof FromStream)  return true
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

// The first SNIFF_HEAD bytes are read and held, and the body handed on replays
// them before it continues with the rest, so the type is known and @accept has
// answered before anything is written.
async function streamValue(value, fieldName) {
  const reader = value.readable.getReader()
  const held   = []
  let   total  = 0
  while (total < SNIFF_HEAD) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    held.push(chunk)
    total += chunk.length
  }
  const head = Buffer.concat(held).subarray(0, SNIFF_HEAD)
  let replay = 0
  const body = new ReadableStream({
    async pull(controller) {
      if (replay < held.length) return controller.enqueue(held[replay++])
      const { done, value: chunk } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(chunk)
    },
    cancel: reason => reader.cancel(reason),
  })
  return {
    body, head, size: value.size ?? undefined,
    mime:     value.type || 'application/octet-stream',
    filename: displayName(value.name) ?? fieldName,
    name:     displayName(value.name),
    cancel:   reason => body.cancel(reason),
  }
}

async function readValue(value, fieldName, model) {
  if (value instanceof FromStream) return streamValue(value, fieldName)
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
    return blobValue(await openAsBlob(path), {
      mime: guessMime(path), filename: basename(path), name: displayName(basename(path)),
      ...(value.move ? { move: path } : {}),
    })
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

  // The directory a local store writes under, which is what junction serves;
  // null for every provider whose bytes live elsewhere.
  get localRoot() {
    return this._provider instanceof LocalProvider ? this._provider._root : null
  }


  // Extract per-field options from schema (keepVersions, accept)
  _fieldOptions(field) {
    const acceptAttr = field.attributes.find(a => a.kind === 'accept')
    const digestAttr = field.attributes.find(a => a.kind === 'digest')
    return {
      keepVersions: !!field.attributes.find(a => a.kind === 'keepVersions'),
      accept:       acceptAttr ? acceptAttr.types : null,
      digest:       digestAttr ? digestAttr.column : null,
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

    // A plugin is shared by every client a tenant registry builds, so the
    // config is settled by the first and the rest keep it.
    if (this._provider) return

    // What code leaves unsaid the environment says, under the framework's own
    // names, so a deploy can read the same ones (`FJS-D1549`). With no provider
    // named either way, the bytes go to disk beside the database — the one
    // directory a deploy keeps and backs up (`FJS-D493`) — and junction serves
    // them. A config here is never refused for naming no provider: that refusal
    // was a production upload failing in front of a customer.
    const cfg = { ...this.config }
    for (const [option, name] of Object.entries(FILES_ENV)) {
      if (cfg[option] == null && process.env[name]) cfg[option] = process.env[name]
    }
    if (!cfg.provider && !cfg.endpoint) cfg.provider = 'local'
    if (cfg.provider === 'local' && !cfg.localPath && ctx?.filesRoot) cfg.localPath = ctx.filesRoot
    this.config = cfg
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

  // serialize: Buffer/File/fromPath/fromStream → upload → return ref object
  async serialize(value, { field, model, id, ctx }) {
    const fieldOpts = this._maps(ctx).fieldMap[model]?.[field] ?? {}
    const { body, head, mime, filename, name, size: stated, cancel, move } = await readValue(value, field, model)
    let key, type
    try {
      // The stored type is the evidence and never the claim: `mime` is what the
      // client or the filename SAID, and it is also what gets persisted on the ref
      // and handed to the provider as `contentType`, which is what a public bucket
      // later serves under. Both must be the same answer, so it is resolved once.
      const resolved = resolveType(mime, head)
      type = resolved.type
      checkAccept(type, fieldOpts.accept, model, field, resolved.evidence ? mime : null)
      key = resolveKey(this.config.keyPattern, { model, field, filename, type })
    } catch (err) {
      await cancel?.(err)
      throw err
    }
    const adopting = move && this._provider.adopt
    const { sha256, size } = adopting
      ? await this._adopt(key, move)
      : await this._store(key, body, { contentType: type, size: stated, model, field })
    if (move && !adopting) await rm(move, { force: true })
    return {
      key,
      ...(name ? { name } : {}),
      bucket:     this.config.bucket,
      provider:   this.config.provider ?? 'local',
      endpoint:   this.config.endpoint ?? null,
      size,
      sha256,
      mime: type,
      uploadedAt: new Date().toISOString(),
    }
  }

  // The one pass over the bytes: whatever the provider is handed is the bytes'
  // only read, and the hash and the count are taken from that read. A second
  // read of a Blob or a stream is its size again in heap or a stream that is
  // already gone (FJS-3094). The length check lives here and not in a provider
  // (FJS-D1808), and an object that is partial or the wrong length is deleted.
  async _store(key, body, { contentType, size: stated, model, field }) {
    // A Blob to a provider that signs the payload was always read whole; as a
    // stream it would be refused, which is fromStream's rule and not a File's.
    if (body instanceof Blob && this._provider.signsPayload) body = new Uint8Array(await body.arrayBuffer())
    if (!(body instanceof Blob) && !(body instanceof ReadableStream)) {
      await this._provider.put(key, body, { contentType, size: stated })
      return { sha256: createHash('sha256').update(body).digest('hex'), size: stated }
    }
    const hash  = createHash('sha256')
    let   count = 0
    const tap   = new TransformStream({
      transform(chunk, controller) { hash.update(chunk); count += chunk.length; controller.enqueue(chunk) },
    })
    const source = body instanceof Blob ? body.stream() : body
    const stream = source.pipeThrough(tap)
    const size   = stated ?? (body instanceof Blob ? body.size : undefined)
    try {
      await this._provider.put(key, stream, { contentType, size })
    } catch (err) {
      // A remote provider that refused before reading owns no object, and asking
      // it to delete one is a request for nothing; a local one has already
      // opened the file it would write, so an empty one is left behind.
      if (count > 0 || this._provider instanceof LocalProvider) await this._provider.delete(key).catch(() => {})
      else await stream.cancel(err).catch(() => {})
      throw err
    }
    if (size != null && count !== size) {
      await this._provider.delete(key).catch(() => {})
      throw refuse(model, field,
        `the file's ${count} bytes disagree with its stated size of ${size}; nothing was kept`)
    }
    return { sha256: hash.digest('hex'), size: count }
  }

  // A file already on the provider's own disk: hashed in one read, then moved
  // into place without a second write.
  async _adopt(key, path) {
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
    await this._provider.adopt(key, path)
    return { sha256: hash.digest('hex'), size }
  }

  // resolve: ref object → public URL string
  // autoResolve defaults to true — file fields return URLs directly on read.
  // A ref with no publicBase and no endpoint has no address and resolves to null
  // for every client, asSystem() included. `select: { file: { resolve: false } }`
  // is how a caller allowed to see the ref reads it.
  // fileUrl() still works for manual resolution of raw ref strings, and a
  // local ref's plain URL is refused by the route that serves it.
  // A local store's bytes are reachable only through a URL this read signed:
  // the row gate ran on the read, and the key alone is no secret (FJS-D1703).
  async resolve(ref, { field, model, ctx }) {
    if (!ref) return null
    const url = refUrlUnder(ref, this.config)
    if (!url || ref.provider !== 'local' || !this.localRoot) return url
    return this._provider.sign(ref.key)
  }

  // Whether a request for `key` carries a live signature from resolve().
  verify(key, signed) {
    return this._provider instanceof LocalProvider && this._provider.verify(key, signed)
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
    if (!fields || !args.data) return super.onBeforeCreate(model, args, ctx)
    const raw     = this._rawDigested(fields, args.data)
    const written = this._written(fields, args.data)
    await super.onBeforeCreate(model, args, ctx)
    await this._followOrDrop(model, fields, args.data, raw, written, false, ctx)
  }

  // Each File value of each row this write hands bytes to, as [field, index],
  // index null for a single File; read before serialize replaces it with a ref.
  _written(fields, data) {
    return [].concat(data ?? []).map(row => Object.entries(fields).flatMap(([field, opts]) =>
      opts.isArray
        ? [].concat(row?.[field] ?? []).flatMap((item, i) => isFileValue(item) ? [[field, i]] : [])
        : isFileValue(row?.[field]) ? [[field, null]] : []))
  }

  // The objects are stored before the sibling can be compared, and a write
  // that throws reaches no onAfterWrite: a refusal deletes what this write
  // stored and forgets the old refs it queued for cleanup, or the bytes are
  // orphaned and the next update's cleanup deletes the file the row still holds.
  async _followOrDrop(model, fields, data, raw, written, isUpdate, ctx) {
    try {
      this._followBytes(model, fields, data, raw, isUpdate)
    } catch (err) {
      const rows = [].concat(data ?? [])
      await Promise.all(written.flatMap((pairs, r) => pairs.map(([field, i]) =>
        this._cleanupRef(i === null ? this._parseRef(rows[r]?.[field]) : rows[r]?.[field]?.[i], { field, model, ctx }))))
      if (isUpdate) this._forgetStash(ctx, model, written.flat().map(([field]) => field))
      throw err
    }
  }

  _forgetStash(ctx, model, written) {
    const stash = this._stashMap.get(ctx._flavor ?? ctx)
    if (!stash) return
    for (const field of new Set(written)) {
      for (const k of stash.keys()) if (k === `${model}.${field}` || k.startsWith(`${model}.${field}[`)) stash.delete(k)
    }
  }

  // ── @digest: the sibling column follows the bytes ──────────────────────────

  // Which @digest File columns of each row this write hands bytes to, read
  // before serialize replaces the value with the ref.
  _rawDigested(fields, data) {
    return [].concat(data ?? []).map(row => Object.entries(fields)
      .filter(([field, opts]) => opts.digest && isFileValue(row?.[field]))
      .map(([field]) => field))
  }

  // The sibling is the hash of the bytes this write stored. Left out it is
  // filled; stated and different it is refused, naming both columns -- the
  // client's word for what it sent is the value the never-send-twice check
  // rests on (FJS-3051). Without the file, or clearing it, the sibling cannot
  // be set to anything but nothing (Invariant 9: key presence, not `??`).
  _followBytes(model, fields, data, raw, isUpdate) {
    const rows = [].concat(data ?? [])
    rows.forEach((row, i) => {
      if (!row) return
      for (const [field, opts] of Object.entries(fields)) {
        const sibling = opts.digest
        if (!sibling) continue
        const stated = row[sibling]
        if (raw[i]?.includes(field)) {
          const sha256 = this._parseRef(row[field])?.sha256
          if (stated === undefined) row[sibling] = sha256
          else if (stated !== sha256)
            throw refuse(model, sibling,
              `${sibling} states ${stated === null ? 'null' : `"${stated}"`} and the bytes written to ${field} hash to "${sha256}"`)
        } else if (row[field] === null) {
          if (stated != null)
            throw refuse(model, sibling, `${sibling} is the hash of ${field}, which this write clears, so it cannot be set to a value`)
          if (isUpdate || stated === undefined) row[sibling] = null
        } else if (row[field] === undefined && stated !== undefined) {
          throw refuse(model, sibling, `${sibling} is the hash of ${field} and cannot be set without a ${field} in the same write`)
        }
      }
    })
  }

  // ── Override onBeforeUpdate to handle keepVersions ────────────────────────
  // keepVersions: skip stashing old ref (so cleanup won't run in onAfterWrite)

  async onBeforeUpdate(model, args, ctx) {
    const fields = this._maps(ctx).fieldMap[model]
    if (!fields || !args.data) return
    const raw     = this._rawDigested(fields, args.data)
    const written = this._written(fields, args.data)
    await this._storeUpdate(model, args, ctx, fields)
    await this._followOrDrop(model, fields, args.data, raw, written, true, ctx)
  }

  async _storeUpdate(model, args, ctx, fields) {
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

// The environment names a deploy reads too (`FJS-D1549`), keyed by the option
// each one fills. An option passed in code wins over its name.
export const FILES_ENV = Object.freeze({
  provider:        'FILES_PROVIDER',
  bucket:          'FILES_BUCKET',
  endpoint:        'FILES_ENDPOINT',
  accessKeyId:     'FILES_KEY',
  secretAccessKey: 'FILES_SECRET',
  publicBase:      'FILES_PUBLIC_BASE',
})

export function FileStorage(config) {
  return new FileStoragePlugin({ autoResolve: true, ...config })
}
