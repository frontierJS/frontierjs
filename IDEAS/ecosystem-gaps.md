# Idea — Ecosystem gaps: what is missing to compete with Laravel and the likes

**Status: ASSESSMENT + FUTURE WORK.** Dated 2026-08-02. Claims were probed against
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
`IDEAS/framework-shape.md` item 1 claimed schema→UI derivation was entirely absent;
that was wrong as written. It is *codegen*, not derivation — files are emitted and
then yours — but the gap is narrower than recorded.

**However, it has drifted badly from the current stack** and is very likely
non-functional as shipped. Four signals, all in
`packages/cli/commands/admin/generate.md`:

1. It emits **`.svelte` files**, not `.mesa` — 12+ occurrences. Sierra compiles Mesa.
2. It writes to **`web/src/routes/admin/`**; Sierra's routes live in `src/routes/`.
3. It generates **`_layout.svelte`**; Sierra's layout convention is `_module.mesa`.
4. Its docs tell you to add `isAdmin` to your **`users`** model — lowercase plural,
   which violates the PascalCase-singular rule that is mandatory per `DECISIONS.md`,
   and would not produce the accessor the generated code expects.

It also assumes a `$session.user.isAdmin` store that does not match Sierra's
Junction binding (`status`, `getClient`, `login`, `logout`).

**Full-text search exists.** Litestone generates FTS5 virtual tables
(`packages/litestone/src/core/ddl.js:305`, with parser support for tokenizer
choice). That is Laravel Scout, already covered — no gap.

**Model factories exist** (correction added 2026-08-04, probed by running).
Tier-2 item 5 below was written as "factories do not exist"; they do, in
`@frontierjs/litestone/testing`. See that item for what is actually left.

---

## Tier 1 — an app cannot ship without these

These block a typical SaaS outright. They are the reason an evaluator stops.

### 1. OAuth / social login

**Missing entirely.** `packages/auth/auth.ts` implements `verifySession`, `login`,
`logout`, `createUser`, `deleteUser`, password reset, email verification and API
keys. There is no OAuth of any kind — no provider flow, no token exchange, no
account linking.

- **Laravel equivalent:** Socialite
- **Proposed home:** `@frontierjs/auth` (provider flows) — the `Credential` model
  already has `type`, `accessToken`, `refreshToken`, `tokenExpiresAt` and `scope`
  columns, so the schema anticipated this
- **Why first:** "Sign in with Google" is table stakes. This is the most likely
  single reason someone evaluates FJS and leaves.

### 2. Billing and subscriptions

**Missing entirely.** No payment provider integration, no subscription lifecycle,
no invoicing, no billing webhooks, no proration or trials.

- **Laravel equivalent:** Cashier
- **Proposed home:** a Slice (`IDEAS/slices.md`) — this is the canonical case for
  the slice format: models + service + webhook endpoints + optional UI
- **Substrate already present:** Conduit is the right outbound boundary for a
  payment provider, and Junction's webhooks plugin is the right inbound one. Nothing
  is built on either.

### 3. Object storage driver

`IFileStorage` (`packages/junction/src/storage/filestorage/index.ts`) is a clean
contract with exactly one implementation: local disk. No S3, R2 or GCS anywhere.

- **Laravel equivalent:** Flysystem drivers
- **Why it blocks:** any container, serverless or multi-node deployment
- **Size:** small — a driver against an interface that already exists

### 4. Internationalization

**Missing entirely.** No message catalogues, no pluralization, no locale
negotiation, no per-locale formatting.

- **Laravel equivalent:** the `Lang` facade and `lang/` directory
- **Why now rather than later:** retrofitting i18n into a UI layer costs far more
  than designing for it. Every string added before this exists is a string to be
  found again later.
- **Design question it forces:** does a translated string belong in the schema
  (labels derived from models) or only in the UI? The answer shapes schema→UI.

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

**What is actually left is adoption.** Grep the monorepo: the only caller is
Litestone's own `test/litestone.test.ts`. Junction's test kit, basecamp's suite and
`example/` all still hand-roll rows, so the payoff this item was written for — a
good test kit that is under-used because making data for it is manual — has not
been collected. That is the tracked work, not the building.

See `IDEAS/testing-and-ci.md`, which treats this as the unblocking step for a
cross-realm suite.

### 6. Two-factor authentication

`IAuth` declares `setupTotp` as an optional method; the native provider does not
implement it. Increasingly table stakes for B2B.

### 7. Feature flags

No equivalent to Laravel Pennant. Natural fit as a small slice over a Litestone
model plus a Junction plugin exposing `app.features`.

### 8. Browser / end-to-end testing

No Playwright, Puppeteer or equivalent harness. Laravel has Dusk. Notably, this
site's own pages are already verified with headless Chrome — the technique exists in
the repo, it is just not a package.

**Broader than it looks** (2026-08-03): the technique now exists in the repo *three*
times as one-off harnesses — `packages/sierra/tests/fixtures/island-site/verify.mjs`,
`packages/css/test/run.js`, `packages/ui/test/render.mjs` — and none is reusable.
Paired with item 5, this is the UI half of the Suite realm, which has no package at
all. And nothing runs on commit: there is no `.github/` directory in this repo. See
`IDEAS/testing-and-ci.md`.

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

### 11. Rate limiting

**Added 2026-08-04. Tier-1 severity, filed here to avoid renumbering** — several
files cite `ecosystem-gaps.md` tier-1 item numbers.

**Missing entirely.** No limiter, no throttle, no quota, nothing in
`packages/junction/src/transport/`. A public API cannot ship without one, and the
absence is not survivable by convention the way some tier-2 items are.

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

### 12. Streaming responses

**Added 2026-08-04.**

**Missing entirely.** No SSE, no chunked transfer, no streaming body anywhere in the
transport. Every response is buffered and returned whole.

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

1. **Build the tier-1 blockers directly** — OAuth, billing, storage, i18n. Nothing
   ships without them and no community will fill them early.
2. **Make slices real** (`IDEAS/slices.md`) so tier 2 can be filled by other people.
3. **Treat documentation as a product**, with the same seriousness as a package.
4. **Repair or retire `admin:generate`.** It is either the fastest route to a
   schema→UI story or dead weight advertising a feature that does not run. Both are
   defensible; leaving it drifted is not.

---

## Note on the website's claims

`website/packages.js` currently describes auth as *"Sessions · passwords · API keys ·
OAuth · TOTP"*. OAuth and TOTP do not exist. This is consistent with the
finished-state voice the site was deliberately written in, and
`website/README.md` already gates publication on the packages actually shipping —
but auth is the first thing a technical evaluator tests, so it should be true before
the site is public rather than eventually.

## See also

- `IDEAS/framework-shape.md` — the realm-by-realm gap assessment (item 1 corrected above)
- `IDEAS/slices.md` — the distribution format that lets others fill tier 2
- `IDEAS/offline-first-and-release.md` — where the deployment story is going
- `IDEAS/testing-and-ci.md` — automated CI, and the Suite realm items 5 and 8 belong to
- `website/README.md` — the publication gate for the launch-voice copy
