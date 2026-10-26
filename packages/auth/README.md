# @frontierjs/auth

FJS native authentication. One import, a schema that ships with the package, everything derived.

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
// api/src/core/auth.ts
import { createLitestoneAuth }               from '@frontierjs/auth'
import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'
import { defineEnv }                        from '@frontierjs/junction'

export const env = defineEnv({
  ENCRYPTION_KEY: { required: true, minLength: 64 },
  FRONTIER_APP_URL:        { required: true },
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

  onPasswordResetRequested: async ({ email, token }) => {
    await mailer.send({
      to:      email,
      subject: 'Reset your password',
      html:    `<a href="${env.FRONTIER_APP_URL}/reset/#token=${token}">Reset</a>`,
    })
  },
  onEmailVerificationRequested: async ({ email, token }) => {
    await mailer.send({
      to:      email,
      subject: 'Verify your email',
      html:    `<a href="${env.FRONTIER_APP_URL}/verify-email/#token=${token}">Verify</a>`,
    })
  },
})
```

```typescript
// api/src/app.ts
import { auth, db }         from './core/auth.ts'
import { auth as authPlugin } from '@frontierjs/auth'
import { createApp }        from '@frontierjs/junction'

// `db` on createApp installs withLitestoneDb for you — it is an around hook,
// not a plugin, and it is what puts a per-request scoped client on
// $.db. Passing it here is the one wiring; app.configure() of it is
// not a thing.
const app = createApp({ auth, db })

// Mounts /auth/* and registers the account / sessions / api-keys services. Its
// work() phase starts the hourly sweep of expired sessions, verifications,
// OAuth flows and login challenges; `auth.cleanup.sweepNow()` runs it on demand.
app.configure(authPlugin({ auth }))

