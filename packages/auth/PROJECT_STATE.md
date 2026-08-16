# Auth — Project State

_Audited **and partly fixed** 2026-08-02 by running the code: 34 data-layer
probes, 22 route probes against a real Junction app, 7 gate-enforcement probes,
and a packed-tarball install. Findings 1 and 3 are now fixed and the probes have
become 57 permanent tests. Everything marked **verified** was reproduced._

> Drop this file into a fresh session to pick up Auth cold.
> Read `../../CLAUDE.md` first for repo-wide vocabulary and landmines.

---

## What it is

`@frontierjs/auth` v1.0.0 — a native `IAuth` provider implemented over Litestone
`asSystem()`, plus schema fragments and a `/auth/*` route plugin.

Realm: **D6**. It is the inbound identity seam: Junction calls
`IAuth.verifySession(token)` from `transport/http.ts`, and this package
implements it.

```
index.ts     public barrel
auth.ts      createLitestoneAuth() — the IAuth implementation
plugin.ts    createAuthPlugin() — the /auth/* routes (no error mapping: see errors.ts)
errors.ts    named domain errors (AuthError and friends)
db/*.lite    the models this package ships — user.lite (the app's) + auth.lite
schema.ts    reads those two — authUserModel / authMachineryModels / both
cleanup.ts   createAuthCleanupJobs() — expiry sweeps
crypto.ts    hashing / token generation
types.ts
tests/harness.ts               real Litestone db + auth, shared by both suites
tests/schema-accessors.test.ts schema fragments + accessor naming (pre-existing)
tests/flows.test.ts            the 13 IAuth methods, failure paths, gate enforcement
tests/routes.test.ts           /auth/* against a real Junction app
```

## Verified state

| | |
|---|---|
| Version | **1.0.0** — the only package here above 0.x; CLAUDE.md says it has run in production |
| Tests | **70 pass, 0 fail**, 3 files (`bun run test`) — was 7 in 1 file |
| Typecheck | **4 errors**, baseline 4, all pre-existing in `schema-accessors.test.ts` |
| Published? | **No — `npm view @frontierjs/auth` 404s.** Junction 404s too; only litestone (1.1.0) is on npm |

Reproduce: `cd packages/auth && bun run test && bun run typecheck`.

The suites need a real Chrome-free bun only, but they DO build a real SQLite
database per file under `os.tmpdir()`. Those dirs are reaped at **process exit**,
not in `afterAll` — `@@log(audit)` flushes asynchronously through the jsonl
driver after the awaited call returns, and tearing the directory down early
raced it into `SQLITE_READONLY_DBMOVED`. See the note in `tests/harness.ts`;
it is consistent with the audit-logger landmine in `../../CLAUDE.md`.

---

## The good news, established by running it

The **data layer is correct**. 34 probes against a real Litestone client
exercised all 13 IAuth methods and their failure paths; every one behaved.
Specifically confirmed, because these were the open questions:

- **Expired sessions are rejected** — the `expiresAt: { gt: new Date() }`
  comparison works against the ISO strings `crypto.ts` writes.
- **Password reset DOES invalidate all existing sessions.** The previous version
  of this file said "assume not until tested". Tested: a session issued before
  the reset returns `null` afterwards.
- Reset and verification tokens are **single-use** and **expiry-checked**.
- **Cross-protocol token confusion fails closed**: a `verify:` token used on
  `confirmPasswordReset` (and vice versa) is refused. Note this is *incidental* —
  both lookups match on `value` alone and are saved by the subsequent email
  lookup failing. Scoping the query by identifier prefix would make it deliberate.
- API keys: revocation and per-credential expiry both refuse correctly.
- `deleteUser` cascades — sessions, credentials, and verifications all reach 0.

**Gates genuinely enforce.** The three credential-material models are
`@@gate("8")` — SYSTEM, `asSystem()` only — and refuse reads and writes from an
anonymous client and a `$setAuth`'d normal user alike. `User` was 8 too until
`FJS-170`, which is a level at which an app cannot list its own people; it now
reads at USER(4) with the two declarations that bound the level rather than
raise it, and the suite asserts the refusals rather than the levels: a stranger
is refused by level, one user cannot write another's row, nobody writes their
own `role` or `emailVerified`, an ADMINISTRATOR does both. This is *not* the
"gates fail open" failure from `VERIFYING.md` — verified by running.

