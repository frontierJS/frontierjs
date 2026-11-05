---
id: mcp-oauth
status: proposed
dated: 2026-11-05
---

# Connector sign-in — an App as the OAuth server its own MCP needs

**Status: PROPOSED.** Dated 2026-11-05. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: a person adds an App's `/mcp` to their own claude.ai (or Claude Code,
Desktop, mobile) as a custom connector, signs in as themselves, and every tool
call is graded at their own gate level. Today nobody can, against any App: a
connector signs in only over OAuth, and FrontierJS is not an OAuth server.

`FJS-D1922` ruled the shape: `@frontierjs/auth` becomes the authorization
server, and its access tokens are signed rather than stored, so a copy staged
before a token was minted still accepts it. It came out of
`read-only-copy.md` 0.3, which needs it for step 3.5, but the live App needs it
first. "Claude replaces the UI" only holds if a teammate's Claude can reach the
App, not just the developer's Claude Code with a pasted key.

---

## What a connector needs

Read 2026-11-05 from Anthropic's
[connector authentication](https://claude.com/docs/connectors/building/authentication)
and the MCP authorization spec
[2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

- **A `401` with `WWW-Authenticate: Bearer resource_metadata="…"`** on an
  unauthenticated call. A header on a `200` is ignored, so no 401 means no
  sign-in.
- **Protected-resource metadata** (RFC 9728) whose `resource` equals the MCP URL
  exactly. Only the first `authorization_servers` entry is used.
- **Authorization-server metadata** (RFC 8414 or OIDC discovery), reachable from
  Anthropic's egress range `160.79.104.0/21`.
- **Client identity by CIMD**, used only when the metadata advertises
  `client_id_metadata_document_supported: true` and `"none"` in
  `token_endpoint_auth_methods_supported`. Otherwise DCR.
- **S256 PKCE** on every request, advertised in
  `code_challenge_methods_supported`. A form-encoded `/token`.
- **Redirects** to `https://claude.ai/api/mcp/auth_callback`, plus a
  port-agnostic loopback for Claude Code on both `localhost` and `127.0.0.1`.
- **Refresh tokens rotate** for a public client: the response that issues a new
  one invalidates the old.
- **Timeouts**: 10 s on discovery and token, 30 s on refresh.
- **No `client_credentials` grant.** `static_headers` is beta and
  organization-wide, and names no user. `FJS-D1922` set it aside.

## What exists

- **One Bearer door.** Junction's transport calls `auth.verifySession(token)`
  and nothing else. It already routes by prefix: an API key (`API_KEY_PREFIX`,
  `crypto.ts`) skips the `Session` lookup (`auth.ts`, `verifySession`). A signed
  access token is a third arm of that branch, not a second door.
- **Every first factor ends at `firstFactorProven()`** (`FJS-D888`,
  `FJS-D915`), which issues a session or a TOTP ticket. An `/authorize` that
  ends there inherits the second factor. One that calls `issueSession` itself
  is a way past it.
- **PKCE and HMAC are already in `crypto.ts`**: `pkceChallenge` (S256),
  `hashHandoff` (a code bound to its challenge), `hashApiKey`. `oauth.ts` is the
  *client* half, used to sign in with Google and the like. It has no HTTP, no
  database and no session, and stays that way.
- **The MCP surface grades by the caller**: `@frontierjs/mcp` reads `ctx.user`
  and grades each tool by `standingOf`. An agent over `/mcp` is already refused
  every credential write (`refuseDelegated`, keyed on `ctx.transport === 'mcp'`,
  `FJS-D628`). So a connector can read and write data at the person's level, but
  cannot change how they sign in.
- **An unauthenticated `/mcp` call answers `200` with the level-0 tools**
  (`plugin.ts`, `standingOf(app, null)`), so a connector never starts a sign-in.
  That is Q1.
- **Sessions already have a full lifecycle**: `listSessions`, `revokeSession`,
  `endOtherSessions` on a credential change (`FJS-D1208`), `@@expires` with the
  sweep, and, on a read-only copy, a move into the writable `sessions` block
  (`FJS-D1921`). That is why Q4 recommends a grant be a `Session` row.

## Prior art

- **[Better Auth's MCP plugin](https://better-auth.com/docs/plugins/mcp)**, built
  on its [OAuth 2.1 Provider](https://better-auth.com/docs/plugins/oauth-provider):
  - The app becomes the authorization server and the protected resource.
  - Unauthenticated requests get "a JSON-RPC `401` with the RFC 9728
    `WWW-Authenticate` header".
  - JWT access tokens are verified against a JWKS from its `jwt()` plugin.
  - "CIMD is the recommended client identity mechanism", and DCR is never
    enabled implicitly because "MCP deprecates Dynamic Client Registration".
  - The app supplies `loginPage` and `consentPage` paths.
  - It uses seven tables (`oauthClient`, `oauthAccessToken`,
    `oauthRefreshToken`, `oauthConsent`, …).
  - `refreshTokenReuseInterval` defaults to 30 seconds for MCP clients, so reuse
    of a rotated token inside the window is "not treated as replay".
  - It has scopes, with `403 insufficient_scope`.
- **[Supabase Auth's OAuth 2.1 server](https://supabase.com/docs/guides/auth/oauth-server)**
  and its [MCP guide](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication):
  - The authorization code flow with PKCE, plus DCR for MCP clients.
  - The consent screen is the app's own, from an "OAuth Consent block".
  - The overview page says it is in beta.
  - The MCP page states no token format and says nothing of `resource`. A
    third-party tutorial says the parameter is ignored; not verified here.
- **Both put the login and consent screens in the app's web frontend.** That
  assumes a web surface, which an API-only App and a read-only copy do not have.
  That is Q2.

---

## Phases

### Phase 0 — Read and probe before building

Goal: the facts the build rests on, observed rather than assumed.
Done when: each step has a line under it saying what was observed and how.

- [ ] 0.1 Read the client metadata documents claude.ai and Claude Code publish
      for CIMD: the `client_id` URLs, their `redirect_uris` and
      `grant_types`. Record them verbatim, because 2.2 checks against them.
- [ ] 0.2 Which apps rely on level-0 MCP tools for an anonymous caller? Search
      this tree and `fjs-prototypes` for `/mcp` used without a Bearer, since Q1
      would end that.
- [ ] 0.3 Who can render the sign-in page under Invariant 1? Find whether
      `@frontierjs/auth` may depend on Mesa's SSR string mode (`FJS-D1634`), or
      whether the page has to be plain HTML. This settles Q2's mechanism.
- [ ] 0.4 Load `bridge-index` for the seams this touches: the `401` and its
      header (Invariant 4, one owner turns a throw into a status), the
      `.well-known` routes at the root, and the protected-resource metadata
      that `mcp` owns and auth's issuer feeds.

### Phase 1 — Discovery

Goal: a connector learns where to sign in.
Done when: `claude mcp add --transport http <example>/mcp` opens a browser at
the App's `/authorize`.

- [ ] 1.1 `/mcp` answers `401` with `WWW-Authenticate: Bearer
      resource_metadata=…` per Q1.
- [ ] 1.2 `/.well-known/oauth-protected-resource` (and the path-suffixed form)
      names the MCP URL as `resource` and the App's issuer as its one
      authorization server.
- [ ] 1.3 `/.well-known/oauth-authorization-server`: issuer, the two endpoints,
      `code_challenge_methods_supported: ["S256"]`,
      `token_endpoint_auth_methods_supported: ["none"]`,
      `client_id_metadata_document_supported: true`, the grant types.

### Phase 2 — Authorize

Goal: a person signs in as themselves and approves the connector.
Done when: a test runs password plus TOTP through `/authorize` and gets a code
back at a loopback redirect, and the same run with a wrong redirect is refused
before any page is shown.

- [ ] 2.1 The sign-in and consent page per Q2: the first factor, then the
      code if one is owed, then "Allow `<client name>` to act as you in
      `<App>`". The sign-in ends at `firstFactorProven()` and never at
      `issueSession` directly.
- [ ] 2.2 Fetch the client metadata document per Q7: https only, a public
      address, size and time caps, cached. Check `redirect_uri` against it
      exactly, except a loopback port.
- [ ] 2.3 Issue the code bound to its challenge, the way `hashHandoff` binds a
      handoff code: short-lived, single use, and naming the client, the
      redirect and the `resource`.

### Phase 3 — Token

Goal: a code becomes a token the one door accepts.
Done when: a test trades a code for tokens, calls `/mcp` with the access token
at the person's gate level, refreshes, and shows the old refresh token refused.

- [ ] 3.1 `/token`, `authorization_code` grant: verify PKCE, client and
      redirect; refuse a `resource` that is not the MCP URL.
- [ ] 3.2 The access token per Q3, one hour by default. It carries the user, the
      client, the audience and the expiry, and nothing a gate reads, so the
      level is graded at call time as for any session.
- [ ] 3.3 `verifySession` takes the access token's prefix as its third arm. The
      token answers as the `User` with `transport` unchanged, so
      `refuseDelegated` still holds.
- [ ] 3.4 The grant per Q4, created when the code is spent. It holds the refresh
      token, hashed.
- [ ] 3.5 `refresh_token` grant: rotate, and handle reuse per Q5.

### Phase 4 — Living with it

Goal: a person can see and end what they connected, and the trail says what
happened.
Done when: revoking a connection from the sessions list stops its next refresh,
and a password change ends every connection.

- [ ] 4.1 Connected clients show in `listSessions` with the client's name, and
      `revokeSession` ends one.
- [ ] 4.2 A credential change ends grants through `endOtherSessions`.
- [ ] 4.3 Audit entries for granted, refreshed, reuse refused and revoked, with
      tokens redacted (Invariant 7).
- [ ] 4.4 The sweep removes expired grants and codes (`@@expires`, `PURGE`).

### Phase 5 — Proved with a real connector

Goal: it works from the clients people actually use.
Done when: the owner adds example's `/mcp` to claude.ai over a tunnel, signs
in, and a tool call answers at their level. Claude Code's loopback flow passes
the same run.

- [ ] 5.1 A conformance test against § What a connector needs, item by item:
      the 401 header, the exact `resource`, S256 only, form-encoded `/token`,
      rotation.
- [ ] 5.2 The claude.ai run (owner's: it needs their account and a public URL).
- [ ] 5.3 The Claude Code run.

### Phase 6 — On a read-only copy

Goal: `read-only-copy.md` 3.5.
Done when: a connector signed in on the live App answers on a copy staged before
it signed in, until its access token expires, and then handles refresh per Q6.

- [ ] 6.1 The copy accepts access tokens the live App signed: same key, no row.
- [ ] 6.2 Grants move with `Session` into the copy's `sessions` block
      (`FJS-D1921`), so a sign-in on the copy can write one.
- [ ] 6.3 Refresh on the copy per Q6.

---

## Open questions

- **Q1 — Does an unauthenticated `/mcp` call answer `401`?**
  - **A** — yes, whenever the App installs `auth()`. Anonymous level-0 tools end
    for that App.
  - **B** — only when the App turns connector sign-in on.
  - **C** — two paths: `/mcp` stays anonymous, and a second path is the
    signed-in one.
  - **Recommend A** — a connector starts sign-in only on a 401, so an App with
    accounts that answers 200 cannot be connected. B is an option every App
    with auth would set. C is two URLs for one surface, and a person pastes the
    wrong one. 0.2 says what A ends.
- **Q2 — Where does the person sign in and consent?**
  - **A** — one page `@frontierjs/auth` serves at `/authorize`: the first
    factor, the code, consent. It needs no web surface.
  - **B** — redirect to the App's web surface's own sign-in and consent
    screens, as Better Auth and Supabase do.
  - **Recommend A** — an API-only App and the read-only copy have no web
    surface, and the copy is where this matters most. B can follow as a skin
    for an App that has one. 0.3 settles whether A is rendered through Mesa
    (`FJS-D38`) or as plain HTML.
- **Q3 — What is the access token?**
  - **A** — a prefixed HMAC token in `crypto.ts`'s style, with its own prefix
    beside `API_KEY_PREFIX`, signed with a key derived from the App's
    `encryptionKey`.
  - **B** — a JWT signed HS256 with the same key.
  - **C** — a JWT signed with an asymmetric key, plus a JWKS endpoint (Better
    Auth, Supabase).
  - **Recommend A** — the issuer and the only verifier are the same App, so a
    public key buys nothing until a separate server verifies tokens. A routes in
    `verifySession` by prefix the way an API key does, and needs no JOSE
    dependency. C is the answer when a second verifier appears. Rotating
    `encryptionKey` ends every access token within the hour, which is
    acceptable.
- **Q4 — Where does a grant live?**
  - **A** — a `Session` row: a new nullable `clientId` and a separate,
    hashed, refresh-token column.
  - **B** — its own model, `OauthGrant`, in `auth.lite`.
  - **Recommend A** — listing, revoking, ending on a credential change, the
    sweep, and the copy's move to `sessions` (`FJS-D1921`) all come with the
    row. B rebuilds each of them, and Better Auth's seven tables are what B
    grows into. The hazard A brings is that a refresh token must never pass
    `verifySession` as a session token, so it lives in its own column with its
    own prefix and the session lookup never reads that column. 3.4 has a test
    for it.
- **Q5 — What happens when a rotated refresh token is presented again?**
  - **A** — strict: the grant is revoked at once.
  - **B** — a 30-second grace window, then revoke (Better Auth's MCP default).
  - **Recommend B** — Anthropic times a refresh out at 30 s, so a client that
    retries after a timeout presents the token the server just rotated.
    Under A that retry signs the person out. The cost is a stolen refresh token
    replayed inside the window, which Better Auth's page names.
- **Q6 — On the copy, how does a connector refresh?** The copy is restored daily
  and tokens rotate hourly, so the copy almost never holds the connector's
  current refresh token.
  - **A** — the refresh is refused, the connector asks the person to sign in
    again, and the sign-in writes a grant in the copy's `sessions` block. After
    the switch back, the live App does not know that grant either, so the
    person signs in once more.
  - **B** — signed refresh tokens carrying a generation the copy honors when it
    is newer than its own row.
  - **Recommend A** — the copy's sign-in already works (`FJS-D1920`). The
    lifeboat banner says people sign in again (`read-only-copy.md` 3.2a). B is
    a second rotation scheme for a mode that runs during outages only. An
    unknown token is refused, not treated as reuse, so A revokes nothing.
- **Q7 — How does the App know the client?**
  - **A** — CIMD only, fetched with guards.
  - **B** — CIMD, and DCR as a fallback.
  - **C** — an allowlist of client ids the App declares.
  - **Recommend A** — every Claude client supports CIMD, and the MCP spec
    deprecates DCR, which lets anyone register a name and logo (Better Auth's
    warning). C is an option every App must keep current. The fetch is the
    risky part, so 2.2 refuses a private address.
- **Q8 — Does a token carry scopes?**
  - **A** — no: the token is the person, graded by the schema's gates like any
    session.
  - **B** — a `read` scope a person can pick at consent, refused at the tool
    call.
  - **Recommend A** — access is declared in the schema (Invariant 6), and a
    scope is a second place that narrows it. B is the first thing to add if
    people ask to connect Claude read-only, and it would need one owner for
    the refusal.
