/*
 * bearer.js — what a bearer secret looks like when it is written down.
 *
 * A bearer token is a string whose HOLDER is the whole of the proof: a cart
 * token, a portal link, an API key, a recovery code. Nothing about it is
 * verifiable, so the only questions are how it is stored and how a presented
 * one is recognized — and both have a wrong answer that works.
 *
 * Storing the token itself is the wrong answer that works: every lookup
 * succeeds, every test passes, and a database anybody reads is a set of live
 * credentials. So what is stored is a keyed DIGEST, and the token is never
 * written anywhere but the email or the header that carries it.
 *
 * A digest rather than a password hash, deliberately. bcrypt and argon2 exist
 * because a person's password has perhaps 30 bits of entropy and must be made
 * expensive to guess; a minted token has 128 or more and cannot be guessed at
 * any cost. Per-request work is the thing this is on the hot path of — a guest
 * carrying a cart token pays it on every call — so a fast keyed digest is the
 * correct instrument, and the key is what stops an exfiltrated column from
 * being attacked offline at all.
 *
 * WHY THIS IS NOT `/signature`. That kit answers *what does a signed request
 * look like* — a protocol string two machines must build identically. This one
 * answers *what does a secret look like at rest*. They share an HMAC the way
 * two buildings share concrete.
 *
 * WHY NOT `/ids`. That kit MINTS — `generateCuid`, `mintId`, the generators
 * behind `@default(cuid())`. A token comes from there; what happens to it
 * afterwards is here.
 *
 * Zero dependencies and no ambient state: WebCrypto is a platform global in
 * node, bun and a browser, and the key is an argument. `node:crypto` is not
 * imported — it parses on a server and kills a browser bundle.
 */

const ENCODER = new TextEncoder()

/** Lower-case hex, the spelling every stored digest in this repo uses. */
function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', ENCODER.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, ENCODER.encode(message))))
}

/**
 * The digest a column holds for this secret.
 *
 * `purpose` is DOMAIN SEPARATION and it is required rather than optional. The
 * same token digested for two tables under one key produces one string, so a
 * portal link's digest would be a legal API key digest — a row from the table
 * with the weaker gate presented to the one with the stronger. Naming the
 * purpose makes the two digests unrelated, and requiring it means nobody
 * discovers the rule by being bitten by it.
 *
 * Throws on a missing key or an empty secret rather than digesting the empty
 * string: `fingerprint('')` has a perfectly good answer, and a column holding
 * it matches every caller who presents nothing.
 */
export async function fingerprint(secret, { key, purpose } = {}) {
  if (typeof secret !== 'string' || !secret)
    throw new TypeError('fingerprint: the secret must be a non-empty string.')
  if (typeof key !== 'string' || !key)
    throw new TypeError('fingerprint: `key` is the app secret this digest is keyed on, and there is no default.')
  if (typeof purpose !== 'string' || !purpose)
    throw new TypeError(
      'fingerprint: `purpose` names what this digest is FOR — a table, a column, an act. ' +
      'Without it one secret digests identically everywhere and a row from one table is a credential for another.')

  return hmac(key, `${purpose}\n${secret}`)
}

/**
 * Is the presented secret the one this digest was made from?
 *
 * Constant-time over the two digests, which matters only where the stored
 * digest was fetched by something OTHER than itself — a row found by its id,
 * an API key found by its prefix. A lookup keyed on the digest never reaches
 * here, and the two shapes are easy to mistake for each other, so the safe one
 * is what the kit offers.
 *
 * Answers false for anything malformed rather than throwing: a caller is asking
 * *is this the secret*, and a token of the wrong shape is a legitimate no. The
 * one exception is the key, which is a programming error either way.
 */
export async function matchesFingerprint(stored, presented, { key, purpose } = {}) {
  if (typeof key !== 'string' || !key)
    throw new TypeError('matchesFingerprint: `key` is the app secret this digest is keyed on, and there is no default.')
  if (typeof stored !== 'string' || !stored) return false
  if (typeof presented !== 'string' || !presented) return false

  let computed
  try { computed = await fingerprint(presented, { key, purpose }) }
  catch { return false }

  return timingSafeEqual(stored, computed)
}

/**
 * Compare two hex strings without leaking WHERE they differ.
 *
 * The length is not secret — every digest here is 64 hex characters — but an
 * early return on the first differing character is, so the loop runs over the
 * whole string and accumulates. A mismatched length answers false without
 * comparing, since there is nothing to learn from it.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false

  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
