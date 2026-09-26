# Auth and the principal

The full entries behind this section of the `api-hazards` skill's index.

- **`IAuth.sessionFor(userId)` is how a principal is rebuilt without a credential**, and it must never be wired to anything a request can name — it proves nothing. Optional; a provider lacking it makes `runAs(userId, …)` throw by name rather than quietly downgrade.
- **Junction resolves every Bearer token through `IAuth.verifySession()` and calls `verifyApiKey` nowhere** (`transport/http.ts`, `FJS-D10`). A key is verified only if the provider's `verifySession` falls through to its own `verifyApiKey`, so a new provider inherits that job.
