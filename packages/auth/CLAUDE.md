# auth — package map

**`@frontierjs/auth`.** A native `IAuth` implementation over Litestone's
`asSystem()` client, plus the schema fragments it contributes into the app's seed
and the `/auth/*` route plugin. `bun run test` (bun).

---

## Layout

```
auth.ts      the IAuth implementation — sessions, login, verification
plugin.ts    createAuthPlugin() — mounts /auth/*, declares the cookie mode,
             and registers the three services at boot()
services.ts  account / sessions / api-keys — the half that is NOT a route
db/user.lite      model User — the app's. Appended into its schema.lite
db/auth.lite      Credential / Session / Verification — imported, not pasted
schema.ts    reads those two: authUserModel / authMachineryModels /
             authSchemaFragments (both) / retargetDb
crypto.ts    hashing / token generation
cleanup.ts   expired-session pruning
errors.ts    the auth error classes (each carries its own `status`)
types.ts     the public types
index.ts     public API
```

---

## What bites here

- **A route ESTABLISHES a session; everything after it is a service.** Login
  cannot be gated by login, so register / login / logout / password-reset /
  email-verify are raw routes and always will be. The line is whether the call
  can be REFUSED for want of a session: `me`, the caller's other sessions, their
  API keys and their password all can, so they are ordinary services and get the
  hook pipeline, the audit trail, validation and both transports. `GET /auth/me`
  is `account.get('me')` (`FJS-D20`, `DECISIONS.md` § API design).
- **Every service method is scoped to the caller, and the ownership is in the
  WHERE.** No method takes a user id; the id a caller supplies names a row, never
  an owner. `revokeSession` and `revokeApiKey` put `userId` into the delete
  rather than checking after a read — the id is what a UI hands back from a list,
  and matching on it alone ends anyone's session whose id can be guessed.
- **The three names are options, and a collision is refused at BOOT.** The
  registry is a Map, so the alternative is one of the two silently replacing the
  other depending on registration order — basecamp has its own `api-keys` (a
  workspace's, not a person's) and turns auth's off by name. Registration is in
  `boot()` rather than `register()` because autoload runs first, so a collision
  is visible from there whichever order the two were written in.
- **`services: { level }` is opt-in and absent by default.** The app owns the
  role→level mapping — whatever it passed to `GatePlugin({ getLevel })` — and a
  default answer on `account.me` would be a SECOND mapping that disagrees with
  the one every request is graded by, silently, and only near a gate boundary.
- **The two `.lite` files are the source; `schema.ts` reads them and the CLI
  reads them.** `fli auth:install` carried a hand copy of these models and it
  drifted three times, because two walls held it up: `fli` is global so the
  package is not beside it, and `fli` runs on **node** while this file is
  TypeScript, so even resolved it could not be imported. Bytes get past both
  (`FJS-038`). The split is by owner, and the gate already states it — `User` is
  `@@gate("4.4.4.5")` with policies an app changes, so it is APPENDED into the
  app's own `schema.lite`; the other three are `8`, so they are a file the app
  imports and an upgrade reaches without a re-inject.
- **A shipped `.lite` spells `@@db(main)` although an absent `@@db` already means
  main.** The literal is redundant to the parser and load-bearing to
  `retargetDb`, which is how `--db` works at all; tidy it out and the flag
  silently stops. The substitution is **line-anchored** because both files
  discuss the attribute in their own headers, and a bare `replaceAll` rewrote
  that prose into a lie. That rule is the one thing the CLI still restates — it
  cannot import this file — so `tests/schema-accessors.test.ts` lifts its arrow
  out of `install.md` and runs it against the shipped bytes.
- **`cookieAuth: true` works end to end** — the plugin declares the mode via
  `app.http.setAuthCookie('session')` and Junction reads it (FJS-002).
- **`User` is `@@gate("4.4.4.5")` and the level is not what makes it safe.** A
  gate is per MODEL, so that alone says *any signed-in caller may write any user
  row*. The fragment ships the two declarations that bound it:
  `@@allow('update', id == auth().id || auth().isAdmin)` for whose row, and
  `@allow('write', auth().isAdmin)` on `role` and `emailVerified` for the columns
  a resolver grades on — a column the caller can write is not a column a level
  can be graded from. `8` stays on `Credential` / `Session` / `Verification`,
  which is what 8 is for: a model nothing outside `asSystem()` has anything to
  say to. Ruled in `DECISIONS.md` § Access control (2026-08-14).
- **An app says what `'admin'` means once, in `sessionFields`.** The policies
  read `auth().isAdmin` — the same standing `FrontierGateGetLevel` and
  `sessionGateLevel()` grade ADMINISTRATOR(5) from — so an app whose resolver
  keys on a role string must project it (`{ isAdmin: user.role === 'admin' }`)
  or the level and the policy disagree, silently, because a policy filters
  rather than refuses. Both scaffolds and `example/api/app.ts` do this.
