---
id: mcp-oauth
status: proposed
dated: 2026-11-05
---

# MCP sign-in — an App as the OAuth server its own MCP needs

**Status: PROPOSED.** Dated 2026-11-05. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: a person adds an App's `/mcp` to their own claude.ai (or Claude Code,
Desktop, mobile) as what Anthropic calls a custom connector, signs in as themselves, and every tool
call is graded at their own gate level. Today nobody can, against any App: a
Claude client signs in only over OAuth, and FrontierJS is not an OAuth server.

`FJS-D1922` ruled the shape: `@frontierjs/auth` becomes the authorization
server, and its access tokens are signed rather than stored, so a copy staged
before a token was minted still accepts it. It came out of
`read-only-copy.md` 0.3, which needs it for step 3.5, but the live App needs it
first. "Connector" below is Anthropic's word only; in this repo a `conduit-*`
connector is an outbound integration (`FJS-D1559`), and what a person makes
here is a **connection**. "Claude replaces the UI" only holds if a teammate's Claude can reach the
App, not just the developer's Claude Code with a pasted key.

---

## What a Claude client needs

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
  `FJS-D628`), but only over `/mcp`. `transport: 'mcp'` is set where a tool call
  is dispatched (`mcp/src/plugin.ts`, `run`), so the same token sent to a REST
  route arrives as `http` and is not refused today. 3.3 closes that.
- **An unauthenticated `/mcp` call answers `200` with the level-0 tools**
  (`plugin.ts`, `standingOf(app, null)`), so a connector never starts a sign-in.
  That is Q1.
- **Sessions already have a full lifecycle**: `listSessions`, `revokeSession`,
  `endOtherSessions` on a credential change (`FJS-D1208`), `@@expires` with the
  sweep, and, on a read-only copy, a move into the writable `sessions` block
  (`FJS-D1921`). That is why Q4 recommends a connection be a `Session` row.
  `listSessions` answers only `{ id, createdAt, expiresAt, current }`, so 4.1
  grows it.
- **`resource` has no owner yet.** Nothing in junction reads
  `FRONTIER_API_URL`, the name `FJS-D1102` gave where a client reaches the API.
  auth's provider sign-in states its own `oauth.publicUrl`, and local-files
  builds API file URLs from `FRONTIER_APP_URL`, the SPA's origin. That is Q9.
  `junction/src/core/public-url.ts` is the SSRF guard (`assertPublicUrl`,
  `pinTo`), which 2.2's fetch uses.
- **Junction owns "a throw becomes a 401"** (`http.ts`, the error mapper), and
  `mcp` and `auth` each depend on junction alone, so neither may import the
  other. The issuer is the one value `mcp` needs from `auth`, and it crosses
  through junction config (Q9), not between the two packages.

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

