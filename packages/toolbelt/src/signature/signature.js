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
 *   query    …nor against the same endpoint with different parameters. It was
 *            absent until `FJS-678`: a signed `GET /transfer?to=alice` verified
 *            unchanged against `?to=mallory`, and a receiver that wanted to
 *            include the query could not, because the signer had excluded it
 *   service method  the `X-Service-Method` header, which junction dispatches on:
 *            `POST /servers/7` is `heartbeat` or `delete` by that header alone, so
 *            a signature that left it out verified unchanged under any other
 *            method (`FJS-1858`). Always a line, empty when the request carries
 *            none, for the reason the query is
 *   timestamp  the receiver rejects anything outside its freshness window
 *   nonce      …and anything it has already seen inside that window
 *   sha256(body)  a bodyless request signs the hash of the empty string, so
 *                 every request is signed the same way
 *
 * The version rides in the signature VALUE (`v1-sha256=…`), and it is there
 * before it is needed. A signer one version behind produces a perfectly
 * well-formed digest of a string this side no longer builds, so with no marker
 * the answer is *signature does not match* — the same sentence a wrong secret
 * produces, and the wrong half to spend a fleet-wide outage on. Nothing outside
 * this repo signs anything yet, so v1 is the only version that has ever been
 * emitted; the machinery is what a second one will cost, which is a prefix and
 * a branch rather than a scheme.
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

/**
 * Hash a body. Takes a string or the raw bytes.
 *
 * Bytes are accepted because a signed request may carry a binary body — an
 * upload, a protobuf — and there is no lossless way to make one a string first:
 * `String(bytes)` and `JSON.stringify(bytes)` each hash something that was never
 * sent, so the far side computes a different digest and the request is refused
 * as an invalid credential. Passed through untouched; only a string is encoded.
 */
export async function sha256Hex(body) {
  const input = (body instanceof Uint8Array || body instanceof ArrayBuffer)
    ? body
    : ENCODER.encode(body ?? '')
  const digest = await crypto.subtle.digest('SHA-256', input)
  return toHex(new Uint8Array(digest))
}

/** The scheme label the signature value carries. Bumped when the canonical string changes. */
export const SIGNATURE_VERSION = 1

const PREFIX = 'v1-sha256='

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone, which RFC 3986 reserves — two
 * sides using different encoders produce different strings for the same
 * parameter and every request 401s.
 */
function rfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * The query, as both sides must spell it: pairs sorted by key then value,
 * percent-encoded, joined with `&`. Empty string when there is none.
 *
 * Sorted because nothing preserves parameter order across a proxy, a client
 * library or a redirect, and a signature bound to the order the sender happened
 * to use is a signature that fails intermittently. Repeated keys are kept —
 * `?tag=a&tag=b` is two values, and folding them into one loses the second.
 *
 * Takes a search string (with or without the leading `?`), a URLSearchParams,
 * an array of pairs, or a plain object, because a signer holds a URL and a
 * verifier holds whatever its transport parsed.
 */
