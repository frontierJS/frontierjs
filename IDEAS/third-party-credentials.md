---
id: third-party-credentials
status: partial
dated: 2026-08-24
---

# Idea — Third-party credentials: who mints them, who spends them

**Status: THE LOGIN HALF IS BUILT; THE CREDENTIAL SEAM IS NOT.** Dated 2026-08-24.
Supersedes the scope of overview row 2.2 (*OAuth into `auth`*), which framed this
as one feature in one package. It is not: OAuth login and delegated API access are
two halves with one credential between them, and the half `ecosystem-gaps.md` 1
names is the smaller.

**Read the two halves differently.** Phases 0–6 of § Build plan shipped on
2026-08-24 and are BEHAVIOUR — `packages/auth/oauth.ts`, three routes, a
`connections` service, and `example`'s `verify:oauth` (22 assertions, its own IdP
on 8113). Everything else in this file is still an idea and must not be cited as
behaviour: legs one and three — a principal in `CredentialResolver.get()`, an
expiry in the return, an OAuth-shaped `TargetAuth`, refresh under a lock, and the
scope derivation in § The move that makes this FJS — are unbuilt, deliberately and
in that order.

Claims about the current tree were probed rather than read (`VERIFYING.md`) and the
evidence is named inline. One defect was found while probing and is carried at the
end.

---

## The frame — three legs, not one feature

An application that talks to a third party needs all three of these, and only two
of them exist here:

| Leg | Owner | State |
| --- | --- | --- |
| **Outbound** — a call that leaves the process | conduit (D4) | ships; no per-caller credential |
| **Inbound** — a webhook arriving from them | junction raw route + `@frontierjs/toolbelt/signature` | ships, proven by `example`'s `verify:pay` |
| **Credential** — what authorises the outbound | nobody | **missing entirely** |

The third row is the gap, and it is not *OAuth*. OAuth is one way to mint one kind
of credential. What is missing is the thing a minted credential goes into and comes
out of: a per-caller secret with an expiry, resolved at send time, refreshable
without two concurrent sends fighting over it.

Framing it as *OAuth into auth* hides that, which is how the row has stayed an
`M` for as long as it has.

---

## What the tree already has

**Conduit's credential seam is most of the way there.** A target declares
`auth: { type, ref }` — a reference and never the secret — and a `CredentialResolver`
turns the ref into material at send time, so credentials stay out of the registry,
out of `resolve()`/`list()`, out of hooks and off the management routes
(`packages/conduit/src/credentials.ts`). `createEnvResolver({ prefix })` scopes
lookups so a ref cannot reach arbitrary environment. That instinct is the right one
and the per-user case needs it twice over: a ref must not be able to name another
person's credential.

**Auth's schema anticipated the storage.** `Credential` carries `type`, `value`,
`accessToken`, `refreshToken`, `tokenExpiresAt` and `scope`, at `@@gate("8")` with
both tokens `@secret` — which is `@encrypted @guarded(all)`, so nothing outside
`asSystem()` reads them and they are encrypted at rest
(`packages/auth/db/auth.lite`). `type` is `'password'` and `'apiKey'` today; the
`@@index([type, value])` is already the lookup an OAuth provider account id wants.

**The four auth callbacks already cover the decisions.** `onRegister` is awaited and
a throw refuses, so *may this person have an account at all* — a closed beta, a
blocked domain — is answered with no new mechanism.

**The inbound leg is real.** `verify:pay` verifies a signed webhook against a raw
route with no session anywhere, and refuses four separate ways. Whatever a
third-party integration needs on the way in, it exists and is exercised.

### Three gaps, all narrow

1. **`CredentialResolver.get(ref)` takes one argument** — no principal, so a
   per-user token cannot be resolved through it as written
   (`packages/conduit/src/types.ts`, `CredentialResolver`).
2. **It returns `string | null`** — no expiry, so nothing can say *this one is
   stale*. Refresh has no seam to live in. The comment above it notes a transport
   resolves once per attempt, up to `retry_limit + 1` times, which is where a
   refresh-on-401 would naturally sit and currently only counts failures.
3. **`TargetAuth` has no OAuth variant** — `bearer`, `api_key`, `hmac`, `none`.

---

## The shape

