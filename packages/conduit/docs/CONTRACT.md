# The connector contract

Written after Tier A, from what eight dialects disagree about: Stripe (bearer
over form, HMAC webhooks), the example's psp (this project's own HMAC over
JSON), Resend (bearer over JSON, Svix webhooks), S3 (SigV4 over bytes, a
call that never crosses conduit), Telnyx (bearer over JSON, Ed25519
webhooks), Cloudflare (a 200 that fails, one batch), DigitalOcean and Hetzner
(two money dialects, two error envelopes, two marking grammars). Every Tier B
and C connector is graded against the clauses below; an amendment names the
connector that forced it and the reason, in § Amendments.

`FJS-D890` fixes what a package CONTAINS. This fixes how the pieces behave.

## C1 — The builder returns, the app installs

`<name>Target(opts) → TargetDescriptor`. It reads no environment; `address`
and `ref` are arguments with the vendor as the default address. Facts about
the counterparty go on the descriptor, never per call: `encoding`, a pinned
version header, a required `User-Agent`, the idempotency header name.
*(Stripe: `Stripe-Version` and `Idempotency-Key` moved from the call to the target.)*

More than one target installed together is ONE builder and ONE bind:
`<name>Targets(opts) → { <role>: TargetDescriptor }` and
`bind<Name>(conduit, targets) → { <role>: Send }`, and every call takes the
bundle and picks its own role. *(Quo; § Amendments, C1 — the bundle.)*

One target per ACCOUNT where a credential is a tenant's (`provider:<vendor>:<accountId>`),
one per process where it is the process's (`provider:<vendor>`).
*(Cloudflare, DO, Hetzner: a token is a workspace's — `FJS-1020`.)*

## C2 — Every call takes `send`, never an app

`Send = (req) => conduit.send({ target, ...req })`, bound by `bindSend(conduit, target)`.
With more than one target, `bind<Name>` returns one `Send` per role (C1).
A connector that holds `app` cannot run in a drive with no junction in the
process, and every drive here runs without one.

## C3 — One reader of `error.raw`

`translate(error, status?, headers?) → <Name>Failure { kind, retryable, message, code? }`.
It reads the vendor's error body out of `raw` and the HTTP status out of
`meta.status`, and nothing else in the package touches either. `kind` is a
DOMAIN word (`declined`, `opted_out`, `gone`, `capacity`) or the conduit kind
passed through; a connector never invents a `ConduitErrorKind`.

- A 404 is read off the STATUS: every 4xx is `client_error` to conduit, so
  the kind cannot tell *gone* from *malformed*. *(DO, Hetzner, S3.)*
- A refusal that is *not now* (`capacity`, `quota`) is its own kind, neither
  retryable now nor refused forever. *(Hetzner 423, Resend daily quota.)*
- An auth refusal that is the POLICY's and not the key's (`forbidden`) is
  told apart from `auth_failed`, because only the second should forget a
  credential. *(S3 `AccessDenied`, Cloudflare 403.)*

## C4 — A 2xx that is a failure is refused by `validate`

Where the vendor says *failed* inside a 200, every call passes a
`ResponseValidator` that refuses it, so it lands as `invalid_response` with the
body on `raw` and C3 reads the sentence. Reading `result` off a failed
envelope gives an empty list, which is a plausible wrong answer.
*(Cloudflare `success: false`; ahead: Slack `ok: false`, Turnstile, Google.)*

## C5 — Idempotency is the vendor's claim, stated by the connector

- A write the vendor collapses under a key sends the key under the vendor's
  header name, and the key is the CALLER's — a uuid minted in the connector
  guards nothing. *(Stripe refunds.)*
- A write the vendor does NOT collapse is sent with **no key**, because a key
  the target ignores makes a replayed request look collapsed. The connector
  never forwards one. *(Cloudflare batch, DO create, Hetzner create.)*
- A write that moves nothing is `replayable: true` and unkeyed, so conduit may
  retry it; after a refusal the next attempt must be NEW. *(Stripe intents.)*
- Everything else is unkeyed and unreplayable: a 429, a 5xx and a lost
  response come back to the caller with `retryable` and `retry_after_ms`, and
  **conduit does not replay an unkeyed POST even on a 429** — the connector
  hands the wait over. *(Resend, Telnyx, every create.)*

## C6 — A lost response is `indeterminate`, and the connector names the read that resolves it

Every write that cannot be keyed documents the idempotent read that says
whether it landed: Telnyx `getMessage(id)`, Cloudflare `records(zone)`,
DO/Hetzner `list({ tag | labelSelector })`, S3 `headObject`. The drive proves
the write landed after the timeout.

## C7 — Money is minor units plus a currency

Converted once, in the connector, with `@frontierjs/toolbelt/units`'s
exponent for THAT currency, never `* 100`. A vendor's float, decimal string
or `net`/`gross` pair is read into `{ amount: integer, currency }`. *(DO
`84.005` → 8401 USD; Hetzner `"4.35"` gross × 1.19 → 518 EUR.)*

## C8 — The verifier is pure and takes the clock

`verify<Name>Signature({ rawBody, headers, secret | publicKey, now }) →
{ ok: true, event } | { ok: false, reason }`. Over the RAW bytes; freshness
checked before any crypto; every candidate signature tried (rotation);
constant-time compare with the length checked first; the reason is for the
log and never the response. Three families fit it unchanged: HMAC with a
shared secret (Stripe, psp, Svix), Ed25519 with a public key (Telnyx), and —
ahead — a URL credential compared constant-time where the vendor signs
nothing (Postmark). What the app does with the event (dedupe by id, write a
suppression row) stays the app's; the connector may name it
(`suppressionFor(event)`, `keywordOf(text)`).

## C9 — A refusal the connector can make itself is made before the send

A major-unit amount, a non-E.164 number, a label key with a colon, an
oversized payload, a missing required header: refused locally with a
sentence, because the vendor's refusal costs a round trip and is worded for
somebody else. *(Stripe, Telnyx, Hetzner.)*

## C10 — The sink is a separate listener on `port: 0` and parses the wire by hand

Chaos switches under `/_sink/arm`, what arrived under `/_sink/seen` (recorded
on ARRIVAL, so a held request counts as an attempt), `/_sink/reset` clears
what arrived and what is armed and keeps the state later sections need. The
five chaos cases every sink answers: `lost` (applied, never answered),
`rateLimit: { retryAfter }`, `failNext`, a duplicate delivery where the
vendor sends events, and the vendor's own domain refusal. The sink decodes
independently of conduit's encoder (Stripe's form parser, S3's SigV4
verifier) so a drift in the encoder is a refusal rather than an agreement.

