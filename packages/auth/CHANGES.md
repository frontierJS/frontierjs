# Changes — @frontierjs/auth

## 2026-08-16 — the route layer is typed, and it found a hole the same hour (FJS-063, FJS-296)

137 tests. Typecheck baseline unchanged at 4 — all of it still the two nullable
assertions in `tests/schema-accessors.test.ts`.

`register(app: App)`, `boot(app: App)`, every handler `(ctx: TransportContext)`,
the return `Plugin`, and `createAuthServices(): Service[]`. Three `as any` casts
at call sites went with them, which is the cheap proof the types are real.

**What the first clean compile pointed at was a security hole.** `ctx.body` is
`unknown`, and reading fields off it under `any` meant `{ "email": { "contains":
"@" } }` reached `sys.user.findFirst({ where: { email } })` as a where-operator —
the address was a filter. With a correct password that signed the caller in as
the first matching row; `startsWith` walked the user table with no address known;
`{ "$ne": null }` came back a 500 carrying Litestone's query vocabulary to an
unauthenticated caller. `register` wrote one: an array email became a user whose
address was the array coerced by SQLite, 201 and no complaint.

The password was still verified against whichever row matched, so it was never a
straight bypass — it turns a password spray into a targeted-account selector,
which is bad enough. **The cause is structural**: a raw route has no
`autoValidate`, because that hook is derived from the model and these routes sit
upstream of every service. So there is now one reader — a declared field is a
string or the request is a 400 naming it, and an undeclared key does not travel.
FJS-296, four tests in `routes.test.ts`, probed before and after.

**A second finding went the other way.** `rateLimitHook` is documented for both
contexts, its own comments name `@frontierjs/auth`'s routes as the reason, and
`clientIp()` exists to serve both — but it was typed `(ctx: ServiceContext) =>
void`. Auth's `any` was the only reason its routes compiled. Fixed in junction
rather than cast around here: `rateLimit` returns a `BridgeHook`, whose parameter
is the union and therefore still assignable to `Hook`.

## 2026-08-16 — a login refusal costs the same whichever branch refuses it (FJS-063)

133 tests. Typecheck baseline unchanged at 4.

The three refusals already answered one error and recorded the difference only
in the trail. Two of them never reached the bcrypt: an unknown address and a
user with no password credential both returned on a database read alone,
measured at 9ms against 119ms for a wrong password. An error message that says
nothing is no use when the clock beside it says *this address exists*.

Both branches now call `payPasswordCost`, which verifies against `DUMMY_HASH` —
a real cost-12 hash of a value nobody holds — and discards the answer. The
remaining difference between the paths is one database read, three orders of
magnitude under the bcrypt.

`DUMMY_HASH` is a literal, so it carries its own cost and cannot follow
`BCRYPT_COST`. A test asserts the two agree: raise the cost without regenerating
the literal and the gap reopens narrower and silent, which is the failure the
assertion exists to make loud. The timing test measures the MIN of three runs —
the floor is what an attacker samples for — and bands it at a factor of two, so
a loaded box does not fail it.

`requestPasswordReset` had gone to real trouble not to reveal the same fact,
which is what made this worth doing at S3: the package had already decided
address existence is a secret, and login leaked it out the other door.

## 2026-08-16 — `sessionFor(userId)`

131 tests, unchanged. Typecheck clean.

The re-resolution `app.runAs(userId, …)` needs: build a session for a caller who
is presenting nothing, because deferred work outlives the request that asked for
it and by then there is no token to verify. It goes through `toContext()` like
every other path — same row, same `sessionFields`, same standing — because a
parallel builder here would be a second answer to *what standing does this user
hold*, diverging exactly where it shows least.

`authMethod: 'created'`, so anything auditing *how* a caller authenticated can
tell it from a session or a key. Reads fresh and answers `null` for a user who
no longer exists. **It proves no credential** and must never be reachable from
anything a request can name.

## 2026-08-16 — the surface splits: routes establish a session, services are what you do next (FJS-D20)

