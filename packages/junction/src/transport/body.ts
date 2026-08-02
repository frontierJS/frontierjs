// transport/body.ts
// Request body parsing — JSON, urlencoded, multipart.
// All work is done once per request, results cached on raw request.
// Compiled constants at module level — never recreated per request.

import type { UploadedFile } from './types.ts'

// ─── Module-level constants ────────────────────────────────────────────────

const MAX_BODY_SIZE   = 256 * 1024        // 256 KB default
const MAX_FILE_SIZE   = 50  * 1024 * 1024 // 50 MB default
const BOUNDARY_PREFIX = 'boundary='
const CRLF            = '\r\n'
const CRLF_CRLF       = '\r\n\r\n'

const CT_JSON        = 'application/json'
const CT_TEXT_JSON   = 'text/json'
const CT_URLENCODED  = 'application/x-www-form-urlencoded'
const CT_MULTIPART   = 'multipart/form-data'
const CT_TEXT        = 'text/plain'
const CT_XML_APP     = 'application/xml'
const CT_XML_TEXT    = 'text/xml'

// Compiled once at module load — never recreated per request.
// TextDecoder construction allocates an ICU conversion context;
// creating one per request is measurably expensive at high throughput.
const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()

// Pre-compiled multipart header param patterns.
// extractHeaderParam() was calling new RegExp() on every part of every
// multipart upload — two compilations per field, more for multi-file forms.
const RE_CONTENT_DISPOSITION_NAME     = /name="([^"]*)"/i
const RE_CONTENT_DISPOSITION_FILENAME = /filename="([^"]*)"/i

// ─── Body parse result ────────────────────────────────────────────────────

export type BodyType = 'json' | 'urlencoded' | 'multipart' | 'xml' | 'text' | 'binary' | 'empty'

export interface ParsedBody {
  type:  BodyType
  data:  unknown
  files: UploadedFile[]
  size:  number
}

// ─── Main entry point ─────────────────────────────────────────────────────

export async function parseBody(
  req:     Request,
  maxSize: number = MAX_BODY_SIZE
): Promise<ParsedBody> {

  const method = req.method.toUpperCase()

  // GET/HEAD/OPTIONS never have a body
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { type: 'empty', data: null, files: [], size: 0 }
  }

  const contentType = (req.headers.get('content-type') || '').toLowerCase()
  const idx         = contentType.indexOf(';')
  const baseType    = idx === -1 ? contentType : contentType.slice(0, idx).trim()

  // No content-type → empty (can't know how to parse)
  if (!contentType) {
    return { type: 'empty', data: null, files: [], size: 0 }
  }

  // Enforce the size limit BEFORE buffering. A declared Content-Length over
  // the limit is rejected without reading a single body byte — otherwise a
  // client could push an arbitrarily large body fully into memory before
  // the 413 fires. (The post-read check below still covers chunked bodies
  // that arrive without a Content-Length.)
  const declaredLength = parseInt(req.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > maxSize) {
    throw new Error(`Request body exceeds ${maxSize} bytes`)
  }

  // Read body as ArrayBuffer — single allocation
  let buffer: ArrayBuffer
  try {
    buffer = await req.arrayBuffer()
  } catch {
    return { type: 'empty', data: null, files: [], size: 0 }
  }

  const size = buffer.byteLength

  // Enforce size limit (chunked / undeclared-length bodies)
  if (size > maxSize) {
    throw new Error(`Request body exceeds ${maxSize} bytes`)
  }

  // ── JSON ────────────────────────────────────────────────────────────
  if (baseType === CT_JSON || baseType === CT_TEXT_JSON) {
    try {
      const text = DECODER.decode(buffer)
      const data = JSON.parse(text)
      return { type: 'json', data, files: [], size }
    } catch {
      return { type: 'json', data: null, files: [], size }
    }
  }

  // ── URL-encoded ─────────────────────────────────────────────────────
  if (baseType === CT_URLENCODED) {
    const text   = DECODER.decode(buffer)
    const data   = parseUrlEncoded(text)
    return { type: 'urlencoded', data, files: [], size }
  }

  // ── Multipart ────────────────────────────────────────────────────────
  if (baseType === CT_MULTIPART) {
    const boundaryIdx = contentType.indexOf(BOUNDARY_PREFIX)
    if (boundaryIdx === -1)
      return { type: 'multipart', data: {}, files: [], size }

    const boundary = contentType.slice(boundaryIdx + BOUNDARY_PREFIX.length).trim()
    const { fields, files } = parseMultipart(buffer, boundary, MAX_FILE_SIZE)
    return { type: 'multipart', data: fields, files, size }
  }

  // ── XML ──────────────────────────────────────────────────────────────
  if (baseType === CT_XML_APP || baseType === CT_XML_TEXT) {
    const text = DECODER.decode(buffer)
    return { type: 'xml', data: text, files: [], size }
  }

  // ── Plain text ────────────────────────────────────────────────────────
  if (baseType.startsWith('text/')) {
    const text = DECODER.decode(buffer)
    return { type: 'text', data: text, files: [], size }
  }

  // ── Binary fallback ───────────────────────────────────────────────────
  return { type: 'binary', data: buffer, files: [], size }
}