export function canonicalQuery(query) {
  if (query === undefined || query === null || query === '') return ''

  let pairs
  if (typeof query === 'string') {
    pairs = [...new URLSearchParams(query.replace(/^\?/, ''))]
  } else if (Array.isArray(query)) {
    // Before the `.entries()` branch: an Array has one too, and it answers
    // index/value pairs, so a list of pairs would canonicalize as `0=to,alice`.
    pairs = query.map(([k, v]) => [k, v])
  } else if (typeof query.entries === 'function') {
    pairs = [...query.entries()]
  } else {
    // A plain object cannot hold a repeated key, but it can hold an array
    // under one — which is how a repeated key survives a parse.
    pairs = []
    for (const [k, v] of Object.entries(query)) {
      for (const item of Array.isArray(v) ? v : [v]) {
        if (item === undefined || item === null) continue
        pairs.push([k, item])
      }
    }
  }

  return pairs
    .map(([k, v]) => [rfc3986(k), rfc3986(v ?? '')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

/**
 * Split a path that carries its own query.
 *
 * A verifier reads the raw request URL and hands over whatever it holds; a
 * `path` with a `?` in it and no `query` beside it means the caller has both in
 * one string. Signing the whole thing as the path would work and would disagree
 * with a caller who passed them apart, so they are separated here — one owner.
 */
function splitTarget(path, query) {
  const raw = String(path ?? '')
  const cut = raw.indexOf('?')
  if (query !== undefined && query !== null) return { path: cut === -1 ? raw : raw.slice(0, cut), query }
  if (cut === -1) return { path: raw, query: '' }
  return { path: raw.slice(0, cut), query: raw.slice(cut + 1) }
}

/**
 * The string both sides run the HMAC over.
 *
 * `query` is the one part allowed to be empty — a request with no parameters
 * signs an empty line rather than omitting one, so the number of lines is
 * fixed and a query cannot be smuggled into the path.
 *
 * @param {{method: string, path: string, query?: string|object, serviceMethod?: string, timestamp: string|number, nonce: string, bodyHash: string}} parts
 * @returns {string}
 */
export function canonicalRequest({ method, path, query, serviceMethod, timestamp, nonce, bodyHash }) {
  const target = splitTarget(path, query)

  for (const [name, value] of Object.entries({ method, path: target.path, timestamp, nonce, bodyHash })) {
    if (value === undefined || value === null || value === '')
      throw new TypeError(`canonicalRequest: ${name} is required`)
    if (String(value).includes('\n'))
      throw new TypeError(`canonicalRequest: ${name} must not contain a newline — it is the separator`)
  }

  const canonical = canonicalQuery(target.query)
  if (canonical.includes('\n'))
    throw new TypeError('canonicalRequest: query must not contain a newline — it is the separator')

  const dispatch = String(serviceMethod ?? '').trim()
  if (dispatch.includes('\n'))
    throw new TypeError('canonicalRequest: serviceMethod must not contain a newline — it is the separator')

  return [
    String(method).toUpperCase(), target.path, canonical, dispatch, String(timestamp), nonce, bodyHash,
  ].join('\n')
}

/*
 * Seconds since the epoch, not milliseconds — and the difference is CHECKED
 * rather than documented.
 *
 * Both units are a finite number, so nothing could tell them apart, and
 * `Date.now()` is the reflex every JS caller has. A millisecond timestamp
 * signs and verifies perfectly against a millisecond `now`, with the tolerance
 * then meaning 300ms instead of 300s — so a webhook a third of a second old is
 * refused as clock skew, reported as `3600000s out` for a request one hour old.
 *
 * Every unit mismatch fails closed, which is why this needs naming rather than
 * leaving: the first repair anyone reaches for is widening the tolerance, and a
 * caller in seconds who sets 300000 to make a millisecond scheme work has bought
 * a three-and-a-half day replay window with nothing saying so.
 *
 * 1e11 separates them from 1973 to the year 5138 — seconds passes it in 5138,
 * milliseconds passed it in March 1973 — so no realistic value is ambiguous.
 */
const MS_SHAPED = 1e11

function refuseMilliseconds(label, value) {
  if (Number(value) > MS_SHAPED)
    return `${label} looks like milliseconds (${value}). This scheme signs SECONDS — divide by 1000, e.g. Math.floor(Date.now() / 1000).`
  return null
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(message))))
}

/**
 * Sign a request. Answers the three headers a receiver needs, under the given
 * prefix (`X-Fjs` by default — the framework's own scheme, and the same
 * abbreviation junction's `x-fjs-build` header already uses).
 *
 * `timestamp` and `nonce` are REQUIRED, not defaulted. Defaulting them would
 * mean reading a clock and generating a uuid in a package whose whole license to
 * be imported by litestone and mesa is that it does neither — and it also makes
 * every caller state the two values a receiver will grade it on, which is the
 * pair most likely to be wrong.
 *
 * @param {{
 *   secret: string, method: string, path: string, query?: string|object,
 *   serviceMethod?: string, body?: string|Uint8Array, prefix?: string, timestamp: string|number, nonce: string
 * }} opts
 * @returns {Promise<Record<string,string>>}
 */
