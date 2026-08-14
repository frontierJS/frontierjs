# auth — package map

**`@frontierjs/auth`.** A native `IAuth` implementation over Litestone's
`asSystem()` client, plus the schema fragments it contributes into the app's seed
and the `/auth/*` route plugin. `bun run test` (bun).

---

## Layout

```
auth.ts      the IAuth implementation — sessions, login, verification
plugin.ts    createAuthPlugin() — mounts /auth/*, declares the cookie mode
schema.ts    authSchemaFragments(db) — auth's models, contributed INTO the seed
crypto.ts    hashing / token generation
cleanup.ts   expired-session pruning
errors.ts    the auth error classes (each carries its own `status`)
types.ts     the public types
index.ts     public API
```

---

## What bites here

- **`/auth/*` deliberately bypasses the Service abstraction** — login cannot be
  gated by login. That is a decision, not an omission.
- **`schema.ts` is duplicated by the CLI**, in `packages/cli/commands/auth/install.md`.
  Change one, change both — it is a hand copy and it has drifted three times.
  `tests/schema-accessors.test.ts` now compares what the two DECLARE (gate, row
  policies, field policies) rather than trusting the instruction; comments may
  differ, an access rule may not.
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