await app.start()
```

A working version of exactly this is [`example/api/src/app.ts`](../../example/api/src/app.ts),
driven end to end by `example`'s `bun run verify`.

### Callbacks

Each takes one event object and states its tier (`FJS-D06`): a **Hook** may
halt the operation by throwing, a **Guard** answers allow/deny, an
**Observer** is told and a throw is logged.

| Option | Tier | Event | When |
| --- | --- | --- | --- |
| `onLogin` | Hook | `{ user }` | the password verified, before a session is issued |
| `onLoginFailed` | Hook | `{ email, userId, reason, stage }` | before the refusal is raised; throw your own to replace it |
| `onLogout` | Hook | `{ userId, sessionId }` | before the session row is deleted |
| `onRegistered` | Hook | `{ user, db }` | inside the registration's transaction, at every door that makes an account; a throw rolls it back, which is how a closed signup refuses |
| `onPasswordResetRequested` | Observer | `{ email, token }` | after the reset row is written and the route has answered |
| `onEmailVerificationRequested` | Observer | `{ email, token }` | after a verification, address-change or registration row is written |
| `onMagicLinkRequested` | Observer | `{ email, token, code }` | after the request has answered |
| `onOAuthLinkRequested` | Observer | `{ email, token, provider }` | an identity asks to join an account that has not proved the address |
| `onCredentialChanged` | Observer | `{ event, userId, email, actorId, at, meta }` | after a way into the account changed |
| `canStartSupport` (plugin) | Guard | `{ operator, subjectId, reason }` | before a support episode starts; absent refuses |

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
| `POST` | `/auth/register` | Create account + issue session. Where `onEmailVerificationRequested` is set it answers `202 { ok: true }` for every address instead: a free one is mailed a link whose click (`POST /auth/email/verify`) makes the account and signs in, a held one is mailed its owner through `onCredentialChanged` as `registration.attempted` |
| `POST` | `/auth/login` | Login, returns a token — or a challenge ticket when the account has a second factor |
| `POST` | `/auth/login/challenge` | The second step: the ticket plus a TOTP or recovery code, returns a token |
| `POST` | `/auth/logout` | Revoke current session |
| `POST` | `/auth/password-reset/request` | Send reset email |
| `POST` | `/auth/password-reset/confirm` | Confirm reset with token. On an account with no credential — one an operator created — this sets the first password, which is what makes an invitation a reset link. An account whose only way in is an OAuth provider is refused (409) |
| `POST` | `/auth/magic-link/request` | Mail a sign-in link and a six-digit code. Answers `{ ok: true }` for any address. Mounted only when `onMagicLinkRequested` is set — see [Magic link](#magic-link) |
| `POST` | `/auth/magic-link/verify` | `{ token }`, or `{ email, code }` from another device. Returns what `/auth/login` does: a token, or a challenge ticket when the account has a second factor |
| `POST` | `/auth/email/verify/request` | Re-send verification email |
| `POST` | `/auth/email/verify` | Spend a mailed link's token. A registration's link makes the account and signs in, answering what `/auth/login` does (a token, or a challenge ticket); confirming or changing an existing account's address answers `{ ok: true }` and signs nobody in. The mailed link lands on a page of the app's web surface and that page posts the token — a GET that spent it would be burned by a mail scanner's prefetch |
| `POST` | `/auth/support/start` · `/auth/support/end` | Begin and end acting as another account — bounded by that account's standing, refused for one standing above yours, and recorded under the operator. Needs `canStartSupport` and a level resolver (`services: { standingLevel }` or `{ level }`); the account is told through `onCredentialChanged` |
| `GET`  | `/auth/oauth` | Which OAuth providers this app offers |
| `GET`  | `/auth/oauth/{provider}` · `/auth/oauth/{provider}/callback` | The redirect flow — browser navigations, not `fetch` calls |
| `GET`  | `/auth/oauth/{provider}?link=` | The emailed link: starts the provider flow, and the callback attaches the provider to the account only when it returns the identity the link was sent for |

## Services

Registered by the same plugin, at the app's own service root. Every method is
scoped to the CALLER — nothing here takes a user id — except `account-recovery` and `people`,
which are an operator acting on somebody else's account and have a floor of their
own (§ *When a factor is lost*, below).

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/account/me` | The caller's session — what `/auth/me` was |
| `POST` | `/account/me` + `X-Service-Method: reauthenticate` | `{ password, code? }` — the code where a factor is on. Confirms THIS session for `reauthenticationWindow` (default 1 hour); answers `{ until }` |
| `POST` | `/account/me` + `X-Service-Method: changePassword` | `{ newPassword }`. Replace it and sign out every other session |
| `POST` | `/account/me` + `X-Service-Method: requestEmailChange` | `{ newEmail }`. Mail a link to the new address through `onEmailVerificationRequested`; the address changes, verified, when `/auth/email/verify` spends that link, and the OLD address is told (`email.changed`) |
| `GET`  | `/sessions` | Where else this caller is signed in; the current one is marked |
| `DELETE` | `/sessions/{id}` | End one of them |
| `POST` | `/sessions` + `X-Service-Method: revokeOthers` | Sign out everywhere else |
| `GET`  | `/api-keys` | The caller's keys — never the key itself |
| `POST` | `/api-keys` | Issue one. **The raw key is in this response and nowhere else** |
| `DELETE` | `/api-keys/{id}` | Revoke one |
| `GET`  | `/connections` | Which OAuth providers are attached to the caller |
| `DELETE` | `/connections/{id}` | Detach one |
| `POST` | `/account-recovery/{userId}` + `X-Service-Method: resetTotp` | An operator resetting somebody else's lost second factor — SYSADMIN(7) |
| `GET`  | `/people/{userId}` | An operator reading somebody else's sessions and API keys — ADMINISTRATOR(5) |
| `POST` | `/people/{userId}` + `X-Service-Method: revokeSession` · `revokeApiKey` · `signOut` | An operator ending them. Refused over `/mcp` |
| `DELETE` | `/people/{userId}` | An operator removing the account with its credentials and sessions. Refused over `/mcp` |
| `POST` | `/people` + `X-Service-Method: invite` | An operator inviting somebody: `{ userId, token, expiresAt }`, the token sets a first password at `/auth/password-reset/confirm`. Nothing is mailed |

`account` also answers `totpStatus`, `setupTotp`, `confirmTotp`, `disableTotp` and
`regenerateRecoveryCodes` (§ *Two-factor authentication*).