`GET /auth/me` is gone. It is `account.get('me')`, and with it come the two
services this package had the data layer for and no surface to reach:
`sessions` (list, revoke one, revoke the rest) and `api-keys` (issue, list,
revoke). `account.changePassword` is the third, and `changePassword` /
`listSessions` / `revokeSession` / `revokeSessions` / `listApiKeys` are new
optional methods on `IAuth` — a provider that has none of them answers 400 by
name, exactly as the reset routes already did.

**The rule is whether the call can be refused for want of a session.** Login
cannot be gated by login, so register, login, logout and the recovery flows stay
raw routes. Everything after that can be refused, and as a service it gets the
hook pipeline, the audit trail, schema validation, the WebSocket transport and
the browser client — none of which a hand-written route has.

**Every method is scoped to the CALLER.** No method takes a user id; the id a
caller supplies names a row and never an owner. Both revokes put `userId` INTO
the delete rather than checking it after a read, because the id is what a UI
hands back from a list, and matching on it alone ends anyone's session whose id
can be guessed. The tests name the other person's ids and assert nothing happens.

`SessionContext.sessionId` is new on the session path — a caller listing where
they are signed in has to be told which row is the one asking, and comparing
raw tokens to work that out would put a bearer token in front of app code.

Two options on the plugin: `services` renames or drops any of the three (a name
another service already claims is refused at BOOT, naming the option, because
the registry is a Map and the alternative is a silent replacement), and
`services: { level }` makes `account.me` answer the caller's gate level. That
one is opt-in on purpose: the app owns the role→level mapping, and a default
answer here would be a second one, disagreeing exactly where it matters.

## 2026-08-15 — four hooks an app can act on, and a throw refuses (FJS-042)

The package emitted nothing, so an app could not rate-limit, lock out or notify
without wrapping the routes. `onLogin`, `onLoginFailed`, `onLogout` and
`onRegister` are options on `createLitestoneAuth` — the same shape
`onPasswordResetRequested` already had, so no new vocabulary, and identical
whether or not Junction is in the picture.

**Awaited, and a throw refuses.** That is what makes lockout possible at the auth
layer rather than only in a hook in front of the route, and it is the cost too: an
app handler is now a failure mode on the login path. Single handlers rather than a
bus, because each is a decision and a decision has one owner; a second listener
that wants to observe belongs on Junction's `app.events`, and that question is
left open deliberately.

**One ordering rule — a hook runs before the thing it can refuse.** So none is
handed what its refusal would have prevented: `onLogin` gets no session id,
`onRegister` no user row. A hook that both refuses a thing and reports its result
cannot exist, and getting it backwards leaves behind exactly what was refused —
a session for a login that never happened. The hook is the gate; `db.$audit` is
the record.

`login.failed` is written BEFORE `onLoginFailed` runs, so a hook that swaps the
401 for a 429 cannot erase the attempt. `onLogin` throwing records
`reason: 'refused-by-app'`.

## 2026-08-15 — a sign-in leaves a trail with a name on it (FJS-276/267)

The package emitted nothing and recorded only what `@@log(audit)` picked up as a
side effect of a write: a sign-in as `create:session` with **`actorId: null`**,
and a failed sign-in as **nothing at all** — the event an app most wants, for
rate-limiting, lockout and alerting.

Four events now go through litestone's `db.$audit`, beside those rows rather
than instead of them: `login.succeeded`, `login.failed` and `logout`. The
`create:session` row records the WRITE and cannot name the actor; these record
the EVENT and do.

**Every login refusal still answers the same error.** Telling a caller whether an
address exists is an enumeration oracle, so the three branches — no such user, no
password credential, bad password — are distinguishable by `reason` in the trail
and nowhere else. The attempted ADDRESS is recorded, deliberately: a spray across
many addresses is invisible without it, and it is the only identifier an attempt
on an unknown user has. The attempted password is not, and a test asserts it
appears nowhere.