export async function signRequest({ secret, method, path, query, serviceMethod, body = '', prefix = 'X-Fjs', timestamp, nonce }) {
  if (!secret)    throw new TypeError('signRequest: secret is required')
  if (!timestamp) throw new TypeError('signRequest: timestamp is required — seconds, from the caller\'s clock')
  if (!nonce)     throw new TypeError('signRequest: nonce is required — one per request, from the caller')

  const wrongUnit = refuseMilliseconds('timestamp', timestamp)
  if (wrongUnit) throw new TypeError(`signRequest: ${wrongUnit}`)

  const ts  = String(timestamp)
  const sig = await hmacHex(secret, canonicalRequest({
    method, path, query, serviceMethod, timestamp: ts, nonce, bodyHash: await sha256Hex(body),
  }))
  return {
    [`${prefix}-Signature`]: `${PREFIX}${sig}`,
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
 * nonce has been used (and records it). It must remember a nonce for TWICE
 * `toleranceSeconds`: a timestamp accepted at the limit ahead of this clock
 * stays fresh for another full tolerance, so a memory of one tolerance lets it
 * replay (FJS-1833). Omit it and the
 * signature is still bound to a freshness window — weaker, and it is the
 * caller's decision rather than a silent default.
 *
 * The comparison is constant-time: a fast `!==` leaks how much of a forged
 * signature was right, one byte at a time.
 *
 * @param {{
 *   secret: string|undefined, method: string, path: string, query?: string|object,
 *   body?: string|Uint8Array,
 *   headers: Record<string,string>|Headers, prefix?: string,
 *   toleranceSeconds?: number, now: number,
 *   seenNonce?: ((nonce: string) => boolean|Promise<boolean>)|null
 * }} opts
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyRequest({
  secret, method, path, query, body = '', headers, prefix = 'X-Fjs', toleranceSeconds = 300,
  now, seenNonce = null,
}) {
  if (!secret) return { ok: false, reason: 'no secret is configured on this side' }
  // Same rule as signing: the clock belongs to the caller. A default here would
  // be a clock read in the substrate package, and a receiver that forgot to
  // pass one would silently grade every timestamp against zero.
  if (!Number.isFinite(now)) throw new TypeError('verifyRequest: now is required — seconds, from the receiver\'s clock')

  const get = name => headerValue(headers, `${prefix}-${name}`)

  const signature = get('Signature')
  const timestamp = get('Timestamp')
  const nonce     = get('Nonce')
  if (!signature || !timestamp || !nonce) return { ok: false, reason: 'signature headers are missing' }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'timestamp is not a number' }

  // The caller's own clock first: a receiver passing `Date.now()` refuses every
  // legitimate request, and naming that is the difference between a five-minute
  // fix and an outage spent on the signer.
  const ourUnit = refuseMilliseconds('now', now)
  if (ourUnit) throw new TypeError(`verifyRequest: ${ourUnit}`)
  // The sender's is an ANSWER rather than a throw — it is remote input, and a
  // receiver must not be crashed by what a caller put in a header.
  const theirUnit = refuseMilliseconds('timestamp', seconds)
  if (theirUnit) return { ok: false, reason: theirUnit }

  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds)
    return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }

  // Version before digest. A signer on another version produces a well-formed
  // digest of a string this side does not build, so without this the answer is
  // `signature does not match` — the same sentence a wrong secret gives, which
  // is the wrong half to go looking at while a fleet 401s every call.
  if (!signature.startsWith(PREFIX))
    return { ok: false, reason: `signature is not v${SIGNATURE_VERSION}, which is the only version this side understands` }

  // Read off the request rather than passed in: the receiver's job is to check
  // the header it is about to dispatch on, and a parameter is a way to forget.
  const serviceMethod = headerValue(headers, 'x-service-method')
  const expected = await hmacHex(secret, canonicalRequest({
    method, path, query, serviceMethod, timestamp, nonce, bodyHash: await sha256Hex(body),
  }))
  if (!timingSafeEqual(signature.slice(PREFIX.length), expected))
    return { ok: false, reason: 'signature does not match' }

  // Last, and only once the signature is known good: a replay check that runs
  // before verification is a free way to fill somebody's nonce store.
  if (seenNonce && await seenNonce(nonce)) return { ok: false, reason: 'nonce has already been used' }

  return { ok: true }
}

/** One header off a Headers or a plain object, whatever case the sender used. */
function headerValue(headers, name) {
  const key = name.toLowerCase()
  if (typeof headers?.get === 'function') return headers.get(key) ?? undefined
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === key) return v
  return undefined
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

