// storage/sigv4.js — minimal AWS Signature V4 using SubtleCrypto (Bun built-in)
// Handles PUT, DELETE, GET, and presigned URL generation for S3-compatible APIs.

const enc = new TextEncoder()

const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' }

async function importHmacKey(key) {
  const raw = typeof key === 'string' ? enc.encode(key) : key
  return crypto.subtle.importKey('raw', raw, HMAC_ALGO, false, ['sign'])
}

async function hmac(key, data) {
  // Accept a pre-imported CryptoKey (the cached signing key) or raw material
  const k = key instanceof CryptoKey ? key : await importHmacKey(key)
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

async function sha256hex(data) {
  const buf = typeof data === 'string' ? enc.encode(data) : data
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function isoDate(d = new Date()) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
}

// ─── Derive signing key ───────────────────────────────────────────────────────
// The derived key is valid for a whole UTC day per (secret, region, service),
// so cache it — AWS SDKs do the same. Without the cache every signed request
// re-ran the 4-step HMAC chain with a fresh importKey per step (~10 SubtleCrypto
// round trips per call). The cache stores an imported CryptoKey so the final
// per-request HMAC skips importKey too. Secrets are not stored in the cache
// key directly — a short prefix + length disambiguates without retaining the
// full secret in a second place.

const _signingKeyCache = new Map()   // scope string → Promise<CryptoKey>
const SIGNING_KEY_CACHE_MAX = 16     // (secret, date, region, service) tuples

async function deriveSigningKey(secret, dateStamp, region, service) {
  const kDate    = await hmac(`AWS4${secret}`, dateStamp)
  const kRegion  = await hmac(kDate,   region)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')
  return importHmacKey(kSigning)
}

function signingKey(secret, dateStamp, region, service) {
  const cacheKey = `${dateStamp}/${region}/${service}/${secret.length}/${secret.slice(0, 4)}/${secret.slice(-4)}`
  let hit = _signingKeyCache.get(cacheKey)
  if (!hit) {
    hit = deriveSigningKey(secret, dateStamp, region, service)
    // Evict oldest entries (Map preserves insertion order) — the cache only
    // ever holds a couple of live day-keys, this is just a leak guard.
    if (_signingKeyCache.size >= SIGNING_KEY_CACHE_MAX) {
      _signingKeyCache.delete(_signingKeyCache.keys().next().value)
    }
    _signingKeyCache.set(cacheKey, hit)
    // Don't cache failures
    hit.catch(() => _signingKeyCache.delete(cacheKey))
  }
  return hit
}

// ─── Canonical form ───────────────────────────────────────────────────────────
//
// A signature covers the request as the SERVER re-derives it: S3 decodes the
// path to the object key and encodes it again with AWS's UriEncode. So the
// canonical path is built from the decoded key, never from `URL.pathname`,
// which is already percent-encoded — encoding that a second time signs
// `a%2520b` for a request that sent `a%20b`, and the vendor answers 403
// SignatureDoesNotMatch, which reads as bad credentials.
// `test/fixtures/sigv4/` is AWS's own suite for every rule here.

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

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

export async function signRequest(method, url, headers, body, opts) {
  const { accessKeyId, secretAccessKey, region = 'auto', service = 's3' } = opts
  const now       = new Date()
  const amzDate   = isoDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const urlObj    = new URL(url)
  const host      = urlObj.host

  const bodyHash = body
    ? await sha256hex(typeof body === 'string' ? enc.encode(body) : body)
    : EMPTY_HASH

  // The payload hash as a signed header is S3's rule rather than SigV4's, and
  // AWS's own suite signs every other service without it.
  const canonHeaders = {
    host,
    'x-amz-date': amzDate,
    ...(service === 's3' ? { 'x-amz-content-sha256': bodyHash } : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), canonicalHeaderValue(v)])),
  }
  const sortedKeys    = Object.keys(canonHeaders).sort()
  const canonStr      = sortedKeys.map(k => `${k}:${canonHeaders[k]}`).join('\n') + '\n'
  const signedHeaders = sortedKeys.join(';')

  const canonUri     = canonicalUri(urlObj.pathname)
  const canonQuery   = canonicalQuery(urlObj.searchParams)
  const canonRequest = [method.toUpperCase(), canonUri, canonQuery, canonStr, signedHeaders, bodyHash].join('\n')

  // String to sign
  const credScope  = `${dateStamp}/${region}/${service}/aws4_request`
  const strToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, await sha256hex(canonRequest)].join('\n')

  // Signature
  const sigKey = await signingKey(secretAccessKey, dateStamp, region, service)
  const sig    = toHex(await hmac(sigKey, strToSign))

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date':  amzDate,
    ...(service === 's3' ? { 'x-amz-content-sha256': bodyHash } : {}),
  }
}

// ─── Presigned URL (GET) ──────────────────────────────────────────────────────

export async function presignUrl(method, url, opts, expiresIn = 3600) {
  const { accessKeyId, secretAccessKey, region = 'auto', service = 's3' } = opts
  const now       = new Date()
  const amzDate   = isoDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const urlObj    = new URL(url)
  const host      = urlObj.host
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`

  urlObj.searchParams.set('X-Amz-Algorithm',     'AWS4-HMAC-SHA256')
  urlObj.searchParams.set('X-Amz-Credential',    `${accessKeyId}/${credScope}`)
  urlObj.searchParams.set('X-Amz-Date',          amzDate)
  urlObj.searchParams.set('X-Amz-Expires',       String(expiresIn))
  urlObj.searchParams.set('X-Amz-SignedHeaders', 'host')

  // S3 presigns an unsigned payload; every other service signs the empty body.
  const payload      = service === 's3' ? 'UNSIGNED-PAYLOAD' : EMPTY_HASH
  const canonQuery   = canonicalQuery(urlObj.searchParams)
  const canonRequest = [method.toUpperCase(), canonicalUri(urlObj.pathname), canonQuery, `host:${host}\n`, 'host', payload].join('\n')

  const strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, await sha256hex(canonRequest)].join('\n')
  const sigKey    = await signingKey(secretAccessKey, dateStamp, region, service)
  const sig       = toHex(await hmac(sigKey, strToSign))

  // Written from the canonical string rather than URLSearchParams, which sends a
  // space as `+` — a character S3 reads back as itself, not as the space signed.
  urlObj.search = `?${canonQuery}&X-Amz-Signature=${sig}`
  return urlObj.toString()
}
