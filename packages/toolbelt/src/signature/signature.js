/*
 * signature.js — what a signed machine-to-machine request looks like.
 *
 * Three places in this repo sign an outbound HTTP request with an HMAC, and
 * until now each carried its own idea of what gets signed: conduit's transport
 * (method + path + timestamp + nonce + body hash), junction's webhook delivery
 * (`timestamp.body`), and — in the shape this file exists to prevent — whatever
 * the receiving side would have invented.
 *
 * Nothing verified anything. Conduit signs what it sends to an Outpost and
 * basecamp's three Outpost endpoints took no credential at all, with a comment
 * claiming the transport had handled it (`FJS-349`): an unauthenticated POST
 * moved a server to `online` and pointed every later fleet command at an
 * address the caller chose. A verifier is not a second implementation of the
 * signer, and the way to be sure of that is for both to read one function.
 *
 * Zero dependencies AND no ambient state: WebCrypto is a platform global in
 * node, bun and a browser, but a clock and a uuid are not pure, and purity is
 * the whole of the argument that any package here may import this one
 * (`FJS-D26`). So `timestamp` and `nonce` are arguments to signing and `now` is
 * an argument to verifying — a caller passes what its own environment knows.
 * CI enforces this: `Date.now()` in a file under `packages/toolbelt` fails the
 * build rather than any consumer's suite.
 *
 * WHAT IS SIGNED, and why each part is in it:
 *
 *   method   a captured signature cannot be replayed as a different verb
 *   path     …nor against a different endpoint on the same host
 *   timestamp  the receiver rejects anything outside its freshness window
 *   nonce      …and anything it has already seen inside that window
 *   sha256(body)  a bodyless request signs the hash of the empty string, so
 *                 every request is signed the same way
 *
 * The receiver must recompute this exact string. That is the whole contract,
 * and it is why the parts are joined with a newline rather than concatenated:
 * `('a','bc')` and `('ab','c')` must not produce one string.
 */

const ENCODER = new TextEncoder()

/** Lower-case hex, the spelling every header in this repo uses. */
function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(text ?? ''))
  return toHex(new Uint8Array(digest))
}

/**
 * The string both sides run the HMAC over.
 *
 * @param {{method: string, path: string, timestamp: string|number, nonce: string, bodyHash: string}} parts
 * @returns {string}
 */
export function canonicalRequest({ method, path, timestamp, nonce, bodyHash }) {
  for (const [name, value] of Object.entries({ method, path, timestamp, nonce, bodyHash })) {
    if (value === undefined || value === null || value === '')
      throw new TypeError(`canonicalRequest: ${name} is required`)
    if (String(value).includes('\n'))
      throw new TypeError(`canonicalRequest: ${name} must not contain a newline — it is the separator`)
  }
  return [String(method).toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n')
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(message))))
}

/**
 * Sign a request. Answers the three headers a receiver needs, under the given
 * prefix (`X-Hub` by default, which is what conduit has always sent).
 *
 * `timestamp` and `nonce` are REQUIRED, not defaulted. Defaulting them would
 * mean reading a clock and generating a uuid in a package whose whole licence to
 * be imported by litestone and mesa is that it does neither — and it also makes
 * every caller state the two values a receiver will grade it on, which is the
 * pair most likely to be wrong.
 *
 * @param {{
 *   secret: string, method: string, path: string, body?: string,
 *   prefix?: string, timestamp: string|number, nonce: string
 * }} opts
 * @returns {Promise<Record<string,string>>}
 */
export async function signRequest({ secret, method, path, body = '', prefix = 'X-Hub', timestamp, nonce }) {
  if (!secret)    throw new TypeError('signRequest: secret is required')
  if (!timestamp) throw new TypeError('signRequest: timestamp is required — seconds, from the caller\'s clock')
  if (!nonce)     throw new TypeError('signRequest: nonce is required — one per request, from the caller')

  const ts  = String(timestamp)
  const sig = await hmacHex(secret, canonicalRequest({
    method, path, timestamp: ts, nonce, bodyHash: await sha256Hex(body),
  }))
  return {
    [`${prefix}-Signature`]: `sha256=${sig}`,
    [`${prefix}-Timestamp`]: ts,
    [`${prefix}-Nonce`]:     nonce,
  }
}

/**
 * Verify one. Answers `{ ok: true }` or `{ ok: false, reason }` rather than a
 * boolean, because a receiver has to be able to say WHICH check failed in a log
 * — a clock 40 seconds out and a wrong secret are the same 401 to a caller and
 * completely different problems to whoever is fixing it.
 *
 * `seenNonce` is the replay half and it is the CALLER's, because storing it is
 * I/O and this package does none: hand in a function that answers whether this
 * nonce has been used inside the window (and records it). Omit it and the
 * signature is still bound to a freshness window — weaker, and it is the
 * caller's decision rather than a silent default.
 *
 * The comparison is constant-time: a fast `!==` leaks how much of a forged
 * signature was right, one byte at a time.
 *
 * @param {{
 *   secret: string|undefined, method: string, path: string, body?: string,
 *   headers: Record<string,string>|Headers, prefix?: string,
 *   toleranceSeconds?: number, now: number,
 *   seenNonce?: ((nonce: string) => boolean|Promise<boolean>)|null
 * }} opts
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyRequest({
  secret, method, path, body = '', headers, prefix = 'X-Hub', toleranceSeconds = 300,
  now, seenNonce = null,
}) {
  if (!secret) return { ok: false, reason: 'no secret is configured on this side' }
  // Same rule as signing: the clock belongs to the caller. A default here would
  // be a clock read in the substrate package, and a receiver that forgot to
  // pass one would silently grade every timestamp against zero.
  if (!Number.isFinite(now)) throw new TypeError('verifyRequest: now is required — seconds, from the receiver\'s clock')

  const get = name => {
    const key = `${prefix}-${name}`.toLowerCase()
    if (typeof headers?.get === 'function') return headers.get(key) ?? undefined
    // A plain object: header names arrive in whatever case the sender used.
    for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === key) return v
    return undefined
  }

  const signature = get('Signature')
  const timestamp = get('Timestamp')
  const nonce     = get('Nonce')
  if (!signature || !timestamp || !nonce) return { ok: false, reason: 'signature headers are missing' }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'timestamp is not a number' }
  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds)
    return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }

  const expected = await hmacHex(secret, canonicalRequest({
    method, path, timestamp, nonce, bodyHash: await sha256Hex(body),
  }))
  if (!timingSafeEqual(signature.replace(/^sha256=/, ''), expected))
    return { ok: false, reason: 'signature does not match' }

  // Last, and only once the signature is known good: a replay check that runs
  // before verification is a free way to fill somebody's nonce store.
  if (seenNonce && await seenNonce(nonce)) return { ok: false, reason: 'nonce has already been used' }

  return { ok: true }
}

/** Constant-time compare of two hex strings of equal expected length. */
function timingSafeEqual(a, b) {
  const x = String(a), y = String(b)
  // Length is not a secret — the digest length is fixed and public — but the
  // loop below needs a fixed bound, so an unequal length fails after a full
  // pass rather than immediately.
  let diff = x.length === y.length ? 0 : 1
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) ^ y.charCodeAt(i)) || 0
  return diff === 0
}
