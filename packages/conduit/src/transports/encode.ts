/**
 * conduit/transports/encode — what an outbound body becomes on the wire.
 *
 * One owner, and it has to be one, because the SAME string goes to `fetch` and
 * to the HMAC signer (`buildAuthHeaders` hashes the body). An encoder living in
 * a caller — or in a connector package — would sign bytes the transport did not
 * send, which is a signature that verifies against nothing and fails as *invalid
 * credential* (`FJS-D153`).
 *
 * Two encodings, because there are two kinds of API and no third has come up:
 *
 *   json  `application/json` — the default, and what this project's own
 *         services speak.
 *   form  `application/x-www-form-urlencoded` — Stripe, PayPal, Twilio and
 *         every OAuth token endpoint. Not an oddity: it is what most of the
 *         payment world still takes.
 *
 * ─── Why not `@frontierjs/toolbelt/query` ─────────────────────────────────
 *
 * `encodePairs` also emits bracket notation, and reusing it was the obvious
 * move and is wrong. That module is Invariant 10's grammar — a wire format
 * designed to round-trip back through `parseValue`, so it QUOTES a string that
 * looks like a number (`"5"`), writes `null` as the four letters, and marks an
 * array `k[]`. A provider reads all three literally: Stripe would store the
 * quotes, take `null` as a name, and reject `k[]` where it wants `k[0]`. Same
 * punctuation, different language.
 */

/** How a target's request bodies are encoded. */
export type BodyEncoding = 'json' | 'form'

export const CONTENT_TYPE: Record<BodyEncoding, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
}

// Depth and breadth caps, so a cyclic-ish or hostile structure cannot make the
// encoder run away. JSON.stringify throws on a cycle; this one would not.
const MAX_DEPTH = 8
const MAX_ITEMS = 512

// A key that would let a crafted payload reach an object prototype while the
// pairs are being built. Same list `@frontierjs/toolbelt/query` refuses.
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A structure → `application/x-www-form-urlencoded` pairs.
 *
 * Nested objects are `a[b]=`, arrays are INDEXED — `a[0][price]=` — rather than
 * `a[]=`. Indexed because `a[]` cannot express two fields of the same item: two
 * `a[][price]` pairs are indistinguishable from one item with two prices, and a
 * list of objects is the ordinary shape here (line items, metadata).
 *
 * `undefined` is dropped, because absent and *not stated* are the same thing on
 * a form. `null` is sent as an EMPTY VALUE rather than dropped, since form
 * encoding has no null and empty is what a provider reads as *clear this* —
 * dropping it would silently turn a clear into a leave-alone.
 *
 * A `Date` goes out as ISO-8601. A provider wanting unix seconds is a provider
 * whose connector converts; guessing here would make the wrong one silent.
 */
export function formPairs(body: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (body === null || body === undefined) return out
  if (typeof body !== 'object') {
    throw new TypeError(
      `form encoding needs an object body, got ${typeof body}. A pre-encoded ` +
      `string is not a way past this: it would be encoded again.`
    )
  }
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) walk(out, k, v, 1)
  return out
}

function walk(out: Array<[string, string]>, prefix: string, value: unknown, depth: number): void {
  if (value === undefined) return
  if (depth > MAX_DEPTH || out.length >= MAX_ITEMS) return

  if (Array.isArray(value)) {
    value.slice(0, MAX_ITEMS).forEach((item, i) => walk(out, `${prefix}[${i}]`, item, depth + 1))
    return
  }

  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) { out.push([prefix, value.toISOString()]); return }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN.has(k)) continue
      walk(out, `${prefix}[${k}]`, v, depth + 1)
    }
    return
  }

  // null lands here and becomes ''. Booleans go out as `true`/`false`, which is
  // what every form-encoded API in this class reads them as.
  out.push([prefix, value === null ? '' : String(value)])
}

/** The encoded body, or `undefined` where there is nothing to send. */
export function encodeBody(body: unknown, encoding: BodyEncoding): string {
  if (encoding === 'form') {
    return formPairs(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
  }
  return JSON.stringify(body)
}
