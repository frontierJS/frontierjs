/*
 * redact.spec.js
 *
 * The kit answers *is this key a credential* for three packages that each had
 * the question and no answer. What follows is written against the two ways a
 * redactor is wrong, because both are silent:
 *
 *   IT MISSES     — a name spelled differently from the list. Every name row is
 *                   therefore asked in all four spellings the ecosystem uses,
 *                   since `X-API-Key`, `x_api_key` and `apiKey` are one header.
 *
 *   IT DESTROYS   — a redactor that walks a Date, a URL or an Error rebuilds it
 *                   as a bare object, and a logger that turns every timestamp
 *                   into `{}` gets switched off. Every removal row here has a
 *                   PRESERVATION row beside it.
 */

import { SECRET_KEY_NAMES, REDACTED, isSecretKey, isSecretEnvName, redactBy, redactSecrets, redactUrl, redactValue }
  from '../../src/redact/redact.js'

// ─── the names ────────────────────────────────────────────────────────────────

test('redact: one entry covers every spelling of a header', function () {
  for (const spelling of ['x-api-key', 'X-API-KEY', 'x_api_key', 'xApiKey', 'XApiKey'])
    assert.equal(isSecretKey(spelling), true, spelling)

  for (const spelling of ['authorization', 'Authorization', 'AUTHORIZATION'])
    assert.equal(isSecretKey(spelling), true, spelling)

  // The negative control: a name that merely CONTAINS one is not one. Matching
  // on substring is how `passwordResetRequestedAt` — a timestamp — becomes
  // unreadable in the trail that exists to show it.
  for (const ordinary of ['passwordResetAt', 'tokenCount', 'secretary', 'cookies', 'id', 'name'])
    assert.equal(isSecretKey(ordinary), false, ordinary)
})

test('redact: the set is normalised, so no entry can be unreachable', function () {
  // An entry written with a capital or an underscore would never match, because
  // the lookup normalises the QUERY. This asserts the stored form.
  for (const name of SECRET_KEY_NAMES) assert.equal(name, name.toLowerCase().replace(/[-_]/g, ''))
})

// ─── the walk ─────────────────────────────────────────────────────────────────

test('redact: nested, and inside an array', function () {
  const out = redactSecrets({
    ok: 1,
    headers: { Authorization: 'Bearer x', accept: 'json' },
    items: [{ password: 'p', label: 'first' }],
  })
  assert.equal(out.ok, 1)
  assert.equal(out.headers.Authorization, REDACTED)
  assert.equal(out.headers.accept, 'json')      // the pair: its sibling survives
  assert.equal(out.items[0].password, REDACTED)
  assert.equal(out.items[0].label, 'first')
})

test('redact: the input is not mutated', function () {
  const input = { password: 'hunter2' }
  redactSecrets(input)
  assert.equal(input.password, 'hunter2')
})

test('redact: a cycle is answered, not followed', function () {
  const a = { token: 't' }
  a.self = a
  const out = redactSecrets(a)
  assert.equal(out.token, REDACTED)
  assert.equal(out.self, '[circular]')
})

test('redact: a non-plain object is returned WHOLE', function () {
  // The destruction half. Walking one of these rebuilds it as `{}`.
  const d = new Date(0)
  const e = new Error('boom')
  const u = new URL('https://example.com/x')
  const m = new Map([['password', 'p']])
  const out = redactSecrets({ d, e, u, m, password: 'p' })

  assert.equal(out.d, d)
  assert.equal(out.e, e)
  assert.equal(out.u, u)
  assert.equal(out.m, m)
  assert.equal(out.password, REDACTED)   // …while the plain sibling still goes
})

test('redact: redactBy takes the predicate, so the schema can ask too', function () {
  // Junction's error sanitiser passes the SCHEMA's protected set through this
  // same walk. One walker, two predicates — a second walker is how the cycle
  // guard comes to exist in one of them and not the other.
  const protectedFields = { ssn: 'encrypted' }
  const out = redactBy({ ssn: '111', password: 'p' }, (k) => Boolean(protectedFields[k]))
  assert.equal(out.ssn, REDACTED)
  assert.equal(out.password, 'p')        // not in THIS predicate's set
})

// ─── URLs ─────────────────────────────────────────────────────────────────────

test('redact: a connection string loses its password and keeps its host', function () {
  assert.equal(
    redactUrl('postgres://admin:S3cr3t@db.internal:5432/prod'),
    `postgres://admin:${REDACTED}@db.internal:5432/prod`)

  // The user survives: *wrong password for admin* and *wrong user* are
  // different bugs, and WHICH host refused is the content of the message.
  assert.ok(redactUrl('postgres://admin:S3cr3t@db.internal/prod').includes('admin'))
  assert.ok(redactUrl('postgres://admin:S3cr3t@db.internal/prod').includes('db.internal'))

  // A password containing an encoded `@` — the userinfo runs to the LAST one.
  assert.equal(
    redactUrl('postgres://admin:p@ss@db.internal/prod'),
    `postgres://admin:${REDACTED}@db.internal/prod`)

  // No userinfo, no change.
  assert.equal(redactUrl('postgres://db.internal/prod'), 'postgres://db.internal/prod')
  assert.equal(redactUrl('just some text'), 'just some text')
  assert.equal(redactUrl('user@example.com'), 'user@example.com')   // an address, not an authority
  assert.equal(redactUrl('https://example.com/path'), 'https://example.com/path')
})

test('redact: a MALFORMED url is the case it exists for', function () {
  // The caller reaching for this is holding a value that failed to parse —
  // `defineEnv` quoting a bad DATABASE_URL is what it was written for — so a
  // rule anchored on `://` misses the one string it is always handed.
  assert.equal(
    redactUrl('postgres//admin:S3cr3tP@ss@db.internal:5432/prod'),
    `postgres//admin:${REDACTED}@db.internal:5432/prod`)

  // The scheme must not be read as the user. This is the shape that regressed
  // when the rule was first broadened: the password may not span a `/`, so in
  // `postgres://admin:s@h` there is only one place a password can begin.
  assert.ok(redactUrl('postgres://admin:S3cr3t@db.internal/prod').startsWith('postgres://admin:'))

  // An empty user is the documented shape for a server with a password and no
  // user, and it leaked while the user token was required.
  assert.equal(redactUrl('redis://:onlypass@cache:6379'), `redis://:${REDACTED}@cache:6379`)
})

test('redact: an env var name is matched per segment, not whole', function () {
  for (const n of ['STRIPE_SECRET_KEY', 'DATABASE_PASSWORD', 'GITHUB_TOKEN', 'AUTH_SECRET', 'X_API_KEY'])
    assert.equal(isSecretEnvName(n), true, n)

  // `KEY` alone is too broad, and these are the names it would have caught.
  // DATABASE_URL is plain on purpose: its NAME is not a secret, and what it
  // CARRIES is redactUrl's job.
  for (const n of ['DATABASE_URL', 'PORT', 'NODE_ENV', 'SORT_KEY', 'CACHE_KEY', 'PARTITION_KEY', 'LOG_LEVEL'])
    assert.equal(isSecretEnvName(n), false, n)
})

test('redact: redactValue takes either kind', function () {
  assert.equal(redactValue('mysql://u:p@h/d'), `mysql://u:${REDACTED}@h/d`)
  assert.equal(redactValue({ cookie: 'c' }).cookie, REDACTED)
  assert.equal(redactValue(42), 42)
  assert.equal(redactValue(null), null)
})