## C11 — The drive is a table of claims, with a negative control

`results()` / `report()` from `lib/drive.ts`; one row per claim; expected
values beside the drive, not inside it. A fixture is the same rows against
`FIXTURE_URL`, chaos rows excluded. At least one row must FAIL when the
feature is removed (Stripe's form encoding, S3's wrong secret).

## C12 — What stays the app's

The mark and its spelling (Cloudflare `comment`, DO tags, Hetzner labels) —
the connector takes a predicate or the spelled value. The suppression row,
the dedupe table, the cache of a paid lookup, the tenant's credential. A
vendor's extension to a protocol until a second implementation shares it
(`FJS-D889`).

## C13 — Where the connector reaches past the seam, it says so

A `signed` target has no parameters, so a signer that needs one (SigV4's
region) is a factory registered under a parameterized name. A credential with
several parts rides the resolver's one string in a stated spelling
(`<accessKeyId>:<secretAccessKey>`). A call that cannot cross conduit
(presign) is a named function with its reason in the header
comment. Each of these is a framework gap filed by id, and the package's
`PROJECT_STATE.md` names it.

## Amendments

- **C5 — plausible** — added the read-only case explicitly: a POST that only READS is `replayable: true`, so conduit itself replays a lost response and a 429 with `Retry-After`; a 429 with no header on such a read is retried by conduit's own backoff and reaches the caller only after the retries are spent, which for an hourly budget is `quota`.
- **C8 — postmark** — the third family is real: where the vendor signs nothing, the verifier is a constant-time compare of the credential the app embedded in the webhook URL (`verifyPostmarkWebhook({ authorization, credential, ip?, allowIps? })`), and the README's first paragraph says the request itself is unauthenticated.
- **C4 — turnstile** — a vendor that answers 200 for EVERY verdict (not only failures) still fits: `validate` refuses `success: false` and the kind is read off the body's codes.
- **C8 — mailgun** — a signature that covers NO byte of the body (HMAC over `timestamp + token`) still fits: the verifier takes the clock AND `seenNonce`, spends the token as the nonce, and keeps the window tight (5 minutes), because inside it a captured signature verifies over any body. It is also the first dialect whose `parse` is async — a MIME parser is — and conduit's `Dialect.parse` type widened to a promise for every dialect rather than a flag for one.
- **C5 — mailgun** — a vendor that reads a REPEATED form key (`o:tag`, `o:tag`) gets ONE, because conduit's form encoder writes an array as `k[0]` and the vendor ignores it; what would have been the second key rides where the vendor keeps a map (`v:` variables), as Postmark's `Metadata` does.

