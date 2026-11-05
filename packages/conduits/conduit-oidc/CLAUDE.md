# conduit-oidc — package map

`src/index.ts` `oidcTargets()` (`client`, `public`), `bindOidc()`, `OidcSend`, the five calls, PKCE, the
validators · `src/verify.ts` the pure verifier (id_token and logout token) ·
`src/jwt.ts` JWS parse/sign/verify over WebCrypto, the alg allow-list ·
`src/signer.ts` `oidc-client-basic` and Apple's minted secret · `src/resolver.ts`
`jwksKeys` (refetch once) and `oidcTokenResolver` (leg three) · `src/errors.ts`
the one reader of `raw` and `WWW-Authenticate` · `sink.ts` · `test/oidc.drive.ts`
· `test/fixture/panva.ts` the in-process conforming provider.

## What bites

- **The target's address is the issuer's ORIGIN; the verifier's `issuer` is the `iss` spelling.** Mix them and discovery 404s or every token fails on `iss`.
- **Every endpoint is sent as an absolute `address`.** One on another origin goes through only where the target declares it in `origins`; conduit refuses the rest by name (`FJS-2730`).
- **The signer puts Basic on a POST with no `authorization` and nothing on anything else.** A caller who sets `authorization` on a token POST has replaced the client credential; a call that forgets the Bearer on userinfo gets no Basic either, which the sink answers `invalid_token`.
- **The Basic halves are form-urlencoded first.** A secret with `:` or `%` is the drive's; a sink that decodes it the other way is a 401 that reads like a wrong secret.
- **`oidcTokenResolver` is never wrapped in `withCache`.** The cache would drop `expires_in` (measured, `expiresIn.droppedByWithCache`); the resolver is its own cache and holds the lock.
- **A rotated refresh token is handed to `grants.onRotated` BEFORE the access token is answered**, and never stored here. A `lost` mark is cleared only by `forget(ref)`.
- **A lost refresh under rotation is a lost grant.** The retry with the old token is `invalid_grant`; nothing else resolves it.
- **`unknownKid` is the only reason that triggers a JWKS refetch, and once.** The verifier checks `iss`, `aud`, `exp` before the key lookup, so a stale token never costs a fetch.
- **The sink's `/_sink/mint` removes a claim given as `null`** — JSON cannot carry `undefined`.
- **`bun install` here pulls the PUBLISHED `@frontierjs/conduit` under every `packages/*/node_modules/@frontierjs`**, which has no `signed` auth; remove those directories so resolution reaches the root symlinks (`../../link.sh`).

## Proving a change

`bun run drive` (sink, 38 rows); `bun run drive:fixture` (panva `oidc-provider`
in-process, 44 rows). Dex: `test/fixture/README.md`, unproved.
