// storage/sigv4.js — minimal AWS Signature V4 using SubtleCrypto (Bun built-in)
// Handles PUT, DELETE, GET, and presigned URL generation for S3-compatible APIs.

const enc = new TextEncoder()

async function hmac(key, data) {
  const k = typeof key === 'string'
    ? await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : await crypto.subtle.importKey('raw', key,             { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
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

async function signingKey(secret, dateStamp, region, service) {
  const kDate    = await hmac(`AWS4${secret}`, dateStamp)
  const kRegion  = await hmac(kDate,   region)
  const kService = await hmac(kRegion, service)
  return       await hmac(kService, 'aws4_request')
}

// ─── Sign a request ───────────────────────────────────────────────────────────

export async function signRequest(method, url, headers, body, opts) {
  const { accessKeyId, secretAccessKey, region = 'auto', service = 's3' } = opts
  const now       = new Date()
  const amzDate   = isoDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const urlObj    = new URL(url)
  const host      = urlObj.host

  // Content hash
  const bodyHash = body
    ? await sha256hex(typeof body === 'string' ? enc.encode(body) : body)
    : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'  // empty

  // Canonical headers — must be sorted and include host + x-amz-date
  const canonHeaders = {
    host,
    'x-amz-date':            amzDate,
    'x-amz-content-sha256':  bodyHash,
    ...Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(), v])),
  }
  const sortedKeys   = Object.keys(canonHeaders).sort()
  const canonStr     = sortedKeys.map(k => `${k}:${canonHeaders[k]}`).join('\n') + '\n'
  const signedHeaders = sortedKeys.join(';')

  // Canonical request
  const canonUri     = encodeURIComponent(urlObj.pathname).replace(/%2F/g, '/')
  const canonQuery   = urlObj.searchParams.toString()
  const canonRequest = [method.toUpperCase(), canonUri, canonQuery, canonStr, signedHeaders, bodyHash].join('\n')

  // String to sign
  const credScope  = `${dateStamp}/${region}/${service}/aws4_request`
  const strToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, await sha256hex(canonRequest)].join('\n')

  // Signature
  const sigKey = await signingKey(secretAccessKey, dateStamp, region, service)
  const sig    = toHex(await hmac(sigKey, strToSign))

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date':           amzDate,
    'x-amz-content-sha256': bodyHash,
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

  // Add query params for presigned URL
  urlObj.searchParams.set('X-Amz-Algorithm',     'AWS4-HMAC-SHA256')
  urlObj.searchParams.set('X-Amz-Credential',    `${accessKeyId}/${credScope}`)
  urlObj.searchParams.set('X-Amz-Date',          amzDate)
  urlObj.searchParams.set('X-Amz-Expires',       String(expiresIn))
  urlObj.searchParams.set('X-Amz-SignedHeaders', 'host')
  // AWS spec requires query params to be alphabetically sorted in the canonical string
  urlObj.searchParams.sort()

  const canonUri     = encodeURIComponent(urlObj.pathname).replace(/%2F/g, '/')
  const canonQuery   = urlObj.searchParams.toString()
  const canonRequest = [method, canonUri, canonQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')

  const strToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, await sha256hex(canonRequest)].join('\n')
  const sigKey    = await signingKey(secretAccessKey, dateStamp, region, service)
  const sig       = toHex(await hmac(sigKey, strToSign))

  urlObj.searchParams.set('X-Amz-Signature', sig)
  return urlObj.toString()
}
