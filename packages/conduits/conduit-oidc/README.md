# @frontierjs/conduit-oidc

OpenID Connect over `@frontierjs/conduit` (`FJS-D889`, a PROTOCOL connector):
discovery, JWKS, the token endpoint (authorization code with PKCE, refresh),
userinfo, and a pure `id_token` verifier. One connector for Google, Microsoft,
Apple, Okta, Auth0, Keycloak, Dex and panva's `oidc-provider`; a vendor's
extension to the protocol stays the app's.

**Sink-only plus one conforming fixture.** No real provider has answered this
code. `bun run drive` is 38 rows on the sink; `bun run drive:fixture` is those
plus 8 against panva's `oidc-provider` running in-process. Dex is unproved
(`test/fixture/README.md`).

## What it covers

| Piece | Where |
| --- | --- |
| targets | one per credential, one bundle: `oidcTargets({ issuer, name, ref, address?, origins?, id? })` → `{ client, public }`. `client` is `provider:oidc:<name>`, `signed` with signer `oidc-client-basic`, `encoding: 'form'`; `public` is `provider:oidc:<name>:public`, auth `none`. Both address the issuer's ORIGIN. `bindOidc(conduit, targets)` → `{ client, public }` Sends |
| signer | `oidcSigners` spread into `createConduit({ signers })`; the resolver's string is `<client_id>:<client_secret>` |
| leg one | `pkce()`, `authorizationUrl(discovery, { clientId, redirectUri, state, nonce, codeChallenge })` |
| calls | every call takes the bound bundle (`oidc`) and picks its role: `discover(oidc, issuer)`, `fetchJwks(oidc, discovery)`, `userInfo(oidc, discovery, accessToken)` go through `public`; `exchangeCode(oidc, discovery, { code, redirectUri, codeVerifier })`, `refreshTokens(oidc, discovery, { refreshToken })` through `client` |
| verifier | `verifyIdToken(jwt, { jwks, issuer, audience, nonce?, now, clockSkewSeconds?, maxAgeSeconds? })`; `verifyLogoutToken` is the same function under the back-channel profile |
| keys | `jwksKeys(withCache(jwksResolver(oidc, discovery)), discovery).verify(jwt, opts)` — refetches ONCE on an unknown `kid` |
| leg three | `oidcTokenResolver(oidc, discovery, grants)` — a `CredentialResolver` that refreshes under a per-grant lock, honors `expires_in`, hands a rotated refresh token to `grants.onRotated`, marks `invalid_grant` as lost |
| Apple | `appleClientSecretResolver({ teamId, clientId, keyId, privateKey })` mints the ES256 client secret; no vendor call |
| errors | `translate(error, headers)` — table below |
| sink | `sink.ts`: a minimal provider with its own RS256 key, PKCE verified, refresh ROTATION, `client_secret_basic` only |
| drive | `bun run drive` (sink) · `bun run drive:fixture` (panva) · `FIXTURE_URL=… FIXTURE_CLIENT=id:secret bun run drive` (any provider) |

## The target is the issuer's origin

Microsoft's issuer is `https://login.microsoftonline.com/<tenant>/v2.0` and
its token endpoint `/<tenant>/oauth2/v2.0/token` — outside the issuer's path —
so the target's address is the origin and `discoveryPath(issuer)` prefixes the
issuer's path onto the one request that needs it. Every endpoint discovery
names is sent as an absolute `address`. Google's discovery names THREE origins
(`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`), so
the bundle declares the ones it reaches in `origins`:
`oidcTargets({ issuer, name, ref, origins: ['https://www.googleapis.com',
'https://openidconnect.googleapis.com'] })`, and conduit refuses an endpoint on
an undeclared origin by name (`FJS-2730`). The verifier's `issuer` is always the
`iss` spelling, never the address.

## Who spends what

| Call | Credential | How |
| --- | --- | --- |
| discovery, JWKS | none | the `public` target, auth `none` |
| token endpoint | the CLIENT's | `Authorization: Basic` from the resolver's `<client_id>:<client_secret>`, both halves form-urlencoded first (RFC 6749 §2.3.1) |
| userinfo | the USER's | the `public` target, carrying the caller's `authorization: Bearer <access_token>` — on the `client` target Basic would replace it; `userInfo` picks `public` itself |

A `bearer` target whose resolver is `oidcTokenResolver` is how an app calls a
provider's OTHER APIs as the user: conduit asks the resolver, the resolver
refreshes if the token is near expiry, a 401 forgets that token through
`invalidate` and the send replays on a fresh one. The drive's
`bearerTarget.resolverMintsOnDemand` row is that shape.

## Errors

| provider `error` | HTTP | conduit kind | `OidcFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `invalid_grant` | 400 | `client_error` | **`grant_lost`** — mark the row, re-authenticate (`FJS-D795`) | no |
| `invalid_client` | 401 | `auth_failed` | `auth_failed` — conduit forgets the client secret and replays once | no |
| `invalid_request`, `unsupported_grant_type`, `invalid_scope`, `unauthorized_client` | 400 | `client_error` | `refused` | no |
| `invalid_token` (userinfo, RFC 6750; read off `WWW-Authenticate` when the body is empty) | 401 | `auth_failed` | `token_invalid` — the USER's token, not ours | no |
| `insufficient_scope` | 403 | `auth_failed` | `forbidden` | no |
| `temporarily_unavailable`, `server_error` | 503 / 500 | `server_error` | `server_error`; `indeterminate` on a POST | conduit's call |
| any | 429 | `rate_limited` | `rate_limited` with `retryAfterMs`; a token POST is NOT replayed by conduit | yes, by the caller |
| discovery whose `issuer` is not the one asked | 200 | `invalid_response` (via `validate`) | `invalid_response` | no |

An id_token failure is never a kind: `verifyIdToken` answers `{ ok: false,
reason }` and the reason is for the log.

## What the verifier refuses

`alg: none`; every `HS*` (a shared-secret algorithm against a public key set);
any `alg` outside RS256 / ES256, by name; a `kid` not in the set (once
refetched); a key whose `kty` does not fit the `alg`; `iss` not exact; `aud`
without this client; several audiences with no `azp` or an `azp` that is not
this client; `exp` past, `nbf` ahead or `iat` ahead beyond the skew (60 s by
default); `nonce` mismatch when one was handed in; a JWE (five segments). A
logout token must carry `events` naming the back-channel event, `jti`, and
`sub` or `sid`, and must NOT carry a `nonce`; `exp` is optional there.

## What stays the app's (C12)

The refresh token row: `grants.refreshTokenFor(ref)` reads it,
`grants.onRotated(ref, next, previous)` writes it, `grants.onLost(ref,
failure)` marks it. The resolver stores none of it. The `state`/`nonce` of a
login in flight, the session, the lock across processes (this one is
in-process), the id_token's `jti` dedupe for logout tokens.

## Measured: `expires_in` cannot reach `withCache` (`FJS-2245`)

The drive's `expiresIn.droppedByWithCache` row: the sink says the token lives
1 s; `withCache(resolver, { ttl_ms: 60_000 })` hands the same token out at
1.2 s and the provider answers `invalid_token`. `expiresIn.honoredByResolver`
beside it: `oidcTokenResolver` alone refreshes at 1.2 s, because it keeps the
provider's number. So the resolver is NOT wrapped in `withCache`; it is its own
cache with the provider's expiry, and the refresh lock lives in it.
