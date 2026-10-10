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

import { SECRET_KEY_NAMES, REDACTED, isSecretKey, isSecretEnvName, redactBy, omitBy, redactSecrets, redactUrl, redactValue }
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

// FJS-2191: a credential is usually a compound, and the compound is judged by
// its LAST word — `currentPassword` is a password, `passwordResetAt` is when.
test('redact: a compound name is a credential by its last word', function () {
  for (const name of [
    'currentPassword', 'newPassword', 'new_password', 'passwordHash', 'password-hash',
    'apiToken', 'accessKey', 'secretKey', 'AWS_SECRET_ACCESS_KEY', 'AWSSecretKey',
    'otp', 'totp', 'x-amz-security-token', 'csrfToken', 'clientSecret', 'dbPassword',
  ]) assert.equal(isSecretKey(name), true, name)

  for (const name of ['sortKey', 'cacheKey', 'partitionKey', 'tokenCount', 'passwordResetAt', 'secretaryName', 'commitHash', 'keyboard'])
    assert.equal(isSecretKey(name), false, name)
})

test('redact: the set is normalized, so no entry can be unreachable', function () {
  // An entry written with a capital or an underscore would never match, because
  // the lookup normalizes the QUERY. This asserts the stored form.
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

test('redact: a value reached by two paths is walked twice, not called a cycle', function () {
  const shared = { token: 't', label: 'x' }
  const out = redactSecrets({ a: shared, b: shared, list: [shared, shared] })
  assert.deepEqual(out.b, { token: REDACTED, label: 'x' })
  assert.deepEqual(out.list[1], { token: REDACTED, label: 'x' })
})

test('omitBy: a matching key is dropped, the rest kept, nested and in lists', function () {
  const isSecret = (k) => k === 'secret'
  const out = omitBy({ id: 1, secret: 's', rows: [{ id: 2, secret: 's2', title: 't' }] }, isSecret)
  assert.deepEqual(out, { id: 1, rows: [{ id: 2, title: 't' }] })
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
  // Junction's error sanitizer passes the SCHEMA's protected set through this
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

test('redact: redactUrl is linear on text with no credential in it', function () {
  // At 80 KB the pattern-per-start version took 8 s. Linear is a millisecond
  // or two; the ceiling is two orders above that so a slow runner cannot fail it.
  for (const text of ['a:'.repeat(80000), 'a'.repeat(160000), 'a:'.repeat(80000) + '@', 'a:@'.repeat(60000)]) {
    const t0 = performance.now()
    redactUrl(text)
    assert.ok(performance.now() - t0 < 500, 'redactUrl took ' + Math.round(performance.now() - t0) + ' ms on ' + text.length + ' chars')
  }

  // Greedy to the last `@` that still leaves a host, per whitespace-separated token.
  assert.equal(redactUrl('a:b:c@d@e f:g@h'), `a:${REDACTED}@e f:${REDACTED}@h`)
  assert.equal(redactUrl('x:y@ z:w@h'), `x:y@ z:${REDACTED}@h`)
})

test('redact: an env var name is matched per segment, not whole', function () {
  for (const n of ['STRIPE_SECRET_KEY', 'DATABASE_PASSWORD', 'GITHUB_TOKEN', 'AUTH_SECRET', 'X_API_KEY', 'SMTP_PASS', 'KEY_PASSPHRASE', 'ADMIN_OTP'])
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

// Junction runs omitBy over every response of a model with a protected field,
// so one stored Json value deeper than the stack was a 500 on every later read
// of that model. Bun's JSON.parse and JSON.stringify take the depth; node's
// stringify does not, so the value is built here rather than round-tripped.
test('redact: omitBy walks a value nested deeper than the call stack', function () {
  let deep = [{ token: 't', keep: 1 }]
  for (let i = 0; i < 20000; i++) deep = [deep]
  const value = { data: deep }

  const isToken = k => k === 'token'
  let out = omitBy(value, isToken).data
  let red = redactBy(value, isToken).data
  for (let i = 0; i < 20000; i++) { out = out[0]; red = red[0] }
  assert.deepEqual(out, [{ keep: 1 }])
  assert.deepEqual(red, [{ token: REDACTED, keep: 1 }])
})

test('redact: a sparse array keeps its holes and a sibling is not a cycle', function () {
  const shared = { a: 1 }
  // biome-ignore lint/suspicious/noSparseArray: a sparse array is the input under test
  const sparse = [1, , 3]
  const out = omitBy({ sparse, x: shared, y: shared }, () => false)
  assert.equal(out.sparse.length, 3)
  assert.equal(1 in out.sparse, false)
  assert.deepEqual(out.x, { a: 1 })
  assert.deepEqual(out.y, { a: 1 })
})

// FJS-2190: a password may hold a `/` or a space, and an https userinfo may be a token alone.
test('redact: redactUrl takes a password holding / or whitespace, and a token-only userinfo', function () {
  assert.equal(redactUrl('postgres://admin:pa/ss@db/x'), `postgres://admin:${REDACTED}@db/x`)
  assert.equal(redactUrl('postgres://admin:Zm9v/YmFy+Zg==@db:5432/x'), `postgres://admin:${REDACTED}@db:5432/x`)
  assert.equal(redactUrl('redis://:my pass@h'), `redis://:${REDACTED}@h`)
  assert.equal(redactUrl('connect failed: redis://u:my pass@h:6379 refused'), `connect failed: redis://u:${REDACTED}@h:6379 refused`)
  assert.equal(redactUrl('https://ghp_abc@github.com'), `https://${REDACTED}@github.com`)
  assert.equal(redactUrl('https://ghp_abc@github.com/org/repo.git'), `https://${REDACTED}@github.com/org/repo.git`)
  assert.equal(redactUrl('a://u:p@h1 b://u2:p2@h2'), `a://u:${REDACTED}@h1 b://u2:${REDACTED}@h2`)

  // not credentials: a username-only ssh url, a path holding an @, a port, an address after a url
  assert.equal(redactUrl('ssh://git@github.com/org/repo'), 'ssh://git@github.com/org/repo')
  assert.equal(redactUrl('https://example.com/feed/@alice'), 'https://example.com/feed/@alice')
  assert.equal(redactUrl('https://example.com:8080/feed/@alice'), 'https://example.com:8080/feed/@alice')
  assert.equal(redactUrl('failed https://host:8080 for bob@x.com'), 'failed https://host:8080 for bob@x.com')
  assert.equal(redactUrl('see https://example.com/a, mail me@x.com'), 'see https://example.com/a, mail me@x.com')
  assert.equal(redactUrl('https://u:pw@h/feed/@alice'), `https://u:${REDACTED}@h/feed/@alice`)
})

test('redact: redactUrl stays linear on repeated schemes', function () {
  for (const text of ['a://'.repeat(60000), 'a://x:'.repeat(40000), 'a://x y '.repeat(30000), 'a://x/'.repeat(40000) + '@h']) {
    const t0 = performance.now()
    redactUrl(text)
    assert.ok(performance.now() - t0 < 500, 'redactUrl took ' + Math.round(performance.now() - t0) + ' ms on ' + text.length + ' chars')
  }
})

// FJS-2192: an own `__proto__` member is data, and `out[k] = v` makes it the copy's prototype.
test('redact: an own __proto__ member survives the walk as a member', function () {
  const body = JSON.parse('{"a":1,"__proto__":{"isAdmin":true},"list":[{"__proto__":{"x":1},"a":2}]}')
  for (const out of [omitBy(body, (k) => k === 'a'), redactBy(body, (k) => k === 'a')]) {
    assert.equal(Object.getPrototypeOf(out), Object.prototype)
    assert.equal(out.isAdmin, undefined)
    assert.deepEqual(Object.keys(out).filter((k) => k === '__proto__'), ['__proto__'])
    assert.deepEqual(Object.getOwnPropertyDescriptor(out, '__proto__').value, { isAdmin: true })
    assert.deepEqual(Object.getOwnPropertyDescriptor(out.list[0], '__proto__').value, { x: 1 })
  }
})
