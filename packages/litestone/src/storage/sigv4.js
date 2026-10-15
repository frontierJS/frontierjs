// storage/sigv4.js — the clock and the signing-key cache for @frontierjs/toolbelt/sigv4.
//
// The scheme is toolbelt's (`FJS-D892`); a kit there is pure, so the instant and
// the cache of derived keys are held here. The derived key is valid for a whole
// UTC day per (secret, region, service) -- without the cache every signed request
// re-ran the 4-step HMAC chain with a fresh importKey per step. The cache key
// holds a short prefix + length of the secret rather than the secret itself, so
// the full secret is not retained in a second place.

import { amzDate, deriveSigningKey, signRequest as sign, presignUrl as presign } from '@frontierjs/toolbelt/sigv4'

const _signingKeyCache = new Map()   // scope string → Promise<CryptoKey>
const SIGNING_KEY_CACHE_MAX = 16     // (secret, date, region, service) tuples

function signingKey(secret, now, region, service) {
  const dateStamp = amzDate(now).slice(0, 8)
  const cacheKey  = `${dateStamp}/${region}/${service}/${secret.length}/${secret.slice(0, 4)}/${secret.slice(-4)}`
  let hit = _signingKeyCache.get(cacheKey)
  if (!hit) {
    hit = deriveSigningKey(secret, dateStamp, region, service)
    // Evict oldest entries (Map preserves insertion order) — the cache only
    // ever holds a couple of live day-keys, this is just a leak guard.
    if (_signingKeyCache.size >= SIGNING_KEY_CACHE_MAX) {
      _signingKeyCache.delete(_signingKeyCache.keys().next().value)
    }
    _signingKeyCache.set(cacheKey, hit)
    hit.catch(() => _signingKeyCache.delete(cacheKey))   // don't cache failures
  }
  return hit
}

async function withClock(opts) {
  const { secretAccessKey, region = 'auto', service = 's3' } = opts
  const now = new Date()
  return { ...opts, now, signingKey: await signingKey(secretAccessKey, now, region, service) }
}

export async function signRequest(method, url, headers, body, opts) {
  return sign(method, url, headers, body, await withClock(opts))
}

export async function presignUrl(method, url, opts, expiresIn = 3600) {
  return presign(method, url, await withClock(opts), expiresIn)
}
