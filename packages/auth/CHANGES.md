# Changes — @frontierjs/auth

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
