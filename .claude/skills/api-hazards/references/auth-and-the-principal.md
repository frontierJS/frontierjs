# Auth and the principal

The full entries behind this section of the `api-hazards` skill's index.

- **`IAuth.sessionFor(userId)` is how a principal is rebuilt without a credential**, and it must never be wired to anything a request can name — it proves nothing. Optional; a provider lacking it makes `runAs(userId, …)` throw by name rather than quietly downgrade.
- **A bearer token is the credentials list's last entry: `verifySession`, then `verifyApiKey` when that answers null** (`resolvePrincipal` in `auth/credentials.ts`, `FJS-D475`, `FJS-1607`). HTTP and the WS upgrade both ask it, so a key a provider never routes from its own `verifySession` still works; a provider that does route one costs a repeated lookup on a token that was already bad.
