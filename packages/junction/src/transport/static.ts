// transport/static.ts
// Static file serving — range requests, etag, gzip, cache headers.
// All the HTTP muscle from Total.js, rewritten for Bun.file().

import { join, extname, resolve, sep } from 'node:path'
import { realpath }                     from 'node:fs/promises'

import { contentTypeFor, isCompressible, isInlineSafe } from '@frontierjs/toolbelt/mime'

// ─── Module-level constants ────────────────────────────────────────────────
// Compiled once, never recreated per request.

// What may be CACHED is policy read off a URL, not a fact about the bytes, so
// it stays here while the type table moves to `@frontierjs/toolbelt/mime`
// (`FJS-1186`) — four packages kept one each and 24 of 32 extensions differed.
const CACHEABLE: Record<string, 1> = {
  js: 1, css: 1, png: 1, jpg: 1, jpeg: 1, gif: 1, ico: 1, svg: 1,
  woff: 1, woff2: 1, ttf: 1, eot: 1, otf: 1, webp: 1,
  mp4: 1, mp3: 1, webm: 1, pdf: 1
}

// This root serves an app's own bundle AND, wherever a `File` column's local
// provider points at it, bytes a stranger uploaded — and the handler cannot tell
// the two apart. `nosniff` is the half that is safe for both: it binds the
// browser to the declared type, which `@frontierjs/toolbelt/mime` now makes
// correct across every server here. **It is not the whole answer** — an SVG
// served inline still runs in this origin, and refusing that needs to know which
// population the bytes came from ([FJS-1187](ISSUES.md#fjs-1187) option B).
const NOSNIFF     = 'nosniff'

const NOCACHE      = 'private, no-cache, no-store, max-age=0'
const MAX_AGE      = 60        // seconds
const ETAG_PREFIX  = 'W/"'
const RANGE_RE     = /^bytes=(\d*)-(\d*)$/

// ─── Compressed-output cache ──────────────────────────────────────────────
// Static files are immutable between mtime changes, yet gzip was re-run
// synchronously on EVERY request (full read + CPU-bound compression on the
// event loop). Cache the gzipped bytes keyed by path+mtime+size — an mtime
// change produces a new key and the stale entry ages out via the size cap.

const GZIP_CACHE_MAX_ENTRIES = 256
const GZIP_CACHE_MAX_BYTES   = 32 * 1024 * 1024   // 32 MB budget
const _gzipCache = new Map<string, Uint8Array<ArrayBuffer>>()
let   _gzipCacheBytes = 0

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: since TypeScript
// 5.7 the latter widens to ArrayBufferLike, which admits SharedArrayBuffer —
// and neither Bun.gzipSync nor Response accepts one.
function cachedGzip(key: string, raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const hit = _gzipCache.get(key)
  if (hit) return hit

  const gzipped = Bun.gzipSync(raw) as Uint8Array<ArrayBuffer>

  // Evict oldest entries (Map insertion order) until the new one fits.
  while (
    _gzipCache.size >= GZIP_CACHE_MAX_ENTRIES ||
    (_gzipCacheBytes + gzipped.byteLength > GZIP_CACHE_MAX_BYTES && _gzipCache.size > 0)
  ) {
    const oldestKey = _gzipCache.keys().next().value as string
    const oldest    = _gzipCache.get(oldestKey)!
    _gzipCache.delete(oldestKey)
    _gzipCacheBytes -= oldest.byteLength
  }

  // Don't cache single blobs bigger than the whole budget — serve one-off.
  if (gzipped.byteLength <= GZIP_CACHE_MAX_BYTES) {
    _gzipCache.set(key, gzipped)
    _gzipCacheBytes += gzipped.byteLength
  }
  return gzipped
}

// ─── Static file handler ──────────────────────────────────────────────────

export interface StaticOptions {
  root:       string
  maxAge?:    number        // seconds, default 60
  etag?:      string        // app version tag for etag
  compress?:  boolean       // gzip compressible types, default true
  index?:     string        // default 'index.html'

  /**
   * Directories a symlink inside the root may legitimately resolve into.
   *
   * A link out of the root is refused, because it is served to anyone who can
   * guess the URL — but `dist/assets → /srv/shared/assets` is a real
   * deployment and refusing it with no way to say otherwise is how a check
   * like this gets turned off wholesale. Name the directory instead; anything
   * not named is still refused.
   */
  allowOutside?: string[]

