# conduit-oidc — state

**New, drive green on the sink (38 rows) and on panva `oidc-provider` in-process (46 rows). Dex UNPROVED.** 2026-10-11.

- Sink-only plus one conforming fixture; no real provider has answered this code.
- Fixtures (`FJS-D889` wants two): panva `oidc-provider` 9.12.2 — PROVED, `bun run drive:fixture` walks its dev login without a browser and runs the code exchange, id_token, refresh and userinfo rows; **Dex — unproved**, no docker here, `test/fixture/README.md` has the start.
- Framework gaps met (each in `PROJECT_STATE.md`'s root table under FJS):
  - one `auth` per target, two credentials per protocol — closed as one target per credential (`FJS-2729`): `oidcTargets() → { client, public }` and `bindOidc()`, each call picking its role from the bundle (the per-call refusal is gone; `bundle.callsPickTheirRole` proves the credential on the wire);
  - one address per target, discovery names absolute URLs on other origins — closed by `FJS-2730`: a target declares `origins`, rows `endpoint.declaredOriginReached` / `endpoint.foreignOriginRefused`;
  - `withCache` has a fixed TTL and a resolver's answer carries no expiry — measured in `expiresIn.droppedByWithCache`; `oidcTokenResolver` is its own cache (`FJS-2245`, measurement text in the handback);
  - the lock is in-process; two replicas each refresh (`FJS-2245` already says so).
- Unverified: Apple documents `client_secret_post`; whether its token endpoint takes `client_secret_basic` as PLAN §9 assumes needs a key. `appleClientSecretResolver` mints the right JWT either way.
- Not built: `end_session_endpoint`, revocation, introspection, JWE id_tokens, `response_mode`, `client_secret_jwt` / `private_key_jwt` client auth, request objects.