> **auth mints, conduit spends.**

`FJS-D06` already rules that **a Provider is a third party the app speaks to** and a
Plugin is what attaches a capability. A user's Google token is a credential for a
party outside the app, so spending it is conduit's realm; proving who the person is
belongs to auth. The seam between them is a row.

**Nothing needs to import anything.** Conduit already declares
`CredentialResolver`; auth can export an object that structurally matches it; the
app wires the two at its composition root. Duck-typed, no edge added to the
dependency graph — the same way caravan reaches junction.

**A target does not multiply.** One declared target `google-calendar`; ten thousand
callers, ten thousand `Credential` rows. `TargetDescriptor` stays process-scoped and
declared, which is the whole point of the package — one place listing what this
process may talk to.

**The principal comes from the ambient call.** Junction's `$` is the service call in
progress and throws by name outside one, so a per-user target reached from a cron
fire fails loudly rather than silently sending as nobody. That failure mode is the
argument for reading it ambiently rather than threading it through `send()`.

---

## The move that makes this FJS rather than a port of Socialite

Conduit targets are **declared, statically, in one place**. `Credential.scope`
already exists. So:

> **A target declares the scopes it needs, and the consent screen asks for the union
> of the declared targets.**

That kills the most common OAuth failure in the wild, and it is silent by
construction: an app asks for scope A, ships, adds a feature needing scope B, and
every existing user's token 403s forever with nothing saying why — because the
consent already granted is the consent they gave last year.

Here it becomes an answer something can compute: a declared target needs a scope no
minted credential holds, so say which, by name, and offer the re-consent. Whether it
runs at boot, in `fli check`, or as a committed snapshot is open below.

This is the same shape as `valueset` (`FJS-D120`) — the list a picker offers is the
list the boundary accepts — applied to consent instead of options.

---

## What was settled in discussion, and why

Recorded as reasoning, not as rulings. None of this is `DECISIONS.md` yet.

**Login only, at first — and *store but never refresh* is refused by name.** Three
options were weighed. Storing a token and never refreshing it pays the entire
security cost of holding third-party secrets (an `encryptionKey` becomes mandatory,
a database compromise reaches other services) and buys a capability that expires in
about an hour — so an app builds refresh itself anyway. Worse, it fails in the shape
this repo is most hostile to: works in dev where the token is fresh, 401s in
production an hour later, nothing saying why.

**The session must not reach the browser by a new route.** The callback is a
full-page redirect, so a bearer token in a response body is not available. Rather
than adding an auth mode, the callback should honour whichever the app already
chose: `cookieAuth: true` sets the cookie and redirects clean; the Bearer default
hands back a single-use, short-lived code the client exchanges — the shape the
widget handoff already uses in `verify:widget`. Putting the session token itself on
the fragment is refused: it is a thirty-day credential written into browser history.

**Identity matching needs three conditions, and the first draft of this paragraph
had two.** It said *a trusted provider asserting `email_verified` links to the
existing user*, which is a published vulnerability class — see § Prior art below.
The third condition is that **the existing account's own address must already be
verified**, because an account that never proved it owns the address is not evidence
of anything:

    link only when all three hold
      provider.trustEmail            the app configured this provider as trustworthy
      claim.email_verified           the provider says it verified the address
      existingUser.emailVerified     we verified it — the one the CVEs miss

Everything else falls back to the app proving control of the address by mail, and a
proof-path link onto a previously unverified account must also **invalidate that
account's password credential**: proof establishes who owns the address, and does
nothing about what somebody else planted before it. Never silently create a second
account for an address that already exists; `User.email` is `@unique @lower`, so the
mistaken path is a `UniqueConflictError` at the Data boundary rather than a duplicate
row.

An app that never verifies email therefore takes the proof path every time. That is
correct rather than a defect, and it is the incentive to turn verification on.

Auto-linking on a fully verified match is still the behaviour people expect, and
refusing *that* buys little: the user who forgot they had a password account does a
password reset, which is proof of control of the same address, taken the long way
round.

---

## Prior art — what n8n does, and what does not transfer

