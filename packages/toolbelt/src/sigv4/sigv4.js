/*
 * sigv4.js — AWS Signature Version 4, over WebCrypto.
 *
 * Litestone's `File` columns sign S3 requests and `conduit-s3` signs the same
 * ones; conduit may not be imported by litestone, so the scheme sits below both
 * (`FJS-D892`). A wrong signature fails as `403 SignatureDoesNotMatch`, which
 * reads as bad credentials, so nothing in production points here.
 *
 * Pure like every kit: the instant is `opts.now`, a Date the caller reads from
 * its own clock, and the derived signing key is state a caller keeps. A caller
 * signing often derives the day's key once with `deriveSigningKey` and passes it
 * as `opts.signingKey` -- without it each call re-runs the four-step HMAC chain.
 * `test/fixtures/sigv4/` is AWS's own suite for every rule below.
 */

const enc = new TextEncoder()

const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' }

// SHA-256 of the empty string
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

async function importHmacKey(key) {
  const raw = typeof key === 'string' ? enc.encode(key) : key
  return crypto.subtle.importKey('raw', raw, HMAC_ALGO, false, ['sign'])
}

// Accepts a pre-imported CryptoKey (the signing key) or raw material
async function hmac(key, data) {
  const k = key instanceof CryptoKey ? key : await importHmacKey(key)
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256hex(data) {
  const buf = typeof data === 'string' ? enc.encode(data) : data
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
}

function instantOf(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('sigv4: opts.now must be a valid Date -- this kit reads no clock')
  }
  return now
}

/** A Date → SigV4's `YYYYMMDDTHHMMSSZ`. The first eight characters are the credential scope's date. */
export function amzDate(now) {
  return instantOf(now).toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
}

// ─── Signing key ──────────────────────────────────────────────────────────────

/**
 * The key one UTC day signs with for a (secret, region, service) -- an imported
 * CryptoKey, valid for the whole day, which is what a caller caches.
 */
export async function deriveSigningKey(secret, dateStamp, region, service) {
  const kDate    = await hmac(`AWS4${secret}`, dateStamp)
  const kRegion  = await hmac(kDate,   region)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')
  return importHmacKey(kSigning)
}

// ─── Canonical form ───────────────────────────────────────────────────────────
//
// A signature covers the request as the SERVER re-derives it: S3 decodes the
// path to the object key and encodes it again with AWS's UriEncode. So the
// canonical path is built from the decoded key, never from `URL.pathname`,
// which is already percent-encoded -- encoding that a second time signs
// `a%2520b` for a request that sent `a%20b`, and the vendor answers 403.