In a browser they are `client.auth.me()`, `.changePassword()`, `.requestEmailChange()`, `.sessions()`,
`.revokeSession(id)`, `.revokeOtherSessions()`, `.apiKeys()`, `.createApiKey()`
and `.revokeApiKey(id)` — and a Sierra app gets a reactive `session` object over
the top (`@frontierjs/sierra/resource`).

Rename or drop any of them with `services`, and add a `level` resolver to
have `account.me` answer the caller's gate level:

```ts
app.configure(authPlugin({
  auth,
  services: { apiKeys: false, level: myGateLevel },
}))
```

A name another service already claimed is refused at boot, naming the option —
the registry is a Map, so the alternative is one of the two silently replacing
the other depending on which registered last.

## Schema models

`fli auth:install` appends `User` to `db/schema.lite` — it is yours to extend —
and imports the rest with `import "@frontierjs/auth/schema.lite"`, so an upgrade
reaches them:

- `User` — identity. `@@gate(4.4.4.5)` — read, create and update USER(4),
  delete ADMINISTRATOR(5) — bounded by `@@allow(update, id == auth().id ||
  auth().isAdmin)` and `@allow(write, auth().isAdmin)` on `role` and
  `emailVerified`. A level says what kind of caller, a policy says whose row, a
  field policy says which columns; identity needs all three, and the columns a
  gate is graded from are exactly the ones a caller must not write. `@@trail(audit)`
- `Credential` — passwords + API keys (`@@gate(8)` — SYSTEM)
- `Session` — active sessions (`@@gate(8)`, `@@trail(audit)`)
- `Verification` — reset, verify, OAuth-link and magic-link tokens (`@@gate(8)`)
- `LoginChallenge` — a password accepted, a second factor owed (`@@gate(8)`)
- `OauthFlow` — one in-flight OAuth redirect (`@@gate(8)`)

`8` is for a model nothing outside `asSystem()` has anything to say to. That is
true of credential material and false of the table an app's own screens list —
see `litestone/docs/access-control.md` § The identity models.

## Magic link

Passwordless sign-in by mail. Setting `onMagicLinkRequested` turns it on; without
it the methods do not exist and the routes are not mounted (`FJS-D888`).

```ts
const auth = createLitestoneAuth(db, {
  onMagicLinkRequested: async ({ email, token, code }) => {
    await mailer.send({
      to:      email,
      subject: `Your sign-in code is ${code}`,
      html:    `<a href="${env.FRONTIER_APP_URL}/sign-in/link#token=${token}">Sign in</a>`,
    })
  },
  magicLinkTtl: '10 minutes',   // the default
})
```

The link lands on a page of the app's web surface. That page posts the token,
for the reason `/auth/email/verify` does it that way: a mail scanner's prefetch
would spend a GET. In the browser:

```ts
await client.auth.requestMagicLink(email)
// the token from the link's page, or the address and code typed on another device
const result = await client.auth.signInWithMagicLink(token ? { token } : { email, code })
if ('challenge' in result) await client.auth.completeSignIn(totpCode)
```

What the click does depends on the account:

| Account | The click |
| --- | --- |
| None holds the address | Creates a verified account through `onRegistered`, so a closed signup refuses here, then signs it in. The request makes no row |
| Has a password, or no credential at all | Signs in and marks the address verified |
| Has a second factor | Returns a challenge ticket — the mailbox is one factor |
| Its only way in is an OAuth provider | Refused, and the request mails nothing (`FJS-987`) |

The link and the code are spent together, by either one's first use, and a new
request replaces both. A wrong code answers `retryable: true` until
`loginChallengeAttempts` misses, which spends the link. `onLogin` and
`onLoginFailed` run as they do for a password, with `stage: 'magic-link'`.

## Two-factor authentication

A `totp` credential existing is what makes a login owe a code, so an account with
none behaves exactly as it did. One enrolls in two calls — `setupTotp` answers a
secret and an `otpauth://` URI, and **`confirmTotp` is what switches it on**,
because enrollment that enabled before it verified would cost the account rather
than a retry on the first wrong clock.

```typescript
const { secret, qr } = await auth.setupTotp(userId)
const { recoveryCodes } = await auth.confirmTotp(userId, codeFromTheApp)
```