- **This package owns `model User`; apps EXTEND it, and their columns reach the
  session through `sessionFields` — nothing else.** `toContext()` is the single
  place every issued session is built, so the hook covers login,
  `verifySession`, an API key and `createUser` at once. It is spread LAST, so an
  app that states a field wins; adding a key above it would otherwise silently
  override what an app asked for. **Do not tell an app to wrap `verifySession`
  and re-read the user** — that is a third query on the hottest path in that
  app, forever, for a row `toContext()` already holds, and it is the thing this
  option exists to remove.
- **Four awaited callbacks, and A THROW REFUSES** — `onLogin`, `onLoginFailed`,
  `onLogout`, `onRegister` (`FJS-042`). The same shape `onPasswordResetRequested`
  already had, so no new vocabulary; single handlers, not a bus, because each is
  a decision and a decision has one owner. A second listener that wants to
  OBSERVE belongs on Junction's `app.events`, which is a separate question and
  is not answered here. The cost is stated rather than hidden: an app handler is
  now a failure mode on the login path, and a slow one slows every sign-in.
- **One ordering rule: a hook runs BEFORE the thing it can refuse.** So none is
  handed what its refusal would have prevented — `onLogin` has no session id,
  `onRegister` has no user row — because a hook that both refuses a thing and
  reports its result cannot exist. **The hook is the gate, `db.$audit` is the
  record.** Get this backwards and a refusal leaves behind exactly what it
  refused: a session for a login that never happened, a user for a registration
  that was blocked. The suite asserts the absence, not just the throw.
- **A refusal is recorded before the hook can change it.** `login.failed` is
  written first, then `onLoginFailed` runs — so a hook that swaps the 401 for a
  429 cannot also erase the attempt from the trail. `onLogin` throwing records
  `reason: 'refused-by-app'` with the message: a veto that leaves no trace is
  the class of defect `FJS-277` was.
- **Auth records four events through `db.$audit`, beside the `@@log(audit)` rows
  rather than instead of them.** `login.succeeded`, `login.failed`, `logout` —
  `@@log` covers writes, so it covered the sign-in (`create:session`, with
  `actorId: null`, because an `asSystem()` write names no principal) and missed
  the failed attempt entirely, which is the one an app rate-limits on
  (`FJS-276`, `FJS-277`). The `create:session` row records the WRITE and cannot
  name the actor; this one records the EVENT and does.
- **Two softenings on the login path, both deliberate.** An app is not required
  to declare a logger database — auth's own fragment does, but an app may bring
  its own `User`, and a login that throws because there is nowhere to write the
  record is a worse failure than the missing record. And a failed audit WRITE
  does not fail the request; it is reported, not swallowed. An app wanting a
  sign-in refused when it cannot be recorded has to say so itself. The
  `hasAuditLog` guard is not redundant with the `try`/`catch`: without it every
  such app gets a warning on every sign-in, forever, and the suite stays green —
  which is why the test asserts the QUIET, not just the success.
- **Every login refusal answers the same error and records a different
  `reason`.** Telling a caller whether an address exists is an enumeration
  oracle, so the three branches are distinguishable in the trail and nowhere
  else — **including on the clock.** The two branches that never reach the
  password comparison pay its cost anyway (`payPasswordCost`), because an early
  return answered in a millisecond against ~220ms and read off which addresses
  have accounts through a message that says nothing (`FJS-063`). A new refusal
  branch added above the bcrypt has to pay it too. The attempted address IS
  recorded — a spray across many addresses is
  invisible without it, and it is the only identifier an attempt on an unknown
  user has. The attempted password never is.
- **A raw route has no validator in front of it, so `plugin.ts` carries its
  own.** `autoValidate` is derived from the model and runs in a service
  pipeline; these eight routes are upstream of every service, and `ctx.body` is
  `unknown` — whatever a caller posted. One reader checks it: a declared field is
  a string or the request is a 400 naming it, and an undeclared key does not
  travel. Without it `{ "email": { "contains": "@" } }` reached
  `findFirst({ where: { email } })` as a where-operator and the address was a
  FILTER (`FJS-296`). **A new route reads its body through that reader**; a new
  field is a line in `BODY_FIELDS`.
- **A session is graded, not trusted.** `sessionGateLevel()` (in Junction) turns
  a `SessionContext` into Litestone's 0–7 scale, and `toDataPrincipal()` turns it
  into the principal `auth()` reads. Absent ≠ null: an app with no verification
  flow must not grade down.
- **Ids are uuids, not ints.** The audit log's `actorId` is `Any` for exactly
  this reason; a STRICT INTEGER column throws on the first audited write.
- **Junction is imported by SPECIFIER — `@frontierjs/junction`, never a relative
  path.** `../junction/index.ts` resolves inside the workspace and nowhere else,
  so the tarball imported nothing and said so only on install. `files` in
  `package.json` is `["*.ts", "README.md"]`: a new source file at the package
  root ships, a new directory does not.
- **It is shippable — its peer went to npm on 2026-08-10.** A `bun add` of the
  auth tarball into an empty project resolves `@frontierjs/junction@^0.1.0` from
  the registry and imports. Still no OAuth, and its typecheck baseline is
  non-zero; see `scripts/typecheck-baselines.json`.

## Proving a change

`bun run test`, then `example`: `verify` (sign-in, gate ladder) and `basecamp`:
`verify` (first-run setup, login, the navigation guard).