**The CLI hand-copy is in sync, and a test says so now.** It has drifted
three times, so `tests/schema-accessors.test.ts` parses both copies and compares
what they DECLARE — gate, row policies, field policies, model for model. Prose
asking two files to stay together is the thing that failed; comments may differ,
an access rule may not. Verified by breaking it: dropping the row policy from the
CLI copy turns the suite red.

Rate limiting works: 5 registers then `429`, keyed per-IP off `ctx.ip`.

---

## Findings — ranked by cost of being wrong


*Still open here, in `../../ISSUES.md`: **`FJS-002`** (cookie auth),
**`FJS-042`** (API keys, no events — `stale?`). **`FJS-063`** closed 2026-08-16,
both halves, and **`FJS-296`** was filed and closed out of it. Decision waiting:
**`FJS-D20`**. The writeups below are the argued detail.*

**Status: all seven are fixed except 2.**

### 1. Every auth failure reached the client as HTTP 500 — **FIXED**

`auth.ts` threw plain `new Error(...)`. Junction's `toFrameworkError()`
(`src/core/errors.ts`) only honours its own `FrameworkError` subclasses plus two
name-matched Litestone errors — everything else became `GeneralError`, a **500**.

Reproduced against a real `createTestApp()` — 5 of 22 route probes:

| request | expected | was | now |
|---|---|---|---|
| `POST /auth/login` wrong password | 401 | **500** | 401 |
| `POST /auth/login` unknown email | 401 | **500** | 401 |
| `POST /auth/register` duplicate email | 409 | **500** | 409 |
| `POST /auth/password-reset/confirm` bad token | 400 | **500** | 400 |
| `GET /auth/email/verify` bad token | 400 | **500** | 400 |

The boundary was exact: everything `plugin.ts` raised itself (`BadRequest`,
`Unauthorized`, `TooManyRequests`) returned the right status; everything raised
in `auth.ts` returned 500. A mistyped password was indistinguishable from an
outage, ordinary typos paged whoever watches the 5xx rate, and the internal
error string shipped in the body. Sierra's client keys off **401** to clear a
stale token and redirect (`packages/sierra/src/junction/index.js:318`).

**The fix keeps the data layer HTTP-free**, which is what `auth.ts`'s own header
comment promises ("never touches HTTP — that is the plugin's job"):

- **`errors.ts`** declares named domain errors — `InvalidCredentialsError`,
  `EmailTakenError`, `InvalidTokenError`, `UserNotFoundError`, `AuthConfigError`,
  all extending `AuthError`. They are exported from the barrel, so a consumer
  calling `createLitestoneAuth()` with no Junction anywhere can still branch on
  what went wrong.
- **`auth.ts`** throws those at all 10 sites. It still imports only types.
- **`errors.ts`** also declares the numeric `status` each one means, which is
  what Junction's error boundary reads. **`AuthConfigError` keeps 500** — a
  missing `encryptionKey` is the server's fault, not the caller's.

`InvalidCredentialsError` carries one message for wrong-password, unknown-email
and missing-credential alike, because distinguishing them is a user-enumeration
oracle. Asserted in both suites.

**Superseded 2026-08-02 — the mapping moved out of this package.** Junction's
error boundary now reads a numeric `status` off any thrown error, so `errors.ts`
declares one per class and `plugin.ts`'s `toHttpError` + `route()` wrapper are
**deleted**. This package still imports nothing from Junction for its statuses.

Why it matters beyond tidiness: the wrapper only covered the 8 `/auth/*`
handlers, so the same error raised from an ordinary **service** still reached the
client as a 500 — verified before the change, and now covered by
`routes.test.ts` › "auth errors map correctly outside the auth routes".

Same bug class as Caravan's admin guard — see the error-boundary entry in
`../../CLAUDE.md`.

### 2. `cookieAuth: true` cannot authenticate a request — **FIXED 2026-08-06**

The cookie was set correctly — `session=…; Path=/; Max-Age=2592000; HttpOnly;
SameSite=Lax`, with `Max-Age` derived from `sessionTtl`. But:

```
GET /auth/me  with cookie only  → 401
```

Junction's `extractToken()` read **only** `authorization: Bearer` and
`x-api-key`, so `ctx.user` was never populated from a cookie. Login and logout
worked (auth's own `extractToken` has a `ctx.cookies?.session` fallback);
everything in between did not. The documented mode got you a session you could
not use.

**Fixed in Junction, declared here.** `extractToken` takes an optional cookie
name, and this plugin calls `app.http.setAuthCookie('session')` from its own
`register()` when configured `{ cookieAuth: true }` — so cookie mode is ONE
switch. Requiring the app to also write `config.auth.cookie` would have left a
half-configured state that reproduces exactly the bug above.

Junction keeps cookies **off by default**, and that is a security decision, not
caution: a Bearer token has to be attached by script so a cross-site request
cannot forge one, while a cookie travels automatically — which is what makes
CSRF possible at all. What makes it safe when enabled is the `SameSite=Lax` this
plugin sets: the browser withholds the cookie from cross-site writes. An app
that sets its own session cookie with `SameSite=None` re-opens that and Junction
cannot tell.

The marker test flipped: `routes.test.ts`'s `KNOWN GAP: a cookie alone does not
authenticate a request` (asserting 401) is now `a cookie alone authenticates a
request` (asserting 200), joined by four more covering no-cookie, a garbage
cookie, the emptied cookie a logout leaves, and Bearer-beats-cookie precedence.
Junction carries 12 of its own in `tests/auth-cookie.test.ts`, including the
WebSocket upgrade — a cookie-authenticated app was otherwise connecting its
socket anonymously, which is silent because an unauthenticated socket is a legal
state.

### 3. `cookieAuth: true` also returned the token in the body — **FIXED**

`types.ts` documents the cookie as going out "instead of returning it in the
response body". It did both: `respond()` set the cookie and still serialised
`{ token, user }`. The entire point of `httpOnly` is that page JavaScript cannot
read the token, and handing it back in the body defeated the opt-in.

`respond()` now strips `token` from the payload when it sets the cookie —
returning `{ user }` — and only when `ctx.setCookie` actually exists, so a
transport without cookie support does not leave the caller with nothing.
Verified by reverting: 2 route tests go red.
### 4. The package could not be published as-is — **FIXED**

Was: five shipped files imported **`../junction/index.ts`** — a relative path
outside the package root — 8 times, 3 of them runtime value imports (`parseTtl`,
`Unauthorized/BadRequest/TooManyRequests`, `createScheduler`). Proven, not
inferred: `npm pack`, extract into a bare `node_modules/`, import it →

```
error: Cannot find module '../junction/index.ts' from …/auth-pkg/plugin.ts
```

All 8 are now `@frontierjs/junction`, which is what conduit, caravan,
notifications, basecamp and `sierra/example` were already writing — auth was the
only package in the repo reaching out by path, and it resolved only because it
sat inside the workspace. The peer range is `^0.1.0` rather than `"*"`, the
pattern that caused the litestone dialect trap (`../../CLAUDE.md`), and `files`
is `["*.ts", "README.md"]` — a 10-file tarball, with `tests/`, `tsconfig.json`
and the markdown that is not the README no longer shipping.

Re-proven the same way it was found: pack, install the tarball into an empty
project, import it, build a plugin. The three runtime value imports resolve
through the specifier.

**The peer landed the same day.** `@frontierjs/junction@0.1.0` is on npm, so a
`bun add` of the auth tarball into an empty project now resolves the peer from
the registry and imports — which it could not do while junction was a 404, and
could not do from a sibling `file:` tarball either (bun declines to satisfy a
semver peer from one; it does that with `"*"` as the range too, so that failure
was never about the range).

### 5. The coverage gap — **CLOSED for the flows, by 57 new tests**

Was: 7 tests, all on schema fragments and accessor naming, with all 13 IAuth
methods and all 8 routes untested. Now **64 tests across 3 files**:

- `tests/flows.test.ts` — every IAuth method on its failure paths, plus the
  Data-boundary block: the three credential models refuse anonymous and
  signed-in callers alike, and `User`'s ladder is asserted through its
  refusals — by level, by row, and by field.
- `tests/routes.test.ts` (23) — the 8 routes against a real `createTestApp()`,
  every status code, rate limiting, and cookie mode.
- `tests/schema-accessors.test.ts` (7) — unchanged.

Everything in "the good news" above is now regression-protected, including the
two facts this file previously told readers to assume were broken.

Still uncovered: `createAuthCleanupJobs` has no test, and there is no test for
concurrent logins or session-fixation behaviour.
### 6. Login is a user-enumeration timing oracle — **FIXED**

Was: `login()` returned early when the user was absent, skipping the bcrypt
(cost 12) comparison entirely, so "unknown email" answered measurably faster
than "wrong password". Measured rather than reasoned about: 9ms against 119ms,
the floor of three runs each. The `no-password-credential` branch bailed the
same way and was not in the original writeup.

Both branches now `await payPasswordCost(password)` before refusing —
`Bun.password.verify` against a cost-12 hash of a value nobody holds, answer
discarded. What is left between the paths is one database read.

The rate limit blunted it, and the reason it was worth fixing anyway is that
`requestPasswordReset` goes to real trouble not to reveal the same fact: the
package had decided address existence is a secret and then leaked it out a
different door. `tests/flows.test.ts` § login holds the timing assertion and the
one that catches `DUMMY_HASH` drifting off `BCRYPT_COST`.

### 7. `plugin.ts` types `app` and `ctx` as `any` — **FIXED**

Was: `register(app: any)`, every handler `(ctx: any)`, which is precisely why
findings 1–3 produced **zero** typecheck diagnostics. Now `App`,
`TransportContext`, a `Plugin` return and `createAuthServices(): Service[]`;
three `as any` casts at call sites deleted as needless.

It was filed as *cheap and would have caught the cookie assumption*. The first
clean compile pointed at two live defects instead:

- **A where-operator object in place of an email** (`FJS-296`). `ctx.body` is
  `unknown` and nothing here was reading it as such, so `{ email: { contains:
  '@' } }` reached `findFirst({ where: { email } })` intact and the address
  became a filter. Fixed here, because a raw route has no `autoValidate` to put
  in front of it — the check is one reader, and every declared field is a string
  or the request is a 400 naming it.
- **`rateLimitHook` was typed for one context and documented for two.** Its own
  comments name these routes as the reason it reaches `auth` optionally, and
  `clientIp()` exists to serve both shapes — but the signature said
  `ServiceContext`, and auth's `any` was the only reason this file compiled.
  Fixed in junction (`BridgeHook`), not cast around here.

---

## Typecheck baseline: 4

All 4 are nullable assertions in `tests/schema-accessors.test.ts`. **Zero**
diagnostics in the package's own source or public surface — but see finding 7:
that is mostly because the route layer is typed `any`.

---

## Conventions that apply here

- Run tests with **`bun run test`**, not `bun test`.
- Model names are **PascalCase singular** — `model User` → accessor `db.user`.
- `asSystem()` is the Data-boundary **bypass**; every use is deliberate
  privilege escalation. Here it is correct and gate-enforced (verified above).
- Auth's `/auth/*` routes **intentionally bypass the Service abstraction** —
  login cannot be gated by login. They are raw `app.post` routes, so the raw-route
  landmine in `../../CLAUDE.md` applies: `{id}` params, `ctx.headers`, and
  return-don't-throw for status codes.
- Auth's developer-facing API is **not finalized** (`CLAUDE.md` §Unsettled), but
  this is the one package at v1.0.0 with production use — weigh that.

## Unconfirmed

- **OAuth**: `Credential` carries `accessToken`/`refreshToken`/`scope` fields and
  the schema comment mentions OAuth tokens, but no OAuth flow exists in any
  source file. The schema anticipates a feature that isn't implemented.
- Whether `createAuthCleanupJobs` is wired anywhere. It uses Junction's own
  `createScheduler` (not Caravan), so Caravan's state is irrelevant to it — but no
  caller was found in this repo.
- Password strength: nothing validates it. `password: 'x'` is accepted.
- Multi-process: the rate limiter is an in-process `Map`, documented as such.
  Two Bun workers = two independent budgets.