- [x] 0.1 Read the client metadata documents claude.ai and Claude Code publish
      for CIMD: the `client_id` URLs, their `redirect_uris` and
      `grant_types`. Record them verbatim, because 2.2 checks against them.
      **Observed 2026-11-05** by `curl` of each URL (both `200`,
      `application/json`, `cache-control: public, max-age=300`).
      Claude Code's URL is linked from Anthropic's authentication page, and
      claude.ai's is named in its Enterprise Managed Auth page.
  - **claude.ai**, which web, Desktop, mobile and Cowork share:
    `{"client_id":"https://claude.ai/oauth/mcp-oauth-client-metadata","client_name":"Claude","client_uri":"https://claude.ai","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"response_types":["code"],"token_endpoint_auth_method":"none"}`
  - **Claude Code**:
    `{"client_id":"https://claude.ai/oauth/claude-code-client-metadata","client_name":"Claude Code","client_uri":"https://claude.ai","redirect_uris":["http://localhost/callback","http://127.0.0.1/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}`
  - **A confidential twin** exists only for claude.ai, at
    `…/mcp-oauth-client-metadata/confidential_client`
    (`token_endpoint_auth_method: "private_key_jwt"`, `jwks_uri:
    "https://claude.ai/v1/mcp/jwks"`). Claude presents it only when the
    metadata lists `private_key_jwt`. 1.3 lists `"none"` alone, so the
    public document is the one 2.2 sees. Claude Code has no twin (`404`).
  - **`jwt-bearer`** is Enterprise Managed Auth. 1.3 does not advertise it,
    and 3.1 refuses it like any grant it does not name.
  - **Both are public clients**, so the token request proves nothing about who
    sends it (`anthropics/claude-ai-mcp#1221`). For claude.ai the fixed
    `https` redirect is what binds the code to it. For Claude Code any local
    process can bind the port, so 2.1 warns on a loopback-only client, as
    the MCP spec asks.
  - **Lazy authentication** is Anthropic's name for a fourth spelling of Q1,
    not weighed there: `initialize` and `tools/list` answer `200` to anyone,
    and only a `tools/call` for a protected tool answers `401`, after which
    Claude shows an inline Connect card and retries the call. It needs
    `tools/list` to show an anonymous caller tools above its standing, which
    `standingOf(app, null)` hides today. `FJS-D1924` stands. If 0.2 finds an
    App that relies on level-0 tools, this is the spelling to price.
  - **`offline_access`**: Claude adds it to the request only when
    `scopes_supported` lists it. Q8 means no scopes, so 3.1 issues a refresh
    token without being asked for one.
- [x] 0.2 Which apps rely on level-0 MCP tools for an anonymous caller? Search
      this tree and `fjs-prototypes` for `/mcp` used without a Bearer, since Q1
      would end that.
      **Observed 2026-11-05** by `rg` for `@frontierjs/mcp` beside
      `@frontierjs/auth`, then each hit's callers read: `example`, `basecamp`,
      `ela`, `charter`. **No product caller relies on it.** Two tools do, and
      1.1 moves both in the same change:
  - **`example`'s `verify:mcp`** (`web/test/verify-mcp.mjs`) opens a client
    with no credential and checks that a stranger is offered tools and the
    catalog's views. Under A those checks become *a stranger is answered
    `401` with `WWW-Authenticate`*. The level-0 projection stays proved by
    `packages/mcp/test/plugin.test.ts`, whose app installs no `auth()`, and by
    `/levels`.
  - **The terminal client's `login`** (`mcp/src/client/run.ts`) lists tools
    with the key and again without, because a Bearer the app cannot verify is
    read as nobody. Under A the second list answers `401`, so `login` fails
    against every App with `auth()`, which turns `basecamp`'s `verify:cli` red.
    A `401` to the keyed list is now the refusal itself, and the comparison
    goes.
  - **Not affected**: `basecamp`, `ela` and `charter` always send a Bearer.
    The mcp package's own tests install no `auth()`. `sierra/src/mcp/host.js`
    is `postMessage`.
  - **Lazy authentication** (0.1) has no App to serve, so it is not priced.
