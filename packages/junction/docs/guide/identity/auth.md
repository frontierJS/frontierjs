# Auth

Junction defines an `IAuth` interface and ships no vendor adapter; `@frontierjs/auth` is the native one. Mounting it gives the app `/auth/*` routes and a session that arrives as `ctx.user`.

```ts
const signedOut = await client.auth.me().catch(() => null)
if (signedOut) throw new Error('an anonymous caller has no account')

await client.auth.signUp({ email: 'alice@example.com', password: 'correct horse battery', name: 'Alice' })
const { token } = await client.auth.signIn('alice@example.com', 'correct horse battery')
if (!token) throw new Error('sign-in returned no token')

const me = await client.auth.me() as any
if (me.email !== 'alice@example.com') throw new Error('the token did not identify Alice')
```

## What else it can do

- `fli auth:install` appends `User` to `db/schema.lite` and imports `Credential`, `Session` and the other models the package brings
- `app.configure(authPlugin({ auth }))` mounts `/auth/*` for an `auth` made with `createLitestoneAuth(db)`; `createApp({ auth, db })` is the other half
- The transport reads `Authorization: Bearer` or `X-API-Key`, asks `auth.verifySession()` and stamps `ctx.user`
- The `authenticate` hook refuses a call that has no `ctx.user`
- A browser holding a session cookie is signed in by [cookie mode](sessions.md); a request that is not a bearer token has its own [credential verifier](credentials.md)
- `client.auth` also holds `signOut`, `sessions`, `revokeOtherSessions`, `createApiKey`, `changePassword`, `reauthenticate`, `requestPasswordReset` and the magic-link pair
- Routes establish a session and services change one's own credentials afterward, so those get hooks and the audit trail
- The mailed flows need your mailer: `onPasswordResetRequested`, `onEmailVerificationRequested` and `onMagicLinkRequested` receive the token to send; setting `onMagicLinkRequested` is what turns the passwordless routes on
- `onCredentialChanged` hears every change to how an account signs in, so the person who did not make it can be told
- A `totp` credential makes sign-in answer a challenge ticket instead of a token, finished by `client.auth.completeSignIn(code)`; `requireSecondFactor` asks it of every account or the ones a function names
- Changing a credential asks for a recent password: past `reauthenticationWindow` a call answers 403 `reauthentication_required` until `reauthenticate` runs
- An operator acts as another account with `/auth/support/start`, which needs `canStartSupport` and records the episode under the operator
- `IAuth.requestPasswordReset`, `requestEmailVerification` and `requestMagicLink` are optional; an adapter that omits them handles those routes itself
- A different auth library implements `IAuth` and mounts its handler on a raw route
- `SessionContext` is what `ctx.user` looks like: `id`, `userType`, `authMethod`, `email`, `role`, `scopes`, tenant ids and the standing fields the gate reads

**In depth:** [README § Auth](../../../README.md#auth) and [packages/auth/README.md](../../../../auth/README.md)