n8n does this the standard way: Authorization Code grant, `state`, tokens encrypted
at rest under a shared `N8N_ENCRYPTION_KEY`, one callback path per instance
(`/rest/oauth2-credential/callback`). Their encryption-key requirement is the same
constraint `@secret` imposes here, for the same reason, and refresh-token rotation
is a live pain in their issue tracker rather than a theoretical one.

**But n8n never does the login half**, and that is why connecting a service there
feels easy. The Google account is not claiming to be a user — it attaches to a
workspace somebody already signed into — so n8n has no identity matching, no account
linking and no session to get back to a browser. Its own login is separate.

Three things make it feel frictionless and none of them is protocol: it is one
server, so there is one redirect URI forever, where an app has one per environment
and per port; n8n Cloud ships pre-registered OAuth applications so you never open a
provider console; and an operator is doing it rather than an end user, so there is no
UX cliff to design.

**Their split is ours.** n8n's credential store is conduit's job, n8n's own login is
auth's job, and they are separate there too. That is a mature product landing on this
boundary independently, which is worth more than the argument for it.

---

## Prior art, and the mistakes it records

Checked before locking anything in, 2026-08-24. Three findings changed the design and
one confirmed it. The sources are named because two of them are CVEs against the exact
rule this file carried an hour earlier.

**The linking rule above was a named vulnerability class.** `CVE-2026-53516` against
Better Auth is described as *the auto-link gate validates only the OAuth provider's
`userInfo.emailVerified` claim; the local row's `emailVerified` field is never read* —
which is what the first draft of § What was settled said, word for word in substance.
`CVE-2026-35511` against Authorizer is the same shape. The attack is pre-registration:
somebody signs up with the victim's address and a password they control, the row is
written unverified, the victim later signs in with Google, and the two are fused with
the attacker's password still on the account. Corrected above.

**`state` must be bound to the user agent, and ours was bound to a database row.**
RFC 9700 (January 2025, BCP 240) requires *one-time use CSRF tokens carried in the
`state` parameter that are securely bound to the user agent*. Keying the flow record
by the state value alone admits login CSRF: an attacker starts a flow, captures their
own `code` and `state` without completing it, and gets the victim to visit the
callback — the session issued is the attacker's and the cookie lands in the victim's
browser, so the victim works inside somebody else's account. **PKCE does not close
this**; it addresses code interception on the device, and the verifier is the server's
rather than the browser's. The fix is an httpOnly cookie set at flow start and
compared against the returned `state` before the row is looked up, which needs no
schema change.

**That cookie must be `SameSite=Lax` and must not be `Strict`.** The callback is a
cross-site top-level GET navigation from the provider; `Strict` withholds the cookie
and the flow fails every time.

**nOAuth is the same root cause one level up, and the schema was already right.**
Mutable `email` used as the identifier instead of the immutable issuer/subject pair —
Semperis found roughly 9% of 104 Entra gallery applications still vulnerable.
`Credential` keys on `@@index([type, value])` where `type` encodes the provider, which
is the correct pair; `value` alone is not, because two providers can issue the same
subject. The operational consequence is that **Microsoft should default to
`trustEmail: false`**: Entra emits unverified email claims deliberately, to support
guest users.

**What the research confirmed rather than changed**: PKCE on every flow including
confidential clients, which RFC 9700 and OAuth 2.1 both require; exact-string redirect
URI matching with no pattern matching, which makes the `publicUrl` derivation
byte-exact rather than approximate; and `returnTo` allow-listing, which the same
document states as a MUST — *clients and authorization servers MUST NOT expose open
redirectors* — rather than as hardening. Junction's session cookie is already
`SameSite=Lax` and carries a note that `SameSite=None` reopens the hole, so the
cookie-mode decision landed on ground that was already defended.

**Where this sits against the ecosystem.** Supabase auto-links by default and has had
to add mitigations behind it; Auth0 ships linking as an opt-in extension. The stance
here — per-provider trust, verified on both sides, and a proof path for everything
else — is closer to Auth0's, which is the right default for a framework: an
application can loosen it deliberately, and a framework that ships the loose default
ships the CVE.

Sources: `GHSA-g38m-r43w-p2q7` (CVE-2026-53516) · `CVE-2026-35511` · RFC 9700 ·
Descope, Okta and Semperis on nOAuth · Auth0 on OAuth CSRF · Supabase identity linking.


## Open questions