/** AWS UriEncode: every UTF-8 byte outside A-Za-z0-9-_.~ as %XX, uppercase. */
export function uriEncode(str) {
  let out = ''
  for (const byte of enc.encode(str)) {
    const c = String.fromCharCode(byte)
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

function decodeSegment(seg) {
  try { return decodeURIComponent(seg) } catch { return seg }   // a bare `%` is a literal
}

/** An already-encoded URL path → its canonical form. Slashes are kept, never collapsed. */
export function canonicalUri(pathname) {
  return pathname.split('/').map(seg => uriEncode(decodeSegment(seg))).join('/')
}

/** Query parameters → encoded, then sorted by name and value. */
export function canonicalQuery(params) {
  return [...params]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function canonicalHeaderValue(v) {
  return String(v).trim().replace(/\s+/g, ' ')
}

// ─── Sign a request ───────────────────────────────────────────────────────────

/**
 * The headers a request must carry to be accepted: `Authorization`, `x-amz-date`
 * and, for S3, `x-amz-content-sha256`. `opts`: `accessKeyId`, `secretAccessKey`,
 * `now`, and optionally `region` ('auto'), `service` ('s3'), `signingKey` and
 * `unsignedPayload` (S3: sign `UNSIGNED-PAYLOAD` rather than the body's hash).
 */
export async function signRequest(method, url, headers, body, opts) {
  const { accessKeyId, secretAccessKey, region = 'auto', service = 's3' } = opts
  const amz       = amzDate(opts.now)
  const dateStamp = amz.slice(0, 8)
  const urlObj    = new URL(url)
  const host      = urlObj.host

  // `opts.unsignedPayload` (S3 only) leaves the body out of the signature, so a
  // body too large to hold -- a Blob streamed from disk -- is never read to hash it.
  const bodyHash = opts.unsignedPayload && service === 's3' ? 'UNSIGNED-PAYLOAD'
    : body ? await sha256hex(typeof body === 'string' ? enc.encode(body) : body)
    : EMPTY_HASH

  // The payload hash as a signed header is S3's rule rather than SigV4's, and
  // AWS's own suite signs every other service without it.
  const canonHeaders = {
    host,
    'x-amz-date': amz,
    ...(service === 's3' ? { 'x-amz-content-sha256': bodyHash } : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), canonicalHeaderValue(v)])),
  }
  const sortedKeys    = Object.keys(canonHeaders).sort()
  const canonStr      = sortedKeys.map(k => `${k}:${canonHeaders[k]}`).join('\n') + '\n'
  const signedHeaders = sortedKeys.join(';')

  const canonRequest = [
    method.toUpperCase(), canonicalUri(urlObj.pathname), canonicalQuery(urlObj.searchParams),
    canonStr, signedHeaders, bodyHash,
  ].join('\n')

  const credScope = `${dateStamp}/${region}/${service}/aws4_request`
  const strToSign = ['AWS4-HMAC-SHA256', amz, credScope, await sha256hex(canonRequest)].join('\n')

  const sigKey = opts.signingKey ?? await deriveSigningKey(secretAccessKey, dateStamp, region, service)
  const sig    = toHex(await hmac(sigKey, strToSign))

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date':  amz,
    ...(service === 's3' ? { 'x-amz-content-sha256': bodyHash } : {}),
  }
}

// ─── Presigned URL ────────────────────────────────────────────────────────────

/** The URL with its signature in the query string, valid for `expiresIn` seconds from `opts.now`. */
export async function presignUrl(method, url, opts, expiresIn = 3600) {
  const { accessKeyId, secretAccessKey, region = 'auto', service = 's3' } = opts
  const amz       = amzDate(opts.now)
  const dateStamp = amz.slice(0, 8)
  const urlObj    = new URL(url)
  const host      = urlObj.host
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`

  urlObj.searchParams.set('X-Amz-Algorithm',     'AWS4-HMAC-SHA256')
  urlObj.searchParams.set('X-Amz-Credential',    `${accessKeyId}/${credScope}`)
  urlObj.searchParams.set('X-Amz-Date',          amz)
  urlObj.searchParams.set('X-Amz-Expires',       String(expiresIn))
  urlObj.searchParams.set('X-Amz-SignedHeaders', 'host')

  // S3 presigns an unsigned payload; every other service signs the empty body.
  const payload      = service === 's3' ? 'UNSIGNED-PAYLOAD' : EMPTY_HASH
  const canonQuery   = canonicalQuery(urlObj.searchParams)
  const canonRequest = [method.toUpperCase(), canonicalUri(urlObj.pathname), canonQuery, `host:${host}\n`, 'host', payload].join('\n')

  const strToSign = ['AWS4-HMAC-SHA256', amz, credScope, await sha256hex(canonRequest)].join('\n')
  const sigKey    = opts.signingKey ?? await deriveSigningKey(secretAccessKey, dateStamp, region, service)
  const sig       = toHex(await hmac(sigKey, strToSign))

  // Written from the canonical string rather than URLSearchParams, which sends a
  // space as `+` -- a character S3 reads back as itself, not as the space signed.
  urlObj.search = `?${canonQuery}&X-Amz-Signature=${sig}`
  return urlObj.toString()
}