  /**
   * These bytes came from strangers ([`FJS-D314`](../../../../DECISIONS.md#fjs-d314)).
   *
   * A `File` column's local provider publishes its objects under some root, and
   * a root serving uploads is not the same thing as one serving the app's own
   * bundle — but this handler cannot tell them apart, so the app says. Marked,
   * anything outside the inline allow-list is answered as an `attachment`:
   * an SVG is a document that may carry script and it runs in the origin that
   * served it, which is stored XSS on the app's own domain.
   *
   * Left unmarked by DEFAULT and deliberately so — `isInlineSafe` refuses
   * `text/javascript`, so applying this to a root holding an app's own bundle
   * would break the app. An image is inline either way, so marking an uploads
   * root costs a photograph nothing.
   */
  untrusted?: boolean

  /**
   * Answer a document request for a path that names no file with the index.
   *
   * A client-routed app is reloaded on `/admin/items`, which is a route in the
   * browser and nothing on disk — behind nginx `try_files` hands it the shell,
   * and with no proxy in front it was a 404. Only a request that asks for HTML
   * and names no extension gets the shell: a missing `/assets/app.js` or a
   * `fetch` for JSON stays a 404 rather than an HTML page parsed as either.
   */
  spa?: boolean
}

/**
 * What a route knows about the file it names, which the file system does not.
 *
 * A stored object has its own identity: the row's content hash is its etag, the
 * mime the uploader declared is its type, and who may cache it is the route's
 * policy. Left unstated the handler derives all three from the file (mtime,
 * extension, public cache), which is right for a bundle and wrong for a private
 * upload. Range, 304, nosniff and disposition run on whichever identity is in
 * force, so a route states three facts and writes no byte arithmetic.
 */
export interface ServedFile {
  /** The full validator, quotes included. Not `StaticOptions.etag`, which salts a derived one. */
  etag?:         string
  /** The Content-Type, used as given: it still meets nosniff and, on an untrusted root, the inline allow-list. */
  type?:         string
  cacheControl?: string
  /** An attachment under this name; `true` names it after the file. */
  download?:     string | true
}

