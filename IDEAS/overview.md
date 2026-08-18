# Ideas — the overview

**Status: INDEX. Derived, not authoritative.** Dated 2026-08-06. Every row here is a
summary of something argued properly in another file; **when this disagrees with a
source file, the source wins.** Nothing listed is built unless the Status column
says otherwise. See `VERIFYING.md`.

Re-verified against the tree on 2026-08-05, which found **five rows wrong**: 0.3
(disputed), 2.8 and 2.9 (both claimed nothing existed; both ship and are tested),
4.1 (shipped 2026-08-04), and the `orion` note. That is the cost of a derived
index nobody re-derives — treat any row older than the tree as a lead.

Re-derived again later on 2026-08-05 after a review of seven proposals imported from
outside the repo. Four survived and are folded in — two as defects (0.6, 0.7, both
found while checking the proposals rather than by the proposals themselves, and
**both fixed the same day**), two as wave-4 rows (4.12, 4.13) and two as extensions
to existing rows (4.4b, and a note on 4.6). Three did not survive; where the
reasoning is worth keeping it is recorded in the source file rather than as a row —
see `one-mental-model.md` § *The target set's missing member*.

Re-derived again on 2026-08-06 after a ten-problem survey of what every fullstack
framework has to answer. Three of the ten landed on the same missing owner and became
`client-data-lifecycle.md` (0.8, 4.14); one was already `static-safety.md` and is now
carried as a defect with an id (4.4); one shipped the same day and left a narrower
remainder behind it (1.1a). The survey's own conclusion is the useful part and is
recorded in those files: **every elegant fix converts a class of bug into something
you cannot express, and every escape hatch is narrow enough that using it does not
repeal the guarantee elsewhere.** By that reading FJS is strong wherever the compiler
or the schema owns a fact and weak wherever the fact lives in imperative client glue —
which is where 0.2, 0.8, 4.6 and 4.14 all sit.

Re-derived a third time on 2026-08-06 against a 39-item glossary of framework
concepts brought in from outside. Most of it already ships here or was already
filed; four items mapped to nothing and became `declared-semantics.md` (4.15),
one was a live defect (`FJS-088`), and three were vocabulary collisions ruled in
`DECISIONS.md` rather than built. The glossary's own summary — *promote it to a
first-class type or a structural rule* — is worth disagreeing with precisely: a
type is enforced where you call it, a **declaration** is enforced at the boundary
whether you call it or not, and this framework has already picked the second. The
glossary also omits the escape-hatch half, which is the harder one.

A fourth pass on 2026-08-06 asked the inverse question — *what do Laravel, Rails
and SvelteKit let you declare that FJS does not?* — and the answer was uncomfortable
in a useful way. Four of the five best answers are **not features FJS lacks; they
are declarations FJS lacks for capabilities it already has**: urlencoded body
parsing with no form actions (2.10), transactions with no commit-scoped hook
(`FJS-089`), a job noun with a stringly-typed name (`FJS-090`), route
introspection with no way to look (`FJS-091`). That is a different failure from a
missing feature and a more annoying one, because the pieces sitting there
unconnected read as though the thing works.

A fifth pass on 2026-08-12 came from outside the repo in a different way — two rounds
of research into how eleven deployment systems actually fail, the second round spent
trying to falsify the first. It landed on the one realm three earlier analyses had
already pointed at, and it changes 2.3 from a single `XL` bet into a sequence whose
first step is `S` and independently useful (2.3a–2.3d, `release-transitions.md`). The
finding worth carrying up here: **every system surveyed ships a rollback that restores
code and nothing else**, and the reason is that none of them can tell whether a change
is reversible — which FJS can, off the seed, for free. Two of the research's own
starting claims were falsified in round two and are recorded as falsified in the source
file, which is the part of it most worth reading.

The same day, a sweep of the app *lifecycle* — create, dev, test, build, deploy,
monitor — asked what the forward pipeline does not cover, and found three things absent
from this register entirely rather than merely unbuilt: **backup** (2.11), **security
advisories** (2.12) and **support mode** (4.17). The pattern is that all three sit on
an axis the pipeline does not run along — getting data *back*, things that recur to a
shipped app, and a human reporting a fault. Each is argued in the existing file it
belongs to rather than a new one.

A second sweep the same day asked the harder version — not *what step of the lifecycle
is missing* but **what kind of application cannot be built here at all** — and returned
three: row-level tenancy (4.18), durable workflows (4.19), inbound integrations (2.13).
The sweep is worth recording for what it *disproved* as much as what it found:
**presence already ships** (`junction/src/transport/presence.ts`, join/sync/leave with
its own protocol) and outbound webhooks ship with HMAC signing, retry and
dead-lettering — both were on the candidate list and both were wrong, which is the
`VERIFYING.md` rule earning its keep on an index that has been wrong before. The
pattern in what survived: all three are *named somewhere and owned nowhere* — one in
`ARCHITECT.md` §5, one in the domain map, one in Domain 4's own admission that it is
narrow.

One row came in the same day from outside in the smallest way — an article on HTML
over WebSockets — and is worth noting for the *shape* of the answer rather than its
size. 4.20 is `S` and ●●○○, but it took an hour of running things to find that the
transport half needs no change at all and the two compilers already agree on a scope
hash, which is the half that is expensive everywhere else. **The idea arrived as one
thing and had to be cut into two**: a fragment push, which is days, and server-held
components, which is a second UI realm and is refused in the source file. Most
outside ideas arrive fused like that.

A third sweep the same day asked the question from the developer's chair rather than the
framework's: **what hard part of ordinary web development does someone still have to
wire up by hand here, because nothing addresses it.** It returned 4.21 (time), 2.14
(bulk data), 2.15 (cursor pagination), 2.3e (backfills) and 5.12 (three small edges).
The disproofs are again the more useful half — **sitemap generation already ships**
(`sierra/src/postbuild/`), and the idempotency half of this was already argued in
`declared-semantics.md`, where the sharp part is recorded as an asymmetry rather than a
gap. And **row 2.1 was found to be wrong**: it claimed no S3 driver existed anywhere,
while litestone has shipped one with hand-written sigv4 signing and presigned URLs for
some time. That is the sixth stale row this index has produced, all by the same
mechanism — a claim written from one package's grep and never re-derived.

Two of the five are worth noting for their shape rather than their size. **2.3e is a
hole in a design written the same week**: `release-transitions.md` refuses a contract
deploy and offers *expand, backfill, contract*, having specified the first and third
steps and not the middle one, which is the only step that takes hours and the only one
that can fail halfway. And **2.14 arrived assuming nothing existed** and found
`parseCsv()` and `loadFixture()` already shipped in litestone's seeder — built for a
developer at seed time, and unusable by a user at runtime for three specific reasons.
Both corrections came from probing before writing, which is the only reliable protection
this file has.

A fourth sweep the same day went after **tooling** — the supporting pieces every
framework ships and this one has never chosen. It found that the repo has **no linter,
no formatter and no `.editorconfig` at all**, which was expected, and one thing that
was not: **a stated house rule blocks the obvious fix.** `CLAUDE.md` requires aligned
columns, Prettier and Biome and dprint all collapse a run of spaces, and the two files
the docs cite as canonical are both aligned — so the decision is a taste ruling before
it is a tool choice. 1.7, 5.13, 5.14 and 5.15 came out of it, and they are grouped as
*the tooling cluster* below rather than as a wave, for a reason stated there.

A fifth sweep, on 2026-08-15, took the published feature catalogue of an outside
fullstack framework — roughly seventy items across frontend, backend, cloud, CI/CD and
DX — and asked which of them map to nothing here. **The disproofs are once again the
larger half, and four of them are things this index or its readers would have called
gaps.** Full-text search ships end to end: `@@fts` builds FTS5 virtual tables with sync
triggers, `db.message.search()` does highlight, snippet and soft-delete modes, and it
reaches the API as the `$search` directive. Aggregates ship — `aggregate`, `groupBy`
with `HAVING`, `count`, `exists`, `findManyAndCount`. Security headers ship —
`helmet()`, `csrf()` and `cors()` with a documented ordering constraint between them.
Sierra's auto-import ships, opt-in per config, with a naming-conflict refusal. And
**`findManyCursor` ships**, which corrects row 2.15 below: cursor paging is missing from
`ctx.directives`, not from the Data realm, and the row was written as though the whole
thing were absent. That is the seventh stale row this file has produced by the same
mechanism.

Five items mapped to nothing and are new rows: **2.17** push and SMS delivery, **3.8**
the teams slice, **4.23** `fli tinker`, **5.18** desktop and mobile as targets, **5.19**
dev URLs. Two more mapped to nothing and are **silences rather than gaps** — SQLite as
the only database, and serverless — so they are ruled in `DECISIONS.md` rather than
carried here. That distinction is worth keeping: *we do not do that* is a decision, and
the same thing recorded as an empty row reads to everyone else as an oversight.

Intended to become the roadmap on the website. That is also the reason to keep it
derived rather than maintained: a roadmap that drifts from the ideas it summarises is
worse than no roadmap. Re-derive it when a source file changes; do not edit a row
here and leave the source behind.

`IDEAS/package-map.md` is the sibling index — same material, organised by *package*
rather than by *work*.

---

## How to read the columns

