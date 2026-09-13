---
id: ecosystem-gaps
status: assessment
dated: 2026-08-02
---

# Idea — Ecosystem gaps: what is missing to compete with Laravel and the likes

**Status: ASSESSMENT + FUTURE WORK.** Dated 2026-08-02; the headings carry what has
shipped since, struck where a gap closed. Claims were probed against
the tree (`VERIFYING.md`); evidence is named inline. Each gap below is written so it
can become a stub or a tracked issue — proposed home, what it attaches to, and why
it matters are stated per item.

The comparison target is Laravel, because it is the most complete
batteries-included framework in any language and therefore the honest bar. "And the
likes" means Rails and Django, whose ecosystems have the same shape.

---

## Corrections to earlier assessments

Two things previously recorded as missing **already exist**, found by probing rather
than reading:

**`fli admin:generate` exists — 595 lines.** It generates a gate-aware CRUD admin UI
from `schema.lite`: list, detail, create and edit views per model, an index
dashboard, and an auth-guarded layout. This is Nova / Filament territory.
The framework-shape assessment (since deleted) item 1 claimed schema→UI derivation was entirely absent;
that was wrong as written. It is *codegen*, not derivation — files are emitted and
then yours — but the gap is narrower than recorded.

**Corrected 2026-08-31 — it works, and it is proven by running it.** The four
signals this section used to list (`.svelte` output, wrong paths, `_layout.svelte`,
a lowercase-plural model) were spelling and were fixed by `FJS-065`; the session
store assumption went with them. What kept the paragraph honest for longer than
it should have is that **nothing had ever executed the command** (`FJS-372`), so
*is it non-functional* had no answer in either direction, and a stale warning is
indistinguishable from a live one.

`example` now generates 33 sections from its own seed, `fli check` is clean over
the output, and `verify:users` opens the pages in a real browser. Running it is
what found the four defects that reading it never could (`FJS-625`) — a service
name **derived** where it is a filename, a serviceless model generated and then
warned about, a nav linking sections that were never written, and an export name
taking a kebab-cased string. And the one no amount of repair would have reached:
it read `db/schema.lite`, so the identity layer an app appends from a package was
invisible, and the panel had no Users screen in it.

So the Nova / Filament comparison above stands, with the honest caveat that this
is *codegen* — files are emitted and are then yours. The derived-at-runtime half
is still `IDEAS/overview.md` 1.1.

**Full-text search exists.** Litestone generates FTS5 virtual tables
(`packages/litestone/src/core/ddl.js:305`, with parser support for tokenizer
choice). That is Laravel Scout, already covered — no gap.

**Model factories exist** (correction added 2026-08-04, probed by running).
Tier-2 item 5 below was written as "factories do not exist"; they do, in
`@frontierjs/litestone/testing`. See that item for what is actually left.

---

## Tier 1 — an app cannot ship without these

These block a typical SaaS outright. They are the reason an evaluator stops.

### 1. OAuth / social login — ~~missing~~ **shipped in `@frontierjs/auth`**

Provider flows, token exchange and account linking ship in `packages/auth/oauth.ts`;
a callback is a browser redirect, so it runs in `cookieAuth` mode, and `example`'s
`verify:oauth` is the end-to-end proof. Laravel's equivalent is Socialite.

### 2. Billing and subscriptions — **built in `example`, not as a package**

**No package — and `example` builds the whole shape as app code.** A subscription
lifecycle, invoices, proration, dunning and a card processor's webhooks live in
`example/api/src/domain/billing/` and a Stripe connector in `providers/stripe/`,
driven by `verify:billing`, `verify:proration`, `verify:collect` and `verify:stripe`.
What is still open is whether it becomes a Slice (`IDEAS/slices.md`), which is the
canonical case for that format. Laravel's equivalent is Cashier.

### 3. Object storage driver — ~~missing~~ **shipped in the wrong package; the gap is a duplicate abstraction**

**Re-derived 2026-08-12 and the original claim was wrong.** It said *"exactly one
implementation: local disk. No S3, R2 or GCS anywhere."* That is true of the file it
names and false of the repo.

