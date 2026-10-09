# Auth and the principal

The full entries behind this section of the `api-hazards` skill's index.

- **`IAuth.sessionFor(userId)` is how a principal is rebuilt without a credential**, and it must never be wired to anything a request can name — it proves nothing. Optional; a provider lacking it makes `runAs(userId, …)` throw by name rather than quietly downgrade.
- **A bearer token is the credentials list's last entry: `verifySession`, then `verifyApiKey` when that answers null** (`resolvePrincipal` in `auth/credentials.ts`, `FJS-D475`, `FJS-1607`). HTTP and the WS upgrade both ask it, so a key a provider never routes from its own `verifySession` still works; a provider that does route one costs a repeated lookup on a token that was already bad.
- **`bearerClaim` refuses a token that was PRESENTED and does not work — 401, one message for forged, expired and revoked** (`FJS-1999`, `test/bearer-claim.test.ts`). No token at all stays `{}`: most callers carry none. So a `cookie()` source holding a stale value fails every call that reaches the resolver until the app clears it, and a signed-in client that also sends a dead link header gets the `unauthorized` event. `expiresAt` is read off the client's clock (`db.$now()`), so `createClient({ now })` moves it with every other deadline.