// ─── URL-encoded parser ──────────────────────────────────────────────────

function parseUrlEncoded(text: string): Record<string, string | string[]> {
  return parsePairs(text, true)
}

// ─── Query string parser ─────────────────────────────────────────────────

// ─── Shared pair-parsing core ─────────────────────────────────────────────
// One implementation behind BOTH parseQuery (query strings, last-wins) and
// parseUrlEncoded (form bodies, repeated keys accumulate into arrays) —
// they were previously two near-identical loops that had already diverged.

// Malformed percent-encoding ('%zz') used to throw out of decodeURIComponent
// and surface as an uncaught 500; degrade to the literal text instead.
function decodePart(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s }
}

function parsePairs(
  qs:         string,
  accumulate: boolean
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  if (!qs) return result

  for (const pair of qs.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) {
      if (!accumulate && pair) result[decodePart(pair)] = ''   // bare key → '' (query semantics)
      continue
    }
    const key   = decodePart(pair.slice(0, eqIdx))
    const value = decodePart(pair.slice(eqIdx + 1))
    if (!accumulate) {
      result[key] = value                    // last value wins
      continue
    }
    const existing = result[key]
    if (existing === undefined)          result[key] = value
    else if (Array.isArray(existing))    existing.push(value)
    else                                 result[key] = [existing, value]
  }

  return result
}

export function parseQuery(search: string): Record<string, string> {
  if (!search) return {}
  const qs = search.startsWith('?') ? search.slice(1) : search
  return parsePairs(qs, false) as Record<string, string>
}

// ─── Cookie parser ────────────────────────────────────────────────────────

export function parseCookies(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!cookieHeader) return result

  for (const pair of cookieHeader.split(';')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const key   = pair.slice(0, eqIdx).trim()
    const value = pair.slice(eqIdx + 1).trim()
    // NOTE: no '+ → space' here — '+' is a literal in cookie values.
    // Malformed %-sequences degrade to the raw text instead of throwing.
    if (key) {
      try { result[key] = decodeURIComponent(value) } catch { result[key] = value }
    }
  }

  return result
}

// ─── IP extraction ────────────────────────────────────────────────────────