/*
 * A TOKEN — the other thing this file signs.
 *
 * `signRequest` authenticates an HTTP request, and a token that has to live in
 * an e-mail address is a different object: `support+<token>@acme.com` was
 * hand-rolled in a stressor because nothing here fit (`FJS-1941`). The address
 * forces the whole shape.
 *
 *   - A local part is at most 64 octets (RFC 5321 § 4.5.3.1.1). `support+`, a
 *     ULID (26) and a full HMAC-SHA256 in base64url (43) is 78, so the MAC is
 *     cut to 80 bits (16 characters) and the token names ONE id: two ULIDs do
 *     not fit beside any MAC.
 *   - A receiving server may keep or fold a local part's case (§ 2.4). A
 *     base64url MAC would then verify nowhere, so everything is lower-case
 *     Crockford base32, which a ULID already is. Reading is case-insensitive.
 *   - The MAC covers `purpose:id`, so a token minted for a reply address does
 *     not verify as an unsubscribe link under the same secret.
 *   - A ULID carries the instant it was minted, so `ttlSeconds` costs no bits
 *     and no lookup: the id's own time is the expiry.
 *
 * `now` is the caller's, in seconds, for the reason it is in `verifyRequest`.
 */

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'
const TOKEN_MAC_CHARS = 16
const ULID_LENGTH = 26

function base32(bytes) {
  let out = '', bits = 0, value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

async function tokenMac(secret, purpose, id, macChars) {
  const key = await crypto.subtle.importKey(
    'raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(`${purpose}:${id}`)))
  return base32(digest).slice(0, macChars)
}

/** The instant a ULID was minted, in seconds; NaN when it is not one. */
function ulidSeconds(id) {
  if (id.length !== ULID_LENGTH) return Number.NaN
  let ms = 0
  for (const c of id.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(c)
  return ms / 1000
}

/**
 * Mint the token for one id: the id, lower-cased, then a truncated MAC over
 * `purpose:id`. `purpose` and `secret` are required for the reason `fingerprint`
 * requires them. `macChars` defaults to 16 (80 bits) — the most that fits
 * beside a ULID in a plus-address.
 *
 * @param {{ id: string, secret: string, purpose: string, macChars?: number }} opts
 * @returns {Promise<string>}
 */
export async function mintToken({ id, secret, purpose, macChars = TOKEN_MAC_CHARS }) {
  if (!secret)  throw new TypeError('mintToken: secret is required')
  if (!purpose) throw new TypeError('mintToken: purpose is required — what this token is FOR, so one secret does not mint the same token in two places')
  if (!id)      throw new TypeError('mintToken: id is required')
  const lower = String(id).toLowerCase()
  if (![...lower].every(c => CROCKFORD.includes(c)))
    throw new TypeError(`mintToken: id '${id}' is not Crockford base32 — a token has to survive a server folding its case, and only that alphabet does`)
  return lower + await tokenMac(secret, purpose, lower, macChars)
}

/**
 * Read a token back. Answers `{ ok: true, id }` (lower-case, as minted) or
 * `{ ok: false, reason }` with `reason` one of `malformed` (cannot be a token),
 * `forged` (the MAC does not match) or `expired` (older than `ttlSeconds` by
 * the id's ULID time). Forged is graded before expired, so an old token with a
 * wrong MAC is not reported as merely old.
 *
 * `ttlSeconds` needs `now`, and an id that is not a ULID cannot carry a time:
 * it reads as `malformed` rather than as the epoch.
 *
 * @param {string} token
 * @param {{ secret: string, purpose: string, macChars?: number, now?: number, ttlSeconds?: number }} opts
 * @returns {Promise<{ ok: true, id: string } | { ok: false, reason: 'malformed'|'forged'|'expired' }>}
 */
export async function readToken(token, { secret, purpose, macChars = TOKEN_MAC_CHARS, now, ttlSeconds } = {}) {
  if (!secret)  throw new TypeError('readToken: secret is required')
  if (!purpose) throw new TypeError('readToken: purpose is required')
  if (ttlSeconds != null) {
    if (!Number.isFinite(now)) throw new TypeError('readToken: now is required with ttlSeconds — seconds, from the caller\'s clock')
    const wrongUnit = refuseMilliseconds('now', now)
    if (wrongUnit) throw new TypeError(`readToken: ${wrongUnit}`)
  }

  const t = String(token ?? '').toLowerCase()
  if (t.length <= macChars || ![...t].every(c => CROCKFORD.includes(c))) return { ok: false, reason: 'malformed' }
  const id = t.slice(0, t.length - macChars)
  if (ttlSeconds != null && Number.isNaN(ulidSeconds(id))) return { ok: false, reason: 'malformed' }

  if (!timingSafeEqual(t.slice(id.length), await tokenMac(secret, purpose, id, macChars)))
    return { ok: false, reason: 'forged' }
  if (ttlSeconds != null && now - ulidSeconds(id) > ttlSeconds) return { ok: false, reason: 'expired' }
  return { ok: true, id }
}
