// transport/static.ts
// Static file serving — range requests, etag, gzip, cache headers.
// All the HTTP muscle from Total.js, rewritten for Bun.file().

import { join, extname } from 'node:path'

// ─── Module-level constants ────────────────────────────────────────────────
// Compiled once, never recreated per request.

const COMPRESSIBLE: Record<string, 1> = {
  'text/plain': 1, 'text/html': 1, 'text/css': 1,
  'text/javascript': 1, 'text/xml': 1,
  'application/javascript': 1, 'application/json': 1,
  'application/xml': 1, 'image/svg+xml': 1,
  'application/x-javascript': 1
}

const CACHEABLE: Record<string, 1> = {
  js: 1, css: 1, png: 1, jpg: 1, jpeg: 1, gif: 1, ico: 1, svg: 1,
  woff: 1, woff2: 1, ttf: 1, eot: 1, otf: 1, webp: 1,
  mp4: 1, mp3: 1, webm: 1, pdf: 1
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  css:  'text/css',
  js:   'text/javascript',
  mjs:  'text/javascript',
  json: 'application/json',
  xml:  'application/xml',
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  ico:  'image/x-icon',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2:'font/woff2',
  ttf:  'font/ttf',
  eot:  'application/vnd.ms-fontobject',
  otf:  'font/otf',
  mp4:  'video/mp4',
  webm: 'video/webm',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  pdf:  'application/pdf',
  txt:  'text/plain',
  md:   'text/markdown',
  map:  'application/json',
  wasm: 'application/wasm',
}

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
const _gzipCache = new Map<string, Uint8Array>()
let   _gzipCacheBytes = 0

function cachedGzip(key: string, raw: Uint8Array): Uint8Array {
  const hit = _gzipCache.get(key)
  if (hit) return hit

  const gzipped = Bun.gzipSync(raw)

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
}

export async function serveStatic(
  req:        Request,
  urlPath:    string,
  opts:       StaticOptions
): Promise<Response | null> {

  const {
    root,
    maxAge    = MAX_AGE,
    etag      = '',
    compress  = true,
    index     = 'index.html'
  } = opts

  // Normalize and sanitize path — prevent directory traversal
  const safe = sanitizePath(urlPath)
  if (!safe) return new Response('Forbidden', { status: 403 })

  let filePath = join(root, safe)

  // Try index file for directory requests
  if (filePath.endsWith('/') || !extname(filePath))
    filePath = join(filePath, index)

  // Resolve file via Bun — throws if not found
  const file = Bun.file(filePath)
  const exists = await file.exists()
  if (!exists) return null  // let router handle 404

  const ext      = extname(filePath).slice(1).toLowerCase()
  const mimeType = CONTENT_TYPES[ext] ?? 'application/octet-stream'
  const size     = file.size
  const mtime    = new Date(file.lastModified)
  const mtimeStr = mtime.toUTCString()

  // ── ETag + Last-Modified cache check ────────────────────────────────
  const fileEtag = `${ETAG_PREFIX}${etag}${file.lastModified}"` 

  const ifNoneMatch    = req.headers.get('if-none-match')
  const ifModifiedSince = req.headers.get('if-modified-since')

  if (
    (ifNoneMatch && ifNoneMatch === fileEtag) ||
    (!ifNoneMatch && ifModifiedSince && new Date(ifModifiedSince) >= mtime)
  ) {
    return new Response(null, {
      status: 304,
      headers: {
        'etag':          fileEtag,
        'last-modified': mtimeStr,
        'cache-control': buildCacheControl(ext, maxAge)
      }
    })
  }

  // ── Range request (byte serving) ─────────────────────────────────────
  const rangeHeader = req.headers.get('range')
  if (rangeHeader) {
    return serveRange(file, rangeHeader, mimeType, size, fileEtag, mtimeStr)
  }

  // ── Regular response ──────────────────────────────────────────────────
  const headers: Record<string, string> = {
    'content-type':  mimeType,
    'etag':          fileEtag,
    'last-modified': mtimeStr,
    'cache-control': buildCacheControl(ext, maxAge),
    'accept-ranges': 'bytes'
  }

  // ── Gzip compression ──────────────────────────────────────────────────
  const acceptEncoding = req.headers.get('accept-encoding') ?? ''
  const canCompress    = compress && acceptEncoding.includes('gzip') && COMPRESSIBLE[mimeType]

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

// ─── Range response ───────────────────────────────────────────────────────

async function serveRange(
  file:     ReturnType<typeof Bun.file>,
  range:    string,
  mimeType: string,
  size:     number,
  etag:     string,
  mtime:    string
): Promise<Response> {

  const match = RANGE_RE.exec(range)
  if (!match) {
    return new Response('Invalid Range', { status: 416 })
  }

  const startStr = match[1]
  const endStr   = match[2]

  let start = startStr ? parseInt(startStr, 10) : size - parseInt(endStr, 10)
  let end   = endStr   ? parseInt(endStr, 10)   : size - 1

  // Clamp
  start = Math.max(0, Math.min(start, size - 1))
  end   = Math.max(start, Math.min(end, size - 1))

  const chunkSize = end - start + 1

  // Bun.file supports slice
  const chunk = file.slice(start, end + 1)

  return new Response(chunk, {
    status: 206,
    headers: {
      'content-type':  mimeType,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(chunkSize),
      'accept-ranges': 'bytes',
      'etag':          etag,
      'last-modified': mtime
    }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildCacheControl(ext: string, maxAge: number): string {
  if (CACHEABLE[ext])
    return `public, max-age=${maxAge}, must-revalidate`
  return NOCACHE
}

// Prevent path traversal — returns null if suspicious
function sanitizePath(urlPath: string): string | null {
  // Decode once
  let p: string
  try {
    p = decodeURIComponent(urlPath)
  } catch {
    return null
  }

  // Block null bytes
  if (p.includes('\0')) return null

  // Block traversal
  if (p.includes('..')) return null

  // Normalize slashes
  p = p.replace(/\\/g, '/')

  // Must start with /
  if (!p.startsWith('/')) p = '/' + p

  return p
}