**The credential seam**

- Does `get(ref)` gain a principal argument, or is a per-caller resolver a second
  interface? A second interface keeps the process-scoped case exactly as it is.
- What does the resolver return once expiry matters — a string plus an expiry, or a
  richer credential object? Every existing resolver returns a string.
- Is OAuth a fifth `TargetAuth` kind, or does it resolve *to* `bearer`? The second is
  cheaper and the transport already knows how to send a bearer.
- Can one target hold both a machine credential and a per-user one — an app calling
  GitHub as itself and as a person?

**Refresh**

- Lazy at send time, or ahead of expiry on caravan? Lazy needs a lock: two concurrent
  sends both refresh, the provider rotates the refresh token, and one of them is now
  holding a dead one — Google does rotate. The outbox already claims with a
  compare-and-set and is the precedent to copy.
- What does a dead credential mean to a caller? `auth_failed` is terminal today, and
  *this person must reconnect Google* is a UI state rather than an error. It needs a
  name and a way to reach a screen.
- Who notices a revocation at the provider's end, and how does the app find out
  before the next call fails?

**Scope**

- Where does the declared-target scope check run — boot, `fli check`, or a committed
  snapshot? A snapshot makes drift a diff, which is the house answer elsewhere.
- Incremental consent, or one union up front? The union is simpler and asks for more
  than most users have been shown before.

**The login half**

- Route or service for *linking* a second provider to a caller who is already signed
  in? It establishes no session, so `FJS-D20` says service — but it shares the whole
  redirect flow with the half that does.
- Where do `state`, the PKCE verifier and the OIDC nonce live? `Verification` is
  already *identifier, guarded value, expiry* with a sweep in `cleanup.ts`. What is
  the identifier before a user exists?
- One OIDC engine plus per-provider normalisers, or a provider table? Discovery
  covers Google, Microsoft, Okta and Auth0 generically; GitHub and Apple do not.
- Can a caller unlink their last credential and lock themselves out?
- Which surfaces are supported at v1 — `web/` certainly, but `site/`, `widgets/` and
  `extension/` each have a different redirect story and the extension has no origin
  at all.
- Where is the provider configured? `junction.config.js` is nicer, and the hazard is
  known: a plugin must read config in `boot()` and never `register()`, which made
  caravan's entire config section unreachable (`FJS-431`).
- Does the redirect URI get scaffolded? It must match the provider console exactly
  and differs per environment and port (8000, 8010, production).

**The kit**

- Brand sign-in buttons need brand colours, and Invariant 13 says style with a tone
  and a treatment, never a colour. This is the one case where the colour is the
  requirement. Does `@frontierjs/ui` ship them, and under what exemption?

---

## Where this meets the access group

Another session grouped four rows under **access has one shape** — 4.5 `warden`, 3.8
teams, 4.18a membership tenancy, 4.10 audience — on the argument that all four arrive
at one boundary asking *may this caller see this row* on axes that are not comparable.

**This does not join that group**, and the reason is the boundary. Those four all
answer a question at our own Data boundary; this one asks *as whom do we call out, and
with what*, which is the outbound boundary conduit owns. A fifth member would blur what
makes the group coherent, and the group is already large enough to be at risk.

**They meet at exactly one place: the principal.** The group produces a richer one — a
tenant claim and a row-shaped standing resolved per request; this consumes it, because
*whose token* is a question about the caller. So the order matters even though the work
does not merge.

### Who owns a credential is a membership question, and the schema has already answered

`Credential` carries `userId` and no tenant column, and basecamp declares the five auth
models `@@tenant(none)` — spanning tenants deliberately. For a password that is correct.
For a workspace's Slack connection it is not, and 4.18a is the row that says why: most
B2B software is one person in several accounts holding different authority in each.

Person-owned means the integration dies when they leave. Tenant-owned means it survives
and any admin can spend it, but the person consented as themselves. The schema currently
says person-owned by omission — a question answered without being asked.

### The hole: there is no client flavour that is system AND still in one tenant

`Credential` is `@@gate("8")` and only `asSystem()` reads it. `asSystem()` is a complete
bypass of all policies (`packages/litestone/src/core/policy.js` — `if (ctx.isSystem)
return null`), and declared row tenancy desugars to `@@deny`, which is a policy. So the
only client that can read a credential is the one that ignores tenancy.

