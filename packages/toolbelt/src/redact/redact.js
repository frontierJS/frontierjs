/*
 * redact.js — what must never reach a log line, and the one walk that removes it.
 *
 * Two different questions look alike and only one of them had an owner.
 *
 *   Is this column protected by the SCHEMA? — `@encrypted`, `@guarded`,
 *   `@secret`. Answered by `db.$protectedFields(accessor)`, enforced as
 *   Invariant 7, and not this file's business.
 *
 *   Is this key a CREDENTIAL, whatever the schema says? — `authorization`,
 *   `cookie`, `password`. These are on no row and in no schema: they are
 *   transport and configuration, so nothing derived from a model can answer for
 *   them. That is this file.
 *
 * It exists because the second question had three askers and no answer.
 * Junction's logger printed `authorization`, `cookie` and `password` verbatim in
 * its JSON line; `defineEnv` printed the offending value on a type failure, so a
 * malformed `DATABASE_URL` put its password on stderr at boot; and conduit
 * carries a request URL with userinfo into `raw` on a connection failure. Three
 * packages, one question, and a name list written three times would be three
 * lists that disagree the first time somebody adds a header.
 *
 * ─── What it does NOT decide ───────────────────────────────────────────────
 *
 * A name list is a floor and never a proof. It cannot see a secret stored under
 * `note`, and it must not be read as *everything else is safe to log*. What it
 * buys is that the names everybody uses stop leaking by default, which is the
 * difference between a mistake and a habit.
 */

// ─── the names ────────────────────────────────────────────────────────────────
//
// Compared after normalising: lower-cased, with `-` and `_` removed, so one
// entry covers `x-api-key`, `X_API_KEY` and `xApiKey`. Held as the normalised
// form so the comparison is a single Set lookup rather than a walk.

const RAW_SECRET_KEYS = [
  // HTTP credentials
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
  // Bearer material
  'token', 'access-token', 'refresh-token', 'id-token', 'session-token',
  'jwt', 'bearer',
  // Shared secrets
  'password', 'passwd', 'pwd', 'secret', 'client-secret', 'api-key', 'apikey',
  'private-key', 'signing-key', 'encryption-key', 'webhook-secret',
  // Session and identity
  'session-id', 'sessionid', 'sid', 'credentials',
  // Payment
  'card-number', 'cvv', 'cvc',
]

const norm = (name) => String(name).toLowerCase().replace(/[-_]/g, '')

/** The normalised name set. Exported so a caller can see the floor it is getting. */
export const SECRET_KEY_NAMES = Object.freeze(new Set(RAW_SECRET_KEYS.map(norm)))

/** Is this key name a credential by convention? */
export function isSecretKey(name) {
  return SECRET_KEY_NAMES.has(norm(name))
}

/**
 * Is this ENVIRONMENT VARIABLE name a credential?
 *
 * A separate rule from `isSecretKey`, and deliberately so: an env var is
 * `SCREAMING_SNAKE` and compound by convention — `STRIPE_SECRET_KEY`,
 * `DATABASE_PASSWORD`, `GITHUB_TOKEN` — so the answer is per SEGMENT, where an
 * object key is whole. Folding the two together would make either this one
 * blind to a prefix or that one match `passwordResetAt`, which is a timestamp
 * and belongs in the trail that exists to show it.
 *
 * A segment is enough on its own: nobody names an ordinary variable `_TOKEN`.
 */
const SECRET_SEGMENTS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'key', 'credential',
  'credentials', 'apikey', 'auth', 'signature', 'cert', 'privatekey',
])

export function isSecretEnvName(name) {
  const parts = String(name).toLowerCase().split(/[-_]+/)
  // `KEY` alone is too broad — a `SORT_KEY` or a `CACHE_KEY` is not a secret —
  // so it counts only beside something that makes it one.
  const hasKey = parts.includes('key')
  const qualified = parts.some(p => ['api', 'secret', 'private', 'signing', 'encryption', 'access'].includes(p))
  if (hasKey && qualified) return true
  return parts.some(p => p !== 'key' && SECRET_SEGMENTS.has(p))
}

/** What a redacted value reads as. One string, so a grep finds every one. */
export const REDACTED = '[redacted]'

// ─── the walk ─────────────────────────────────────────────────────────────────

/**
 * A copy of `value` with every key `isSecret` answers true for replaced.
 *
 * The predicate is a parameter because the two questions above share this walk
 * and nothing else: junction's error sanitiser passes the SCHEMA's protected
 * set, the logger passes `isSecretKey`. One walker, two predicates — a second
 * walker is how the cycle guard comes to exist in one of them and not the other.
 *
 * **A cycle is answered rather than followed.** An object that points at itself
 * is not worth a stack overflow inside a log call.
 *
 * **A non-plain object is returned untouched.** A `Date`, a `URL`, an `Error`, a
 * class instance: walking one rebuilds it as a bare object and destroys it, and
 * a logger that turned every Date into `{}` would be worse than the leak.
 */
export function redactBy(value, isSecret, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map(v => redactBy(v, isSecret, seen))

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecret(k) ? REDACTED : redactBy(v, isSecret, seen)
  }
  return out
}

/** `redactBy` with the credential name list. The common case. */
export function redactSecrets(value) {
  return redactBy(value, isSecretKey)
}

// ─── a URL is a credential carrier ────────────────────────────────────────────

/**
 * A URL with its userinfo removed, for a message that has to quote one.
 *
 * `postgres://admin:s3cr3t@db/prod` is the shape every connection string takes,
 * and the moment one fails to parse or a connection to it is refused, the
 * natural error message quotes it whole. Both happened: `defineEnv`'s type
 * failure printed it to stderr at boot, and conduit put Bun's error — whose
 * `path` is the full URL — into `raw`.
 *
 * **Text, not a `URL`**, because the callers that need this are exactly the ones
 * holding a string that did NOT parse. So the userinfo is found by pattern, and
 * a string with no `://` is returned unchanged rather than guessed at.
 *
 * The host is deliberately KEPT: *which* database refused is the whole content
 * of the message, and a redaction that removes the answer along with the secret
 * gets turned off by the first person who has to debug a connection.
 *
 * **It does not require a well-formed scheme, and that is the point.** The
 * caller reaching for this is usually holding a value that FAILED to parse —
 * `defineEnv` quoting a bad `DATABASE_URL` is the case it was written for — and
 * a rule anchored on `://` misses `postgres//admin:p@ss@db`, which is a typo
 * away from every real one. So the shape matched is the credential itself:
 * a user token, a colon, a password, an `@`, a host.
 *
 * The password is greedy up to the LAST `@` that still leaves a host, because a
 * password may legally contain an encoded one and the host may not.
 */
export function redactUrl(text) {
  if (typeof text !== 'string') return text
  return text.replace(
    // The password may not span a `/`, which is what keeps the SCHEME from
    // matching as the user: in `postgres://admin:s@h` the only place a password
    // can start without crossing a slash is after `admin:`. The user may be
    // EMPTY, because `redis://:pass@host` is the documented shape for a server
    // with a password and no user.
    /([A-Za-z0-9._~%+-]*):([^\s/]+)@([^\s@]+)/g,
    (_m, user, _pass, host) => `${user}:${REDACTED}@${host}`
  )
}

/**
 * A value safe to quote back in an error message about it.
 *
 * A string is scanned for a URL; anything else is walked. Used where a message
 * wants to say *got "…"* and cannot know whether the value it is quoting is a
 * connection string, a token, or a genuinely harmless typo.
 */
export function redactValue(value) {
  if (typeof value === 'string') return redactUrl(value)
  return redactSecrets(value)
}