export async function serveStatic(
  req:        Request,
  urlPath:    string,
  opts:       StaticOptions,
  served:     ServedFile = {}
): Promise<Response | null> {

  const {
    root,
    maxAge    = MAX_AGE,
    etag      = '',
    compress  = true,
    index     = 'index.html',
    allowOutside = [],
    untrusted = false
  } = opts

  const safe = sanitizePath(urlPath)
  if (safe === 400) return new Response('Bad Request', { status: 400 })
  if (safe === 403) return new Response('Forbidden', { status: 403 })

  let filePath = join(root, safe)

  // Try index file for directory requests
  if (filePath.endsWith('/') || !extname(filePath))
    filePath = join(filePath, index)

  // Resolve file via Bun — throws if not found
  const file = Bun.file(filePath)
  const exists = await file.exists()
  if (!exists) {
    if (opts.spa && !extname(safe) && req.headers.get('accept')?.includes('text/html'))
      return serveStatic(req, '/', { ...opts, spa: false })
    return null  // let router handle 404
  }

  // A path that stays inside the root is not the same as a FILE that does.
  // `sanitizePath` refuses `..` and a NUL byte, which is the whole of what a
  // URL can say — and a symlink INSIDE the root pointing out of it says the
  // rest: `assets/css/link.css → ../../secret.txt` was served 200 with the
  // contents (`FJS-746`). Only the resolved path can answer this, so it is
  // asked here rather than of the request.
  if (!await withinRoot(root, filePath, allowOutside)) return null

  const ext      = extname(filePath).slice(1).toLowerCase()
  const mimeType = served.type ?? contentTypeFor(ext, { charset: true })
  const size     = file.size
  const mtime    = new Date(file.lastModified)
  const mtimeStr = mtime.toUTCString()

  // ── ETag + Last-Modified cache check ────────────────────────────────
  const fileEtag     = served.etag ?? `${ETAG_PREFIX}${etag}${file.lastModified}"`
  const cacheControl = served.cacheControl ?? buildCacheControl(safe, ext, maxAge)

  const ifNoneMatch    = req.headers.get('if-none-match')
  const ifModifiedSince = req.headers.get('if-modified-since')

  if (
    (ifNoneMatch && etagMatches(ifNoneMatch, fileEtag)) ||
    (!ifNoneMatch && ifModifiedSince && new Date(ifModifiedSince) >= mtime)
  ) {
    return new Response(null, {
      status: 304,
      headers: {
        'etag':          fileEtag,
        'last-modified': mtimeStr,
        'cache-control': cacheControl
      }
    })
  }

  // Computed once and shared by both responses: a 206 declares the same type as
  // the 200, so an attachment rule that reached one and not the other would hand
  // back an inline copy of exactly the file the full response refused to inline.
  const disposition = served.download
    ? downloadDisposition(served.download === true ? filePath.split(/[\\/]/).pop() ?? 'download' : served.download)
    : dispositionFor(mimeType, untrusted, filePath)

  // ── Range request (byte serving) ─────────────────────────────────────
  const rangeHeader = req.headers.get('range')
  if (rangeHeader) {
    return serveRange(file, rangeHeader, mimeType, size, fileEtag, mtimeStr, disposition, cacheControl)
  }

  // ── Regular response ──────────────────────────────────────────────────
  const headers: Record<string, string> = {
    'content-type':  mimeType,
    'x-content-type-options': NOSNIFF,
    ...disposition,
    'etag':          fileEtag,
    'last-modified': mtimeStr,
    'cache-control': cacheControl,
    'accept-ranges': 'bytes'
  }

  // ── Gzip compression ──────────────────────────────────────────────────
  const acceptEncoding = req.headers.get('accept-encoding') ?? ''
  const canCompress    = compress && acceptEncoding.includes('gzip') && isCompressible(mimeType)

  if (canCompress && size > 256) {
    // Cached by path+mtime+size — identical requests reuse the compressed
    // bytes instead of re-reading and re-gzipping the file every time.
    const cacheKey = `${file.name ?? ''}:${file.lastModified}:${size}`
    let gzipped = _gzipCache.get(cacheKey)
    if (!gzipped) {
      const raw = await file.arrayBuffer()
      gzipped   = cachedGzip(cacheKey, new Uint8Array(raw))
    }
    headers['content-encoding'] = 'gzip'
    headers['content-length']   = String(gzipped.byteLength)
    headers['vary']             = 'Accept-Encoding'
    return new Response(gzipped, { status: 200, headers })
  }

  headers['content-length'] = String(size)

  return new Response(file, { status: 200, headers })
}

// ─── Root containment ─────────────────────────────────────────────────────

// The realpath of each declared root. A root is a configured constant and
// resolving it is a syscall, so it is resolved once; the FILE is resolved on
// every request, because a symlink can be repointed under a running server and
// a cached answer would go on serving what it used to be.
const _realRoots = new Map<string, string | null>()

async function realRoot(root: string): Promise<string | null> {
  if (_realRoots.has(root)) return _realRoots.get(root)!
  let real: string | null
  try   { real = await realpath(resolve(root)) }
  catch { real = null }   // the root itself is gone — nothing can be inside it
  _realRoots.set(root, real)
  return real
}

/**
 * Is the file this request resolved to really inside the declared root?
 *
 * An EMPTY root is not a root: `ctx.file('/var/data/report.pdf')` names a file
 * the application chose, and there is nothing for it to be inside of. The
 * check is about a directory an operator published, not about every path the
 * app itself can name.
 *
 * A link that escapes answers the same 404 a missing file does, deliberately —
 * a 403 would confirm to the caller that they found a way out of the root. The
 * OPERATOR is told instead, once per path, because a symlinked asset directory
 * is a real deployment shape and silently serving nothing would be a day lost.
 */
/**
 * `Content-Disposition` for an untrusted root, and nothing for any other.
 *
 * The filename is the one the object is stored under rather than anything a
 * caller sent — it is already sanitized by `resolveKey`, and quoting a value
 * from a request into a header is how a header gets split.
 */
function downloadDisposition(name: string): Record<string, string> {
  return { 'content-disposition': `attachment; filename*=utf-8''${encodeURIComponent(name)}` }
}