| Column | Meaning |
| --- | --- |
| **Effort** | `S` days · `M` a week or two · `L` about a month · `XL` multi-month |
| **Payoff** | How much it unblocks, wins, or prevents. ●○○○ → ●●●● |
| **Edge** | How *only-FJS* it is. `stakes` (everyone has it, we don't) · `parity` (matching a good implementation) · `edge` (better than the field because of a choice already made) · **`only`** (structurally impossible for frameworks whose authz lives in handlers) |
| **Realms** | **D**ata · **A**PI · **U**I · **R**elease · **T**esting · `—` cross-cutting |
| **Status** | `idea` · `partial` (something exists and is incomplete) · **`defect`** (something shipped is wrong today) · `contested` (the defect claim is disputed — see `ISSUES.md`) · ~~`shipped`~~ (landed since; the row is kept only for the remainder named in it) |

**Edge is the column that should drive the roadmap.** A `stakes` item is why someone
leaves; an `only` item is why someone arrives. A plan made of one and not the other
fails in a predictable direction.

---

## Wave 0 — repairs


*These are defects, and **`ISSUES.md` is where their status is of record** —
0.1 = `FJS-009` · 0.2 = `FJS-011` (**closed**) · 0.3 = `FJS-071` (**contested**) ·
0.4 = `FJS-065` · 0.6 = `FJS-073` (**closed**) · 0.7 = `FJS-074` (**closed**) ·
0.8 = `FJS-082` ·
4.4a = `FJS-005` · 4.6 = `FJS-011` (**closed**; the residue is `FJS-270`). They stay listed here
because each is argued in an ideas file and carries an effort/payoff/edge
reading the register does not. 0.5 (`fli doctor`) is a feature, not a repair.*

Shipped behaviour that is wrong. These are not features and they are not optional;
they are listed here because each is argued in an ideas file rather than a ledger.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1 | **Automated CI** — no `.github/` exists; every landmine in `CLAUDE.md` was found by hand | S | ●●●● | stakes | T | idea | `testing-and-ci.md` |
| 0.2 | **Live-store filter leak** — `resource()` upserts every event regardless of query; a patched row that leaves the filter stays and goes wrong silently | S | ●●●○ | — | A U | **defect** | `live-queries.md` |
| 0.3 | **Audit logger writes 0 rows** — *disputed.* `CLAUDE.md` records the opposite: the logger buffers ~1s and flushes on exit, so a read straight after a write returns 0 and litestone's own examples read too early. Real and separate: `path` resolves against process CWD, not the schema file. Settle it, then repair or close | S | ●●●○ | edge | D | `contested` — `ISSUES.md` `FJS-071` | `framework-shape.md` 4 |
| 0.4 | **`admin:generate` repair-or-retire** — emits `.svelte`, wrong paths, lowercase-plural model. Either the fastest route to schema→UI or dead weight advertising a feature that does not run | S | ●●○○ | — | U | **defect** | `ecosystem-gaps.md` |
| 0.5 | **`fli doctor`** — the live-hazard catalogue as an executable rule set. Every entry was found by hand and every one will be found again by every person who builds on this. Compounds with 0.1 | M | ●●●● | **only** | — | idea | `diagnostics.md` |
| 0.6 | ~~**`<mesa:boundary>` watches every async value in the component**~~ — **fixed 2026-08-05.** The watch set is now what the body reads; the union is kept when the body reads nothing async or renders a snippet defined elsewhere. 9 tests. Remainder: none — the next step is 4.12, which is a feature | S | ●●○○ | — | U | ~~`shipped`~~ | `derived-suspense.md` |
| 0.8 | **A load has no identity** — `resource().load()` is `store.set(rows)` with nothing comparing the result to the query that asked for it (`junction/src/client/index.ts:519`), so two overlapping loads resolve in arrival order and a search box can settle on the older answer. The fix is the same rule 0.6 applied one realm over: staleness is dependency identity, not arrival time | S | ●●●○ | — | A U | **defect** | `client-data-lifecycle.md` |
| 0.7 | ~~**`updateMany`/`deleteMany` write no audit entry at all**~~ — **fixed 2026-08-05.** All five uninstrumented paths log, and bulk entries name their rows (which also fixed `createMany`'s empty `records`). 8 tests. Remainder: a bulk entry records *which* rows and *what* operation, not contents — so a bulk delete is now visible but still not invertible, which 4.13 has to answer | S | ●●●○ | — | D | ~~`shipped`~~ | `time-travel.md` |

---

## Wave 1 — make the thesis visible

The framework's central claim is two-thirds delivered. Nothing else changes how it
*reads* to a newcomer as much as this wave.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 | **Schema → UI (`foundry`)** — `<AutoForm>`, `<AutoTable>`, derived admin. Every input is already in the browser bundle and nothing consumes it. **The form half landed 2026-08-15** (1.1a): `<Form {resource} />` is `<AutoForm>` under the name that already existed, and the control table it needed is now a module anything else can read. What is left is the other three surfaces — a table, a detail view, a filter bar — and the admin that composes them. **The extension mechanism is settled and shipped** (`FJS-D17`, 2026-08-16): a control is `registerControl(name, resolve)` in sierra plus `registerFormControl(name, Component)` in the kit, two halves because the naming side must run in plain Node and the rendering side may not import sierra. Each remaining surface inherits it unchanged — `(rule, ctx) → name` plus a name→component binding — and gets its registry when it gets a GENERATOR, not before: a registry with no consumer is a name nobody can call | L | ●●●● | **only** | D U | partial | `framework-shape.md` 1 |
| 1.1a | ~~**Generate the form, not just its parts**~~ — **shipped 2026-08-15.** `<Form {resource} />` with no children renders every writable column in schema order, each with the control its type implies; `only` narrows and orders, `except` removes, children win. The control table has one home — `controlFor` / `formFieldList` in sierra's `field-rules.js` — and the kit reaches it through the resource rather than importing sierra, which keeps `@frontierjs/ui` peering on mesa and css alone. `example`'s `orders/create.mesa` went from ~150 lines to nine, its only field name being an `except` for the column a Caravan job writes (`FJS-095`). **1.5 was not a gate after all**: the generator authors no string — a label is `@label` or the title-cased column name, exactly what a hand-written control already resolved — so i18n has the same one job before and after. Two prerequisites were real and landed with it (`FJS-078`, and `FJS-077` for `Checkbox`); one was not (`FJS-079` — a generated `DateTime` gets the same text box a hand-written one does). A column the table cannot place is **warned about by name**, never dropped | M | ●●●○ | **only** | D U | ~~`shipped`~~ | `forms-from-the-seed.md` |
| 1.2 | ~~**`create-frontier`**~~ — **shipped 2026-08-15.** `npm create frontier@latest my-app`, `bun create frontier my-app`. An entry point and nothing else: it resolves `@frontierjs/cli` and runs `fli new`, so one implementation of the scaffold. Three things it adds are about being invoked through `npm create` — **`--project <cwd>`**, because fli walks UP for a project root and a scaffold inside an existing repo otherwise lands in that repo's root (measured both ways); a prompt for the name; a bun check before anything is written. Arguments are forwarded untouched, since sorting them into flags and positionals does not survive `--source npm`. **Unpublished** — it cannot go up before `@frontierjs/config` does | S | ●●●● | stakes | — | **shipped** | `packages/create-frontier/` |
| 1.3 | **Model factories** — derived from field types and rules; Junction's test kit is good and under-used because making data is manual | S | ●●●○ | parity | D T | idea | `ecosystem-gaps.md` 5 |
| 1.4 | **`quarry` — demo data + a persona per gate level** — `fli demo` boots an app you can click through as STRANGER / USER / ADMIN. How the framework gets *shown*, and what `foundry` needs to render | M | ●●●○ | edge | D T | idea | `package-map.md` |
| 1.5 | **i18n (`lexicon`)** — ~~must be *decided* before 1.1 ships~~ **ruled 2026-08-15 (`FJS-D12`) and deferred to V2.** It was never a gate: the generator authors no string, so what it multiplies is call sites. English only for alpha, with six constraints holding the seam open — `@label` is a default string and never a key (the address is derived `Model.field.label`), an error carries a code and params rather than a sentence, configuration strings and content stay two mechanisms, `/inflect` never takes a locale, kit strings are props with English defaults, and formatting gets one owner. The build is V2; what is reserved is a seed-derived `strings.snapshot.md`, `db.$setLocale()` as a client flavour, and per-locale prerender | M | ●●○○ | stakes | U | **ruled** | `ecosystem-gaps.md` 4 · `DECISIONS.md` |
| 1.7 | **Lint and format — the blocking half is ruled; the repo's own adoption is not** — `FJS-D32`, 2026-08-15. What made this a taste call was thought to be `CLAUDE.md`'s *aligned columns* rule; it is not, because **the code `fli new` generates is aligned too**, so the first format run of any of the three candidates rewrites the app the scaffold had just written. That is measurable rather than preferred, and it settles it: **Biome, linter only**, with `assist` off as well (import sorting reorders an aligned block — a format change wearing a lint rule's clothes). Shipped as `@frontierjs/config`, which every scaffolded app extends. The lasting sentence is in `FJS-D32`: a linter owns generic JavaScript, `fli check` owns everything derived from the seed, neither reimplements the other — and `.mesa`/`.lite` are out of reach for every tool, which is why that boundary is not a maturity gap. **What remains is this repo linting itself**: measured, `recommended` gives 7,249 findings here and the shipped set ~600, 123 of them unused imports. A countable cleanup, `FJS-266` | S | ●●○○ | stakes | — | **part shipped** | `tooling-decisions.md` 1 · `DECISIONS.md` `FJS-D32` |
| 1.6 | **App manifest — `frontier.config.js` + `frontier.lock`** — declared intent, observed fact recorded *by booting*, and a three-way reconcile against the filesystem. Turns a filename segment into a claim doctor can falsify, gives 1.2 an input, and makes invariant 14's ratchet mechanical. Extends 0.5 with the leg text-scanning cannot reach | M | ●●●○ | edge | A R | idea | `app-manifest.md` |

> **1.1 gates more than anything else on this list.** It is the reason a Slice's
> `resource/` part is worth shipping, the thing `quarry` renders, and the seam
> offline-first has to be built through rather than around.

---

## Wave 2 — production blockers

An evaluator stops at these. None is differentiating; all are disqualifying.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.1 | **Two file-storage abstractions, one of which reaches S3** — **this row was wrong until 2026-08-12** and said no S3 driver existed anywhere. Litestone ships one: `storage/providers/s3.js` over a hand-written `sigv4.js` (signed requests, presigned URLs, no SDK), driving R2/B2/MinIO/S3 from the `FileStorage` plugin, with `File` columns, `@accept`, `@keepVersions` and delete cleanup — documented and tested. Junction's separate `IFileStorage` is local-disk-only and unaware of it. So the work is a **reconciliation**, not a driver: Invariant 4 says one owner per translation, and there are two. Cheaper than it was and still blocks a multi-node deploy through the Junction interface | S | ●●●○ | stakes | A D | partial | `ecosystem-gaps.md` 3 |
| 2.2 | **OAuth into `auth`** — the `Credential` model already carries `type`/`accessToken`/`refreshToken`/`scope`. The single most likely reason an evaluation ends | M | ●●●● | stakes | A | idea | `ecosystem-gaps.md` 1 |
| 2.3 | **Release story (`depot`)** — artifact kinds first-class: single binary, container, static+API, offline PWA. Found independently by three analyses. **Now sequenced rather than scoped as one bet**: artifact *kind* is a field on the Release object 2.3b describes, and the four phases below are the build order | XL | ●●●● | edge | R | idea | `offline-first-and-release.md` |
| 2.3a | ~~**Pivot classifier — `fli release:check`**~~ — **shipped 2026-08-15.** `litestone release` derives the release surface and `classifyPivot(before, after)` answers *expand / contract / unknown*; `db/release.snapshot.md` is committed and the `snapshots` phase found it with **no CI edit**, which was the claim. The baseline is git (`HEAD`, or `--from v1.4.0`, or a path), because the snapshot holds the surface and never the verdict — a file that depends on its own previous contents is not a fixed point and cannot be rechecked. **Access is in the comparison**: a raised `@@gate` and an added `@@allow` are compatibility changes, and on basecamp's working tree it reported 14 contracts, one per model that gained the tenancy predicate. A required column with no default comes back as a contract carrying its split (expand → backfill → contract), which is 2.3e arriving as advice the classifier already gives. Remainder: nothing — 2.3b is the next row | S | ●●●● | **only** | D R | ~~`shipped`~~ | `release-transitions.md` |
| 2.3b | **Release object + journal + `fli revert`** — content-addressed Release (image ⨯ config values ⨯ secret *references* ⨯ schema version ⨯ declared pivot), an Environment that is mutable but **generational**, journaled idempotent transitions in a Litestone db, and `--plan`. Guarantee: *before the pivot, revert restores code, config and schema*. The generation counter is the whole difference between this and Fly's documented bug — reverting a Release onto today's config | M | ●●●● | edge | R | idea | `release-transitions.md` |
| 2.3c | **Attached services** — a third-party dependency (n8n, a mail server) declared in the app and **bound per Environment**, so a missing binding is a startup refusal rather than a 3am mystery; dev-side compose generated with ports from the existing broker. We never manage the service — provisioning is easy and *de*-provisioning is where integrated platforms die. Mostly free once 2.3b has Environments; answers the daily dev↔prod drift pain by syncing the *declaration*, never the instance | S | ●●●○ | edge | R | idea | `release-transitions.md` |
| 2.3d | **Clients as release state** — stamp Release identity into served HTML, keep the previous Release's assets addressable for a stated retention window, and route two Releases at once. Vercel sells this as *skew protection*; here it is a consequence of owning both ends of the wire. **The window is not a new knob** — it is the same number as *how long must N-1 keep working*, which is what a pivot is defined against. The first Release phase that reaches into the UI realm, so it wants Sierra; 4.10's Audience half is this routing table with a different selector | M | ●●●○ | edge | U R | idea | `release-transitions.md` |
| 2.3e | **Backfill — the middle step of the split we already offer** — 2.3b refuses a contract deploy and hands back *expand now, backfill, contract later*. The first and third steps are specified and **the second is not**, which makes the refusal advice rather than a plan. Filling a new column for ten million existing rows must be resumable after a restart, throttled against live traffic, observable while it runs, and re-runnable without doubling its work — none of which a migration is, or should become. Same machinery as the journal, which makes it **the second workflow in a system built to hold one** and the strongest evidence for 4.19. Also earns the classifier a fourth answer — *expand, and a backfill is required before the matching contract can pass* — derivable, because a new non-null column with no default is exactly that case | M | ●●●○ | edge | D R | idea | `release-transitions.md` |
| 2.3f | **Build once, promote a digest** — the shipped `fli deploy` pulls source, builds web and builds the image **on each target server**, so dev, stage and production never provably run the same bytes and `${appId}:${shortSha}` names different images on different boxes. Nothing about SQLite requires this; it is the one twelve-factor deviation that is accidental rather than chosen. Supplies the image term 2.3b assumes — a Release cannot be content-addressed while its artefact is not. Basecamp's `Deployment` already separates `builtImage` from `toImage`, so the model is ahead of the pipeline. First step (`digest, not tag`) is `S` and independently useful | M | ●●●○ | stakes | R | defect | `deploy-plane.md` |
| 2.3g | **The bootstrap ring — who installs Basecamp** — Basecamp is FJS's Coolify, and a control plane cannot install itself. Three rings: `fli deploy` installs Basecamp (which **reframes `fli deploy` as the fleet tool's installer rather than its competitor**, and caps its scope), Basecamp installs the agent over SSH, the agent deploys applications. Basecamp's own upgrade always goes through ring 0 — a plane that deploys its own replacement must survive its own restart mid-transition, and cannot. Closes both of VISION's open questions at once: the schema already chose an agent (`agentVersion`, `lastHeartbeatAt`, `installing`), so agentless becomes the **degrade path** rather than the alternative | L | ●●●● | edge | R | idea | `deploy-plane.md` |
| 2.4 | **Observability (`lantern`)** — real spans, not just a `correlationId`; request-correlated logs through transport → service → db | M | ●●●○ | parity | A | idea | `operational-edge.md` 3 |
| 2.5 | **Billing (`ledger`)** — the canonical first slice, and the proof the format works | L | ●●●● | parity | D A U | idea | `ecosystem-gaps.md` 2 |
| 2.6 | **2FA / TOTP** — `IAuth` declares `setupTotp`; nothing implements it | S | ●●○○ | stakes | A | partial | `ecosystem-gaps.md` 6 |
| 2.7 | **Media processing** — resizing, thumbnails, formats. Sits on litestone's `FileStorage` plugin, which is where the bytes already are; 2.1 decides whether that is the one place they live | S | ●●○○ | stakes | A | idea | `ecosystem-gaps.md` 9 |
| 2.8 | **Streaming responses** — **SSE already ships**: `ctx.sse()` returns a real `text/event-stream` response with `send`/`close`/`onDisconnect` (`junction/src/transport/http.ts:636`), tested. What is missing is the *contract* — does a stream sit outside the result envelope, or does the envelope grow a third `kind`? — and a chunked-body path for non-event payloads. A ruling, not a build | S | ●●○○ | stakes | A | partial — ruling is `ISSUES.md` `FJS-D13` | `ecosystem-gaps.md` 12 |
| 2.10 | **Form actions — a mutation declared beside its page, working without a bundle** — `<Form>` (shipped 2026-08-06) is JavaScript-only, and a bundle that 404s leaves a form that looks complete and does nothing. Every piece exists already: Junction parses `urlencoded` and `multipart`, `redirectResponse()` ships, the schema's per-field messages are the same sentence on both sides, and `<Field>` already takes an errors map. What is missing is the declaration. Also what makes the `static` target an application rather than a brochure | M | ●●●○ | parity | A U | idea | `form-actions.md` |
| 2.11 | **Backup, restore, and a restore that is *proven*** — checkpoints (4.13) answer *what changed*; nothing answers **the file is gone**. Every competitor inherits this from a vendor — RDS, Neon, PlanetScale — and **FJS is the one framework with no vendor to inherit it from**, which is the cost of the one-binary-beside-one-file pitch nobody has written down. Also the missing counterpart to 2.3b: *revert restores serving state, not database history* is only an acceptable sentence if something else answers data. The `only` half is verification — restore into a temp db and run the app's own suite against it, which needs both ends of a sentence no other framework owns | M | ●●●● | edge | D R | idea | `time-travel.md` |
| 2.12 | **Security advisories and dependency posture** — the words *CVE* and *vulnerability* occur nowhere in `IDEAS/`, and nothing answers **am I affected**. A support policy, an advisory format, a channel, and a `fli` command that compares an advisory against `project:map --json` — a comparison rather than a scan, and narrower than a scanner because the app model knows what is *reachable* rather than merely installed. The floor every mature framework has and no evaluator misses. **Must precede 3.6**: a slice registry without an advisory channel is a supply chain with no way to say *stop using this* | S | ●●●○ | stakes | — | idea | `ecosystem-gaps.md` 13 |
| 2.13 | **Inbound integrations** — Conduit is outbound, the webhooks plugin is outbound (*"At-least-once webhook delivery"*), notifications and mail are outbound. **Nothing receives**: no inbound endpoint, no signature verification on the way in, no replay window, no dedupe of a retried delivery, no declared mapping from an external payload to a Service call. Domain 4 already describes itself as *narrow* and this is the direction. The reason an n8n sits beside an FJS app at all — and distinct from 2.3c, which binds that instance rather than removing the need for it. Wants one definition of *this work already happened*, shared with 2.3b's journal steps and Caravan's `unique` | M | ●●●○ | stakes | A | idea | `ecosystem-gaps.md` 14 |
| 2.14 | **Bulk data — import, export, and the template first** — the probe changed this row before it was written: `parseCsv()` (RFC-4180, quoted fields, embedded newlines) and `loadFixture(db, 'Plan', 'plans.csv', { upsert: 'code' })` **already ship** in litestone's seeder, writing through the ORM so defaults, validators, `@encrypted` and hooks all apply. They are built for a **developer at seed time** and fail for a user at runtime in exactly three ways: the first bad row throws mid-loop, there is no dry run, and it reads from `fs`. **The piece to build first is the downloadable template** — fully derived (writable columns, enum members from the `$defs` table, `@label` as the header, a factory row as the example), useful with no import path built at all, and unable to drift from the validator because one function produces both. The frontend is a five-state screen — choose → map → preview → commit → report — composed from `FileUpload`/`Table` plus `toFieldErrors`'s existing per-field protocol with a row index in front of it, so it belongs to 1.1's generator rather than the kit. **Export is the `only` half**: an export is a read that leaves the building, so `@guarded` columns are absent and `@@allow` applies — where a handler-based framework writes it against the table and quietly ships the columns its own UI hides | M | ●●●○ | edge | D A U | idea | `bulk-data.md` |
| 2.15 | **Cursor pagination** — `ctx.directives` is `{limit, offset, orderBy, select}` and *cursor* occurs nowhere in Junction's bridge or core, so offset is the only paging there is **above the Data boundary — corrected 2026-08-15, because below it there is more than this row assumed**: `findManyCursor` ships in litestone's client, so what is missing is the directive, the envelope and the browser store, not the SQL, which makes the row cheaper than it reads and moves the design question to where the cursor is *carried*. It is correct for a static table and silently wrong for a moving one: rows shift between page 1 and page 2, so one item is shown twice and another is never shown at all — no error, just a list quietly missing things — and `OFFSET 40000` counts forty thousand rows in order to discard them. **It sits worst beside the framework's best feature**: a `channel:` subscription pushing inserts into a store that pages by position has no coherent answer to *what is page 3 now*. Derivable rather than a feature request — `$checkOrderBy` is already the one definition of what may be sorted and why, and its `reason` already separates *no such field* from *`@computed`, so SQLite can neither sort nor paginate by it*, which is exactly the distinction a cursor must make; the schema states the unique tiebreaker. `offset` stays, because a numbered page is a legitimate UI | M | ●●●○ | edge | A U | idea | `client-data-lifecycle.md` hole 4 |
| 2.16 | **Batch the writes the framework itself makes** — measured 2026-08-13, and the numbers are not close: on a file database, 5,000 rows cost 84.7 µs/op through a `create()` loop, 17.7 inside `$transaction()`, **3.3 through `createMany()` — 26×**. The loop pays one WAL commit per row and `:memory:` benchmarks hide it. Nothing needs building; both APIs ship and work. The gap is adoption — `Seeder`/`Factory`/`loadFixture()` loop, and whether Junction's bulk `{data, errors}` path reaches `createMany()` is unverified. Rides with it: `@default(now())` costs +1.9 µs/op because it formats ISO-8601 **per row**, identical to the millisecond across a batch. The same file closes several leads for good — gates +0.5 µs, policies +0.7, validators +0.0, so **there is no speed argument for weakening access control**; reads are already 1.13× raw SQLite; and litestone's live memory is under 10 MB, with `bun --smol` worth more (−56 MB) than any code change | S | ●●●○ | parity | D | idea | `speed-and-footprint.md` |
| 2.17 | **Push and SMS delivery — one is a driver, the other is not** — notifications is genuinely channel-agnostic (`via(user)` → channel list, `toChannel()` per channel, an unimplemented channel throws at send time rather than dropping the message, and the README adds `slack` from outside the package), so neither item is blocked on a mechanism and they should still not be scheduled together. **SMS is a driver**: a Conduit target, a `toSms()`, a length rule — an afternoon. **Push is a design**: VAPID keys that belong beside `encryptionKey`, a service worker Sierra must register, pruning on the `410 Gone` every hand-rolled implementation ignores, and above all **a subscription that is a row** — which is the whole argument for building it here, since it then inherits `@@gate` (a writable handle to someone's device is one of the more sensitive rows an app holds), `@encrypted` keys and invariant 7's redaction, where every hand-rolled version is a plain table with none of it. Boundary to settle first: a push body is a read that leaves the building **via a vendor**, so `@guarded` columns must not be in it — 2.14's export argument one hop further out | M | ●●●○ | stakes · push is edge | D A U | idea | `ecosystem-gaps.md` 16 |
| 2.9 | **Rate limiting** — **two implementations already exist** and neither is on by default: `rateLimit()` middleware (`transport/middleware.ts:206`) and `rateLimitHook` (`core/hooks.ts`), both tested, which is itself an instance of the middleware-vs-hooks split. What is genuinely absent: a default, and any clamp on `ctx.directives.limit`. Urgent once 4.2 exists — an agent calls `find` in a loop by default | S | ●●○○ | stakes | A | partial — see `ISSUES.md` `FJS-017` | `ecosystem-gaps.md` 11 |

---

## Wave 3 — the ecosystem mechanism

How other people fill the gaps instead of this project building all of them.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.1 | ~~**Bare-specifier `.lite` imports**~~ — **shipped, and this row was wrong until 2026-08-15.** `resolveImportSpecifier()` in `parser.js` takes a relative path, an absolute path **or a package**, resolved through node so the package's own `exports` decides what is importable and nothing guesses at a path inside one; the failure message names both causes always, because node distinguishes *not exported* from *not installed* and bun collapses both. `import "@frontierjs/auth/db/auth.lite" into main` works, and the auth hand-copy it was meant to kill is already dead — auth ships the fragments and `fli auth:install` reads those bytes (`FJS-265`). **Eighth stale row this file has produced by the same mechanism**, and it was the one gating all of wave 3 | S | ●●●○ | **only** | D | ~~`shipped`~~ | `slices.md` |
| 3.2 | **The slice installer** — read the directory layout, resolve parts, apply the consumer edits, order by `after` | M | ●●●● | **only** | D A U T | idea | `slices.md` |
| 3.3 | **Suite realm (`createTestEnv`)** — one seeded test environment, gate levels as a first-class axis. **Shipped, both realms.** Data half in `@frontierjs/litestone/testing` (template-clone db per test — 476ms → 13ms; `migrations:`; `actingAs(user)` and `atLevel(n)` deliberately separate; `setup`/`phases` for AAA); API half in the new `@frontierjs/testing`, above Junction — `api:`, `as(user).service(name)`, `announced()`. `listen: true` binds a real port, and `verifyTransportParity()` grades HTTP against WS over a real socket — two transports, no restatement. Port claiming is answered by asking for port 0 and reading it back, which cannot collide at all; rate-limit awareness is what is left | M | ●●●○ | parity | T | **shipped** | `testing-realm.md` |
| 3.4 | **Derived suites** — gate, constraint, relation and `@guarded` tests generated per model, that re-derive when the schema changes. Also removes the last hand-maintained part of the slice format. **Phase 1a shipped**: `litestone access` / `fli test:access` writes the committed `db/access.snapshot.md`, `--check` fails a stale one in CI, and `generateGateMatrix` now covers every level rather than the two edges. The runner over it is Phase 1b and wants 3.3 first | S | ●●●● | **only** | D T | part-shipped | `testing-realm.md` |
| 3.4b | **Schema mutation testing** — **shipped** as `schemaMutants()` + `mutationScore()`. 30 mutants on `example`, 232 on `basecamp` — the enumerability claim, measured. It named the holes and closing them was the work: the gate ladder grew from reads to all four operations, `verifyFieldProtection` was written, `@unique` joined the constraint runner. 97% on `example`, one survivor that genuinely cannot be tested. The trap it nearly fell into: an `error` row counted as a kill reads 93% while four mutations go unnoticed | M | ●●●● | **only** | D T | **shipped** | `testing-realm.md` |
| 3.5 | **Sierra contributing Resources from a package** — deferrable while `eject: true` is the default | L | ●●○○ | edge | U | idea | `slices.md` |
| 3.6 | **A slice registry** | L | ●●○○ | parity | — | idea | `ecosystem-gaps.md` |
| 3.7 | **A package ships its own commands** — a command comes from `fli`'s tree or the project's, never from a dependency, so `commands/auth/install.md` hand-copies auth's schema fragments and three packages' docs advertise commands that do not exist. The dependency tree is already the declaration; oclif needs a second install step and this does not. Same mechanism 3.2 wants, and 3.1 kills the same hand-copy from the schema side | S | ●●●○ | edge | — | idea | `command-surface.md` 1 |
| 3.8 | **Teams, memberships and invitations — the slice that should come first** — 2.5 nominates billing as the canonical first slice; billing is the right *commercial* choice and the wrong *structural* one. Teams is **the largest thing this repo has already built by hand**: basecamp's `Workspace` + `WorkspaceMember`, a five-rung role ladder, `applyStanding()` resolving membership onto the principal once per request, a `/hub/` tier above every workspace, and fifteen models carrying the workspace predicate — a slice with the packaging removed, rewritten slightly differently by every B2B app built here. It is the better proof because it contributes all four parts *and* the one thing no slice has had to carry: **an input to the gate.** Only one `GatePlugin({ getLevel })` may be installed, so a slice supplying standing either owns the ladder outright or contributes a **fragment** an app composes — the way `authSchemaFragments(db)` already contributes into the seed rather than replacing it. That is the sharpest unanswered question about the slice format and billing would never have surfaced it. Invitations are the underestimated half and the reason to ship it as a slice rather than a snippet: `pending → accepted \| expired \| revoked` is a state machine, so the slice **demonstrates `@@transitions`** rather than merely using the framework. Design **with** 4.18 (which rows) and 4.5 (which permissions) — this is the noun both are about, and settled apart they grow three vocabularies for one idea | M | ●●●● | edge | D A U T | idea | `slices.md` |

---

## Wave 4 — the differentiators

The reasons to choose FJS rather than not-leave it. Most are cheap *because the
decisions that make them possible are already made.*

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4.1 | ~~**State machines (`@@transitions`)**~~ — **shipped 2026-08-04.** Declared in the seed, enforced at the Data boundary (`litestone/src/core/parser.js`, `client.js`, `jsonschema.js`), carried to the client as `x-transitions` (`sierra/src/junction/field-rules.js`, tested), and driven from `example/`'s order screen. Remainder: the **full DSL** (litestone backlog 5) — `transitionMap` is the partial form — plus two notes taken from FSL prior art (2026-08-17): a pending-event queue that replays on a state change, and the one declared surface here with no committed snapshot | M | ●●●● | **only** | D A U | ~~`shipped`~~ | `state-machines.md` |
| 4.2 | **Agent surface (`herald`)** — MCP derived from the seed, with the gate as the permission model and tool visibility computed per session level. Answers the industry's actual unsolved problem, which is scoping | M | ●●●● | **only** | A | idea | `agent-surface.md` |
| 4.2b | **Every `fli` command answers a machine** — `--json` as a global contract rather than one command's courtesy, a JSON error envelope on the same switch, and exit codes that separate *bad flag* from *deploy failed*. This is 4.2's CLI half: 197 commands each carrying a description, typed flags and examples already **is** a tool catalogue, and `run(context)` already returns the value nothing reads | S | ●●●○ | edge | — | idea | `command-surface.md` 2 |
| 4.23 | ~~**`fli tinker` — a console that boots at a gate level**~~ — **shipped 2026-08-15, and this row was wrong in three measurable ways.** *There is no REPL anywhere* — `litestone repl` shipped and worked. *There is no `bun repl`* — there is, on 1.3.11. And the `only` half, booting as a principal, **was already built in Studio**: `POST /api/repl` evaluated arbitrary expressions against `activeDb.$setAuth(pickedUser)` with `sys` bound separately and every statement tapped through `$tapQuery`. What was missing was a terminal, and one thing neither had. **A subprocess REPL cannot say what it is running as**, which is the rule the whole item rests on, so `bun repl` + `.load` + two fixed sleeps became `node:readline` hosted in-process. **`--gate <path[#export]>` is the flag the feature turned out to need**: without it the console grades with `FrontierGateGetLevel` rather than the app's own resolver, and on `example` those differ by a level that straddles `@@gate("0.4.4.5")` — a create refused in the console and permitted in the app. `--as` and `--level` stay separate the way `actingAs` and `atLevel` do. **Remaining, and it is the `M` the record predicted**: services rather than `db` alone (`@frontierjs/testing`'s `as(user).service(name)`, which needs the app booted rather than the schema read), and `asSystem()` attributed to the operator — the same question 4.17 asks, still to be answered once for both | S | ●●●○ | **only** | D A T | ~~`shipped`~~ | `command-surface.md` 6 |
| 4.22 | **Studio shows the access surface, and says when it has drifted** — `deriveAccess()` already returns the whole surface as an object and has exactly ONE formatter, the committed `access.snapshot.md`; `studio.html` (4804 lines) has no access view at all. The snapshot is good at being *reviewed* and bad at being *read* — 37 rows of `"4.4.4.5"` answers *what does this model require* and not the question people have, which runs the other way: **what can a level-4 user do to this schema?** `expectedVerdict()` computes exactly that and has no reader outside the test tier. Second half is the sharper one: **the snapshot is *what is* and cannot tell you it has stopped being true** — three distinct drifts (schema↔database, schema↔snapshot, file↔what Studio parsed at boot), of which the third is new and the other two are answers the studio server already gives. Pairs with 4.3, which asks the same question in a PR rather than a browser. **The rule that keeps it safe**: no *regenerate* button — the committed file stays the review artifact, or the CI gate becomes a formality | S | ●●●○ | parity | D T | **built 2026-08-14** | `studio-access-and-drift.md` |
| 4.3 | ~~**Permission diff in CI**~~ — **shipped 2026-08-15.** `fli test:access --from origin/main`, and an `access` phase in `bun run ci` that prints it per app on every run. **The obvious implementation was wrong and that is the finding**: `classifyPivot` already compared two release surfaces, but it grades *can N-1 and N serve one database*, and on a five-part widening **every finding is an `expand`** while the single change that narrows is its only `contract` — a reviewer handed the deploy severity reads green on exactly what should stop them. So a finding carries both, one walk produces it, and `classifyAccess` is a second grading rather than a second traversal. Building it found that **a field-level `@allow` was absent from the release surface entirely** — the shape guarding `isSystemAdmin`, `role` and `emailVerified` — so `release:check` was blind to it too; both axes gained it. A predicate whose text moved is reported *undecidable*, never guessed. The phase reports and never fails, which is the one deliberate exception to the runner's own rule: a branch that widens access is usually a branch doing its job, and `--strict` is the gate for the branch that deploys | S | ●●●○ | **only** | D T | ~~`shipped`~~ | `compliance-from-the-seed.md` 4 |
| 4.4 | **Static-safety proof** — the build fails rather than publishing gated data as a public HTML file. One comparison between two things already known. **Now carries an id**: `build/prerender.js` was re-read on 2026-08-06 and contains no occurrence of gate, auth or level, so the hole is confirmed shipped behaviour, not a hypothetical | S | ●●●○ | **only** | D U | **defect** — `ISSUES.md` `FJS-081` | `static-safety.md` |
| 4.4c | **Server-only modules — put the boundary in the filename** — verified 2026-08-06: `sierra/src` has no `.server.` convention, no `serverOnly`, no `"use server"`. The boundary is a directory enforced only by Vite's root, so `web/` importing `api/` compiles, bundles and ships. `.server.ts` is worth copying nearly verbatim; the FJS-specific win is that one graph walk answers three questions — illegal import, `FJS-081`'s data leak, and 4.4b's route classification. Deliberately the one guarantee with **no escape hatch** | S | ●●●○ | parity | A U R | idea | `server-only-boundary.md` |
| 4.4a | **Scoped SQL** — raw queries run against a view derived from `@scoped`/`@@allow`/`@guarded`/`@@softDelete`, never the base table. `@guarded` columns are *absent from the view*, so `SELECT *` cannot return them. Unblocks SQL for 4.2 and reporting generally. **Fixes a live hole: `$setAuth(user).sql` is byte-identical to unscoped `sql`** | M | ●●●○ | **only** | D | **defect** | `scoped-sql.md` |
| 4.4b | **Route boundary classification** — derive per route whether it is *prerenderable* / *server-needed* / *pure client* from the models it reads and their gates, instead of hand-writing `render: static`. Same two inputs as 4.4, reported as a table rather than thrown as a violation; no other static framework can derive the column, because permissions live behind a fetch. Feeds 4.9 | S | ●●●○ | **only** | D U R | idea | `static-safety.md` |
| 4.5 | **`warden` — orthogonal permissions** — named roles over the 0–9 ladder. Until this exists, the best feature caps out the moment an app needs two permissions that are not comparable | L | ●●●● | edge | D A | idea | `package-map.md` |
| 4.6 | **Live queries** — query-scoped subscriptions with a client-side matcher derived from the schema. No server registry, unlike Remult. **Now carries its own answer to the per-subscriber policy problem it names**: at publish time the server holds the row, each subscriber's level and the declared requirement, so the fan-out can withhold a row or strip a `@guarded` column *per socket* — a comparison, not a re-run. That half is `only`, and it is what makes `channel:` safe to opt into | M | ●●●○ | edge | A U | **defect** | `live-queries.md` |
| 4.7 | **Compliance (`marshal`)** — `@pii`/`@retain`, data map, DSAR, erasure cascade. The rare area where the buyer is not the developer | L | ●●●○ | **only** | D | idea | `compliance-from-the-seed.md` |
| 4.8 | **Offline-first (`compass`)** — client-side SQLite, mutation queue, local gate evaluation, `@@sync` conflict policy. One engine on both sides is the strongest structural advantage over Prisma and Drizzle | XL | ●●●● | **only** | D U | idea | `offline-first-and-release.md` |
| 4.9 | **`atlas` — the app model as a product** — generated architecture diagrams, permission matrix, drift detection, outbound-surface report. `project:map --json` already *is* an app model and nothing reads it | M | ●●●○ | **only** | — | partial | `operational-edge.md` |
| 4.10 | **Preview environments, and the Audience half** — the branch inference `fli deploy` already does, plus a namespace and a TTL. **Meets its other half at the same routing table**: 4.10 is a *branch* getting an environment, an **Audience** is a *cohort* getting a Release — ship a preview to early-adopters and let them tell you, which needs none of the metric machinery a percentage canary needs. The routing is 2.3d's retention table with the selector changed from *which Release did this client load* to *who is this principal*, so it is nearly free once that exists — and it is `only` rather than `parity`, because routing by principal requires owning auth, which is why platforms offer percentages and headers instead | M | ●●●○ | **only** | R U | idea | `release-transitions.md` · `operational-edge.md` 2 |
| 4.18 | **Row-level tenancy** — `ARCHITECT.md` §5 says *"row-scoped tenancy has no primitive yet"*; `FJS-007` closes the largest access-control piece in the repo with *"Still open beside it: `@@allow` for row-level tenancy"*; and **basecamp declares 37 models of which exactly one expresses its tenancy in the schema**, the other 36 being a where-clause plus `scopeToWorkspace` written by hand. One thing written thirty-seven times is a missing declaration — the same observation that produced `@@gate`. **Decides which applications can be built safely at all**, since B2B SaaS is one forgotten `WHERE` from a cross-tenant leak, and the framework's filtering half makes the failure silent in both directions. The hard part is already solved by hand: a tenant is not a property of a user (`applyStanding` resolves it per request) | L | ●●●● | **only** | D A | idea | `row-level-tenancy.md` |
| 4.21 | **Time and recurrence declared in the seed** — the word `timezone` appears **nowhere in `IDEAS/`** across thirty-one records, `packages/toolbelt/`'s `/datetime` kit is a README and a parked prototype, and the entire repo holds one timezone concept: an optional `timeZone` in Caravan's cron, correct, tested, and connected to nothing. `DateTime` is ISO-8601 TEXT, which records an instant and says nothing about what it meant. So four failures recur in every application: **an instant and a zoned wall-clock time are different values sharing one column** (*the shop opens at 09:00* is not a point on the timeline), **a future event stored as UTC is a bet on politics** (IANA ships rule changes several times a year, so the meeting moves — the correct storage is wall-clock plus zone, resolved late, and almost nobody knows this until it bites), **DST makes 02:30 run zero times in spring and twice in autumn**, and **"today" is a different eight hours per viewer**, which every report and every `@retain` window rests on. Declarable because the distinction is a property of the column, not of the code that reads it; the viewer's-zone case is the same per-request resolution `applyStanding()` already does. Settle **with** 4.15's bitemporality or one will invent a vocabulary the other must live with. Refuse the general RRULE | M | ●●●○ | edge | D A U | idea | `time-and-recurrence.md` |
| 4.19 | **Durable workflows** — the domain map names it (*Orion, planned, absent*) and 63 tracked files sit below the `packages/*` glob unrun (`FJS-D14`). A Caravan job is one unit retried; `@@transitions` is one row in a state machine; **the thing between them has no noun** — a multi-step process that survives a restart, compensates when a later step fails, and has a point past which it can only go forward. Temporal is a company built on this category. **Arriving anyway, unnamed**: 2.3b is a durable workflow engine with exactly one workflow in it, and the saga vocabulary it imported should be ruled once for both rather than defined twice. The FJS position, if taken: steps are Services and state is a Model, so it inherits gates, audit and derived suites — where the alternative is a second runtime with its own security model | XL | ●●●○ | edge | A D | idea | `operational-edge.md` 4 |
| 4.17 | **Support mode — bounded, audited impersonation** — *"a customer says it is broken and nobody can reproduce it"* is the most common day-two task in any app, and the word `impersonation` occurs nowhere in `IDEAS/`. Everywhere else it is hand-rolled as a god-mode switch, because authorization living in handlers cannot express *act as this person and no higher*; here the ceiling is `sessionGateLevel` on the impersonated principal, enforced at the Data boundary like every other request. Attribution is the **operator**, not the subject; invariant 7's redactions still hold, so *see what the user sees* stays distinct from *see everything about the user*; and a session is an episode with a start, an end and a reason — which turns a DSAR into *who looked at my record, when, and why*. Wants a complete audit trail, so it sits behind the same dependency as 4.13 | M | ●●●○ | **only** | D A | idea | `compliance-from-the-seed.md` 6 |
| 4.16 | **Basecamp as the deploy console** — fleet view, trigger a deploy or revert, watch it live. Small, because every part already ships there: the gate ladder decides who may deploy, channels make a triggered deploy announce to a second tab, `/hub/` is the cross-workspace view. Two rules keep it from becoming Forge — **basecamp is a viewer and a trigger, never the source of truth** (the journal lives with the app; if basecamp vanishes `fli` still deploys), and **CLI-first always** (basecamp must be deployable with no basecamp running, or the first bad deploy of the console leaves no hands). Needs shape from 2.3b, not work: machine-readable `fli` output, which is 4.2b arriving where it is first load-bearing | M | ●●●○ | edge | R | idea | `release-transitions.md` |
| 4.11 | **Provisioning from declarations** — FJS's declarations are written by a human and already parsed, so the plan can be *reviewed before it runs*. Must degrade to nothing for the one-binary path | L | ●●○○ | edge | R | idea | `operational-edge.md` 1 |
| 4.12 | **Derived suspense boundaries** — place the boundary at the lowest node whose subtree reads a pending value, instead of hand-wrapping `<mesa:boundary>` and guessing granularity. Mesa already generates per-value `$async` state; React and Solid cannot derive this because their runtimes cannot see which subtree depends on which promise. Do 0.6 first — it is the same narrowing, one level down. **Carries a second half**: `pending` and `failed` are structural and `empty` is still copy-pasted per call site, which is the same problem the element exists to remove — derivable because `kind:'list'` is a discriminator the compiler can test, but a layout decision more than a loading one, so probably derive the condition and leave the placement | M | ●●○○ | edge | U | idea | `derived-suspense.md` |
| 4.15 | **Declared semantics — the categories the seed should know about** — `@version` **shipped 2026-08-06** (optimistic concurrency: `update()` requires the version it read and 409s if it moved; `updateMany`/`upsert` bump but do not require; `asSystem()` skips — 21 tests). Remainder: `Money` (a scalar that is not a float — `example` models money as `Float`), bitemporality (`occurredAt` vs `createdAt`), and a resumable-process noun | M | ●●●● | edge | D | partial | `declared-semantics.md` |
| 4.14 | **The client data lifecycle** — optimism as a transaction (`mutate(fn, { optimistic, rollback })`) over a store keyed by entity id rather than per-`resource()` copy, so five views of one order are five subscribers to one node. The announcement half is already better than the field's — the server says what changed, so you never call `invalidateQueries` — but it is incomplete (`FJS-010`) and nothing models a value being *provisional*. `FJS-011` was the other blocker and is closed: the store removes a row on a filter miss now, which is the same move a rollback makes. Also carries `FJS-083` (search params are not reactive and not on `page`, though `ctx.directives` is already the shape they want) and `FJS-084` (the browser client cannot ask for a relation, though the wire, the bridge and Litestone's batched includes all support it) | M | ●●●○ | edge | A U | idea | `client-data-lifecycle.md` |
| 4.13 | **Named checkpoints + time travel** — `fli db:checkpoint` / `db:log` / `db:restore` over the audit trail. Snapshot is the truth, the log is the narrative; replay never reconstructs a redacted value, which keeps Invariant 7. Cheap because history is *declared* (`@@log`) and the Data realm is a file. Blocked on 0.7 — one uninstrumented bulk write ends the invertible history. Unblocks 1.4, 3.3 and half of 4.7 | M | ●●●○ | **only** | D T R | idea | `time-travel.md` |
| 4.20 | **HTML over the wire** — the server pushes a *rendered fragment* on a channel and the client places it, for the cases where a client-side Resource is overkill: a toast, a badge, a row appended, a feed. Verified 2026-08-12 by running it: the transport needs **no change** (`app.channel(n).send()` → the `event` frame the browser client already re-emits), and both compilers gave the same source the same scope id, so **a server-rendered fragment matches the CSS the page already loaded** — Invariant 12 paying for the expensive half. Three small gaps: `target: 'fragment'` is the email shape and flattens `var(--fg)` to `style="color:"`, no compile cache (6.4ms/render, two fs touches), no client shim. **Wants one ruling first** — a rendered string cannot be filtered per subscriber the way 4.6 filters a row, so a fragment channel is *uniform* or *per-socket*, fail closed. Scoped deliberately: **server-held components (LiveView proper) are refused**, argued in the source | S | ●●○○ | parity | A U | idea | `html-over-the-wire.md` |

---

## Wave 5 — coherence

Cheap, mostly rulings rather than code, and each removes a place where the framework
teaches two things at once. **Interleave these; do not schedule them as a block.**

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.1 | **Rule the Context shape** — adopt Junction's split as the base; conforming subsets elsewhere. Needs a `DECISIONS.md` entry more than it needs code | S | ●●●○ | — | — | idea | `one-mental-model.md` 3 |
| 5.2 | **One frontmatter parser** — three call sites, one zero-dep leaf. The concept users touch most often | S | ●●○○ | — | — | idea | `one-mental-model.md` 2 |
| 5.2b | **A generated `fli` reference, and doc drift as a test failure** — the CLI's own file says several documented commands do not do what the prose says and three packages advertise commands that do not exist. `fli docs` renders the reference from the registry (the input is markdown a human already wrote), and a test asserts every `fli <command>` named in any markdown resolves — which makes the class impossible rather than fixed once | S | ●●●○ | — | — | idea | `command-surface.md` 3 |
| 5.2c | **Flag relations in frontmatter** — `exclusive`, `dependsOn`, `exactlyOne`, `multiple`, `env`, `allowNo`, validated once by the runtime. `deploy:doctor` declares `--production` and `--stage`, mutually exclusive, and silently picks one. Every one of these is a fact the command file already states in prose above the fence, where nothing reads it | S | ●●○○ | — | — | idea | `command-surface.md` 4 |
| 5.2d | **`runCommand()` — a command a test can run** — invariant 15's parse sweep compiles with NO module script, so a command using a namespace helper parses whether or not the helper exists; the stated remedy is *run the command*, which nothing automated does. `--dry` already makes most of them safe to run | S | ●●○○ | — | T | idea | `command-surface.md` 5 |
| 5.3 | **Litestone Plugin gets a `name`; rename the concept** — the missing identity blocks introspection, ordering and `/metrics` | S | ●●○○ | — | D | idea | `one-mental-model.md` 1 |
| 5.4 | **Name Mesa's target set publicly** — documentation and an API over code that already works. Highest vision-value per unit of effort | S | ●●●○ | edge | U | partial | `one-mental-model.md` 5 |
| 5.5 | **One target axis in Sierra; jetty becomes `extension`** — de-forks the hand-copies and makes desktop/mobile cheap later | M | ●●●○ | edge | U | idea | `one-mental-model.md` 6 |
| 5.6 | **Type-check the derivation end to end** — nothing verifies that Junction's service types agree with the generated Model declarations. The quiet threat to the whole thesis | M | ●●●● | — | — | partial | `framework-shape.md` 5 |
| 5.7 | **Upgrade codemods (`shift`)** — a reviewable diff, never a silent rewrite. The `Integer→Int` rename is the reference test case; a tool that cannot do it automatically is not worth shipping | L | ●●●○ | **only** | — | idea | `ecosystem-gaps.md` 10 |
| 5.8 | **Documentation as a product** — excellent docs for maintainers, essentially none for users. Laravel's moat is not features | XL | ●●●● | stakes | — | partial | `ecosystem-gaps.md` |
| 5.10 | **Page composition — the tier `@frontierjs/css` never built** — every term in the Frame and Page tiers is app chrome (Topbar, Sidebar, Shell, Screen, Pane), so there is no vocabulary for a marketing band. **The prose half shipped** — `.prose` in `src/patterns/prose.css`, opt-in and scoped exactly as the record proposed; the band/section vocabulary is what remains. Found by comparing against an outside design system whose coverage is the mirror image: it is a page compositor, this is a component vocabulary, and the philosophies already agree (a name is a contract, colour is never the API, a skinless base composed into). Four items, ranked in the source; the section/band structure vocabulary is the real gap and the positional-role idea is the one to refuse — `nth-1` is a position with no class to look up, which trades away the both-directions checkability that caught five real bugs | M | ●●○○ | parity | U | idea | `page-composition.md` |
| 5.11 | **Fill `@frontierjs/toolbelt` by divergence, not by DRY** — a survey of the repo's whole pure-function surface found only ~250–400 extractable lines, and that is the wrong measure: **four of the duplicated helpers have already drifted apart**, three of them into defects. `glow` is forked and mesa runs the pre-fix copy (`FJS-191`); four inflection rule sets resolve one invariant and the weakest sits behind `createResource` (`FJS-192`); `slugify` has four spellings of which the `@slug` transform's is the authority and no client shares it; `escapeHTML` has two, one missing `'`. The rule that falls out — *extract when two copies drifting would be a defect, not when two copies exist* — leaves `sleep` alone at five copies and moves `slugify` at two, and it refuses `deepMerge`, which is genuinely three functions (sierra concatenates arrays, the other two replace). **Unblocked 2026-08-15** — `FJS-D26` admits `@frontierjs/toolbelt` (which absorbed `utils`) as substrate below the graph, so mesa, litestone and sierra may import it; the work is now work rather than a ruling | S | ●●●○ | — | — | **defect** | `shared-pure-functions.md` |
| 5.13 | ~~**What a scaffolded app is given**~~ — **shipped 2026-08-15**, `FJS-D33`. Moved out of a 1400-line command into `packages/cli/core/app-config.js`, one module with the reasoning attached and a test per default. Answers: **linter** yes / **formatter** no (`FJS-D32`); **tsconfig** and **biome.json** are one line of `extends` over `@frontierjs/config`, so the rule that was worth fixing is the one that shipped — *the config is a dependency, not a copy*; **`.editorconfig`** is the single exception, mechanical (EditorConfig has no extends) and byte-pinned by a test on both sides; **a `lint` script** yes, `--error-on-warnings`, beside `typecheck` and a `check` that runs all three; **`fli doctor`** is about fli's own setup, so the app-facing one is **`fli check`** and it runs FIRST, being the half a linter cannot reach; **a CI workflow** yes, calling `bun run check` and nothing else, `--no-ci` to skip. `@frontierjs/cli` is a devDependency rather than a global on PATH. Proved by `scripts/scaffold-build.mjs`, which now runs the app's own gate against a real tarball install | S | ●●●○ | stakes | — | **shipped** | `packages/config/` · `DECISIONS.md` `FJS-D33` |
| 5.14 | **Four test runners and ten shapes of `test` script** — probed: `bun test`, `vitest run`, plain `node` with a hand-listed file sequence, and `npm` for the extension. `CLAUDE.md` mitigates it with a table and a warning that the wrong runner *"produces failures that belong to nothing"* — ~35 phantom failures in mesa. Three of the four have real reasons; **the one that does not is `bun test` versus a hand-listed `node a.js && node b.js`**, which is where a new test file gets forgotten silently. A ruling, before the count grows | S | ●●○○ | — | T | idea | `tooling-decisions.md` 2 |
| 5.15 | **Dependency posture is a CI phase or a bot, and nothing has chosen** — `fli npm:audit` and `npm:outdated` already exist as commands; no renovate, no dependabot, and nothing runs either on any schedule. The tooling half under 2.12, which argues the harder question (*am I affected*, compared against `project:map --json`). The decision is **which side of the project's own line this falls on**: every other check is a phase in `scripts/ci.mjs` specifically so CI runs identically on a laptop, and an external bot is the first exception | S | ●●○○ | stakes | — | idea | `tooling-decisions.md` 5 |
| 5.12 | **The small sharp edges** — three that are too small for a record and too common to lose, each a day or two, each currently written from scratch in every app, each with a known correct answer people only find after shipping the wrong one. **User-defined ordering**: drag-to-reorder with `position: Int` rewrites every row after the one that moved; the answer is a fractional rank, and `$checkOrderBy` should know the column is a rank rather than a number. **Conditional form fields**: *show VAT only for EU, require it when shown* is imperative code in every page, and it is now the one part of a generated `<Form>` that is not generated — 1.1a cannot generate a field list without an answer for fields that are sometimes not in it. **`@@softDelete` × `@unique`**: a soft-deleted row still occupies its unique index, so re-registering a deleted user's email fails with a constraint violation naming nothing they did; both features ship, the interaction is undefined, and it should be one ruling rather than a trap each app finds | S | ●●○○ | — | D U | idea | `ecosystem-gaps.md` 15 |
| 5.9 | **Cascading fields (`@@cascade`)** — declare "when this field changes here, carry it to related rows"; `once` for one-way stamps, `mirror` for flags. `@@softDelete(cascade)` is already this feature with the column frozen to `deletedAt`; generalising it makes one mechanism where there are two, and fixes the shipped cascade's missing transaction and missing child audit entries on the way | S | ●●○○ | edge | D | idea | `cascading-fields.md` |
| 5.16 | **Mesa golden compile corpus — scope IDs, not output** — Invariant 12 says compiler output is reproducible because scope ids are content-addressed, which is what makes CSS dedupe work across the two compilers a static build runs, and **nothing asserts it**; Invariant 15's tests parse output rather than compare it, so a change to the hashing input leaves every suite green and silently doubles a prerendered page's CSS. Ids-only is the form that survives the noise objection | S | ●●○○ | edge | U · T | idea | `committed-artifacts.md` A |
| 5.17 | **The UI kit contract as a committed artifact** — three rules live in prose and all three are invisible when broken: a kit component may not style a class `@frontierjs/css` owns, every component forwards its caller's attributes, and where the spread lands is not uniform (a form control puts it on the CONTROL, for `<label for>` and `aria-describedby`). One row per component, generated by compiling it. **Wait for the kit to settle** — 29 of 64 verified in a browser — but the tokens column is worth pulling out now if `FJS-128` is being worked | M | ●●○○ | parity | U | idea | `committed-artifacts.md` B |
| 5.18 | **Desktop and mobile — say which, and say it in `DECISIONS.md`** — the words appear in this repository in exactly two places: the trailing *"and later `desktop`, `mobile`"* of `one-mental-model.md` §6 and the half-clause of 5.5 that summarises it. No record, no reading, **no stated refusal** — which is the worst of the three available states, because nobody can tell whether it is planned, deferred or declined. They are also not one item. **Desktop is nearly free**: it is the `spa` build inside a shell process, and the framework's shape helps — the database is a file, the API is a process, and *single binary* is already a named artifact kind, so a desktop app is that artifact with a window in front of it and belongs as much to Release as to Sierra. **Mobile is a different problem wearing the same word**: store review, two signing identities, push credentials (2.17), a webview whose storage the OS may evict, and background execution rules that make 4.8 a prerequisite rather than a companion. Probable answer: `desktop` becomes an entry on the target axis once 5.5 folds jetty in, and **`mobile` is refused with that trigger named**. The item is the ruling, not the build | S | ●●○○ | edge | U R | idea | `one-mental-model.md` 6 |
| 5.19 | **Dev URLs — `example.localhost`, not `localhost:8010`** — worth a row only because **the derivation already exists**: `cli/core/ports.js` holds the formula, the category map and the `PROJECTS` registry, so the names are a rendering of the table that is already the source of truth for the numbers, and browsers resolve `*.localhost` to loopback with no `/etc/hosts` entry. Three things it fixes that are not *remembering a number*: `strictPort` exists because vite hops in silence and the second app's drive then tests the first app's app — a name makes that unreachable rather than merely loud; **cookie scope stops being a lie**, since a port is not part of a cookie's origin, so `:8010` and `:8110` share a jar and dev cookie-auth behaves unlike production; and a drive's assertions stop hard-coding the port `CLAUDE.md` also states. Costs: a proxy on 80 needs a privileged bind on a project whose pitch is plain user processes (fall back to `:8080` + a name), and it must stay **strictly additive** — the numbers keep working, or a DX nicety becomes load-bearing, which is a worse trade than the tax it removes. Belongs to the broker, not to vite | S | ●●○○ | parity | — | idea | `tooling-decisions.md` 7 |
| 5.20 | **CSS delivery — measure the inline route before replacing it** — a component's scoped rules are inlined into its own module as `$runtime.addStyles(hash, …)`, by both Vite plugins, and the hash is a **content** hash, which is what lets Sierra's prerenderer write the ids into the HTML and a hydrating client skip what is already painted (Invariant 12). Mesa's plugin also carried a virtual CSS module handing the rules to Vite instead; the condition guarding it could never be true, so it had never run in any build, and `FJS-291` deleted it. The idea behind it is sound — a real `.css` file in a build, styles before the script runs, and **style-only HMR that does not remount the component and reset its state** — but it is one file compiled by two plugins, so it cannot be true in one build and false in the other, and every item on that list is currently a plausible claim with no number attached. The order is measure, then rule for both plugins, then rewrite the prerender dedupe in the same change. **Inline in dev, extract in build** is the intermediate worth pricing first | S | ●●○○ | — | U | idea | `css-delivery.md` |
| 5.21 | **The terminal has no tone vocabulary and no owner for a line** — two halves, both cheap. `cli/core/color.js` is chalk-compatible by design (correct: it dropped zx off the read-only paths, ~85ms of a ~200ms invocation) and inherited chalk's *vocabulary* with it, so call sites say `red`, nothing retimes to a light terminal, and the CLI's one accent is a hex literal inside a markdown renderer. **Invariant 13 already ruled this for the browser** — a tone, never a colour — and the argument does not stop at the DOM. The second half is not about colour: booting basecamp prints **four prefix vocabularies in nine lines** from four packages, because *an event becomes a line* has no owner and each guessed; they are also two formats, not one, since command output is transient and wants a verb column while a runtime log is a stream and wants a timestamp, a scope and `--json`. Shapes borrowed rather than invented: Cargo's verb column, rustc's caret diagnostic for `fli check`'s eleven silent-when-broken rules, `gh`'s `--json` on everything that reports. Ruled 2026-08-17 (`FJS-D37`); the table belongs in `@frontierjs/toolbelt/tty` with a backend seam, so one vocabulary reaches ANSI, terminal cells and the eleven `theme-*` blocks css already ships | S | ●●●○ | edge | — | **ruled** | `terminal-surface.md` · `DECISIONS.md` `FJS-D37` |
| 5.22 | **A TUI target — and the measurement that repriced it** — `runtime.js`'s reactive core (lines 1–760) holds **2** DOM references and the remaining 4,200 hold **99**, and the compiler emits a template as an HTML *string* parsed by `htmlToFragment()` then walked by `refer(root, path)`: dom-expressions, unportable for the same reason it is fast. So Mesa has **no renderer abstraction**, and a terminal target is a second compiler backend emitting a cell tree rather than a new renderer — every Mesa target that exists produces markup, SSR and `email-kit`'s `target: 'email'` included, so nothing in the tree says a non-markup target is cheap. `FJS-D37` ruled the engine is **bought** (cell diffing, yoga layout, kitty-protocol input and grapheme width are not where FJS differentiates) and deferred the build past alpha on `FJS-D14`'s reasoning. What is owed now is the ruling alone: `FJS-D38`, reuse `.mesa` or a separate authoring model — the second answer makes the framework's reply to *how do I build a terminal app* be *use React*. Same family as 5.18 and inherits 5.5's target axis | L | ●●○○ | edge | U | idea — `ISSUES.md` `FJS-D38` | `terminal-surface.md` |

---

## Reading the table three ways

**Cheapest high payoff — do these first.** All `S`, all ●●●+:
0.1 CI · 2.1 the storage reconciliation ·
~~1.2 `create-frontier`~~ · ~~5.13 what a scaffolded app is given~~ ·
~~2.3a pivot classifier~~ · ~~4.3 permission diff~~ · ~~3.1 bare-specifier `.lite`
imports~~ (shipped 2026-08-15; 3.1 had shipped earlier and the row was stale) ·
2.12 security posture ·
4.4b route classification · 1.3 factories · 5.1 context ruling ·
4.23 `fli tinker`.

**All three of the comparison items are now built — 2.3a, 4.3 and 4.4 — and each
took about a day, which was the claim.** They are the same trick: a comparison
between two things the seed already states, which is unavailable to a framework
whose authorization lives in handlers. What 4.3 added to the reading is that the
comparison and the *grading* are separable — one walk of two schema versions
answers the deploy question and the reviewer's question, and those two answers
are close to inverted. Expect the next item of this shape to be a grading, not a
traversal. **0.5 (`fli doctor`) is `M` rather than `S` but belongs in this
group** — its first four rules are an afternoon, and it is the only item that pays
back on every app built on the framework rather than once.

**Biggest bets — expensive, and each defines a category:**
1.1 schema → UI · 2.3 Release · 4.8 offline-first · 5.8 documentation.

**Gates the most downstream work:**
1.1 (schema→UI) blocks 1.4, 3.5 and the useful half of 3.2 ·
3.1 (`.lite` imports) blocks all of wave 3 ·
2.9 (rate limiting) becomes urgent the moment 4.2 ships — the mechanism exists,
the default does not ·
4.5 (`warden`) blocks the ceiling of 4.2 and 4.7 ·
2.3a (pivot classifier) is the input every other Release row consumes — 2.3b's
guarantee is stated against it, 2.3d's retention window is measured in it, and
4.10's Audience half is illegal across it. **Shipped, so those three are no longer
blocked on it** ·
2.3b decides recorded state (Release fields, journal rows, binding generations,
audience keys) for everything after it, which is why its shape matters more than
its scope: a verb can be added later, a recorded-state format cannot ·
2.12 (advisories) must precede 3.6 (a slice registry) — a registry with no way to
say *stop using this* is a supply chain, not an ecosystem ·
4.13's completed audit trail gates 4.17, for the same reason it gates replay: a
support episode a bulk write can escape is not an episode ·
4.18 (tenancy) should be designed **with** 4.4a (scoped SQL) and **against** 4.5
(`warden`) — raw SQL is the bypass that makes a tenanted app leak, and orthogonal
roles plus a tenant scope are two non-ordinal axes arriving at one boundary, which
is how a system ends up with two answers to *may this caller see this row*. It also
shares a question with 4.10: an Audience is a declared set of principals and a
tenant is a declared set of rows, so settling them apart grows two vocabularies for
*which subset* — and **3.8 is the noun all three are about**, which is the argument
for designing it with them rather than after them ·
3.8 also carries the slice format's own unanswered question — whether a slice may
contribute an input to `getLevel`, given that only one `GatePlugin` may be installed —
so it gates the useful half of 3.2 in a way 2.5 does not ·
4.19 (workflows) is **already being built** as 2.3b — a journal of idempotent steps,
compensable before a pivot, forward-only after, with exactly one workflow in it. The
decision is whether that stays deploy-only, made once, rather than discovered when
the second copy does not match. **2.3e is that second copy arriving**, which moves
the decision from hypothetical to scheduled ·
2.3a's classifier is what makes 2.3e's fourth answer derivable, and 2.3e is what
makes 2.3b's *"refused and offered as a split"* a plan rather than advice — the
three are one sequence, not three rows ·
4.21 (time) should be settled **with** 4.15's bitemporality, since `occurredAt`
versus `createdAt` and instant versus zoned are the same observation from two
directions, and it gates the honest version of 4.7's `@retain` — a legal retention
period resting on an undefined day boundary is an artefact, not a control ·
2.15 (cursor pagination) and 4.6 (live queries) are one question: paging by position
and pushing rows into the same store have no combined meaning, so shipping the
second without the first is shipping a list that goes wrong only under load ·
~~0.7 blocks 4.13~~ — **cleared 2026-08-05**: bulk writes now log, so a bulk op no
longer ends the trail. What 4.13 still owes is *contents*, since a bulk entry
names rows without snapshotting them ·
~~0.6 is the first move of 4.12~~ — **done 2026-08-05**; 4.12 is now the whole
remaining feature, not a narrowing plus a feature.

**The tooling cluster.** Asked for as a category and recorded as a cluster instead,
because the waves sequence by *urgency* and a tooling wave would have to take rows out
of five of them — leaving the file with two organising principles and no way to read
either. The members: **1.7** lint/format · **5.13** what a scaffolded app is given ·
**5.14** test runners · **5.15** dependency posture · **0.5** `fli doctor` · **0.1** CI
· **1.2** `create-frontier` · **1.6** the app manifest · **4.2b** every command answers
a machine · **5.2b–5.2d** the `fli` surface · **5.7** `shift` · **5.19** dev URLs ·
**4.23** `fli tinker`.

Two things were true of the cluster that were not true of its members, and **2026-08-15
settled both**. **It is where the framework's opinion is read from** — almost nobody
reads this repo, and everybody reads what `create-frontier` puts in their
`package.json`, which made 5.13 the highest-stakes `S` on the list; 1.2 and 5.13
shipped together, since the second is only decidable once the first exists to carry it.
And **the live boundary dispute is ruled** (`FJS-D32`): a linter owns generic
JavaScript, `fli check` owns everything derived from the seed, neither reimplements the
other. It is not the maturity gap it looked like — no JavaScript tool reads `.mesa` or
`.lite`, and doctor-class questions are cross-file anyway. What is left of 1.7 is this
repo extending its own config, which is a counted cleanup (`FJS-266`).
`IDEAS/tooling-decisions.md` is still the cluster's owner and still holds 5.14, 5.15
and 0.5 as *unmade decisions* rather than a plan.

**The agent-surface cluster.** 4.2 reads as a standalone `M` and is not one: it can
stream (2.8 turned out to be a ruling rather than a build), but without a default
rate limit (2.9) it is a self-inflicted denial of service, and without 4.5 its
permission model inherits the linear ladder's ceiling. Budget the cluster, not the
item.

**Where the balance currently sits:** the `only` column is well populated and mostly
cheap; the `stakes` column is short but every entry is disqualifying. A roadmap
weighted entirely toward `only` produces a framework nobody can deploy; one weighted
entirely toward `stakes` produces a worse Laravel. **The stated strategy — *it will
not out-feature Laravel, it can out-cohere it* — means clearing `stakes` to the
minimum bar and spending everything else on `only`.**

---

## Not on this list

- Anything already shipped. `CLAUDE.md` is the authority on what exists; this file is
  the authority on nothing.
- Live hazards that are not argued in an ideas file — those live in `CLAUDE.md`
  § Live hazards and the `ISSUES.md` register. Wave 0 here is the subset that *is*
  argued in an ideas file, which is an artefact of where things were written down
  rather than a meaningful distinction.
- Three shapes of committed artifact that were **considered and declined**, with
  their reasons: a deployment artifact (the `deploy` CI phase builds the image and
  asks it for a health answer, which is strictly stronger than diffing the text
  that produced it), a registry of expected snapshots (reintroduces the cost the
  `generated by:` header removes), and versions or sizes inside
  `exports.snapshot.md` (correct, and unread). See `committed-artifacts.md`
  § Rejected — a declined idea with no record comes back without its reason.
- `packages/orion/` — a `README.md` and nothing else, referenced by no other
  document. It is either a reservation that should be named or a thing to
  remove; ruled 2026-08-15 — both are V2, deferred until core leaves alpha (`FJS-D14`).

## See also

- `IDEAS/package-map.md` — the same material organised by package, with names
- `PROS_AND_CONS.md` — the design-level assessment several wave-4 and wave-5 items
  come out of
- `ISSUES.md` — the open register; **every wave-0 defect is counted there**, and a
  new one goes there first. `HANDOFF.md` is session narrative, not a ledger
- `IDEAS/coherence-review.md` — the twelve-package audit's eight cross-package
  findings, verbatim from 2026-07-31. The argument behind `FJS-D06`, and where the
  `Slice` axis and the Hook/Guard/Observer/Delegate split are actually made. Was
  `drift-report.md` at the repo root
- `DECISIONS.md` — where 5.1, 5.3, and the `Slice` vocabulary ruling land
- `website/README.md` — the publication gate, which this file will eventually feed



## Manual List


- We need to clean up the cli output.. (we need to standardize)

```
[env warn]   AUTH_SECRET looks like a placeholder — replace before going to production
02:20:52.191 INFO  [basecamp:deploy-engine] deployment engine registered
02:20:52.191 INFO  [basecamp:job-engine] job engine registered
02:20:52.191 INFO  [basecamp:fleet-engine] fleet engine registered
02:20:52.231 INFO  🚀 app v1.0.0 {"url":"http://0.0.0.0:8120","routes":27,"services":22,"health":"http://0.0.0.0:8120/health","mode":"production"}
02:20:52.232 INFO  🗄  litestone {"models":38,"enums":21,"gated":"37/38","databases":"main → ./db/basecamp.db (sqlite), audit → ./db/audit (logger)"}
  [Sierra] schema: 37 model(s) from /home/j/code/FRONTIER/frontierjs/packages/basecamp/db/schema.lite — User, Credential, Session, Verification, Account, Workspace, WorkspaceMember, Secret, ApiKey, Server, ServerEvent, Volume, Network, ServerNetwork, Project, Environment, App, Domain, AppServer, AppNetwork, Deployment, DeploymentStep, Job, JobRun, Recipe, RecipeRun, DiskUsage, CleanupRun, FeatureFlag, FlagOverride, NotificationChannel, AlertRule, AlertRuleChannel, AlertEvent, Dashboard, DashboardWidget, AuditEvent
````