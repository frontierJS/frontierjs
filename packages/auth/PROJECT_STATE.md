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
services.ts  account / sessions / api-keys / connections — the half that is not a route
cleanup.ts   createAuthCleanupJobs() — expiry sweeps
crypto.ts    hashing / token generation
totp.ts      RFC 6238 codes, base32, recovery codes — clockless (`FJS-D261`)
types.ts
tests/harness.ts               real Litestone db + auth, shared by the suites
tests/schema-accessors.test.ts schema fragments + accessor naming (pre-existing)
tests/flows.test.ts            the IAuth methods, failure paths, gate enforcement
tests/routes.test.ts           /auth/* against a real Junction app
tests/totp.test.ts             RFC 4648 and RFC 6238 published vectors
tests/totp-login.test.ts       enrollment, the two-step login, recovery, the ceiling
tests/credential-events.test.ts every change told to onCredentialChanged, from its real verb
tests/account-recovery.test.ts  resetTotp over HTTP: the SYSADMIN floor, peers, self, support
```

The file list above is the core; `tests/` also holds the OAuth, support-mode,
services and cleanup suites.

## Verified state

| | |
|---|---|
| Version | **1.0.0** — the only package here above 0.x; CLAUDE.md says it has run in production |
| Tests | **384 pass, 0 fail**, 17 files (`bun run test`, 2026-09-12) — was 7 in 1 file |
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

## The second factor — shipped 2026-09-12

TOTP is a second STEP of login and not a second standing (`FJS-D261`): with a
live `totp` credential, `login()` answers `{ challenge, expiresAt }` and no
token, and `POST /auth/login/challenge` with a code or a recovery code answers
the session. Enrollment, confirmation, disable and recovery-code regeneration
are `account` service methods; the gate ladder and `authMethod` are unchanged.

Verified at three distances:

- **The arithmetic** against RFC 4648's and RFC 6238's published vectors
  (`tests/totp.test.ts`), which are the only assertions here written by
  somebody other than the implementation.
- **The provider and both transports** against a harness app — every refusal
  paired with the succeeding call (`tests/totp-login.test.ts`,
  `tests/services.test.ts`, `tests/support-refusals.test.ts`).
- **A real app** — `example`: `verify:users` registers a fresh account, enrolls
  it, and signs in through `example`'s per-shop provider proxy and tenant
  database, with codes from an authenticator written in the drive rather than
  imported from `totp.ts`.

`example` enrolls from `/account/` and signs in through `/sign-in/` with the
shell's code box, and `verify:users` drives both in Chrome. Open: passkeys.

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
- Auth's developer-facing API was ruled and built (`FJS-D20`), and native OAuth
  ships (`oauth.ts`, the flow routes, `example`: `verify:oauth`) — this is not
  the sketch it once was.

## Unconfirmed
- ~~Whether `createAuthCleanupJobs` is wired anywhere.~~ **Answered 2026-09-07.**
  The scaffold wires it — `fli new` and `fli auth:install` both write
  `authCleanup.start()` into `boot()` and `.stop()` into `shutdown()` — and
  neither dogfooding app does: `example` never starts it, and `basecamp` runs a
  `basecamp-cleanup` of its own. It uses Junction's `createScheduler`, not
  Caravan, so Caravan's state is irrelevant to it. `tests/cleanup.test.ts` covers
  it now, through `sweepNow()` rather than a restated predicate (`FJS-1000`).
- Password strength: nothing validates it. `password: 'x'` is accepted.
- Multi-process: the rate limiter is an in-process `Map`, documented as such.
  Two Bun workers = two independent budgets.
