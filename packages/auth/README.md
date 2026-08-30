# @frontierjs/auth

FJS native authentication. One import. Four schema models. Everything derived.

## Install

```bash
fli auth:install
```

Or manually:

```bash
bun add @frontierjs/auth
```

## Setup

```typescript
// api/src/auth.ts
import { createLitestoneAuth, createAuthCleanupJobs } from '@frontierjs/auth'
import { createClient, GatePlugin, LEVELS }           from '@frontierjs/litestone'
import { defineEnv }                                  from '@frontierjs/junction'

export const env = defineEnv({
  ENCRYPTION_KEY: { required: true, minLength: 64 },
  APP_URL:        { required: true },
})

// `path` is a .lite FILE; `schema` is inline text. One options object, never
// positional. `encryptionKey` is 64 hex characters — parsed as hex, so 64
// characters of anything else decodes short and is refused by name.
export const db = await createClient({
  path:          './db/schema.lite',
  encryptionKey: env.ENCRYPTION_KEY,
  plugins: [
    new GatePlugin({
      getLevel(user) {
        if (!user)                 return LEVELS.STRANGER
        if (user.isAdmin)          return LEVELS.ADMINISTRATOR
        return LEVELS.USER
      }
    })
  ],
})

export const auth = createLitestoneAuth(db, {
  // The same key. It is the HMAC secret API keys are hashed with, and
  // createApiKey() throws at call time without it.
  encryptionKey: env.ENCRYPTION_KEY,

  // What 'admin' means in THIS app, said once. The shipped policies read
  // `auth().isAdmin`, which is the standing sessionGateLevel() grades
  // ADMINISTRATOR(5) from — so an app keying on a role string must project it
  // here or the level and the policy disagree, silently, because a policy
  // filters rather than refuses.
  sessionFields: (user) => ({ isAdmin: user.role === 'admin' }),

  onPasswordResetRequested: async (email, token) => {
    await mailer.send({
      to:      email,
      subject: 'Reset your password',
      html:    `<a href="${env.APP_URL}/auth/password-reset/confirm?token=${token}">Reset</a>`,
    })
  },
  onEmailVerificationRequested: async (email, token) => {
    await mailer.send({
      to:      email,
      subject: 'Verify your email',
      html:    `<a href="${env.APP_URL}/auth/email/verify?token=${token}">Verify</a>`,
    })
  },
})

export const authCleanup = createAuthCleanupJobs(db)
```

```typescript
// api/src/server.ts
import { auth, db, authCleanup } from './auth.ts'
import { createAuthPlugin }      from '@frontierjs/auth'
import { createApp }             from '@frontierjs/junction'

// `db` on createApp installs withLitestoneDb for you — it is an around hook,
// not a plugin, and it is what puts a per-request scoped client on
// ctx.locals.db. Passing it here is the one wiring; app.configure() of it is
// not a thing.
const app = createApp({ auth, db })

// Mounts /auth/* and registers the account / sessions / api-keys services.
app.configure(createAuthPlugin(auth))

app.configure({
  name: 'auth-cleanup',
  register() {},
  async boot() { authCleanup.start() },
})

await app.start()
```

A working version of exactly this is [`example/api/src/app.ts`](../../example/api/src/app.ts),
driven end to end by `example`'s `bun run verify`.

## Routes

**A route is what ESTABLISHES a session; a service is what the caller does to
their own credentials afterwards.** Login cannot be gated by login, so the
first list bypasses the Service abstraction on purpose — and everything in the
second list can be refused for want of a session, so it is an ordinary service
and gets the hook pipeline, the audit trail and both transports rather than a
hand-rolled route. `DECISIONS.md` § API design.

Paths below are the plugin's own `prefix` (default `/auth`). They are
registered with `app.post`/`app.get`, so the app's `apiPrefix` applies to them
like it does to every other route — an app configured with `apiPrefix: '/api'`
serves login at `/api/auth/login`, and the browser client's `authPrefix` stays
relative to `apiPrefix` for the same reason.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | Create account + issue session |
| `POST` | `/auth/login` | Login, returns token |
| `POST` | `/auth/logout` | Revoke current session |
| `POST` | `/auth/password-reset/request` | Send reset email |
| `POST` | `/auth/password-reset/confirm` | Confirm reset with token |
| `POST` | `/auth/email/verify/request` | Re-send verification email |
| `GET`  | `/auth/email/verify?token=` | Verify email with token |

## Services

Registered by the same plugin, at the app's own service root. Every method is
scoped to the CALLER — nothing here takes a user id, because acting on somebody
else's account is a different service with a different gate.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/account/me` | The caller's session — what `/auth/me` was |
| `POST` | `/account/me` + `X-Service-Method: changePassword` | Verify the current password, then replace it |
| `GET`  | `/sessions` | Where else this caller is signed in; the current one is marked |
| `DELETE` | `/sessions/{id}` | End one of them |
| `POST` | `/sessions` + `X-Service-Method: revokeOthers` | Sign out everywhere else |
| `GET`  | `/api-keys` | The caller's keys — never the key itself |
| `POST` | `/api-keys` | Issue one. **The raw key is in this response and nowhere else** |
| `DELETE` | `/api-keys/{id}` | Revoke one |

In a browser they are `client.auth.me()`, `.changePassword()`, `.sessions()`,
`.revokeSession(id)`, `.revokeOtherSessions()`, `.apiKeys()`, `.createApiKey()`
and `.revokeApiKey(id)` — and a Sierra app gets a reactive `session` object over
the top (`@frontierjs/sierra/junction`).

Rename or drop any of the three with `services`, and add a `level` resolver to
have `account.me` answer the caller's gate level:

```ts
app.configure(createAuthPlugin(auth, {
  services: { apiKeys: false, level: myGateLevel },
}))
```

A name another service already claimed is refused at boot, naming the option —
the registry is a Map, so the alternative is one of the two silently replacing
the other depending on which registered last.

## Schema models

Injected into `db/schema.lite` by `fli auth:install`:

- `User` — identity. `@@gate("4.4.4.5")` — read, create and update USER(4),
  delete ADMINISTRATOR(5) — bounded by `@@allow('update', id == auth().id ||
  auth().isAdmin)` and `@allow('write', auth().isAdmin)` on `role` and
  `emailVerified`. A level says what kind of caller, a policy says whose row, a
  field policy says which columns; identity needs all three, and the columns a
  gate is graded from are exactly the ones a caller must not write. `@@log(audit)`
- `Credential` — passwords + API keys (`@@gate("8")` — SYSTEM)
- `Session` — active sessions (`@@gate("8")`, `@@log(audit)`)
- `Verification` — reset + verify tokens (`@@gate("8")`)

`8` is for a model nothing outside `asSystem()` has anything to say to. That is
true of credential material and false of the table an app's own screens list —
see `litestone/docs/access-control.md` § The identity models.

## Escape hatch

Need OAuth, TOTP, SSO, or magic links? Swap to Better Auth:

```typescript
import { createBetterAuthAdapter, createBetterAuthPlugin } from '@frontierjs/junction'

const auth = createBetterAuthAdapter({ auth: betterAuthInstance })
const app  = createApp({ auth })
app.configure(createBetterAuthPlugin(betterAuthInstance))
```

Same `createApp({ auth })`. Same `withLitestoneDb(db)`. Same `authenticate` hook everywhere.