// A validator list, weak tags compared as their strong form (RFC 9110 § 13.1.2).
function etagMatches(header: string, etag: string): boolean {
  const strip = (t: string) => t.trim().replace(/^W\//, '')
  const mine  = strip(etag)
  return header.split(',').some(t => t.trim() === '*' || strip(t) === mine)
}

function dispositionFor(mimeType: string, untrusted: boolean, filePath: string): Record<string, string> {
  if (!untrusted || isInlineSafe(mimeType)) return {}
  const name = filePath.split(/[\\/]/).pop() ?? 'download'
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_')
  return { 'content-disposition': `attachment; filename="${safe}"` }
}

async function withinRoot(root: string, filePath: string, allowOutside: string[]): Promise<boolean> {
  if (!root) return true

  const base = await realRoot(root)
  if (!base) return false

  let real: string
  try   { real = await realpath(filePath) }
  catch { return false }   // vanished between the stat and here

  if (contains(base, real)) return true

  // Compared as REALPATHS, or a declared directory that is itself a link
  // never matches the resolved file underneath it — which reads as the
  // allowance being ignored.
  for (const allowed of allowOutside) {
    const dir = await realRoot(allowed)
    if (dir && contains(dir, real)) return true
  }

  warnEscape(filePath, real, base)
  return false
}

function contains(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir + sep)
}

const _warned = new Set<string>()

function warnEscape(filePath: string, real: string, base: string): void {
  if (_warned.has(filePath)) return
  _warned.add(filePath)
  console.warn(
    `[Junction] static: '${filePath}' resolves to '${real}', which is outside the served root ` +
    `'${base}' — refused, and answered as not found. A symlink out of the root is served to ` +
    `anyone who can guess the URL, so it is refused rather than followed. Name the directory ` +
    `in the static block's 'allowOutside' if it is meant to be published.`
  )
}

// ─── Range response ───────────────────────────────────────────────────────

async function serveRange(
  file:     ReturnType<typeof Bun.file>,
  range:    string,
  mimeType: string,
  size:     number,
  etag:     string,
  mtime:    string,
  disposition: Record<string, string>,
  cacheControl: string
): Promise<Response> {

  // A range the server cannot satisfy names the size, so the client can ask again.
  const unsatisfiable = () => new Response(null, {
    status: 416,
    headers: { 'content-range': `bytes */${size}`, 'etag': etag, 'cache-control': cacheControl }
  })

  const match = RANGE_RE.exec(range)
  if (!match || (!match[1] && !match[2])) return unsatisfiable()

  const startStr = match[1]
  const endStr   = match[2]

  const start = startStr ? parseInt(startStr, 10) : Math.max(0, size - parseInt(endStr, 10))
  const end   = endStr && startStr ? Math.min(parseInt(endStr, 10), size - 1) : size - 1

  if (size === 0 || start >= size || start > end || (!startStr && parseInt(endStr, 10) === 0)) return unsatisfiable()

  const chunkSize = end - start + 1

  // Bun.file supports slice
  const chunk = file.slice(start, end + 1)

  return new Response(chunk, {
    status: 206,
    headers: {
      'content-type':  mimeType,
      'x-content-type-options': NOSNIFF,
      ...disposition,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(chunkSize),
      'accept-ranges': 'bytes',
      'etag':          etag,
      'last-modified': mtime,
      'cache-control': cacheControl
    }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// A bundle file under /assets is named by its content hash, so a cached copy
// can never be stale and a year is the longest a browser honors. The page that
// names the hashes is not under /assets, so it keeps revalidating.
const HASHED = /\/assets\/[^/]*-[\w-]{8,}\.\w+$/

function buildCacheControl(urlPath: string, ext: string, maxAge: number): string {
  if (!CACHEABLE[ext]) return NOCACHE
  if (HASHED.test(urlPath)) return 'public, max-age=31536000, immutable'
  return `public, max-age=${maxAge}, must-revalidate`
}

// The path a URL names, or the status that refuses it. Undecodable and NUL are
// 400 — not a URL, so not a file anybody has — and a `..` SEGMENT is 403, since
// `a..b.css` is a legal name. Sierra's origins answer the same question in their
// own copy; the cases both are graded on are `test/fixtures/served-path-vectors.json`.
function sanitizePath(urlPath: string): string | 400 | 403 {
  let p: string
  try {
    p = decodeURIComponent(urlPath)
  } catch {
    return 400
  }

  // A NUL truncates at the syscall, so an extension read off the URL is not
  // the extension of the file opened.
  if (p.includes('\0')) return 400

  if (p.split(/[\\/]/).includes('..')) return 403

  p = p.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p

  return p
}