- **C1 — google-maps** — a vendor served from several origins is one descriptor each from ONE builder (`googleMapsTargets() → { places, routes, geocoding }`): a descriptor has one address, and they share the one fact that matters, the key's `ref`. `<name>Target(opts) → TargetDescriptor` holds per origin.
- **C5 — google-maps** — the same read-only case as plausible's, where every call is a read the vendor CHARGES per request: `replayable: true`, a replay is a second charge and never a second write, the README states the cost, and C6 has nothing to resolve. A 429 with no `Retry-After` reaches the caller after conduit's retries with the quota window supplied (60 s) rather than no wait.
- **C6 — slack** — a vendor with NO idempotent read is allowed to say so: an incoming webhook is write-only (there is no API that lists what a webhook posted), so a lost response is `indeterminate` with nothing that resolves it, and the connector documents that the app treats the post as possibly delivered. Where a read exists but is out of scope (`conversations.history` for a bot post), the connector NAMES it in its README without building it.
- **C6 — apns, fcm** — (was push, split `FJS-D1918`) where NO read exists (neither APNs nor FCM keeps a record a provider can read), the connector says so in the call's header comment and names the app's evidence (the token row's `sentAt`); a lost push is `indeterminate` with nothing that resolves it.
- **C13 — fcm** — retired. A credential the resolver mints by calling a third party sends through its own `auth: none` target (`FJS-D933`), and a failed mint is thrown as `MintError`, so the send that needed it is `auth_failed` with the mint's `retryable` (`FJS-2722`). `fcmTokenResolver` takes `send`; OIDC's refresh already went through `oidcClientTarget`.
- **C1 — oidc** — a PROTOCOL connector's target is one per ISSUER (`provider:oidc:<name>`), its `address` is the issuer's ORIGIN and the issuer's path rides the discovery request alone, because discovery answers absolute URLs outside the issuer's path (Microsoft's `/<tenant>/v2.0`). Every endpoint is sent as an absolute `address`; a provider whose discovery names endpoints on OTHER origins (Google: three) declares them in the target's `origins`, and conduit refuses an undeclared one by name (`FJS-2730`).
- **C3 — oidc** — the one reader of `raw` also reads `meta.headers`: RFC 6750 puts a resource server's refusal in `WWW-Authenticate: Bearer error="invalid_token"` and permits an empty body, so `translate(error, headers)` takes the response headers and nothing else in the package touches them. A 429 keeps conduit's `rate_limited` whatever the body's `error` says, since the status carries `Retry-After`.
- **C6 — oidc** — where the vendor BURNS the credential on use (refresh-token rotation: Microsoft, Auth0 with rotation, this sink), a lost response has no resolving read and the refusal itself is the resolution: the next refresh with the old token answers `invalid_grant`, the connector names it `grant_lost`, and the app marks the row and re-authenticates (`FJS-D795`). An authorization code is the same — single use, so a replay is `grant_lost` and the drive asserts it.
- **C8 — oidc** — a fourth family: an asymmetric JWS verified against a KEY SET — `verifyIdToken(jwt, { jwks, issuer, audience, nonce?, now, clockSkewSeconds })`. Still pure and still takes the clock, but (a) it takes the token rather than `{ rawBody, headers }`, since the signed bytes are the token's own first two segments; (b) it is `async`, because WebCrypto is; (c) the refusal list is the feature — `none`, HS*, and any `alg` outside RS256/ES256 refused by name before any crypto; (d) an unknown `kid` is a distinct answer (`unknownKid: true`) that a caching layer acts on exactly once. The logout token runs the same function under a profile.
- **C13 — oidc** — a `signed` target has ONE credential and OIDC spends two: the client's (token endpoint, Basic) and the user's (userinfo, Bearer). Closed as one target per credential (`FJS-2729`): `oidcClientTarget` carries the client's Basic on every request, `oidcPublicTarget` carries none and userinfo puts the user's Bearer on it, and each call refuses a send bound to the other.
- **C5 — anthropic** — the fourth case is a write the vendor BILLS and collapses under nothing: `createMessage` is unkeyed and unreplayable, so a 429 comes back after one attempt with `retryAfterMs` and conduit never sleeps on it. Where the vendor's own word says a 5xx was refused before running (Anthropic's 529 `overloaded_error`), `translate` may reopen the `retryable` conduit's `declineReplay` closed, because conduit cannot know a 5xx was unbilled and the connector can; a 500 keeps conduit's `indeterminate`. The read beside it (`countTokens`) is plausible's case.
- **C13 — anthropic** — retired. SSE crosses conduit (`FJS-2728`, `FJS-D934`): `streamMessage` and openai's `streamChatCompletion` take `bindStream(conduit)`, a refusal before the first event reaches `translate()` with the status `createMessage` would have seen, and neither package calls `fetch`.
- **C3 — gmail** — one STATUS may be four domain words: Gmail spells a missing scope, a Workspace policy, the day's quota and the per-user unit rate all as 403, conduit grades every one `auth_failed` and replays none, and only the body's `reason` (`details[].reason` first, then `errors[].reason`) tells them apart — `forbidden` (+ `scopeMissing`), `quota`, `rate_limited`. The clause's "an auth refusal that is the policy's is told apart from `auth_failed`" holds, and adds: a rate limit the vendor spells as 403 reaches the caller after ONE attempt with the connector's fallback wait, because conduit will not retry what it graded a credential's refusal (`FJS-2721`, `FJS-2286`).
- **C6 — gmail** — the resolving read may be by a header the CONNECTOR minted: Gmail collapses nothing and answers no idempotency key, but it indexes `Message-ID`, so `sendMessage` mints the id before the send, returns it on every outcome, and `findByMessageId(send, id)` (`q: rfc822msgid:…`) is the read that says whether a lost send landed. The drive proves the send applied under a lost answer is found by it in the parent's thread.
- **C8 — gmail** — a fifth family, or the fourth under a profile: a Pub/Sub push's bearer is an OIDC token for a SERVICE ACCOUNT, RS256 under Google's certs with `aud` the hook URL and `azp` the account's own id. oidc's `verifyIdToken` refuses it (`azp` must be the audience), so the connector imports oidc's signature primitives from `@frontierjs/conduit-oidc` and checks this profile's claims itself (`verifyPushBearer`: issuer, audience, pinned publisher with `email_verified`, `exp`/`iat`), still pure, still taking the clock, still refusing `none`/HS* by name and reporting an unknown `kid` once.
- **C1 — mattermost** — a SELF-HOSTED vendor has no default address: `mattermostTarget({ address })` requires it and refuses without one, since a default that points nowhere is a target that reaches nothing. Two targets from two builders because the two credentials differ in KIND, not account: the service token is the process's (`bearer`), the human's is `per_caller` and resolved by `getFor(ref, who)` off the app's `@encrypted` column — oidc's one-target-per-credential, where the second credential is a person's.
- **C1 — 37signals** — where the ACCOUNT is a path on a shared host (`3.basecampapi.com/<id>/…`), it rides the descriptor's `address` and every call's `path` starts after it, so one target per account holds without a host per account. A required header the runtime fills when absent is the builder's to refuse: Bun sends `Bun/<version>` for a missing `User-Agent` and Basecamp answers it 200, so the vendor's own 400 fires only for an empty one, and the drive's negative control sends that. The builder is named for the product (`basecampTargets()`) and the package for the vendor, because an identifier cannot start with a digit.
- **C6 — 37signals** — where the vendor stores no key and its event feed is delayed and best-effort, the resolving read is the PARENT'S OWN LIST, matched rather than keyed. Basecamp collapses nothing, and its feed serves only events older than about 30 s and says completeness needs the resource APIs. So each create returns an `attempt` (where, when, the text) on every outcome, and `findCreated(send, attempt)` reads the list the create posted to, keeping this principal's rows since the attempt whose text matches. A completion is a state, so it is replayable where the creates are not. The drive proves a comment applied under a lost answer is found through the `<div>` Basecamp wraps it in, and that an older identical row and another person's are not.
- **C9 — 37signals** — where the vendor PARSES a field as markup, a body says which it is: `{ text }`, escaped by the connector with its line breaks as `<br>`, or `{ html }`, the caller's markup, and a bare string is refused because its `<` would be a tag. A vendor flag that turns a field into markup (`content_type: text/html` on a Campfire line) is always sent, so one shape covers every verb and a lost create is matched the same way everywhere. The drive proves `a <b> & "c"` goes out escaped and that a lost line holding `<b>` and `&&` is found by its words.
- **C3 — mattermost** — a 403 that conduit grades `auth_failed` is the POLICY's answer (not a member of the channel) and `translate` reads the status to call it `forbidden`, so nothing forgets a good token over it; a 404 is `gone`, which a mirror sync treats as the row leaving. A 429 arrives with `X-Ratelimit-Reset` in seconds and no `Retry-After`, so the one reader of headers turns it into `retryAfterMs`, as oidc's reads `WWW-Authenticate`.
- **C5 — mattermost** — a vendor may collapse a write under a key in the BODY rather than a header (`pending_post_id`, 30 s window): the connector puts the CALLER's key in the body and marks that write `replayable: true`, so conduit replays a timed-out post and the channel holds one message; the same write with no key stays unkeyed and `indeterminate`. The connector never forwards `idempotency_key`, which Mattermost ignores.
- **C8 — mattermost** — Postmark's family with the credential in the BODY and a header: a vendor that signs nothing and sends a static per-hook token (`token` in the form or JSON body, `Authorization: Token <t>`) is verified by comparing EVERY token present constant-time, refusing a request with none. Two things the family needs stated: the replay guard is the dedupe key (`post_id`, `trigger_id`), since a captured request verifies forever and the vendor retries nothing; and where several hooks share one path, the receiver's `credential` function chooses the key by a NON-SECRET field (`trigger_word`, `command`) — a function that looks the token up by itself would verify every forgery.
- **C12 — mattermost** — the answer to a delivery is conduit's (`{ received, outcome }`), and a vendor that reads the response body as a REPLY (a slash command's ephemeral text, a webhook's comment) gets its reply as a send from inside `apply`: a command through `respond()` to its `response_url`, a webhook through the ordinary post verb as the bot. The dialect does not widen `Outcome` to carry a body for one vendor; the second vendor that needs one reopens this.
- **C8 — mattermost (socket)** — a vendor that PUSHES over a socket the app dials has no verifier: the target's credential opens the connection and the connector's `framing.handshake` proves it (here `authentication_challenge`, `hello` the success signal, `FAIL` the refusal), so the export is a `FrameDialect` — `framing`, `parse`, `dedupeKey`, and no `verify`, which conduit refuses by name. A per-connection sequence names a frame only with the connection: the key is `socket:<connection_id>:<seq>`, and the drive's negative control (bare `seq`) loses the first post after a redial as a duplicate.
- **C1 — quo** — google-maps' two descriptors from one builder holds where two API GENERATIONS share one origin and differ by a pinned header: Quo's dated API (`Quo-Api-Version`, required, no default) has no send, and the send is v1's, which carries its version in the path. `quoTargets() → { v1, dated }` shares one `ref`; `bindQuo()` binds both, and each call picks its own generation, so no caller chooses and the version header never reaches a route that was not written for it. The drive's negative control removes the header from `dated`, and every dated read becomes Quo's 400.
- **C7 — dataforseo** — where a vendor prices BELOW the currency's minor unit ($0.0006 a task), minor units round every price to 0, so the connector answers an integer at a stated `@scale` and the field name carries the unit (`costMicros`, a `@scale(6)` column's unit); `null` where the vendor answered no number, never 0, since an unknown cost is not a free task. No currency field where the vendor bills one fixed currency. The drive's `cost.isMicrosNotCents` row is the enforcement.
- **C8 — sendgrid** — a vendor that batches events under ONE signature (a JSON array signed whole) gets a verifier answering `events`, plural: the signature covers the array and not its elements, so one verify is one truth and a call per event would re-verify the same bytes. The singular `event` stays for one-event bodies; a non-array body is `ok: false` by name. Dedupe is per entry (`sg_event_id`) and the app's (C12). A sixth signature family alongside: ECDSA P-256 with a DER signature and an SPKI key, both base64.
- **C1 — the bundle** (`FJS-D1474`) — a connector with more than one target spells them quo's way. `<name>Targets(opts)` returns a record of descriptors keyed by ROLE, with every shared option (address, account, issuer, ref) given once; `bind<Name>(conduit, targets)` returns one `Send` per role; every call takes that bundle and picks the role it goes through. A call therefore cannot be handed the wrong target, which oidc and microsoft each guarded at runtime with a `spends` tag, and mattermost did not guard at all. Where WHOSE credential a call spends is the caller's choice and not the call's (the bot's token or the person's), the caller makes it once, at bind (`bind<Name>(conduit, targets, { as })`), never by handing a call a different `Send`. A target with another lifetime — one per user, built when it is dialed — keeps a builder of its own. A connector with one target keeps `<name>Target` + `bindSend`. Supersedes the separate builders of C1 — mattermost and the per-call refusal of C13 — oidc.
