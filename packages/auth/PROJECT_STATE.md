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
schema.ts    authSchemaFragments(db) — contributes INTO the seed
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

**Gates genuinely enforce.** `@@gate("8")` is SYSTEM (`asSystem()` only — level
table in `litestone/src/core/parser.js:1144`). All four models refused reads and
writes from both an anonymous client and a `$setAuth`'d normal user, with
`AccessDeniedError: "User.read" requires SYSTEM access`. This is *not* the
"gates fail open" failure from `VERIFYING.md` — verified 7/7.

**The CLI hand-copy is in sync.** `packages/cli/commands/auth/install.md` is
byte-identical to `schema.ts` for all four models — verified per-model.

Rate limiting works: 5 registers then `429`, keyed per-IP off `ctx.ip`.

---

## Findings — ranked by cost of being wrong

**Status: 1, 3 and 5 are fixed. 2, 4, 6 and 7 remain open.**

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

### 2. `cookieAuth: true` cannot authenticate a request

The cookie is set correctly — `session=…; Path=/; Max-Age=2592000; HttpOnly;
SameSite=Lax`, with `Max-Age` correctly derived from `sessionTtl`. But:

```
GET /auth/me  with cookie only  → 401
```

Junction's `extractToken()` (`src/transport/http.ts:854`) reads **only**
`authorization: Bearer` and `x-api-key`. It never looks at cookies, so `ctx.user`
is never populated from one. Login and logout work (auth's own `extractToken`
has a `ctx.cookies?.session` fallback); everything in between does not.

So the documented cookie mode gets you a session you cannot use. Fixing it means
teaching Junction's token extraction about a session cookie — a Junction change,
not an auth one.

**Still open, but now pinned**: `routes.test.ts` has a test named
`KNOWN GAP: a cookie alone does not authenticate a request` asserting the 401,
so the gap cannot be mistaken for working. When Junction learns cookies, flip
that assertion to 200 — it is the marker for the fix.

### 3. `cookieAuth: true` also returned the token in the body — **FIXED**

`types.ts` documents the cookie as going out "instead of returning it in the
response body". It did both: `respond()` set the cookie and still serialised
`{ token, user }`. The entire point of `httpOnly` is that page JavaScript cannot
read the token, and handing it back in the body defeated the opt-in.

`respond()` now strips `token` from the payload when it sets the cookie —
returning `{ user }` — and only when `ctx.setCookie` actually exists, so a
transport without cookie support does not leave the caller with nothing.
Verified by reverting: 2 route tests go red.
### 4. The package cannot be published as-is

Five shipped files import **`../junction/index.ts`** — a relative path outside
the package root — 8 times, 3 of them runtime value imports (`parseTtl`,
`Unauthorized/BadRequest/TooManyRequests`, `createScheduler`).

Proven, not inferred: `npm pack`, extract into a bare `node_modules/`, import it →

```
error: Cannot find module '../junction/index.ts' from …/auth-pkg/plugin.ts
```

Meanwhile `package.json` declares `"@frontierjs/junction": "*"` as a peer
dependency it never imports by name — and a bare `"*"` range is the exact pattern
that caused the litestone dialect trap (`../../CLAUDE.md`). There is no `files`
field, so `PROJECT_STATE.md` and the tests ship too.

Severity is bounded: **auth is not on npm** (404), so nothing is broken for real
users today. This is a publish blocker, and it is why v1.0.0 is misleading.

### 5. The coverage gap — **CLOSED for the flows, by 57 new tests**

Was: 7 tests, all on schema fragments and accessor naming, with all 13 IAuth
methods and all 8 routes untested. Now **64 tests across 3 files**:

- `tests/flows.test.ts` (34) — every IAuth method on its failure paths, plus 5
  gate-enforcement tests proving `@@gate("8")` refuses anonymous *and*
  logged-in-user access to all four models.
- `tests/routes.test.ts` (23) — the 8 routes against a real `createTestApp()`,
  every status code, rate limiting, and cookie mode.
- `tests/schema-accessors.test.ts` (7) — unchanged.

Everything in "the good news" above is now regression-protected, including the
two facts this file previously told readers to assume were broken.

Still uncovered: `createAuthCleanupJobs` has no test, and there is no test for
concurrent logins or session-fixation behaviour.
### 6. Minor: login is a user-enumeration timing oracle

`login()` returns early when the user is absent, skipping the bcrypt (cost 12)
comparison entirely, so "unknown email" answers measurably faster than "wrong
password". Standard mitigation is a dummy hash comparison on the absent-user
path. Low severity — the 10-per-15-minutes rate limit blunts it — and worth
noting only because `requestPasswordReset` goes to real trouble not to reveal
the same fact.

### 7. Minor: `plugin.ts` types `app` and `ctx` as `any`

`register(app: any)`, every handler `(ctx: any)`. That is precisely why findings
1–3 produce **zero** typecheck diagnostics. Tightening to `App` and
`TransportContext` is cheap and would have caught the cookie assumption.

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