`login()` then answers one of two things, and the caller discriminates on the key:

```typescript
const result = await auth.login(email, password)

if ('challenge' in result) {
  // No token was issued. The ticket is single-use and lives 5 minutes.
  const { token, user } = await auth.completeLogin(result.challenge, code)
} else {
  const { token, user } = result
}
```

`code` takes a TOTP code or a recovery code — the person typing it is answering
one question. A code is single-use inside its own 30-second window, and every
code from before the last accepted step is refused with it.

Over HTTP the second step is `POST /auth/login/challenge`, a raw route for the
reason `/auth/login` is one: it is what produces a session, so it cannot be gated
by holding one. In `cookieAuth` mode the ticket rides an httpOnly cookie and the
body carries only the expiry.

An OAuth sign-in owes the code too: the provider is a first factor, like a
password or a magic link. The callback cannot answer a body, so it sets the same
cookie and redirects to `errorRedirect` with `?oauth_error=code_required` and
`oauth_expires`. Sierra's `session` reads that as `awaitingCode`, the state a
password challenge sets, so the page's code box and `completeSignIn()` finish it.

Everything a signed-in caller does to their own factor is a SERVICE on `account`,
beside `changePassword` — a call that can be refused for want of a session is not
a route (`FJS-D20`):

| Method | Takes | Answers |
| --- | --- | --- |
| `totpStatus` | — | `{ enabled, recoveryCodesRemaining }` |
| `setupTotp` | — | `{ secret, qr }` — enables nothing |
| `confirmTotp` | `code` | `{ recoveryCodes }` — this is what enables it |
| `disableTotp` | — | `{ ok: true }` |
| `regenerateRecoveryCodes` | — | `{ recoveryCodes }` |

```typescript
const { secret, qr }    = await client.auth.setupTotp()
const { recoveryCodes } = await client.auth.confirmTotp(code)
```

**Sudo mode** (`FJS-D1209`). `changePassword`, `requestEmailChange`, `setupTotp`,
`disableTotp`, `regenerateRecoveryCodes`, `api-keys.create` and
`connections.remove` take no password. Each asks whether the calling session
proved it within `reauthenticationWindow` — a sign-in counts, and so does
`account.reauthenticate` — and answers **403** with
`data.reason: 'reauthentication_required'` past it. A screen asks for the
password then (and the code, where a factor is on), calls `reauthenticate`, and
retries. An account with no password — signed up through a provider — has only
the hour after a sign-in.

`confirmTotp`, `disableTotp`, `regenerateRecoveryCodes` and a confirmed change of
address each end every other session of the account and keep the one that
asked (`FJS-D1208`), as `changePassword` does. For the address that is the
session that posted the click to `/auth/email/verify`, or none.

A wrong password or code here answers **403**, not 401. The session that sent it
is fine, and a 401 is what a browser client signs the person out on.

`reauthenticate` and `confirmTotp` share a rate limit per account,
`services: { reauthenticationRateLimit }`, which defaults to login's own
10 per 15 minutes. Over it is a 429, and the session stays signed in.