export function extractIP(req: Request, remoteAddr?: string, trustProxy = false): string {
  // The socket address is the only value the CLIENT cannot forge.
  // x-forwarded-for / x-real-ip are attacker-settable request headers, so
  // they are only consulted when the operator has explicitly declared that
  // a trusted reverse proxy sits in front of the app (trustProxy: true) —
  // otherwise a client could spoof its way past IP-keyed rate limiting and
  // DDoS protection with a random header per request.
  if (trustProxy) {
    const forwarded = req.headers.get('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0].trim()

    const realIP = req.headers.get('x-real-ip')
    if (realIP) return realIP.trim()
  }

  if (remoteAddr) return remoteAddr

  // No socket address available (tests / mock server): fall back to the
  // proxy headers as a best effort, then localhost.
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()

  const realIP = req.headers.get('x-real-ip')
  if (realIP) return realIP.trim()

  return '127.0.0.1'
}

// ─── Multipart parser ────────────────────────────────────────────────────
// Minimal multipart/form-data parser — no external deps.
// Handles text fields and file uploads.

interface MultipartResult {
  fields: Record<string, string>
  files:  UploadedFile[]
}

function parseMultipart(
  buffer:      ArrayBuffer,
  boundary:    string,
  maxFileSize: number
): MultipartResult {

  const result: MultipartResult = { fields: {}, files: [] }
  const bytes = new Uint8Array(buffer)

  // Build boundary markers as Uint8Array for scanning
  const boundaryBytes  = ENCODER.encode('--' + boundary)
  const finalBytes     = ENCODER.encode('--' + boundary + '--')
  const CRLF_CRLF_BYTES = ENCODER.encode(CRLF_CRLF)

  let pos = 0

  // Skip preamble — find first boundary
  pos = indexOf(bytes, boundaryBytes, pos)
  if (pos === -1) return result

  while (pos !== -1) {
    pos += boundaryBytes.length

    // Check for final boundary
    if (bytes[pos] === 0x2D && bytes[pos + 1] === 0x2D) break

    // Skip CRLF after boundary
    if (bytes[pos] === 0x0D && bytes[pos + 1] === 0x0A) pos += 2

    // Find end of headers (CRLFCRLF)
    const headersEnd = indexOf(bytes, CRLF_CRLF_BYTES, pos)
    if (headersEnd === -1) break

    const headerText = DECODER.decode(bytes.slice(pos, headersEnd))
    pos = headersEnd + 4  // skip CRLFCRLF

    // Find next boundary
    const nextBoundary = indexOf(bytes, boundaryBytes, pos)
    if (nextBoundary === -1) break

    // Content is between pos and nextBoundary - 2 (strip trailing CRLF)
    const contentEnd = nextBoundary - 2  // strip CRLF before boundary
    const content    = bytes.slice(pos, contentEnd)

    // Parse part headers
    const partHeaders = parsePartHeaders(headerText)
    const disposition = partHeaders['content-disposition'] ?? ''
    const name        = extractHeaderParam(disposition, 'name')
    const filename    = extractHeaderParam(disposition, 'filename')
    const mimeType    = partHeaders['content-type'] ?? 'application/octet-stream'

    if (filename) {
      // File upload
      if (content.byteLength <= maxFileSize) {
        result.files.push({
          name:     name ?? 'file',
          filename: filename,
          type:     mimeType,
          size:     content.byteLength,
          data:     content.buffer
        })
      }
    } else if (name) {
      // Text field
      result.fields[name] = DECODER.decode(content)
    }

    pos = nextBoundary
  }

  return result
}

function parsePartHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split(CRLF)) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key   = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()
    headers[key] = value
  }
  return headers
}

function extractHeaderParam(header: string, param: string): string | null {
  const re    = param === 'filename' ? RE_CONTENT_DISPOSITION_FILENAME : RE_CONTENT_DISPOSITION_NAME
  const match = re.exec(header)
  return match ? match[1] : null
}

// Fast Uint8Array substring search (Boyer-Moore-like simple variant)
function indexOf(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  const hLen = haystack.length
  const nLen = needle.length
  if (nLen === 0) return start
  if (nLen > hLen) return -1

  outer:
  for (let i = start; i <= hLen - nLen; i++) {
    for (let j = 0; j < nLen; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}
