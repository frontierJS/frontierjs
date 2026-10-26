# auth — package map

**`@frontierjs/auth`.** A native `IAuth` implementation over Litestone's
`asSystem()` client, plus the schema fragments it contributes into the app's schema
and the `/auth/*` route plugin. `bun run test` (bun).

---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `auth.ts` is the `IAuth` implementation — sessions, login, verification; `firstFactorProven()` is the one tail every first factor ends at, `issueSession` the one place a session is minted, `toContext()` the one place a session context is built, `credentialChanged()` the one credential observer.
- `plugin.ts` is `auth()` — mounts `/auth/*` (the raw routes, with their own body reader `BODY_FIELDS`), declares the cookie mode, registers the three services at `boot()`.
- `services.ts` is `account` / `sessions` / `api-keys` — the half that is NOT a route; `refuseDelegated` and `fresh()` guard every credential write.
- `oauth.ts` is the flow engine — URL, code-for-token trade, normalized identity; no HTTP, no database, no session.
- `db/user.lite` is `model User`, APPENDED into the app's `schema.lite`; `db/auth.lite` is the machinery (`Credential` / `Session` / `Verification` / `LoginChallenge` / `OauthFlow`), IMPORTED and `extend model`ed; `schema.ts` reads both (`retargetDb` is `--db`).
- `tenancy.ts` reads the app's `tenancy` block · `totp.ts` is RFC 6238, clockless, shipped as `@frontierjs/auth/totp` · `cleanup.ts` is the expired-row sweep · `crypto.ts` hashing and `expiresAt(ttl, now)` · `errors.ts` carries each error's `status`.

## What bites here

The fifteen that bite most; the full catalog is `docs/hazards.md`, read it before
touching a login path, a credential write, a `.lite` fragment or a callback.

- **A route ESTABLISHES a session; everything after it is a service** (`FJS-D20`). Login cannot be gated by login; `me`, sessions, keys and the password can be refused and so get the hook pipeline.
- **`login()` returns a session OR `{ challenge, expiresAt }`** (`FJS-D261`); every caller discriminates on `'challenge' in result`. A `totp` credential EXISTING is what makes a login owe a code; enrollment writes `totpPending` and only `confirmTotp` promotes it.
- **Every first factor ends at `firstFactorProven()`** — password, magic link (`FJS-D888`), OAuth (`FJS-D915`), a registration click (`FJS-D1310`). A new door that reaches `issueSession` directly is a way past the second factor; `requireSecondFactor` holds an `enrollmentOnly` session rather than refusing (`FJS-D1008`).
- **Only a `kind: user` signs in, and `issueSession` is where that is refused** (`FJS-D1198`). A bot or peer holds API keys only.
- **A refused proof inside a live session is 403, never 401** (`FJS-1088`) — sierra signs the person out on a 401. `login()` and `completeLogin` hold no session and keep 401.
- **A credential change asks whether the SESSION proved a password recently** (`FJS-D1209`): `fresh(user)` after `refuseDelegated` on every method that changes how the account signs in, and such a change ends every OTHER session through `endOtherSessions` (`FJS-D1208`).
- **A support operator and an agent over `/mcp` are refused the same writes** — `refuseDelegated(ctx, user, what)` on every credential write, never on a read (`FJS-1795`, `FJS-D628`).
- **Ownership is in the WHERE.** No service method takes a user id; `revokeSession` and `revokeApiKey` put `userId` into the delete, never check after a read.
- **A new password is graded in ONE place, `requireStrongPassword`**, before a token is spent (`FJS-2349`); `test/harness.ts` sets `min: 1`.
- **An app IMPORTS `db/auth.lite` and says the rest with `extend model`**, never pastes — a pasted copy drifted `@secret` to `@guarded` with 137 green tests either side. `User` alone is APPENDED (`@@gate(4.4.4.5)`, the other models `8`); `@@db(main)` in the shipped `.lite` is load-bearing to `retargetDb` (`FJS-038`).
- **`User`'s gate is per MODEL; the `@@allow`/`@allow` policies are what bound it** (`FJS-1591`), and they read `auth().isAdmin`, so an app projects it in `sessionFields` — which is synchronous, spread LAST, and a promise from it is refused by name (`FJS-1251`).
- **Every callback takes ONE event object and states its tier** (`FJS-D1332`): four Hooks that refuse by throwing, run BEFORE the thing they can refuse; `onRegistered({ user, db })` runs INSIDE the registration (`FJS-D520`); `onPasswordResetRequested` and `onMagicLinkRequested` are Observers that run after the answer (`FJS-1832`).
- **Every login refusal answers the same error, records a different `reason`, and pays the bcrypt cost** (`payPasswordCost`, `FJS-063`); `login.failed` is written before `onLoginFailed` can change it (`FJS-277`). A failed audit write is reported, never fatal.
- **A raw route reads its body through `plugin.ts`'s own reader** (`FJS-296`, `FJS-1002`); a token-spending route is a POST (`FJS-1839`, `FJS-D616`); register is verify-first wherever the app mails (`FJS-D1310`).
- **Auth reads ONE clock, `sys.$now()`, never `new Date()`**, and four models carry `@@expires`, so a delete that narrows by anything but a row just read spreads `PURGE` (`FJS-D351`); `cleanup.ts`'s predicate is `{ onlyExpired: true }` and `sweepNow()` is how tests grade it (`FJS-1000`).

## Proving a change

`bun run test`, then `example`: `verify` (sign-in, gate ladder) and `basecamp`:
`verify` (first-run setup, login, the navigation guard). A change to the second
factor — `totp.ts`, `completeLogin`, the challenge route, the `account` TOTP
methods, `account-recovery`, `onCredentialChanged` — also runs `example`:
`verify:users`, the only place the two-step login crosses a real app and the
only place a notification is read back out of an outbox.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
auth.ts cleanup.ts crypto.ts errors.ts index.ts oauth.ts package.json plugin.ts schema.ts 
services.ts tenancy.ts totp.ts types.ts 
-->