Sign-in has two buckets. `loginRateLimit` is per address and loose (100 per 15
minutes), since a school or an office is one address. `loginAccountRateLimit`
(10 per 15 minutes) is keyed on the email and the address together, so a spray
at one account from one address stops there while the rest of the room signs in.
`/login/challenge` takes the per-address bucket only. Each bucket is junction's
`rateLimitHook`, which counts in the process (junction's README § Middleware).

The four that change what the account requires are refused inside a support
episode. `totpStatus` is not — seeing what somebody sees is what an episode is
for, and it answers about the subject.

### Requiring a second factor

A factor is opt-in per account until the app says otherwise:

```typescript
createLitestoneAuth(db, {
  encryptionKey,
  requireSecondFactor: true,                          // every person
  // requireSecondFactor: u => u.role === 'admin',    // or the accounts a function names
})
```

An account it names that has a factor is unchanged: it owes its code. One with
none **signs in to a session held to enrollment** (`FJS-D1008`): the login answers
a token like any other, with `user.enrollmentOnly: true`, and the plugin refuses
every service call but `account.totpStatus`, `setupTotp` and `confirmTotp` with a
403 whose `data.reason` is `second_factor_required`. `confirmTotp` releases the
account's held sessions, so the same token carries on without a second sign-in.

A held session cannot start a support episode, and an API key is not held. It
needs `encryptionKey`, and `createLitestoneAuth` refuses to start without one.

### When a factor is lost

A person without their phone or their recovery codes cannot get back in alone.
A **SYSADMIN(7)** can take the factor off for them:

```
POST /account-recovery/{userId}   X-Service-Method: resetTotp   → { sessionsRevoked }
```

The factor, any enrollment in flight, the recovery codes, a half-finished login
and **every session** go — the lost device usually holds one. API keys stay. The
person signs in with their password and enrolls again.

The floor is not configurable (`FJS-D264`): removing a factor is the one thing
between a stolen password and the account, and a help desk is how the thief gets
past it. Both people are graded by YOUR resolver — `services: { standingLevel }`,
else `services: { level }` — so one must be passed; without it every call is a
403 naming both, and an answer that is not a finite number refuses too. Pass
`standingLevel` when your `level` is per tenant: `level` is also what
`account.me` publishes, while recovery and support mode need only the standing
that travels with the user. Either way it must not let a column somebody below 7 can write reach 7. The person must grade below the
operator, so a sysadmin cannot reset a peer, and nobody resets their own
(`disableTotp` does that, with the password). Refused inside a support episode.

## Telling the person

Every change to how an account signs in reaches `onCredentialChanged`, after it
is written. Wire it to mail, because the person who did NOT make a change learns
of it here or nowhere:

```typescript
createLitestoneAuth(db, {
  onCredentialChanged: async ({ event, email, actorId, userId }) => {
    await mailer.send({ to: email, subject: 'Your sign-in settings changed', text: describe(event) })
  },
})
```

`event` is one of `CREDENTIAL_EVENTS` — `password.changed`, `password.reset`,
`email.changed`, `totp.enabled`, `totp.disabled`, `totp.reset`, `recoveryCodes.regenerated`,
`recovery.used`, `apikey.created`, `apikey.revoked`, `oauth.linked`,
`oauth.unlinked`, `support.started`, `registration.attempted` (a stranger
registered a held address; `userId` is the owner) — and is the audit trail's own name for the
same change. `actorId` differs from `userId` only for `totp.reset` and
`support.started`, where it is the operator; the second carries the episode's
`reason` and `endsAt` in `meta`. For `email.changed`, `email` is the address
that was replaced — that mailbox is the one that just lost the account.
Nothing secret is in it.

It is an **observer**, unlike `onLogin` and the other hooks: a throw is logged
and refuses nothing, so a mail outage cannot keep a factor on that somebody
switched off. Optional to the type system, required in practice.

## Typing a code for a secret you enrolled

A seed or a drive that enrolls TOTP through `setupTotp()` / `confirmTotp()` must
type a live code. `@frontierjs/auth/totp` is the package's own arithmetic
(`totp(secret, at)`, `verifyTotp`, base32), so there is one copy of it:

```js
import { totp } from '@frontierjs/auth/totp'
const code = totp(secret, new Date())
```

## In the console

`@frontierjs/auth/console` holds commands for an app's `db/repl.js`, which
`fli db:repl` loads:

```js
import { resetPasswords } from '@frontierjs/auth/console'
export default { resetPasswords }
```

`.resetPasswords [password]` sets every `password` credential in the open
database (or tenant) to one value, `test1234` by default, hashed the way a login
checks it. OAuth credentials are untouched and an account without a password
does not gain one. Under `NODE_ENV=production` it refuses unless given `--force`.

## Escape hatch

OAuth sign-in is native — `oauthProviders` built with `defineProvider` (`oauth.ts`).
For anything this package does not do, an app implements
junction's `IAuth` (an exported type from `@frontierjs/junction`) over the library it
wants and mounts that library's handler on a raw route
(`app.post('/auth/{path}', ctx => lib.handler(ctx.$raw.$req))`). Junction ships no
adapter for a vendor.

Same `createApp({ auth })`. Same `withLitestoneDb(db)`. Same `authenticate` hook everywhere.