Litestone ships a complete object-storage plugin: `src/storage/providers/s3.js` against
`src/storage/sigv4.js` — request signing and presigned URLs written by hand, no AWS SDK
— documented in `packages/litestone/docs/file-storage.md` for R2, B2, MinIO and S3,
with a `local` fallback for dev, a `keyPattern` template, `@accept` MIME filtering,
`@keepVersions`, and `File`/`File[]` as schema types whose rows are cleaned up on
delete. It is tested.

**So the real finding is worse than a missing driver and cheaper to fix: there are two
file-storage abstractions in the repo and only one of them can reach S3.** Junction's
`IFileStorage` is a separate 280-line interface over local disk, unaware of Litestone's.
That is an Invariant 4 problem — one owner per translation — rather than a feature gap,
and the question is whether Junction's should delegate to Litestone's plugin or be
retired.

**Answered 2026-09-12: retired** ([FJS-D260](../DECISIONS.md#fjs-d260)). Delegation was
not available — `useStorage()` takes a stored ref and has no `list`, `meta` or
`toResponse`, so a forwarding `app.filestorage` would have been a third shape rather
than one owner. Nothing in the workspace called it. The claim above that Litestone's S3 path is *tested* did not survive the closing — it was cited by no test file ([FJS-1076](../ISSUES.md#fjs-1076)). It is now, against AWS's own SigV4 suite, and the test found both defects that row predicted plus a third in the provider.

- **Why it still matters:** an app that stores files through Junction's interface rather
  than a `File` column still cannot run on more than one node
- **Size:** small, and it is a reconciliation rather than a build
- **Lesson for this file:** the claim was three words long, sat in the index for
  months, and was wrong because it grepped one package. Six index rows have now been
  found stale this way

### 4. Internationalization — **ruled 2026-08-15 (`FJS-D12`); deferred to V2**

**Still missing entirely.** No message catalogs, no pluralization, no locale
negotiation, no per-locale formatting. What changed is that this is now a
deliberate deferral with a seam held open, rather than an unanswered question.

- **Laravel equivalent:** the `Lang` facade and `lang/` directory
- **Why now rather than later:** retrofitting i18n into a UI layer costs far more
  than designing for it. Every string added before this exists is a string to be
  found again later.
- **Design question it forces:** does a translated string belong in the schema
  (labels derived from models) or only in the UI? The answer shapes schema→UI.

> **The design question is answered: neither, quite.** `@label` stays in the
> schema and stays a **default English string** — the key is DERIVED
> (`Model.field.label`), which is Rails' `human_attribute_name` and costs an
> untranslated app nothing. The UI resolves it; the schema never becomes a
> catalog, and no `.lite` syntax has to change when one arrives.
>
> **It also did not shape schema→UI, which shipped without it.** A generator
> authors no string, so what it multiplies is call sites. The premise this item
> was filed under was wrong about the coupling and right about the cost.
>
> Five more constraints bind alongside the derived key — errors carry a code and
> params rather than a sentence, configuration strings and content stay two
> mechanisms (Drupal's split, Payload's two features), `/inflect` never takes a
> locale, kit strings are props with English defaults, and formatting gets one
> owner. Reserved as ours: a seed-derived `strings.snapshot.md` gated in CI,
> `db.$setLocale()` as a client flavor beside `$setAuth`, and per-locale
> prerender on the `static` target. Full argument and the survey it rests on —
> ZenStack, Rails, Django, Payload, Drupal, Paraglide — in `DECISIONS.md`
> § Dependencies & the ecosystem.

---

## Tier 2 — expected of "batteries included"

### 5. Model factories — ~~missing~~ **shipped; unadopted**

*Rewritten 2026-08-04. The original text said "Seeding exists; factories do not."
That was wrong — it was written from the seeding docs, not from running anything.*

They ship in `@frontierjs/litestone/testing`, which is where this item proposed to
put them, for the reason it gave — Litestone owns the schema, so it derives the
factory's shape from field types and rules:

- `Factory` / `Seeder` / `runSeeder` — `packages/litestone/src/seeder.js`. Traits,
  chained states, `withRelation` (auto-creates the parent) / `for` (uses an existing
  one), `seed(n)` for a deterministic RNG. Every chain method returns a clone.
- `makeTestClient(schemaText, { seed, autoFactories, factories, data })` —
  `packages/litestone/src/testing.js`. In-memory client plus a factory per model,
  topologically sorted so FK parents exist first.
- `generateFactory` / `factoryFrom` — the zero-config path, no subclass. Generated
  values satisfy the field's declared rules (`@length`, `@regex`, `@phone`, numeric
  bounds, `@minItems`), so a generated row is writable.
- `withParents()` / `has()` / `attach()` — the relation shapes. Verified by seeding
  one row per model from both real schemas in this repo: 3/3 and 24/24.
- `generateGateMatrix` / `generateValidationCases` — the same derivation pointed at
  test *cases* rather than test *data*, which Laravel has no equivalent of.

**Adoption has started.** `createTestEnv` is what `@frontierjs/testing` layers the
API tier on, and basecamp's suite builds on it. The derived-case generators
(`generateGateMatrix`, `generateValidationCases`) are still called only from
litestone's own tests.

See the testing-and-ci record (since deleted), which treats this as the unblocking step for a
cross-realm suite.

### 6. Two-factor authentication — ~~missing~~ **TOTP shipped 2026-09-12; passkeys are the open half**

`IAuth` declared `setupTotp` as an optional method and the native provider
implemented neither it nor `verifyTotp`. It does now — `FJS-D261`, and
`packages/auth/CHANGES.md` carries what the ruling cost: a `login()` that answers
a union, `LoginChallenge` as a model, and a replay guard on the credential row.
The website's claim about TOTP is true as of that date; OAuth was already.

**Passkeys are the other half and they are further away.** Added 2026-09-11:
`passkey` and `webauthn` return **0 hits** across every package's source, where
`totp` at least names a method and a `better-auth` provider type. The two are
usually listed together and should not be, for the same reason § 16 separates SMS
from push: TOTP is a secret, a clock and a comparison, and a passkey is **rows plus
a ceremony** — a challenge that must be single-use and short-lived, a credential
with a public key, a signature counter, and a transport list. `Credential` already
exists and `@encrypted` / invariant 7 redaction already apply to it, which is the
same argument § 16 makes for the push subscription: making it a Model is what buys
the gate, the audit trail and the expiry for free.

**The reason it cannot be a package an app picks up**: what a passkey changes is
not a login route, it is the **standing** a session carries — *this caller proved
possession of a device in the last five minutes* is a rung on the gate ladder
(`@frontierjs/toolbelt/gate`), and an app cannot add a rung from outside. That
makes it in-house for a reason unrelated to how hard the crypto is. Nothing else
here needs a vendor, so Conduit buys nothing: WebAuthn is a browser API and a
signature check.

### 7. Feature flags

No equivalent to Laravel Pennant. Natural fit as a small slice over a Litestone
model plus a Junction plugin exposing `app.features`.

### 8. Browser / end-to-end testing — **in the repo, not offered to an app**

No Playwright or Puppeteer, and none wanted: mesa's CDP harness (`test/browser/`) is
shared by mesa, `@frontierjs/ui`, junction's devtools drive and `fli gui`'s, and the
cli ships a small page driver of its own (`core/browser.js`) for the tutor. CI runs
on every push (`bun run ci`, `.github/workflows/ci.yml`). What is still missing is
the Dusk half: a browser harness an APP's own suite can import, since mesa's is a
spec runner and is not published.

### 9. Media processing

No image resizing, thumbnails, or format conversion. Common in almost every real
application, and paired with item 3.

### 10. Automated upgrades — a Laravel Shift equivalent

**Missing entirely, and the one where this project has the biggest structural
advantage.** Laravel Shift is a paid service that takes an app on version X and
produces a reviewable pull request upgrading it to version Y — renamed APIs, moved
config, changed signatures, deprecated calls.

- **Laravel equivalent:** Laravel Shift (third-party, commercial)
- **Proposed home:** `fli upgrade --to 1.2` — a markdown command like every other,
  so the migration steps are readable rather than a black box
- **Output shape:** a **reviewable diff**, never a silent rewrite. This is the same
  principle Litestone migrations already follow — diffed from the schema, written as
  SQL you read before applying. A framework upgrade should not get a weaker
  contract than a column rename.

**Why FJS can do this better than Shift does.** Shift parses PHP source text and
pattern-matches. Here the framework knows its own structure:

- The schema is a real parsed AST (`parseFile()`), not text — so renaming a scalar,
  a model or an attribute is a tree edit with certainty rather than a regex.
- Services are declarative objects with known keys, so a changed key is mechanically
  findable.
- The bridge index in `CLAUDE.md` names every cross-package handoff, which is
  already the list of things an upgrade would need to touch.
- Plugin registration goes through one protocol, so a changed lifecycle contract has
  exactly one call site shape to rewrite.

**There is already a worked example in this repo's own history.** The
`Integer / Text / Real / Blob` → `Int / String / Float / Bytes` rename was a hard
cut with no aliases. It became a documented landmine, a stale hand-copy in
`packages/cli/commands/auth/install.md`, and a class of failure that could only hit
consumers *outside* the workspace. A codemod would have turned that entire episode
into `fli upgrade --to 1.1` plus a diff to read. **Treat that rename as the
reference test case:** an upgrade tool that cannot do it automatically is not worth
shipping.

**Slices need this too.** A slice that bumps a major version has the same problem in
miniature, which argues for an upgrade contribution in the slice format — see the
open question added to `IDEAS/slices.md`.

### 11. Rate limiting — ~~missing~~ **shipped in junction**

**Added 2026-08-04. Tier-1 severity, filed here to avoid renumbering** — several
files cite `ecosystem-gaps.md` tier-1 item numbers.

**Built since.** `packages/junction/src/core/rate-limit.ts` is the one definition,
read by a transport middleware, a pipeline hook and `@frontierjs/auth`'s login
limiter, which were three drifted copies until `FJS-017`. What follows is the
argument it was filed with.

- **Laravel equivalent:** the `throttle` middleware and `RateLimiter` facade
- **Proposed home:** a Junction plugin, so it composes like the others and can be
  declared per service rather than only globally
- **Substrate already present:** `ctx.client.ip`, the session on `ctx.auth`, and
  `app.cache` for counters. `ctx.directives.limit` is the natural thing to *clamp*
  rather than only to count — a caller asking for 10,000 rows is the cheaper half of
  the problem to solve, and nothing bounds it today.
- **Why it becomes urgent:** the agent surface (`IDEAS/agent-surface.md`). An agent
  calls `find` in a loop by default, so an unbounded API plus an MCP endpoint is a
  self-inflicted denial of service.

### 12. Streaming responses — ~~missing~~ **shipped, outside the envelope**

**Added 2026-08-04.** Built since: a raw route has `ctx.sse()`, the export endpoint
streams its file, and conduit has `stream()`. The design question below was ruled
`FJS-D13` — a stream is not a result and `wrapResult` refuses one by name; each frame
is a result and the stream is not.

- **Laravel equivalent:** `StreamedResponse` / `response()->stream()`
- **Why it is not merely nice:** it is a hard prerequisite for
  `IDEAS/agent-surface.md`. An agent surface that cannot stream a token at a time is
  a demo rather than a product, and the same is true of any AI-shaped feature an app
  built on FJS wants to offer. It also covers the mundane cases — a large export, a
  long-running report — which today have to be buffered in memory or faked with
  polling.
- **Design question it forces:** the result envelope assumes a complete value
  (`kind`/`data`/`total`). A stream has no `total` and no end until it ends, so
  either streaming sits *outside* the envelope deliberately, or the envelope grows a
  third kind. That is a ruling, and it should be made before an app invents its own
  convention. Note that WS already carries incremental data without an envelope, so
  the precedent for "outside" exists.
- **Interaction:** pairs with item 11 — a stream that cannot be rate-limited is worse
  than no stream.

### 13. Security advisories and dependency posture — **the audit half shipped**

Added 2026-08-12, from an ecosystem sweep of the app lifecycle. The words *CVE* and
*vulnerability* occur nowhere in `IDEAS/`, and nothing in `fli` answers **am I
affected**.

Laravel, Rails and Django each have a published advisory channel, a supported-version
policy, and a one-command audit of the dependency tree. This is not a differentiator
for any of them — it is the floor, and an evaluator finds its absence in about thirty
seconds. It matters more here than for a hosted framework, because FJS asks people to
run the thing themselves.

`bun run ci`'s `advisories` phase now answers *am I affected* for this framework's
published packages, as a comparison against what a published package's runtime
dependencies reach rather than a scan. The support policy and the channel are
still unwritten. Mostly not code:

- **A stated support policy.** Which versions get fixes, for how long. Pre-alpha is an
  answer, as long as it is written down.
- **An advisory format and a channel.** One file shape, published once per issue.
- **`fli` answering *am I affected*.** The FJS-specific half: an advisory names a
  package and a version range, and `project:map --json` already knows what the app
  actually uses. So the answer is a comparison rather than a scan — and it can be
  narrower than a scanner, because the app model knows which surfaces are *reachable*,
  not merely installed.

Interaction with `IDEAS/slices.md`: the moment a third party can ship a slice, the
advisory channel has to cover slices too, and a registry (item 3.6 in the overview)
without one is a supply chain with no way to say *stop using this*. Better to have the
format before the registry than after.

### 14. Inbound integrations — **direction ruled (`FJS-D177`), mechanism unbuilt**

Added 2026-08-12, from the same sweep as item 13. **`IDEAS/inbound-integrations.md`
supersedes the framing below**: conduit holds the relationship with both ends, and
receiving is two features with two owners. An app receives today through a raw
route and a verifier it owns — `example`'s Stripe and payment-provider webhooks,
`verify:pay` and `verify:stripe` — which is what the paragraph below calls
nothing. As probed then:

- **Conduit is outbound** — declared targets, `app.conduit.send()`. Its own one-liner in
  `CLAUDE.md` says *outbound boundary*.
- **The webhooks plugin is outbound** — `packages/junction/src/plugins/webhooks/index.ts`
  opens *"At-least-once webhook delivery for Junction"*, and the architecture comment
  reads bus → pending row → deliver → retry → dead. It signs what it sends.
- **Notifications are outbound.** Mail is outbound.

**Nothing in the framework receives.** There is no inbound webhook endpoint, no
signature verification on the way in, no replay window, no dedupe of a delivery the
sender retried, and no declared mapping from an external payload to a Service call.
Domain 4 in `ARCHITECT.md` describes itself as *"Conduit (shipped, narrow)"* and this is
the direction the narrowness is in.

The practical evidence is that FJS users run something else for it. An n8n or a Zapier
beside the app is not a preference; it is the only available answer to *Stripe posts
here, do something*. `IDEAS/release-transitions.md` phase 2 makes that instance a
declared attached service, which is the right treatment for a tool you have chosen —
but it is not an answer to whether the app can receive its own events without one.

**The email leg, added 2026-08-24** from the OpenMRP audit (see
`IDEAS/permission-sets.md` for the provenance). Inbound is not only webhooks:
that project runs a shared inbox — an SES-backed email bridge where a customer
replies to a thread and the reply lands as a message on the record it belongs to,
with agent-drafted responses a human approves. FJS has every outbound half of this
(conduit, notifications, email-kit, and a rendered template as a body) and no
receiving half at all, which makes *reply to this order confirmation* unbuildable
here while *send it* is a one-liner. It is the same gap as the webhook one and the
same answer — an inbound payload maps to a Service call — with one addition: an
inbound email has to be **threaded** onto a record, which is a correlation the seed
could declare and a handler otherwise guesses from a subject line.

What makes this FJS-shaped rather than a route with a body parser:

- **An inbound payload maps to a Service call**, and a Service is already typed by the
  seed — so the mapping is validated at the boundary by the mechanism that validates
  everything else, rather than by hand in a handler.
- **The idempotency problem is already on the table.** A retried delivery must not run
  twice, which is the same key discipline `IDEAS/release-transitions.md` needs for
  journal steps and the same lesson `CLAUDE.md` records against Caravan's `unique` —
  three places wanting one definition of *this work already happened*.
- **Verification is a declaration, not a snippet.** A secret, an algorithm, a timestamp
  tolerance. The outbound half already states all three in the plugin quoted above; the
  inbound half is the mirror of code that exists.

Interaction worth noting before either is built: an inbound endpoint is a door in a
`@@gate`-protected application that a stranger must be able to knock on, which is the
same exemption `/auth/*` already takes and should be argued once for both rather than
twice.

### 15. The small sharp edges

Added 2026-08-12 from a sweep asking what a developer still wires up by hand. Three
that are too small to be records and too common to lose. Each is a day or two, each is
currently written from scratch in every application, and each has a known correct
answer that people only find after shipping the wrong one.

**User-defined ordering.** Drag-to-reorder a list. The naïve `position: Int` requires
rewriting every row after the one that moved, which is a write storm and a race, and
`0 hits` is what a grep for `fractional`, `reorder` or `sortOrder` returns across
`IDEAS/` and the parser. The known answer is a fractional or lexicographic rank —
insert between two neighbors, touch one row — plus a rebalance for the pathological
case. It is a field type with a comparison rule, which puts it in the same family as
`IDEAS/declared-semantics.md`. Wants `$checkOrderBy` to know the column is a rank
rather than a number, so the client sorts by it without being told.

**Conditional fields in a form.** **The rule half shipped as `@required(where: …)`
(`FJS-D259`)**, answered in the browser through `@frontierjs/toolbelt/predicate`;
visibility is still the page's. *Show the VAT number only when the country is in the
EU; require it when shown.* Every form in every business application has one and it is
always imperative code in the page. `IDEAS/cascading-fields.md` is the Data-realm
cousin — carrying a value to related rows — and is not this: this is a field's
*visibility and requiredness* depending on another field's current value, in the
browser, before anything is submitted. It matters more here than elsewhere because
`<Form>` now derives labels, constraints and messages from the schema, so a
hand-written conditional is the one part of a generated form that is not generated —
and `overview.md` 1.1a cannot generate a field list without an answer
for the fields that are sometimes not in it. The hazard to state up front: a
client-side condition is an affordance, so the server must still validate, which is the
same split `x-gate` already draws.

**`@@softDelete` and `@unique` do not agree.** **Ruled since** — `FJS-204` keeps the
slot (a soft-deleted row answers `SoftDeletedUniqueError`, which names it), and an
author who wants uniqueness among live rows declares
`@@unique([email], where: deletedAt == null)` (`IDEAS/partial-indexes.md`). As
filed: a soft-deleted row still occupies its unique index, so deleting a user and
re-registering the same email fails with a constraint violation that names nothing
the user did. The
answers are known and none is free — a partial index, a nulled column, or a tombstone
suffix — and the point of recording it here is that **this is a ruling the framework
should make once**, not a trap each app finds. It also lands on
`IDEAS/compliance-from-the-seed.md`'s open question about retention and soft delete,
which is the same collision seen from the legal end.

### 16. Push and SMS delivery — one is a driver, the other is not

Added 2026-08-15, comparing against an outside framework's feature catalog, which
lists *"emails, SMSs, direct, and push notifications & webhooks"* as one line. Four of
those five ship here. The two that do not are usually named together and should not be:
one is an afternoon and one is a design.

**The architecture is already right.** `@frontierjs/notifications` is channel-agnostic:
`via(user)` returns a channel list, `toChannel()` renders per channel, and an
unimplemented channel throws `NotificationChannelNotImplementedError` at send time
rather than dropping the message. The README's own example adds a `slack` channel from
outside the package. So *adding a channel* is a solved problem and neither item below is
blocked on a mechanism.

**SMS is a driver.** A Conduit target with the provider's credentials, a `toSms()`
returning a string, and a length rule. Conduit already owns credential refs that fail
closed and a retryable/not-retryable error table. There is nothing to design; it has
simply not been written.

**Push is not a driver, and calling it one is the mistake to avoid.** A working web-push
channel needs four things and three of them are the framework's: a VAPID keypair, which
belongs beside `encryptionKey` in configuration rather than in an app's `.env` by
convention; **a subscription, which is a row** — endpoint, keys, user, device, created,
last-seen; a service worker registered by the app's own build, which Sierra owns and
jetty has already solved once for the extension container; and pruning, because a push
endpoint returns `410 Gone` when the browser retires it and a table nobody prunes is how
every hand-rolled implementation ends up sending to thousands of dead endpoints.

Making the subscription a Model is the whole argument for building it here rather than
leaving it to an app. It inherits `@@gate` (a subscription is one of the more sensitive
rows an app holds — it is a writable handle to someone's device), `@encrypted` on the
keys, invariant 7's redaction in the audit trail, and `@@softDelete` semantics on
expiry. Every hand-rolled version is a plain table with none of that.

**The trap to state before anything is built**: a push payload is a read that leaves the
building, and it leaves via a third party. The push service sees the body. That is the
same comparison `IDEAS/bulk-data.md` calls export's `only` half — `@guarded` columns
must not be in a rendered notification body — and it is sharper here, because the
recipient is a vendor rather than the user. It is also the same question
`IDEAS/live-queries.md` answers per socket, one hop further out.

Effort: SMS `S`, push `M`. SMS is `stakes` — every competitor has it. Push is `edge`,
for the subscription-as-a-Model reason, and only if the boundary above is settled first.

---

### 17. A pass against a competing Bun framework's own agent map

Added 2026-09-11. The input was `stacksjs/stacks`' committed `AGENTS.md` — the one
file that framework asks every agent to read, and therefore its own statement of
what it believes it ships. It is a useful outside document for the same reason the
2026-08-15 feature-catalog pass was: it is a **catalog**, so it enumerates the
things a framework is expected to answer, rather than the things a competitor
wants to be judged on.

**Most of it landed on rows this file already has, which is the result to record
rather than the findings.** i18n (§ 4, ruled V2), object storage (§ 3), 2FA (§ 6),
SMS and push (§ 16). A comparison that finds the register already holds the answer
is the register working.

**Two claims made while reading the tree were wrong, both in the direction this
file has been wrong before — grepping one package.**

- *Junction's `FileStorage` is local-disk-only, so an app on two machines cannot
  store a file.* True of that file and false of the repo; § 3 corrected this on
  2026-08-12 and the finding is a duplicate abstraction, not a missing driver.
- *Notification transports are a closed set — `drivers/` holds `email.ts` and
  `inapp.ts`.* False. `notify.ts` carries a `state.drivers` registry, a registered
  driver wins over a built-in transport name of the same spelling, and an
  unregistered one is refused by name before any delivery starts. § 16's *adding a
  channel is a solved problem* stands; SMS is unwritten, not unbuildable.

**Four things in the catalog map to nothing filed anywhere here.** Each is one
line because none is argued yet; the verdict column is FJS-D153's, applied rather
than re-derived — the boundary is ours, the vendor is the app's.

| Missing | Shape | Verdict |
| --- | --- | --- |
| A cache an app can share between nodes | Junction's cache is `bun:sqlite`, which is right for one box and wrong for two. The multi-node story ends here the way § 3's ended at the second machine | in-house driver seam; Redis is not HTTP, so Conduit cannot carry it |
| Vectors and embeddings | `vector` returns 0 hits across `IDEAS/`. An embedding is a column with a distance comparison, which is `IDEAS/declared-semantics.md`'s family, and `ai/index.ts` already refuses to name a vendor | in-house column type; the model that produces the embedding is a Conduit target already |
| Secrets at rest | `defineEnv` validates and `/redact` hides, and `@encrypted` covers columns. Nothing encrypts a `.env` or rotates an app secret; `IDEAS/release-transitions.md` reaches for `sops` and does not own it | Deployment realm, in-house — an app secret is a Release fact |
| Maintenance mode | `fli deploy` mints a Release and swaps; there is no *this app is down on purpose* state. Absent, a deploy that must pause serving has to be done by stopping a container, which the journal then reads as a crash | in-house, and it is a transition rather than a flag. **Built — `IDEAS/release-transitions.md` § Phase 3b** (`fli deploy:pause`), and it was not small: the enum it adds needed a migration path `deploy.db` had never had |

**The one axis where the comparison runs the other way is worth stating**, because
it is evidence for § *The strategic read* rather than another gap: that framework's
agent map lists ~52 typed config files and vendor code inside the framework —
SES, SendGrid, Mailgun, Algolia, Meilisearch, Stripe, Bedrock, CDK. FJS ruled the
opposite in `FJS-D153` and `packages/junction/src/ai/index.ts` is the ruling
executed: the adapter shape ships, no vendor does, and the reason is written in the
file. Out-cohering is the bet, and a catalog three times the size with the vendors
inside it is what the bet is against.

---

## The gap that actually decides it

**Laravel's moat is not features. It is documentation, learning material, and
ecosystem.** The docs are the best in any language, Laracasts taught a generation,
and there is a package for everything.

FJS has excellent documentation *for maintainers* — `ARCHITECT.md`, `DECISIONS.md`,
`PHILOSOPHY.md`, `VERIFYING.md` — and essentially none *for users*. The `website/`
work is the first step against this.

Still needed:

- **A documentation site.** Guides, API reference, recipes. Treated as a product
  with an owner, not as a folder.
- **Upgrade guides and a deprecation policy.** What a major version means, how long
  a release is supported, how a breaking change is announced — and, per tier-2 item
  10, the codemod that performs it rather than describing it.
- **A security disclosure process.** Where to report, expected response time.
- **Starter kits.** `fli project:new` scaffolds; it does not produce an app with
  auth screens, a dashboard and billing already wired. Laravel Breeze and Jetstream
  are a significant share of why starting is easy there.
- **A slice registry.** `IDEAS/slices.md` is the ecosystem answer — it is how a
  community fills tier 2 instead of this project building all of it.

---

## The strategic read

FJS will not out-feature Laravel; that is a decade and a company. **It can
out-cohere it.**

- Authorization on the model beats Gates and Policies that live in code a caller can
  route around.
- Derivation from one schema beats Eloquent + FormRequest + Policy + Resource, which
  are four restatements of one field list.
- Single-binary SQLite deployment beats anything available in PHP.

So the sequencing that follows from that:

1. **Build the tier-1 blockers directly** — OAuth, billing, storage. Nothing
   ships without them and no community will fill them early. **i18n left this
   list on 2026-08-15** (`FJS-D12`): it is V2, and what alpha owes it is six
   constraints rather than a build.
2. **Make slices real** (`IDEAS/slices.md`) so tier 2 can be filled by other people.
3. **Treat documentation as a product**, with the same seriousness as a package.
4. **Repair or retire `admin:generate`.** It is either the fastest route to a
   schema→UI story or dead weight advertising a feature that does not run. Both are
   defensible; leaving it drifted is not.

---

## Note on the website's claims

`website/packages.js` describes auth as *"Sessions · passwords · API keys · OAuth ·
TOTP"*. When this file was written OAuth and TOTP did not exist; both ship now, so the
line is true.

## See also

- `IDEAS/slices.md` — the distribution format that lets others fill tier 2
- `IDEAS/offline-first-and-release.md` — where the deployment story is going
- `website/README.md` — the publication gate for the launch-voice copy
