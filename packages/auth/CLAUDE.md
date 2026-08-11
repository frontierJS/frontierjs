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
  Change one, change both — it is a hand copy and it has drifted before.
- **`cookieAuth: true` works end to end** — the plugin declares the mode via
  `app.http.setAuthCookie('session')` and Junction reads it (FJS-002).
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
- **It still cannot go to npm, for junction's reason rather than its own** —
  `@frontierjs/junction` is unpublished, and it is a peer. No OAuth either. Its
  typecheck baseline is non-zero; see `scripts/typecheck-baselines.json`.

## Proving a change

`bun run test`, then `example`: `verify` (sign-in, gate ladder) and `basecamp`:
`verify` (first-run setup, login, the navigation guard).