**A per-tenant credential therefore cannot be enforced declaratively today.** A resolver
would have to carry the tenant in its own where-clause by hand, which is exactly what
Invariant 6 exists to refuse: access is declared in the schema, not in hooks. `$scopedBy`
is not the escape — it binds `@scoped`/`@edge` dimensions, not a tenant.

This is a gap in a **shipped** feature rather than a question about an unbuilt one:
`FJS-374` is closed and basecamp runs on declared tenancy. It belongs to the access group
rather than here, and it is **`FJS-519`**, filed 2026-08-25 once a third instance of the
same cause turned up: `asSystem()` drops every rule at once, and the three callers in this
repo that reach for it each wanted exactly one.

### One ruling, two seams

3.8 names the sharpest unanswered question about the slice format: only one
`GatePlugin({ getLevel })` may be installed, so a slice supplying standing either owns
the ladder outright or contributes a **fragment** an app composes.

Conduit has the identical shape and nobody has noticed: **only one `CredentialResolver`
may be installed**, so a package supplying per-user credentials either owns resolution
outright or contributes a fragment. Same question, second seam, and the precedent for the
answer already exists in `authSchemaFragments(db)`, which contributes into the seed
rather than replacing it.

Whatever 3.8 rules about gate fragments should rule for resolver fragments too.

### Scope is warden-shaped and must not be warden

An OAuth scope is a named, orthogonal, non-comparable permission — literally the shape
4.5 exists to add. It should still not be the same mechanism, because **warden governs
our boundary and a scope governs theirs**. We carry it and reason about it; Google
enforces it, and we could not enforce it if we wanted to.

That makes a scope an affordance about a *foreign* boundary, which is Invariant 6 one
level out: `x-gate` is an affordance the server enforces, and a scope is an affordance
someone else's server enforces. Shared shape, separate mechanism — and the scope
derivation above must not wait for `warden`.

**4.10 audience is the weak link** and is recorded as such. The only connection is that
*which tenant's credential does this send use* resolves like
`tenantFor({ host, headers, principal })`. That is reuse, not shared design.


## Build plan for the login half — BUILT 2026-08-24

Walked through and then built on 2026-08-24. Phases 1–6 are the OAuth login leg;
phase 0 is prerequisite work that is worth doing whether or not it ships. **All
seven landed**, and what follows is kept as written because the reasoning is what
the code is answerable to. Four things came out differently or larger than the
plan says:

- **Phase 0c grew.** `Verification` did not merely gain `purpose` — it was redone
  (`FJS-476`), and `OauthFlow` came out as its own model, because an authorization
  in flight is not a verification: nobody is proving anything, there is no address
  yet, and it carries a PKCE verifier nothing else has a use for.
- **`FJS-474` was two defects**, not one: the boot restore tested `client.token`,
  which is empty for a signed-in caller in cookie mode, and the socket branch
  connected before the session was known.
- **A cookie `Path` bug was found by running the drive**, not by any test: the
  state cookie was scoped to the route as MOUNTED rather than as REQUESTED, so
  every sign-in in an app with an `apiPrefix` failed the state check *exactly the
  way a real attack does*.
- **Phase 4 needed a fifth thing nobody listed**: which providers exist. A screen
  cannot draw buttons for a list it has no way to ask for, so `GET /auth/oauth`
  and `client.auth.providers()` were added after the fact — and the five
  `oauth_error` codes needed sentences, which is sierra's `OAUTH_ERRORS`.

**Phase 0 — three prerequisites, none of them OAuth**

- **0a. Extract `issueSession(user, authMethod)` out of `login()`.** The tail of
  `login()` — the `onLogin` hook, the token, the `Session` row, the audit row — is
  inlined (`packages/auth/auth.ts`). OAuth needs exactly that tail. Extracting it is
  what makes `onLogin` fire for an OAuth sign-in **by construction** rather than by
  somebody remembering, and a hook that fires only for passwords is a lockout hole.
- **0b. `FJS-474`** — the boot restore, since cookie mode is the v1 answer.
- **0c. `FJS-476`** — `Verification` gains `purpose`, both existing lookups filter on
  it, and the OAuth columns arrive in the same change.

