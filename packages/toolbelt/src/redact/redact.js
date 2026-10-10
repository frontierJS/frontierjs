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
// Compared after normalizing: lower-cased, with `-` and `_` removed, so one
// entry covers `x-api-key`, `X_API_KEY` and `xApiKey`. Held as the normalized
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

/** The normalized name set. Exported so a caller can see the floor it is getting. */
export const SECRET_KEY_NAMES = Object.freeze(new Set(RAW_SECRET_KEYS.map(norm)))

// A compound is judged by its LAST word, so `currentPassword` is a password and
// `passwordResetAt`, `tokenCount` are not. `key` is too common to stand alone
// (`sortKey`, `cacheKey`) and counts beside a word that makes it a secret one.
const SECRET_LAST_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'jwt', 'bearer',
  'credentials', 'otp', 'totp',
])
const SECRET_KEY_QUALIFIERS = new Set(['api', 'secret', 'access', 'private', 'signing', 'encryption', 'auth', 'client'])
const SECRET_HASHED = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token'])

const words = (name) => String(name)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .toLowerCase().split(/[\s_-]+/).filter(Boolean)

/** Is this key name a credential by convention? */
export function isSecretKey(name) {
  if (SECRET_KEY_NAMES.has(norm(name))) return true
  const parts = words(name)
  const last = parts[parts.length - 1]
  const before = parts[parts.length - 2]
  if (SECRET_LAST_WORDS.has(last)) return true
  if (last === 'key') return SECRET_KEY_QUALIFIERS.has(before)
  return (last === 'hash' || last === 'digest') && SECRET_HASHED.has(before)
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
  'password', 'passwd', 'pwd', 'pass', 'passphrase', 'secret', 'token', 'key', 'credential',
  'credentials', 'apikey', 'auth', 'signature', 'cert', 'privatekey', 'otp', 'totp',
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
 * and nothing else: junction's error sanitizer passes the SCHEMA's protected
 * set, the logger passes `isSecretKey`. One walker, two predicates — a second
 * walker is how the cycle guard comes to exist in one of them and not the other.
 *
 * **A cycle is answered rather than followed.** An object that points at itself
 * is not worth a stack overflow inside a log call. Only an ANCESTOR is a cycle:
 * a value reached twice by two paths is walked twice, or a response body that
 * names one object in two places reads `[circular]` the second time.
 *
 * **A non-plain object is returned untouched.** A `Date`, a `URL`, an `Error`, a
 * class instance: walking one rebuilds it as a bare object and destroys it, and
 * a logger that turned every Date into `{}` would be worse than the leak.
 */
export function redactBy(value, isSecret, seen = new WeakSet()) {
  return walk(value, isSecret, true, seen)
}

/**
 * `redactBy`, with a matching key DROPPED rather than replaced.
 *
 * For a body a program reads rather than a person: a caller-scoped read of a
 * row omits a protected column, and a `'[redacted]'` string where a typed
 * client expects a `Date` or a number is a second shape for the same row.
 */
export function omitBy(value, isSecret, seen = new WeakSet()) {
  return walk(value, isSecret, false, seen)
}

// `out[k] = v` with k `__proto__` reaches Object.prototype's setter, so a
// parsed body's own `__proto__` member became the copy's prototype and its
// subtree vanished from the output.
function put(out, k, v) {
  Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true })
}

// An explicit stack, not recursion: junction runs this over every response of
// a model with a protected field, and a stored Json value nested deeper than
// the call stack made every later read of that model a 500 (FJS-2183).
function walk(value, isSecret, replace, ancestors) {
  const stack = []
  const enter = (v) => {
    if (!v || typeof v !== 'object') return v
    if (ancestors.has(v)) return '[circular]'
    const isArray = Array.isArray(v)
    const proto = Object.getPrototypeOf(v)
    if (!isArray && proto !== Object.prototype && proto !== null) return v
    ancestors.add(v)
    const out = isArray ? new Array(v.length) : {}
    stack.push({ src: v, out, keys: isArray ? null : Object.keys(v), i: 0 })
    return out
  }

  const result = enter(value)
  try {
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const { src, out, keys } = frame
      if (frame.i === (keys ? keys.length : src.length)) {
        ancestors.delete(src)
        stack.pop()
        continue
      }
      const k = keys ? keys[frame.i] : frame.i
      frame.i++
      if (!keys) { if (k in src) out[k] = enter(src[k]) }
      else if (!isSecret(k)) put(out, k, enter(src[k]))
      else if (replace)      put(out, k, REDACTED)
    }
  } finally {
    for (const frame of stack) ancestors.delete(frame.src)
  }
  return result
}

/** `redactBy` with the credential name list. The common case. */
export function redactSecrets(value) {
  return redactBy(value, isSecretKey)
}

// ─── a URL is a credential carrier ────────────────────────────────────────────

// Schemes whose userinfo with no colon is a credential rather than a name:
// `https://ghp_…@github.com` is a token, `ssh://git@github.com` is a login.
const TOKEN_USERINFO_SCHEMES = new Set(['http', 'https', 'ws', 'wss'])
const USER_CHAR = /[A-Za-z0-9._~%+-]/
const SCHEME_CHAR = /[A-Za-z0-9+.-]/