**Two softenings, both on the login path.** An app need not declare a logger
database — this package's fragment does, but an app may bring its own `User`, and
a login that throws because there is nowhere to write the record is worse than
the missing record. And a failed audit write does not fail the request; it is
reported rather than swallowed. An app that wants a sign-in refused when it
cannot be recorded says so itself — that is a policy this package should not make
quietly.

`FJS-042` remains open and is now only what it should always have been: no
actionable HOOK. The recording half is closed.

## 2026-08-15 — the schema ships as `.lite`, split by who owns the model

`fli auth:install` carried a hand copy of these four models and it had drifted
three times — pre-rename scalars that no longer parse, a missing `role`, and
`@@gate("9")`, which is LOCKED and walled the auth tables off from this package
itself. Two walls had kept the copy there, not one: `fli` is global, so this
package is not installed beside it — and **`fli` runs on node** while `schema.ts`
is TypeScript, so even resolved it could not be imported.

Bytes get past both. `db/user.lite` and `db/auth.lite` are the source now;
`schema.ts` reads them and so does the CLI, through auth's own `exports`
(`@frontierjs/auth/user.lite`, `@frontierjs/auth/schema.lite`). `FJS-038`.

**The split is by owner, and the gate already stated it.** `User` is
`@@gate("4.4.4.5")` with row and field policies an app changes; it grows columns,
relations point at it, and `sessionFields` reads it — so it is APPENDED into the
app's own `schema.lite` where it can be seen and edited. `Credential`, `Session`
and `Verification` are `8`, meaning nothing outside `asSystem()` has anything to
say to them and this package is the only caller that does — so they are a file
the app imports, and an upgrade here reaches an installed app without a re-inject.