**Phase 1 — the flow engine, no server.** Provider descriptor → authorize URL with
`state`, PKCE `S256` and the browser-binding cookie; code plus verifier → token
exchange; token → a normalised `{ providerId, email, emailVerified, name }`. Pure
functions, testable without an HTTP server.

**No `id_token` validation in v1 — fetch userinfo.** One code path for OIDC providers
and for GitHub, no JWKS cache, no JWT verification, no clock skew. It costs one extra
round trip per sign-in, at human frequency. It does *not* dodge the nOAuth problem,
which is about the claim rather than its carrier.

**Phase 2 — routes.** `GET /auth/oauth/{provider}` redirects out;
`GET /auth/oauth/{provider}/callback` comes back. Raw routes take `{provider}` and not
`:provider`. Two hazards belong in from the first line rather than as hardening: the
`returnTo` allow-list, and a redirect URI computed from a stated `publicUrl`, because
the server cannot know its own external address behind a proxy and the provider matches
it byte for byte.

**Phase 3 — identity resolution.** The three-condition rule above, the proof path, and
the password-credential invalidation that follows a proof link.

**Phase 4 — client and Sierra.** Starting a flow is a full-page navigation rather than
an XHR, so the client's job is to build a URL. The boot restore is where the session is
picked up, which is why `FJS-474` is a prerequisite rather than a nicety.

**Phase 5 — a `connections` service.** List and unlink. A service and not a route: it
establishes no session (`FJS-D20`). It must refuse unlinking the last credential.

**Phase 6 — the drive.** A fake provider on **8113** (env 8, category 1, project 1) and
a `verify:oauth` in `example`. Its substance is the refusals, the way `verify:pay`'s is:
a `state` with no matching cookie, a replayed code, an expired flow, an unverified local
account, a `returnTo` off the allow-list.

**Token exchange uses plain `fetch`, not conduit.** Conduit is a peer plugin an app may
not have installed, and requiring it would make auth undeployable without it. Recorded
as the exception rather than left implicit; leg three is where conduit arrives.


## Sequencing

The credential seam is independent of both flows, small, and unblocks each of them.
It should not wait for a decision about OAuth.

1. **The credential seam** — a principal in resolution, an expiry in the return, an
   OAuth-shaped `TargetAuth`. No flow yet, nothing minted. **Not built.**
2. **OAuth login** — mints the row. The redirect and identity questions above.
   **Built 2026-08-24** — and it went first, which the note below says it need not
   have. That cost nothing: the two are independent, and step 2 is what produced a
   `Credential` row with `accessToken`, `refreshToken`, `tokenExpiresAt` and
   `scope` actually populated, which is the thing step 1 resolves.
3. **Conduit spends it** — refresh, the lock, the reconnect state. This is where the
   real work is. **Not built.**
4. **Scope derivation** — the check that makes it FJS. **Not built.**

1 and 2 are independent of each other and both small.

---

## What would prove it

CI reaches no network, so this needs a fake provider process, the same shape as
`example`'s dev payment provider on 8112 — which is the precedent that matters,
because `verify:pay`'s substance is its four separate refusals rather than its happy
path. Next free backend slot for `example` is **8113** (env 8, category 1, project 1).

A drive would have to cover, at minimum: a `state` that does not match, a code
replayed, a provider asserting an unverified address against an existing account, a
link and an unlink, and — for leg three — a send whose credential expired mid-flight
with two callers racing the refresh.

---

## The defect found while probing this

**Sierra's boot restore short-circuits on `!client.token`**
(`packages/sierra/src/junction/session.js`, in `initSession`). Under `cookieAuth`
the browser holds no token, so the restore never asks, and `session.user` stays null
on every cold load while a perfectly valid cookie sits in the jar — the app renders
signed out. The comment explains the short-circuit as avoiding a 401 on every
anonymous visit, which is correct reasoning for the Bearer case and wrong for the
cookie one.

So **`cookieAuth: true` is not wired end to end on the UI side**, whatever the
plugin's own documentation says. It matters here because it is on the critical path
for the redirect-callback question above, but it is a defect today and independent of
any of this.

Filed as **`FJS-474`** (S2), 2026-08-24.