/** The last `@` in `[from, to)` that leaves a host, or -1. */
function lastAt(text, from, to) {
  for (let j = to - 1; j >= from; j--) {
    if (text[j] !== '@') continue
    const next = text[j + 1]
    if (next === undefined || next === '@' || /\s/.test(next)) continue
    return j
  }
  return -1
}

// `user:password` where the password reaches past a `/` or a space. A port
// (`host:8080/feed/@alice`) is the same shape, so a digit run that a `/` or a
// space ends is a port; so is a colon followed by a space.
function passwordShaped(text, from, at) {
  const colon = text.indexOf(':', from)
  if (colon === -1 || colon >= at) return false
  for (let i = from; i < colon; i++) if (!USER_CHAR.test(text[i])) return false
  const password = text.slice(colon + 1, at)
  return password !== '' && !/^\s/.test(password) && !/^\d+[\s/]/.test(password)
}

/**
 * The userinfo of every `scheme://` authority, found with the scheme as the
 * anchor. The authority proper ends at the first `/`; failing an `@` there, a
 * password holding a `/` reaches to the last `@` in the whitespace token, and
 * one holding a space to the last `@` before the line or the next scheme ends.
 * Each step is bounded by the text it scans past, so a long string of `://`
 * stays linear.
 */
function redactAuthorities(text) {
  let out = ''
  let copied = 0
  let search = 0
  let token = { end: -1, at: -1 }
  for (;;) {
    const sep = text.indexOf('://', search)
    if (sep === -1) break
    const from = sep + 3
    search = from
    let s = sep
    while (s > copied && SCHEME_CHAR.test(text[s - 1])) s--
    const scheme = text.slice(s, sep).toLowerCase()

    let segEnd = from
    while (segEnd < text.length && text[segEnd] !== '/' && !/\s/.test(text[segEnd])) segEnd++
    let at = lastAt(text, from, segEnd)

    if (at === -1 && text[segEnd] === '/') {
      if (from >= token.end) {
        let end = segEnd
        while (end < text.length && !/\s/.test(text[end])) end++
        token = { end, at: lastAt(text, from, end) }
      }
      if (token.at >= from && passwordShaped(text, from, token.at)) at = token.at
    }
    if (at === -1) {
      let end = text.indexOf('://', from)
      if (end === -1) end = text.length
      for (let i = from; i < end; i++) if (text[i] === '\n') { end = i; break }
      const spaced = lastAt(text, from, end)
      if (spaced !== -1 && passwordShaped(text, from, spaced)) at = spaced
    }
    if (at === -1 || at === from) continue

    const colon = text.indexOf(':', from)
    let head
    if (colon !== -1 && colon < at) head = `${text.slice(from, colon)}:${REDACTED}`
    else if (TOKEN_USERINFO_SCHEMES.has(scheme)) head = REDACTED
    else continue
    let end = at + 1
    while (end < text.length && text[end] !== '@' && !/\s/.test(text[end])) end++
    out += `${text.slice(copied, from)}${head}@${text.slice(at + 1, end)}`
    copied = search = end
  }
  return copied === 0 ? text : out + text.slice(copied)
}

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
 *
 * **A `://` scheme is read first, by `redactAuthorities`**, because it is what
 * licenses two shapes the scheme-less rule cannot take safely: a password
 * holding a `/` or a space (a base64 one has `/`), and a userinfo that is a
 * token alone (`https://ghp_…@github.com`).
 */
export function redactUrl(text) {
  if (typeof text !== 'string') return text
  text = redactAuthorities(text)
  // This is `([A-Za-z0-9._~%+-]*):([^\s/]+)@([^\s@]+)` done in one pass. As a
  // regex it retried every start position across the rest of its token when no
  // `@` followed, so `'a:'.repeat(40000)` took seconds (`FJS-2189`) and the
  // callers hold error text and request-supplied addresses.
  //
  // The password may not span a `/`, which is what keeps the SCHEME from
  // matching as the user: in `postgres://admin:s@h` the only place a password
  // can start without crossing a slash is after `admin:`. So a match lives in
  // one token (a run of non-space, non-slash), its password ends at the token's
  // LAST `@` that has a host character after it, and its start is the first
  // colon's user-character run. The user may be EMPTY, because
  // `redis://:pass@host` is the documented shape for a server with a password
  // and no user.
  const tokens = /[^\s/]+/g
  const userChar = /[A-Za-z0-9._~%+-]/
  const hostEnd = /[^\s@]*/y
  let out = ''
  let copied = 0
  let at = 0
  for (;;) {
    tokens.lastIndex = at
    const token = tokens.exec(text)
    if (!token) break
    const from = token.index
    const to = from + token[0].length
    at = to
    const colon = text.indexOf(':', from)
    if (colon === -1 || colon >= to) continue
    let last = -1
    for (let j = to - 1; j > colon + 1; j--) {
      if (text[j] !== '@') continue
      const next = text[j + 1]
      if (next === undefined || next === '@' || /\s/.test(next)) continue
      last = j
      break
    }
    if (last === -1) continue
    let start = colon
    while (start > from && userChar.test(text[start - 1])) start--
    hostEnd.lastIndex = last + 1
    hostEnd.test(text)
    const end = hostEnd.lastIndex
    out += `${text.slice(copied, start)}${text.slice(start, colon)}:${REDACTED}@${text.slice(last + 1, end)}`
    copied = at = end
  }
  return copied === 0 ? text : out + text.slice(copied)
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