- [x] 0.3 Price Q2's mechanism: the page authored in Mesa and shipped as its
      compiled output, a string module inside `auth`, so `auth` takes no
      runtime dependency on Mesa (Invariant 1) and the output is reproducible
      (Invariant 12). Check it against SSR string mode (`FJS-D1634`) and
      `@frontierjs/css` (Invariant 13). Plain HTML is a second UI origin
      against `FJS-D38`, so it is the fallback, not the default.
      **Observed 2026-11-05** on a prototype page (all three steps, props, an
      `{#if}` chain), compiled `target: 'server'` and bundled with
      `Bun.build`. The mechanism holds, so plain HTML is not needed. Ruled
      `FJS-D1934`.
  - **The output imports two runtimes**, `@frontierjs/mesa/runtime` (the
    signals) and `runtime/server` (`esc`, `attrs`). Shipped raw, that is a
    runtime dependency, so the page ships bundled.
  - **Bundled, it is 13.5 KB minified (5.3 KB gzipped).** It is byte-identical
    across two builds and renders in plain Bun with no `document` and no
    happy-dom. `<` in the App's name and `"` in a hidden value come out
    escaped.
  - **Calling it through `renderToHTML` brings in happy-dom**: 908 KB. The page
    needs `_renderString`'s synchronous core as a Mesa export that does not
    import `render.js`.
  - **The CSS subset** (reset, tokens, default and dark themes, tones, chip,
    surface, layout, typography, buttons, alerts, cards, form-core,
    `a11y/focus`) is 31 KB minified (6.4 KB gzipped), and also reproducible.
    The whole bundle is 120 KB.
  - **The `snapshots` phase already fits.** It takes any `*.snapshot.<ext>`,
    its `GENERATOR` pattern reads a `/* generated by: … */` header, and `fli`
    is in `SNAPSHOT_BINS`. No API-realm package depends on Mesa today, and
    none needs to, because the generator runs from `fli`.
  - **Chromium enforces `form-action` on the redirect.** A probe page posted
    to a route that answers `302` to another origin. Under `form-action
    'self'`, Chromium 1234 stayed on the page, and Firefox 1538 followed the
    redirect. Naming the redirect's origin, or no `form-action` at all, let
    both through. WebKit did not launch. Junction's helmet default is `form-action
    'self'` (`FJS-D1192`), so the consent page sets its own header, which the
    transport keeps rather than doubles.
- [x] 0.4 Settle the seams with `bridge-index`:
  - **The 401.** `mcp` throws Junction's `Unauthorized`, and Junction's mapper
    adds `WWW-Authenticate`. Check whether `Unauthorized` can carry a header
    today.
  - **The metadata.** It is `mcp`'s, and reads the issuer from an
    `app.own('…')` value that `auth()` takes.
  - **`resource`.** It comes from `public-url.ts`.
  - **The `.well-known` routes.** They sit at the root, outside both packages'
    prefixes.

  **Observed 2026-11-05** by reading each owner the seam names. Two seams
  were not where the plan put them: Q9 (`FJS-D1935`) and Q10 (`FJS-D1936`).
  - **The 401 cannot carry a header today.** `FrameworkError` has `code`,
    `data`, `cause` and `retryable`, and `errorResponse` (`bridge.ts`) writes
    a fixed `JSON_HEADERS`. No junction 401 sends `WWW-Authenticate`, though
    RFC 9110 § 11.6.1 says a 401 must. A 401 passes `sanitizeError`
    unchanged, and `_finalizeWithHeaders` (`http.ts`) adds only CORS,
    security, rate-limit and correlation headers, so a header the mapper
    writes reaches the client. Q10.
  - **`resource` has no owner.** `public-url.ts` is the SSRF guard, which
    2.2 uses. Q9 makes the API's origin a junction config value, and
    `resource` derives as `publicUrl + apiPrefix + path`.
  - **The metadata splits by owner.** The protected-resource document is
    `mcp`'s. The authorization-server document lists `/authorize` and
    `/token`, which only `auth` mounts, so it is `auth`'s. Both read Q9's
    origin from junction config, so neither needs an `app.own` value, and
    `auth` takes none today. It fills junction's `app.auth` slot.
  - **Root routes go through `app.http.router`**, the documented escape
    beneath `app.get` (`app.ts`, Route shortcuts). It applies no
    `apiPrefix`. Today only junction's `example/fullstack` uses it.
  - **A front door can hide the root.** When the web surface proxies `/api`
    on one origin, `/.well-known/…` reaches the static host and not the API.
    The `401`'s `resource_metadata` URL can sit under the prefix, since a
    client follows the header first. The authorization-server document has
    no header, so 1.3 handles it.
  - **CSRF passes `/token`.** It is a form `POST` from claude.ai's servers or
    a local process, with no `Origin`, `Referer` or `Sec-Fetch-Site`, and
    `csrf()` step 5 lets that through (`middleware.ts`). The consent form is
    same-origin (step 1). Neither needs a change.

### Phase 1 — Discovery

Goal: a connector learns where to sign in.
Done when: `claude mcp add --transport http <example>/mcp` opens a browser at
the App's `/authorize`.

- [x] 1.1 `/mcp` answers `401` with `WWW-Authenticate: Bearer
      resource_metadata=…` per Q1. That covers a Bearer that fails to verify
      as well as none, because Claude refreshes an expired token only on a
      `401`. The check sits in the route and not in `app.mcp.answer`, which
      devtools calls as a named principal. `example`'s `verify:mcp` and the
      client's `login` move in the same change (0.2).
  - **First, two junction changes, each its own change.** Q9's `publicUrl`
    (in `loadConfig`, with a `config-surface.test.ts` row), which moves
    auth's provider callback and local-files' `publicBase` onto it, and
    Q10's `challenge` (`errorResponse`, `errors.snapshot.md`).
  - **The route throws** `Unauthorized` with `challenge: { resource_metadata }`.
    A test asserts the exact header string, because a connector missing it
    silently shows "not signed in".

  **Built 2026-11-05.** Proved by `verify:mcp` 38/38, `verify:oauth` 28/28,
  basecamp `verify:cli` 39/39, and the junction, auth and mcp suites. All
  three changes landed in one uncommitted tree. Seven things the plan did not
  say:
  - **`publicUrl` is read only where a host boots.** `FRONTIER_API_URL` fills
    it in the `load-config` phase, which is `needsHost`, so an in-process
    `createTestApp` sees only what its config states. auth's `oauth` now
    refuses to boot without it, naming the env var. `example` and basecamp
    state it with a dev fallback.
  - **Basecamp's dev Google sign-in now ends on the API port.** The callback
    moved off the web origin. The owner kept Q9 over a callback-origin option.
  - **The local-files URL is the API's origin**, where it was
    `FRONTIER_APP_URL`. The route is the API's, so a web surface on another
    origin need not proxy it.
  - **"Installs `auth()`" is the plugin name** `@frontierjs/auth` in
    `app._plugins`, because `mcp` may not import `auth`. An App with a
    verifier and no `auth()` still lists level-0 tools to a stranger.
  - **The metadata URL sits under the prefix**:
    `<publicUrl><apiPrefix>/.well-known/oauth-protected-resource<mcp path>`.
    This is so it survives a front door (0.4). With no `publicUrl` it falls
    back to the request's own origin, which only a dev boot reaches.
  - **A Bearer that fails also carries `error="invalid_token"`** (RFC 6750
    § 3.1), and the CLI's `login` reads that 401 as the refusal. It compares
    no second tool list.
  - **Hand-written 401s carry no header.** `ctx.json(…, 401)` and
    `new Response(…, { status: 401 })` in health, webhooks, export, devtools,
    `bearer.ts` and `http.ts` bypass `errorResponse`. None of them is `/mcp`.
- [ ] 1.2 `/.well-known/oauth-protected-resource` (and the path-suffixed form)
      names the MCP URL as `resource` and the App's issuer as its one
      authorization server. `mcp` mounts it through `app.http.router` (0.4),
      and under the prefix too, at the URL 1.1's header names.
- [ ] 1.3 `/.well-known/oauth-authorization-server`: issuer, the two endpoints,
      `code_challenge_methods_supported: ["S256"]`,
      `token_endpoint_auth_methods_supported: ["none"]`,
      `client_id_metadata_document_supported: true`, the grant types.
      `auth` mounts it, since it names `auth`'s endpoints (0.4). An App
      whose front door sends the root to a static host is told at startup
      that the document is unreachable. Price whether to say so or to serve
      the issuer's path-appended discovery form under the prefix.

### Phase 2 — Authorize

Goal: a person signs in as themselves and approves the connector.
Done when: a test runs password plus TOTP through `/authorize` and gets a code
back at a loopback redirect, and the same run with a wrong redirect is refused
before any page is shown. A document whose own `client_id` is not the URL
fetched is refused too. A document naming itself `Claude` from another host
shows that host on the page and not the name, and the Claude Code fixture shows
the loopback warning.

- [ ] 2.1 The sign-in and consent page per Q2: the password, then the TOTP
      code if one is owed, then "Allow `<client_id host>` to act as you in
      `<App>`", with the redirect's host shown and a warning when every
      redirect is loopback (0.1). The host and not `client_name`, because
      the document asserts its own name. The sign-in ends at
      `firstFactorProven()` and never at
      `issueSession` directly. A magic link or a provider click returns to the
      web surface (`FJS_APP_URL/sign-in/link`) and would have to carry the
      pending request through, so both are outside v1.
  - **Planned per `FJS-D1934`** (0.3). The source is `auth`'s `Authorize.mesa`.
    `fli mesa:pack` writes `authorize-page.snapshot.js` beside it, and
    `auth`'s `files` lists it.
  - **The string render's synchronous core becomes a Mesa export** that
    `render.js`'s `_renderString` calls. It comes first, in its own change.
  - **Styling** uses tones and treatments only (Invariant 13). The page has no
    script. `style-src` is the hash the generator writes.
  - **`form-action`** is `'self'` plus the checked redirect's origin.
  - **Tests** check that the hash equals the inlined style, that `form-action`
    names no other origin, and that a hostile `client_name` and host render
    escaped.
  - **A drive in Chromium** follows Allow through to the redirect.
- [ ] 2.2 Fetch the client metadata document per Q7: https only, a public
      address through `public-url.ts`'s `gradePublicUrl` and `pinTo`, size
      and time caps, cached no longer than its `max-age`. Its
      own `client_id` must equal the URL fetched. Check `redirect_uri`
      against it exactly, except a loopback port, on both `localhost` and
      `127.0.0.1`. A redirect that is neither `https` nor loopback `http` is
      refused, so 2.1's `form-action` never meets an opaque origin. The test fixtures are 0.1's two documents verbatim.
- [ ] 2.3 Issue the code bound to its challenge, as a row in the table
      `hashHandoff` already writes rather than a new one: short-lived, single
      use, and naming the client, the redirect and the `resource`.

### Phase 3 — Token

Goal: a code becomes a token the one door accepts.
Done when: a test trades a code for tokens, calls `/mcp` with the access token
at the person's gate level, refreshes, and shows the old refresh token refused.

- [ ] 3.1 `/token`, `authorization_code` grant: verify PKCE, client and
      redirect; refuse a `resource` that is not the MCP URL.
- [ ] 3.2 The access token per Q3, one hour by default. It carries the user, the
      client, the audience and the expiry, and nothing a gate reads, so the
      level is graded at call time as for any session.
- [ ] 3.3 `verifySession` takes the access token's prefix as its third arm and
      answers the `User` with `delegated: 'connection'`. `refuseDelegated`
      (`junction/src/auth/delegation.ts`, its one owner) refuses on that field
      as it does on `support`, whatever the transport. Test: a connection's
      token is refused `createApiKey` and a password change over REST, and the
      same token's data write at the person's level succeeds over `/mcp` on
      the live App. Only the copy is read-only; a connection is not.
- [ ] 3.4 The connection per Q4, created when the code is spent. It holds the
      refresh token hashed and `@guarded`. Test: its refresh token presented as
      a Bearer is anonymous.
- [ ] 3.5 `refresh_token` grant: rotate, and handle reuse per Q5.

### Phase 4 — Living with it

Goal: a person can see and end what they connected, and the trail says what
happened.
Done when: revoking a connection from the sessions list, or a password change,
stops its next refresh. An access token already minted answers until it
expires.

- [ ] 4.1 Connections show in `listSessions` with the client's name, and
      `revokeSession` ends one. `AuthSessionInfo` grows a `client` field.
- [ ] 4.2 A credential change ends connections through `endOtherSessions`.
- [ ] 4.3 Audit entries for connected, refreshed, reuse refused and revoked.
      The tokens are `@guarded` columns, so Invariant 7 redacts them.
- [ ] 4.4 The sweep removes expired connections and codes (`@@expires`,
      `PURGE`).

### Phase 5 — Proved with a real connector

Goal: it works from the clients people actually use.
Done when: the owner adds example's `/mcp` to claude.ai over a tunnel, signs
in, and a tool call answers at their level. Claude Code's loopback flow passes
the same run.

- [ ] 5.1 A conformance test against § What a Claude client needs, item by item:
      the 401 header, the exact `resource`, S256 only, form-encoded `/token`,
      rotation.
- [ ] 5.2 The claude.ai run (owner's: it needs their account and a public URL).
- [ ] 5.3 The Claude Code run.

### Phase 6 — On a read-only copy

Goal: `read-only-copy.md` 3.5.
Done when: a connector signed in on the live App answers on a copy staged before
it signed in, until its access token expires, and then handles refresh per Q6.

- [ ] 6.1 The copy accepts access tokens the live App signed: same key, no row.
- [ ] 6.2 Connections move with `Session` into the copy's `sessions` block
      (`FJS-D1921`), so a sign-in on the copy can write one.
- [ ] 6.3 Refresh on the copy per Q6.

---

## Open questions

- ~~**Q1 — Does an unauthenticated `/mcp` call answer `401`?**~~ **Answered 2026-11-05 (`FJS-D1924`): A — yes, whenever the App installs `auth()`. Anonymous level-0 tools end for that App.**
  - **A** — yes, whenever the App installs `auth()`. Anonymous level-0 tools end
    for that App.
  - **B** — only when the App turns connector sign-in on.
  - **C** — two paths: `/mcp` stays anonymous, and a second path is the
    signed-in one.
  - **Recommend A** — a connector starts sign-in only on a 401, so an App with
    accounts that answers 200 cannot be connected. B is an option every App
    with auth would set. C is two URLs for one surface, and a person pastes the
    wrong one. 0.2 says what A ends.
- ~~**Q2 — Where does the person sign in and consent?**~~ **Answered 2026-11-05 (`FJS-D1925`): A — one page `@frontierjs/auth` serves at `/authorize`: the password, the TOTP code, consent. It needs no web surface for the factors that finish on the page; a magic link and a provider click are outside v1 (2.1).**
  - **A** — one page `@frontierjs/auth` serves at `/authorize`: the password,
    the TOTP code, consent. It needs no web surface for the factors that finish
    on the page; a magic link and a provider click are outside v1 (2.1).
  - **B** — redirect to the App's web surface's own sign-in and consent
    screens, as Better Auth and Supabase do.
  - **Recommend A** — an API-only App and the read-only copy have no web
    surface, and the copy is where this matters most. B can follow as a skin
    for an App that has one. 0.3 prices A as Mesa output shipped inside `auth`
    (`FJS-D38`), with plain HTML only as the fallback.
- ~~**Q3 — What is the access token?**~~ **Answered 2026-11-05 (`FJS-D1926`): A — a prefixed HMAC token in `crypto.ts`'s style, signed with a key derived from the App's `encryptionKey` and domain-separated the way `hashHandoff` is (`access:` + …). The prefix cannot start with `fjs_`, because `verifySession` tests `API_KEY_PREFIX` first and would read it as an API key. `fja_`, say. An App that turns sign-in on without an `encryptionKey` is refused at construction, as `requireSecondFactor` is.**
  - **A** — a prefixed HMAC token in `crypto.ts`'s style, signed with a key
    derived from the App's `encryptionKey` and domain-separated the way
    `hashHandoff` is (`access:` + …). The prefix cannot start with `fjs_`,
    because `verifySession` tests `API_KEY_PREFIX` first and would read it as
    an API key. `fja_`, say. An App that turns sign-in on without an
    `encryptionKey` is refused at construction, as `requireSecondFactor` is.
  - **B** — a JWT signed HS256 with the same key.
  - **C** — a JWT signed with an asymmetric key, plus a JWKS endpoint (Better
    Auth, Supabase).
  - **Recommend A** — the issuer and the only verifier are the same App, so a
    public key buys nothing until a separate server verifies tokens. A routes in
    `verifySession` by prefix the way an API key does, and needs no JOSE
    dependency. C is the answer when a second verifier appears. Rotating
    `encryptionKey` ends every access token at once, and each connection
    refreshes into a new one. One hour is the default lifetime because a
    revoke or a password change takes effect only at the next refresh. Fifteen
    minutes would narrow that, at four refreshes an hour.
- ~~**Q4 — Where does a connection live?**~~ **Answered 2026-11-05 (`FJS-D1927`): A — a `Session` row: a new nullable `clientId`, `token` made nullable (a connection has no session token, and `findFirst({ where: { token } })` never matches a null), and two `@guarded` refresh columns, the current hash and the previous one with its `rotatedAt` for Q5.**
  - **A** — a `Session` row: a new nullable `clientId`, `token` made nullable
    (a connection has no session token, and `findFirst({ where: { token } })`
    never matches a null), and two `@guarded` refresh columns, the current hash
    and the previous one with its `rotatedAt` for Q5.
  - **B** — its own model, `OauthConnection`, in `auth.lite`.
  - **Recommend A** — listing, revoking, ending on a credential change, the
    sweep, and the copy's move to `sessions` (`FJS-D1921`) all come with the
    row. B rebuilds each of them, and Better Auth's seven tables are what B
    grows into. The hazard A brings is that a refresh token must never pass
    `verifySession` as a session token, so it lives in its own column with its
    own prefix, and the session lookup never reads those columns. 3.4 has a
    test for it. "Grant row" is already the Bearer's (`VOCABULARY.md`), so this
    paper says connection.
- ~~**Q5 — What happens when a rotated refresh token is presented again?**~~ **Answered 2026-11-05 (`FJS-D1931`): B — a 30-second grace window, then revoke (Better Auth's MCP default).**
  - **A** — strict: the connection is revoked at once.
  - **B** — a 30-second grace window, then revoke (Better Auth's MCP default).
  - **Recommend B** — Anthropic times a refresh out at 30 s, so a client that
    retries after a timeout presents the token the server just rotated.
    Under A that retry signs the person out. The cost is a stolen refresh token
    replayed inside the window, which Better Auth's page names.
- ~~**Q6 — On the copy, how does a connection refresh?**~~ **Answered 2026-11-05 (`FJS-D1928`): A — the refresh is refused, the connector asks the person to sign in again, and the sign-in writes a connection in the copy's `sessions` block. After the switch back, the live App does not know that connection either, so the person signs in once more.** The copy is restored daily
  and tokens rotate hourly, so the copy almost never holds the connector's
  current refresh token.
  - **A** — the refresh is refused, the connector asks the person to sign in
    again, and the sign-in writes a connection in the copy's `sessions` block. After
    the switch back, the live App does not know that connection either, so the
    person signs in once more.
  - **B** — signed refresh tokens carrying a generation the copy honors when it
    is newer than its own row.
  - **Recommend A** — the copy's sign-in already works (`FJS-D1920`). The
    lifeboat banner says people sign in again (`read-only-copy.md` 3.2a). B is
    a second rotation scheme for a mode that runs during outages only. An
    unknown token is refused, not treated as reuse, so A revokes nothing.
- ~~**Q7 — How does the App know the client?**~~ **Answered 2026-11-05 (`FJS-D1929`): A — CIMD only, fetched with guards.**
  - **A** — CIMD only, fetched with guards.
  - **B** — CIMD, and DCR as a fallback.
  - **C** — an allowlist of client ids the App declares.
  - **Recommend A** — every Claude client supports CIMD, and the MCP spec
    deprecates DCR, which lets anyone register a name and logo (Better Auth's
    warning). C is an option every App must keep current. The fetch is the
    risky part, so 2.2 refuses a private address. A shuts out a client that
    supports only DCR (Cursor, ChatGPT and the MCP inspector may be among
    them, unchecked), and B can follow for one. "Every Claude client supports
    CIMD" is read from Anthropic's page; 0.1 observes it.
- ~~**Q8 — Does a token carry scopes?**~~ **Answered 2026-11-05 (`FJS-D1930`): A — no: the token is the person, graded by the schema's gates like any session.**
  - **A** — no: the token is the person, graded by the schema's gates like any
    session.
  - **B** — a `read` scope a person can pick at consent, refused at the tool
    call.
  - **Recommend A** — access is declared in the schema (Invariant 6), and a
    scope is a second place that narrows it. Under A a connection writes to the
    live database at the person's level, which the owner wants kept open
    (2026-11-05); only credential writes are refused (3.3). B is the first thing to add if
    people ask to connect Claude read-only, and it would need one owner for
    the refusal.
- ~~**Q9 — Who states the API's public origin?**~~ **Answered 2026-11-05 (`FJS-D1935`): A — junction config: one `publicUrl`, defaulting from `FRONTIER_API_URL`, refused at startup when it carries a path or a trailing slash. auth's issuer and provider callback, mcp's `resource` and local-files' `publicBase` read it, and `oauth.publicUrl` is removed with every caller moved.** The issuer and `resource` are
  exact strings, and so is a provider's redirect URI (0.4).
  - **A** — junction config: one `publicUrl`, defaulting from
    `FRONTIER_API_URL`, refused at startup when it carries a path or a
    trailing slash. auth's issuer and provider callback, mcp's `resource` and
    local-files' `publicBase` read it, and `oauth.publicUrl` is removed with
    every caller moved.
  - **B** — `auth()` takes a top-level `publicUrl`, owns it through `app.own`,
    and `mcp` reads it there. local-files keeps its own reading.
  - **C** — each package states its own, two values that must agree exactly.
  - **Recommend A** — junction already owns config and `apiPrefix`, and
    `FJS-D1102` named `FRONTIER_API_URL` as where a client reaches the API. B
    makes `mcp` read a value from `auth` that is not `auth`'s, and leaves
    local-files reading the SPA's origin. C fails only at the client. Prior
    art states one base URL: Better Auth's `baseURL` (`BETTER_AUTH_URL`),
    Laravel's `APP_URL`, Supabase's `API_EXTERNAL_URL`. Moving local-files
    off `FRONTIER_APP_URL` changes file URLs for an App whose SPA and API
    origins differ, so that move carries its own test.
- ~~**Q10 — How does a 401 carry its challenge?**~~ **Answered 2026-11-05 (`FJS-D1936`): A — `Unauthorized` takes a narrow `challenge` of auth-params. `errorResponse` writes `WWW-Authenticate: Bearer` on every 401, with the params quoted when a challenge is given, on fresh headers rather than the shared `JSON_HEADERS`. The challenge never reaches `toJSON()`.** No junction 401 sends
  `WWW-Authenticate` today (0.4).
  - **A** — `Unauthorized` takes a narrow `challenge` of auth-params.
    `errorResponse` writes `WWW-Authenticate: Bearer` on every 401, with the
    params quoted when a challenge is given, on fresh headers rather than the
    shared `JSON_HEADERS`. The challenge never reaches `toJSON()`.
  - **B** — `FrameworkError` takes generic `headers` that the mapper copies.
  - **C** — `mcp` builds its own 401 `Response`.
  - **Recommend A** — `errorResponse` stays the one place a thrown value
    becomes a status and its headers (Invariant 4), and every 401 meets RFC
    9110. B lets any throw set `Set-Cookie`, `Location` or `Cache-Control`
    (`FJS-1662`). C is a second 401 beside the owner and leaves every other
    one bare. A second header-carrying error, `Retry-After` on a 429, would
    be added the same narrow way.