`authSchemaFragments(db)` still answers both halves for a caller assembling one
schema string in memory (`example/api/db.ts`, this package's test harness).
`authUserModel` / `authMachineryModels` are the halves.

**A shipped `.lite` cannot interpolate**, so it spells `@@db(main)` — redundant
to the parser, which already reads an absent `@@db` as main, and load-bearing to
`retargetDb`, which is how `--db` works. The substitution is line-anchored:
both files discuss the attribute in their own headers, and a bare `replaceAll`
rewrote that prose into a description of a swap it no longer showed. That rule is
the one thing the CLI still restates, and the suite lifts its arrow out of
`install.md` and runs it against the shipped bytes rather than comparing text.

## 2026-08-14 — the fragment ships what bounds the level, not just the level

`FJS-170` moved `User` from `@@gate("8")` — a level no request reaches, so an
app could not list its own people — down to `"4.4.4.5"`, and stated the
remaining gap in a comment rather than closing it: *update at USER means any
signed-in caller may write any user row, its role column included*. Basecamp
then shipped that gap for three days and a `developer` promoted themselves to
the hub tier through it (`FJS-177`), which is the argument for the fragment
carrying the whole shape rather than an instruction to add the rest.

Now declared here:

- `@@allow('update', id == auth().id || auth().isAdmin)` — whose row.
- `@allow('write', auth().isAdmin)` on `role` and `emailVerified` — which
  columns. These are what a resolver grades on, and **a column the caller can
  write is not a column a level can be graded from**. Self-verifying an address
  is skipping the verification.

`auth().isAdmin` rather than a role string, because it is the standing
`FrontierGateGetLevel` and `sessionGateLevel()` both read for ADMINISTRATOR(5) —
the level that deletes a person is the level that sets their role. What
`'admin'` MEANS stays the app's decision, made once in `sessionFields`; both CLI
scaffolds now grade standing and project `role === 'admin'` onto it there,
instead of matching the string in a resolver while the schema read another
field.

`Credential` / `Session` / `Verification` stay at 8, which is the case 8 is
for. Ruled in `DECISIONS.md` § Access control.

The suite states the ladder through refusals — a stranger by level, another
user's row by policy, `role`/`emailVerified` by field policy, an ADMINISTRATOR
doing both — and a new test parses the CLI's hand copy and compares what the two
files DECLARE, because prose asking them to stay in sync is what failed three
times. Verified by breaking it.

## 2026-08-13 — the rate limiter is junction's, not a copy of it

`plugin.ts` carried its own limiter, on the stated grounds that junction's hook
*"operates on ServiceContext, which has `ctx.params.ip`"* while `/auth/*` routes
hold a TransportContext with `ctx.ip`. A ServiceContext has no `params` at all,
so the premise was wrong; the real gap was one accessor, and junction's
`clientIp()` now answers for both shapes. Its hook also reaches `auth`
optionally, because a sign-in route has no principal by definition.

The copy had already drifted: it returned before checking the limit on a fresh
bucket, so `loginRateLimit: { max: 0 }` let one attempt through. `FJS-017`.

The plugin gained a `shutdown()` that disposes both limiters' sweep timers.

## 2026-08-10 — the package is shippable (FJS-003)

Three defects, one shape: the package was written as a folder in a workspace
rather than as a thing that leaves it.

**Eight imports of `../junction/index.ts`** across `auth.ts`, `plugin.ts`,
`types.ts`, `crypto.ts` and `cleanup.ts` — a relative path *out of the package
root*, which resolves only while the package sits next to junction in this repo.
Three of the eight are runtime values (`parseTtl`, `createScheduler`,
`Unauthorized`/`BadRequest`/`TooManyRequests`), so an installed copy did not
merely typecheck wrong, it threw on import. All eight are now
`@frontierjs/junction` — the specifier conduit, caravan, notifications, basecamp
and `sierra/example` were already using. auth was the only package reaching out
by path.

**The peer range was `"*"`** — the pattern that produced the litestone dialect
trap, where a floating range agreed with the workspace by luck. Now `^0.1.0`.

**There was no `files` field**, so `npm pack` shipped `tests/`, `tsconfig.json`,
`PROJECT_STATE.md` and `CHANGES.md`. Now `["*.ts", "README.md"]` — 10 files.
The consequence to know: a new source file at the package root ships, a new
*directory* does not.

Proven the way the issue was found rather than by reading the diff: `npm pack`,
install the tarball into an empty project, import it, call `createAuthPlugin`.
83 tests unchanged and green, typecheck unchanged at its baseline of 4.

`@frontierjs/junction` is still a 404 on the registry, so `npm i
@frontierjs/auth` cannot satisfy its own peer until junction ships. That is
junction's blocker now, not auth's.

## 2026-08-10 — an app's own User columns can reach the session

`createLitestoneAuth(db, { sessionFields })`. Additive; 83 tests unchanged and
green, `example/` 37/37 unchanged.

**The gap.** This package OWNS `model User` and every app that uses it EXTENDS
that model — basecamp adds `kind`, `status`, `isSystemAdmin` and `scopes`. Two
of those decide what a request may do, and there was no way to get either onto
the `SessionContext`. The only route open to an app was to wrap
`verifySession` and re-read the user: a **third query on the hottest path in the
app, forever**, for a row `toContext()` had just fetched.

`sessionFields(user)` is called from `toContext()`, which is the single place
every issued session is built — so one hook covers login, `verifySession`, an
API key and `createUser` alike, rather than four call sites an app has to know
about.

Two kinds of thing belong in it. The **standing** `sessionGateLevel()` grades on
(`isAdmin` / `isOwner` / `isSystemAdmin` / `activatedAt` / `verifiedAt`), which
is how an app whose privileged bit is its own column reaches `@@gate` at all;
and the app's own keys, which travel on the session untouched — the framework
reads none of them and the app's hooks read all of them.

It is spread **last**, so an app that states a field wins. The other order would
mean adding any key to `toContext` silently overrides what an app asked for,
which is a breaking change nobody would see. The doc comment says not to restate
the caller identity through it; that is not the app's to decide.

Found building basecamp's hub tier, which needs `isSystemAdmin` on every request
to grade a caller and `status` to refuse a suspended one.

## 2026-08-09 — an API key can now be used

83 tests (was 74). Found building basecamp's `/api-keys/` screen: the whole
API-key half of `IAuth` was implemented, tested, and unreachable.

**An issued key authenticated nothing** (`FJS-134`). Junction's HTTP transport
resolves a Bearer token through `auth.verifySession()` and calls `verifyApiKey`
nowhere — the better-auth provider knows that and falls through, this one did
not. `createApiKey()` returned a token that was anonymous on every request, and
the failure looked like a bad token rather than a missing code path.
`verifySession` now routes on the `fjs_` prefix (this package generates it, so
a machine request costs no wasted session lookup) and falls back for anything
that missed.

**A key's scopes were stored and then dropped** (`FJS-135`). `createApiKey`
writes them into `Credential.scope`; `verifyApiKey` built its answer from the
USER row, which knows nothing about keys, so `SessionContext.scopes` was always
`undefined`. A key issued `servers:read` had the full standing of the person
who made it. The session now carries `scopes` — absent, not `[]`, when none
were issued, the same absent-≠-null rule `verifiedAt` follows — and a new
`credentialId`, without which an app cannot tell WHICH of a user's keys made a
call.

**`revokeApiKey` revoked nothing on any app with uuid credential ids**
(`FJS-136`). It coerced `Number(keyId)` because `schema.ts` ships
`Credential.id Int` — but the fragments are a starting point apps edit, and
`Number(uuid)` is `NaN`, which matches no row and throws nothing. Revoke
reported success and the key kept working. The coercion is gone, the delete is
filtered on `type: 'apiKey'` so a wrong id cannot take a password with it, and
a revoke that matches nothing throws.

### One behaviour change: verifying is quiet, issuing is loud

`verifyApiKey` used to throw `AuthConfigError` when no `encryptionKey` was
configured. It answers `null` now. It runs on attacker-supplied input on every
request — and `verifySession` falls through to it — so throwing made a 500
anybody could trigger with a Bearer header, in an app that may have no API keys
at all. `createApiKey` still throws, which is where a developer is standing.

## 2026-08-06 — `cookieAuth: true` actually authenticates

74 tests (was 70).

The cookie was set correctly all along — `session=…; HttpOnly; SameSite=Lax`,
`Max-Age` derived from `sessionTtl`. Nothing read it back. Junction's
`extractToken()` looked at `authorization: Bearer` and `x-api-key` only, so
`ctx.user` was never resolved from a cookie and a cookie-only request to any
protected route — including this plugin's own `GET /auth/me` — was 401. Login
and logout worked, because those go through this package's own `extractToken`,
which has always had a `ctx.cookies?.session` fallback. Everything in between
did not. `ISSUES.md` FJS-002.

**The plugin now declares the mode**, in `register()`:

```ts
if (cookieAuth) app.http?.setAuthCookie?.('session')
```

That is deliberately here rather than asked of the app. Junction keeps cookie
reading off by default — a Bearer token cannot be forged cross-site, a cookie
travels automatically, so the CSRF exposure is opt-in — and if the app had to
enable it *separately* from `cookieAuth: true`, the half-configured state would
be exactly the bug above: cookie set, cookie ignored. One switch.

`SameSite=Lax` is what makes the mode safe once on, and this package was already
setting it: the browser withholds the cookie from cross-site writes.

The marker test flipped. `KNOWN GAP: a cookie alone does not authenticate a
request` (asserting 401) is now `a cookie alone authenticates a request`
(asserting 200), plus four covering no cookie, a garbage cookie, the emptied
cookie a logout leaves, and Bearer-beats-cookie precedence.

Applied during the 2026-07-25/26 FrontierJS pass. Baseline was the archive dated
2026-05-07.

## Table accessors are singular

`auth.ts` (33 call sites), `cleanup.ts` (2).

Reported from a running app:

```
error: "users" is not a table in this schema.
  at get (litestone/src/core/client.js:5967)
  at login (auth/auth.ts:101)
```

The package called `sys.users`, `sys.credentials`, `sys.sessions`,
`sys.verifications`. Litestone's `modelToAccessor` is plain camelCase of the
model name (`src/core/ddl.js`), and the documented convention is PascalCase
singular — so `model User` is reached as `db.user`. The plural accessors only
worked against a schema that broke the convention, and failed the moment an app
wrote its schema the documented way.

All 35 call sites are now singular.

## authSchemaFragments() emitted an unparseable schema

`schema.ts`.

Two problems, which concealed each other:

**Model names were lowercase plural** (`model users`), which matched the old
plural accessors above. Fixing only the accessors would have broken apps using
`fli auth:install`; fixing only the fragments would have broken apps that wrote
their own schema. Both had to move together.

**Type names were `Text` and `Integer`.** Litestone lists both in
`RENAMED_TYPES` and rejects them outright — *"Type 'Text' was renamed to
'String'. Update your schema (no aliases are accepted)"*. So the fragments this
package injects did not parse against current Litestone **at all**, at line 12,
before reaching any of the model-name issues.

Fragments now declare `User`, `Credential`, `Session`, `Verification` using
`String` / `Int` / `Float` / `Boolean` / `DateTime`.

**New:** `tests/schema-accessors.test.ts` — closes the loop the two bugs left
open: the schema this package ships must parse, and every accessor this package
calls must exist in it. Verified against both implementations — the original
fails at the parse step (`Type 'Text' was renamed`), the current one passes and
reports a clean four-way match between `user, credential, session, verification`
and what `auth.ts` calls.

## verifySession called a table method that doesn't exist

`auth.ts`, 4 call sites.

Reported as a redirect loop: sign in succeeds, then every attempt bounces back
to `/login/`.

`verifySession` — the hot path, run on every authenticated request — did:

```ts
const user = await sys.user.get(session.userId)
```

Litestone tables expose `findMany`, `findFirst`, `findUnique`,
`findFirstOrThrow`, `findUniqueOrThrow`, `count`, `exists`, `aggregate`,
`groupBy`, `findManyCursor`, `create`, `createMany`, `update`, `updateMany`,
`upsert`, `upsertMany`, `remove`, `removeMany`, `restore`, `delete`,
`deleteMany`, `search`. **There is no `get`.** (The `get` that turns up in
`client.js` is a Proxy trap.)

Why it presented as a loop rather than a plain failure: `login()` never calls
`.get()`, so `POST /api/auth/login` returned 200 and the token was stored. The
*next* request hit `verifySession`, threw, and answered 401. Junction's browser
client emits `unauthorized` on a 401; Sierra's handler clears the stored token
and redirects to `auth.redirectTo`. So the user lands back on the login page
with no token, signs in again, and repeats.

All four sites now use `findUnique({ where: { id } })`.

**Test:** `tests/schema-accessors.test.ts` gained a check that cross-references
every table method the package calls against Litestone's actual surface —
`get` was the only one missing, and it now fails loudly if another creeps in.

## Not changed, but worth knowing

- **`README.md` is stale in four places.** It shows `createLitestoneAuthPlugin`
  (the export is `createAuthPlugin`), `withLitestoneDb` imported from the
  junction root (it lives at `@frontierjs/junction/litestone`),
  `app.configure(withLitestoneDb(db))` (it returns an around-hook, not a plugin
  — the correct form is `app.hooks({ around: { all: [withDb] } })`), and a
  positional `createClient('./db/schema.lite', {...})` where the options-object
  form is used in practice. `types.ts` also refers to
  `createLitestoneAuthPlugin` in a comment.

- **Plugin routes don't inherit `apiPrefix`.** `createAuthPlugin` registers with
  `app.post()` / `app.get()` directly, and Junction applies `apiPrefix` only in
  `registerServiceRoutes`. The default prefix here is `/auth`, but Junction's own
  browser client hardcodes `/api/auth/login` in `authenticate()` — so with
  defaults on both sides they never meet, and every app has to pass
  `prefix: '/api/auth'`. Worth deciding which side should move.
