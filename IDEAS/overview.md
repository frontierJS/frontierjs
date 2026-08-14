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
0.1 = `FJS-009` · 0.2 = `FJS-011` · 0.3 = `FJS-071` (**contested**) ·
0.4 = `FJS-065` · 0.6 = `FJS-073` (**closed**) · 0.7 = `FJS-074` (**closed**) ·
0.8 = `FJS-082` ·
4.4a = `FJS-005` · 4.6 = `FJS-011`. They stay listed here
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
| 1.1 | **Schema → UI (`foundry`)** — `<AutoForm>`, `<AutoTable>`, derived admin. Every input is already in the browser bundle and nothing consumes it | L | ●●●● | **only** | D U | partial | `framework-shape.md` 1 |
| 1.1a | **Generate the form, not just its parts** — the state machine and per-control resolution **shipped 2026-08-06** (`<Form resource={…}>`, nine controls reading `$context.form`), which leaves exactly one restatement of the schema in a form: the *field list*. `example`'s `orders/create.mesa` is ~150 lines and half of them are the same `Object.entries(fields)` loop every app writes. Needs a control table with one home, and 1.5 ruled first | M | ●●●○ | **only** | D U | idea | `forms-from-the-seed.md` |
| 1.2 | **`create-frontier`** — `npm create frontier@latest`. There is no path today from the website to a running app that does not involve cloning a monorepo | S | ●●●● | stakes | — | idea | `ecosystem-gaps.md` |
| 1.3 | **Model factories** — derived from field types and rules; Junction's test kit is good and under-used because making data is manual | S | ●●●○ | parity | D T | idea | `ecosystem-gaps.md` 5 |
| 1.4 | **`quarry` — demo data + a persona per gate level** — `fli demo` boots an app you can click through as STRANGER / USER / ADMIN. How the framework gets *shown*, and what `foundry` needs to render | M | ●●●○ | edge | D T | idea | `package-map.md` |
| 1.5 | **i18n (`lexicon`)** — must be *decided* before 1.1 ships, because a generated form generates labels. Every string written before it exists is a string to find again | M | ●●○○ | stakes | U | idea | `ecosystem-gaps.md` 4 |
| 1.7 | **Lint and format — pick one, and draw the boundary** — verified 2026-08-12: **no linter, no formatter, no `.editorconfig` anywhere**, and no `lint` script in any of the twenty packages; the house style holds by discipline and is holding. The decision is not the tool, it is a **house rule that blocks the tool**: `CLAUDE.md` requires *aligned columns*, and Prettier, Biome and dprint all collapse a run of spaces — so the first format run rewrites `example/api/app.ts` and the root `package.json`, both of which the docs cite. Settle alignment first; the tool follows. Recommendation is **Biome and drop alignment** (one binary, one config, both jobs, same answer in-repo and shipped), or **Biome as linter-only** if alignment is kept; refuse per-block `biome-ignore format:` comments, which buy alignment with the exact noise the comment rule forbids. **The lasting half is a sentence, not a config**: a linter owns generic JavaScript, `fli doctor` (0.5) owns everything derived from the seed, and neither reimplements the other — without it, four hazard-catalogue checks get written as lint rules and two registries disagree. `.mesa`/`.lite` are out of reach for every tool and should stay doctor's | S | ●●○○ | stakes | — | idea | `tooling-decisions.md` 1 |
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
| 2.3a | **Pivot classifier — `fli release:check`** — read a schema diff, answer *expand / contract / unknown* (unknown counts as contract), write a committed snapshot, fail a stale one in CI. **No deploy machinery at all**, and useful to an app deployed entirely by hand. Structurally the same mechanism as 3.4's `db/access.snapshot.md` asking a different question, so it slots beside it in `scripts/ci.mjs`. The one thing in the whole Release realm no competitor can build, because it needs the seed | S | ●●●● | **only** | D R | idea | `release-transitions.md` |
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
| 2.15 | **Cursor pagination** — `ctx.directives` is `{limit, offset, orderBy, select}` and *cursor* occurs nowhere in Junction's bridge or core, so offset is the only paging there is. It is correct for a static table and silently wrong for a moving one: rows shift between page 1 and page 2, so one item is shown twice and another is never shown at all — no error, just a list quietly missing things — and `OFFSET 40000` counts forty thousand rows in order to discard them. **It sits worst beside the framework's best feature**: a `channel:` subscription pushing inserts into a store that pages by position has no coherent answer to *what is page 3 now*. Derivable rather than a feature request — `$checkOrderBy` is already the one definition of what may be sorted and why, and its `reason` already separates *no such field* from *`@computed`, so SQLite can neither sort nor paginate by it*, which is exactly the distinction a cursor must make; the schema states the unique tiebreaker. `offset` stays, because a numbered page is a legitimate UI | M | ●●●○ | edge | A U | idea | `client-data-lifecycle.md` hole 4 |
| 2.16 | **Batch the writes the framework itself makes** — measured 2026-08-13, and the numbers are not close: on a file database, 5,000 rows cost 84.7 µs/op through a `create()` loop, 17.7 inside `$transaction()`, **3.3 through `createMany()` — 26×**. The loop pays one WAL commit per row and `:memory:` benchmarks hide it. Nothing needs building; both APIs ship and work. The gap is adoption — `Seeder`/`Factory`/`loadFixture()` loop, and whether Junction's bulk `{data, errors}` path reaches `createMany()` is unverified. Rides with it: `@default(now())` costs +1.9 µs/op because it formats ISO-8601 **per row**, identical to the millisecond across a batch. The same file closes several leads for good — gates +0.5 µs, policies +0.7, validators +0.0, so **there is no speed argument for weakening access control**; reads are already 1.13× raw SQLite; and litestone's live memory is under 10 MB, with `bun --smol` worth more (−56 MB) than any code change | S | ●●●○ | parity | D | idea | `speed-and-footprint.md` |
| 2.9 | **Rate limiting** — **two implementations already exist** and neither is on by default: `rateLimit()` middleware (`transport/middleware.ts:206`) and `rateLimitHook` (`core/hooks.ts`), both tested, which is itself an instance of the middleware-vs-hooks split. What is genuinely absent: a default, and any clamp on `ctx.directives.limit`. Urgent once 4.2 exists — an agent calls `find` in a loop by default | S | ●●○○ | stakes | A | partial — see `ISSUES.md` `FJS-017` | `ecosystem-gaps.md` 11 |

---

## Wave 3 — the ecosystem mechanism

How other people fill the gaps instead of this project building all of them.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.1 | **Bare-specifier `.lite` imports** — `parseFile()` already resolves relative imports recursively. Teach it `@scope/pkg/model/schema.lite`. Small, load-bearing, and independently kills the auth schema hand-copy | S | ●●●○ | **only** | D | idea | `slices.md` |
| 3.2 | **The slice installer** — read the directory layout, resolve parts, apply the consumer edits, order by `after` | M | ●●●● | **only** | D A U T | idea | `slices.md` |
| 3.3 | **Suite realm (`createTestEnv`)** — one seeded test environment, gate levels as a first-class axis. **Shipped, both realms.** Data half in `@frontierjs/litestone/testing` (template-clone db per test — 476ms → 13ms; `migrations:`; `actingAs(user)` and `atLevel(n)` deliberately separate; `setup`/`phases` for AAA); API half in the new `@frontierjs/testing`, above Junction — `api:`, `as(user).service(name)`, `announced()`. `listen: true` binds a real port, and `verifyTransportParity()` grades HTTP against WS over a real socket — two transports, no restatement. Port claiming is answered by asking for port 0 and reading it back, which cannot collide at all; rate-limit awareness is what is left | M | ●●●○ | parity | T | **shipped** | `testing-realm.md` |
| 3.4 | **Derived suites** — gate, constraint, relation and `@guarded` tests generated per model, that re-derive when the schema changes. Also removes the last hand-maintained part of the slice format. **Phase 1a shipped**: `litestone access` / `fli test:access` writes the committed `db/access.snapshot.md`, `--check` fails a stale one in CI, and `generateGateMatrix` now covers every level rather than the two edges. The runner over it is Phase 1b and wants 3.3 first | S | ●●●● | **only** | D T | part-shipped | `testing-realm.md` |
| 3.4b | **Schema mutation testing** — **shipped** as `schemaMutants()` + `mutationScore()`. 30 mutants on `example`, 232 on `basecamp` — the enumerability claim, measured. It named the holes and closing them was the work: the gate ladder grew from reads to all four operations, `verifyFieldProtection` was written, `@unique` joined the constraint runner. 97% on `example`, one survivor that genuinely cannot be tested. The trap it nearly fell into: an `error` row counted as a kill reads 93% while four mutations go unnoticed | M | ●●●● | **only** | D T | **shipped** | `testing-realm.md` |
| 3.5 | **Sierra contributing Resources from a package** — deferrable while `eject: true` is the default | L | ●●○○ | edge | U | idea | `slices.md` |
| 3.6 | **A slice registry** | L | ●●○○ | parity | — | idea | `ecosystem-gaps.md` |
| 3.7 | **A package ships its own commands** — a command comes from `fli`'s tree or the project's, never from a dependency, so `commands/auth/install.md` hand-copies auth's schema fragments and three packages' docs advertise commands that do not exist. The dependency tree is already the declaration; oclif needs a second install step and this does not. Same mechanism 3.2 wants, and 3.1 kills the same hand-copy from the schema side | S | ●●●○ | edge | — | idea | `command-surface.md` 1 |

---

## Wave 4 — the differentiators

The reasons to choose FJS rather than not-leave it. Most are cheap *because the
decisions that make them possible are already made.*

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4.1 | ~~**State machines (`@@transitions`)**~~ — **shipped 2026-08-04.** Declared in the seed, enforced at the Data boundary (`litestone/src/core/parser.js`, `client.js`, `jsonschema.js`), carried to the client as `x-transitions` (`sierra/src/junction/field-rules.js`, tested), and driven from `example/`'s order screen. Remainder: the **full DSL** (litestone backlog 5) — `transitionMap` is the partial form | M | ●●●● | **only** | D A U | ~~`shipped`~~ | `state-machines.md` |
| 4.2 | **Agent surface (`herald`)** — MCP derived from the seed, with the gate as the permission model and tool visibility computed per session level. Answers the industry's actual unsolved problem, which is scoping | M | ●●●● | **only** | A | idea | `agent-surface.md` |
| 4.2b | **Every `fli` command answers a machine** — `--json` as a global contract rather than one command's courtesy, a JSON error envelope on the same switch, and exit codes that separate *bad flag* from *deploy failed*. This is 4.2's CLI half: 197 commands each carrying a description, typed flags and examples already **is** a tool catalogue, and `run(context)` already returns the value nothing reads | S | ●●●○ | edge | — | idea | `command-surface.md` 2 |
| 4.22 | **Studio shows the access surface, and says when it has drifted** — `deriveAccess()` already returns the whole surface as an object and has exactly ONE formatter, the committed `access.snapshot.md`; `studio.html` (4804 lines) has no access view at all. The snapshot is good at being *reviewed* and bad at being *read* — 37 rows of `"4.4.4.5"` answers *what does this model require* and not the question people have, which runs the other way: **what can a level-4 user do to this schema?** `expectedVerdict()` computes exactly that and has no reader outside the test tier. Second half is the sharper one: **the snapshot is *what is* and cannot tell you it has stopped being true** — three distinct drifts (schema↔database, schema↔snapshot, file↔what Studio parsed at boot), of which the third is new and the other two are answers the studio server already gives. Pairs with 4.3, which asks the same question in a PR rather than a browser. **The rule that keeps it safe**: no *regenerate* button — the committed file stays the review artifact, or the CI gate becomes a formality | S | ●●●○ | parity | D T | **built 2026-08-14** | `studio-access-and-drift.md` |
| 4.3 | **Permission diff in CI** — "this PR widens `User.email` from level 5 to 2". Nearly free, and the most persuasive single artifact the framework can produce | S | ●●●○ | **only** | D T | idea | `compliance-from-the-seed.md` |
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
| 4.21 | **Time and recurrence declared in the seed** — the word `timezone` appears **nowhere in `IDEAS/`** across thirty-one records, `packages/datetime-kit/` is a README with no `package.json`, and the entire repo holds one timezone concept: an optional `timeZone` in Caravan's cron, correct, tested, and connected to nothing. `DateTime` is ISO-8601 TEXT, which records an instant and says nothing about what it meant. So four failures recur in every application: **an instant and a zoned wall-clock time are different values sharing one column** (*the shop opens at 09:00* is not a point on the timeline), **a future event stored as UTC is a bet on politics** (IANA ships rule changes several times a year, so the meeting moves — the correct storage is wall-clock plus zone, resolved late, and almost nobody knows this until it bites), **DST makes 02:30 run zero times in spring and twice in autumn**, and **"today" is a different eight hours per viewer**, which every report and every `@retain` window rests on. Declarable because the distinction is a property of the column, not of the code that reads it; the viewer's-zone case is the same per-request resolution `applyStanding()` already does. Settle **with** 4.15's bitemporality or one will invent a vocabulary the other must live with. Refuse the general RRULE | M | ●●●○ | edge | D A U | idea | `time-and-recurrence.md` |
| 4.19 | **Durable workflows** — the domain map names it (*Orion, planned, absent*) and 63 tracked files sit below the `packages/*` glob unrun (`FJS-D14`). A Caravan job is one unit retried; `@@transitions` is one row in a state machine; **the thing between them has no noun** — a multi-step process that survives a restart, compensates when a later step fails, and has a point past which it can only go forward. Temporal is a company built on this category. **Arriving anyway, unnamed**: 2.3b is a durable workflow engine with exactly one workflow in it, and the saga vocabulary it imported should be ruled once for both rather than defined twice. The FJS position, if taken: steps are Services and state is a Model, so it inherits gates, audit and derived suites — where the alternative is a second runtime with its own security model | XL | ●●●○ | edge | A D | idea | `operational-edge.md` 4 |
| 4.17 | **Support mode — bounded, audited impersonation** — *"a customer says it is broken and nobody can reproduce it"* is the most common day-two task in any app, and the word `impersonation` occurs nowhere in `IDEAS/`. Everywhere else it is hand-rolled as a god-mode switch, because authorization living in handlers cannot express *act as this person and no higher*; here the ceiling is `sessionGateLevel` on the impersonated principal, enforced at the Data boundary like every other request. Attribution is the **operator**, not the subject; invariant 7's redactions still hold, so *see what the user sees* stays distinct from *see everything about the user*; and a session is an episode with a start, an end and a reason — which turns a DSAR into *who looked at my record, when, and why*. Wants a complete audit trail, so it sits behind the same dependency as 4.13 | M | ●●●○ | **only** | D A | idea | `compliance-from-the-seed.md` 6 |
| 4.16 | **Basecamp as the deploy console** — fleet view, trigger a deploy or revert, watch it live. Small, because every part already ships there: the gate ladder decides who may deploy, channels make a triggered deploy announce to a second tab, `/hub/` is the cross-workspace view. Two rules keep it from becoming Forge — **basecamp is a viewer and a trigger, never the source of truth** (the journal lives with the app; if basecamp vanishes `fli` still deploys), and **CLI-first always** (basecamp must be deployable with no basecamp running, or the first bad deploy of the console leaves no hands). Needs shape from 2.3b, not work: machine-readable `fli` output, which is 4.2b arriving where it is first load-bearing | M | ●●●○ | edge | R | idea | `release-transitions.md` |
| 4.11 | **Provisioning from declarations** — FJS's declarations are written by a human and already parsed, so the plan can be *reviewed before it runs*. Must degrade to nothing for the one-binary path | L | ●●○○ | edge | R | idea | `operational-edge.md` 1 |
| 4.12 | **Derived suspense boundaries** — place the boundary at the lowest node whose subtree reads a pending value, instead of hand-wrapping `<mesa:boundary>` and guessing granularity. Mesa already generates per-value `$async` state; React and Solid cannot derive this because their runtimes cannot see which subtree depends on which promise. Do 0.6 first — it is the same narrowing, one level down. **Carries a second half**: `pending` and `failed` are structural and `empty` is still copy-pasted per call site, which is the same problem the element exists to remove — derivable because `kind:'list'` is a discriminator the compiler can test, but a layout decision more than a loading one, so probably derive the condition and leave the placement | M | ●●○○ | edge | U | idea | `derived-suspense.md` |
| 4.15 | **Declared semantics — the categories the seed should know about** — `@version` **shipped 2026-08-06** (optimistic concurrency: `update()` requires the version it read and 409s if it moved; `updateMany`/`upsert` bump but do not require; `asSystem()` skips — 21 tests). Remainder: `Money` (a scalar that is not a float — `example` models money as `Float`), bitemporality (`occurredAt` vs `createdAt`), and a resumable-process noun | M | ●●●● | edge | D | partial | `declared-semantics.md` |
| 4.14 | **The client data lifecycle** — optimism as a transaction (`mutate(fn, { optimistic, rollback })`) over a store keyed by entity id rather than per-`resource()` copy, so five views of one order are five subscribers to one node. The announcement half is already better than the field's — the server says what changed, so you never call `invalidateQueries` — but it is incomplete (`FJS-010`, `FJS-011`) and nothing models a value being *provisional*. Blocked on those two: a store that cannot remove a row on a filter miss cannot roll one back. Also carries `FJS-083` (search params are not reactive and not on `page`, though `ctx.directives` is already the shape they want) and `FJS-084` (the browser client cannot ask for a relation, though the wire, the bridge and Litestone's batched includes all support it) | M | ●●●○ | edge | A U | idea | `client-data-lifecycle.md` |
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
| 5.11 | **Fill `@frontierjs/utils` by divergence, not by DRY** — a survey of the repo's whole pure-function surface found only ~250–400 extractable lines, and that is the wrong measure: **four of the duplicated helpers have already drifted apart**, three of them into defects. `glow` is forked and mesa runs the pre-fix copy (`FJS-191`); four inflection rule sets resolve one invariant and the weakest sits behind `createResource` (`FJS-192`); `slugify` has four spellings of which the `@slug` transform's is the authority and no client shares it; `escapeHTML` has two, one missing `'`. The rule that falls out — *extract when two copies drifting would be a defect, not when two copies exist* — leaves `sleep` alone at five copies and moves `slugify` at two, and it refuses `deepMerge`, which is genuinely three functions (sierra concatenates arrays, the other two replace). **Blocked on a ruling, not on work**: Invariant 1 says mesa is a leaf with zero workspace deps, `utils`'s own README claims the exemption, and until that is settled the three packages holding most of the duplication cannot import the package built to hold it | S | ●●●○ | — | — | **defect** | `shared-pure-functions.md` |
| 5.13 | **What a scaffolded app is given** — when 1.2 runs, the generated `package.json` and config files **are** the framework's real opinion about tooling, and far more people will read them than will read this repo. Undecided: the lint/format config (1.7), `tsconfig`, `.editorconfig`, a `lint` script, whether `fli doctor` runs in the app's own CI, and whether the app gets a CI workflow at all. Every one is nearly impossible to change afterwards. One rule worth fixing now: **the config is a dependency the app extends in a line, not a file copied into it** — a copy never improves again | S | ●●●○ | stakes | — | idea | `tooling-decisions.md` 3 |
| 5.14 | **Four test runners and ten shapes of `test` script** — probed: `bun test`, `vitest run`, plain `node` with a hand-listed file sequence, and `npm` for the extension. `CLAUDE.md` mitigates it with a table and a warning that the wrong runner *"produces failures that belong to nothing"* — ~35 phantom failures in mesa. Three of the four have real reasons; **the one that does not is `bun test` versus a hand-listed `node a.js && node b.js`**, which is where a new test file gets forgotten silently. A ruling, before the count grows | S | ●●○○ | — | T | idea | `tooling-decisions.md` 2 |
| 5.15 | **Dependency posture is a CI phase or a bot, and nothing has chosen** — `fli npm:audit` and `npm:outdated` already exist as commands; no renovate, no dependabot, and nothing runs either on any schedule. The tooling half under 2.12, which argues the harder question (*am I affected*, compared against `project:map --json`). The decision is **which side of the project's own line this falls on**: every other check is a phase in `scripts/ci.mjs` specifically so CI runs identically on a laptop, and an external bot is the first exception | S | ●●○○ | stakes | — | idea | `tooling-decisions.md` 5 |
| 5.12 | **The small sharp edges** — three that are too small for a record and too common to lose, each a day or two, each currently written from scratch in every app, each with a known correct answer people only find after shipping the wrong one. **User-defined ordering**: drag-to-reorder with `position: Int` rewrites every row after the one that moved; the answer is a fractional rank, and `$checkOrderBy` should know the column is a rank rather than a number. **Conditional form fields**: *show VAT only for EU, require it when shown* is imperative code in every page, and it is now the one part of a generated `<Form>` that is not generated — 1.1a cannot generate a field list without an answer for fields that are sometimes not in it. **`@@softDelete` × `@unique`**: a soft-deleted row still occupies its unique index, so re-registering a deleted user's email fails with a constraint violation naming nothing they did; both features ship, the interaction is undefined, and it should be one ruling rather than a trap each app finds | S | ●●○○ | — | D U | idea | `ecosystem-gaps.md` 15 |
| 5.9 | **Cascading fields (`@@cascade`)** — declare "when this field changes here, carry it to related rows"; `once` for one-way stamps, `mirror` for flags. `@@softDelete(cascade)` is already this feature with the column frozen to `deletedAt`; generalising it makes one mechanism where there are two, and fixes the shipped cascade's missing transaction and missing child audit entries on the way | S | ●●○○ | edge | D | idea | `cascading-fields.md` |

---

## Reading the table three ways

**Cheapest high payoff — do these first.** All `S`, all ●●●+:
0.1 CI · 2.1 the storage reconciliation · 1.2 `create-frontier` · 2.3a pivot classifier ·
2.12 security posture · 3.1 bare-specifier `.lite` imports · 4.3 permission diff ·
4.4 static safety · 4.4b route classification · 1.3 factories · 5.1 context ruling.

Seven of those ten are days of work. Three of them (2.3a, 4.3, 4.4) are things no
competitor can do at any price, and all three are the same trick — a comparison
between two things the seed already states. **0.5 (`fli doctor`) is `M` rather than `S` but belongs in this
group** — its first four rules are an afternoon, and it is the only item that pays
back on every app built on the framework rather than once.

**Biggest bets — expensive, and each defines a category:**
1.1 schema → UI · 2.3 Release · 4.8 offline-first · 5.8 documentation.

**Gates the most downstream work:**
1.1 (schema→UI) blocks 1.4, 3.5 and the useful half of 3.2 ·
3.1 (`.lite` imports) blocks all of wave 3 ·
1.5 (i18n decision) must precede 1.1 ·
2.9 (rate limiting) becomes urgent the moment 4.2 ships — the mechanism exists,
the default does not ·
4.5 (`warden`) blocks the ceiling of 4.2 and 4.7 ·
2.3a (pivot classifier) is the input every other Release row consumes — 2.3b's
guarantee is stated against it, 2.3d's retention window is measured in it, and
4.10's Audience half is illegal across it ·
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
*which subset* ·
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
a machine · **5.2b–5.2d** the `fli` surface · **5.7** `shift`.

Two things are true of the cluster that are not true of its members. **It is where the
framework's opinion is read from** — almost nobody reads this repo, and everybody reads
what `create-frontier` puts in their `package.json`, which makes 5.13 the highest-stakes
`S` on the list. And **it has one live boundary dispute**: several of `fli doctor`'s
checks look exactly like lint rules and are not, so 1.7 must be settled with 0.5 in view
or the hazard catalogue gets implemented twice in registries that disagree.
`IDEAS/tooling-decisions.md` is the cluster's owner and holds the *unmade decisions*
rather than a plan.

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
- `packages/orion/` — a `README.md` and nothing else, referenced by no other
  document. It is either a reservation that should be named or a thing to
  remove; tracked as `ISSUES.md` `FJS-D14`.

## See also

- `IDEAS/package-map.md` — the same material organised by package, with names
- `PROS_AND_CONS.md` — the design-level assessment several wave-4 and wave-5 items
  come out of
- `ISSUES.md` — the open register; **every wave-0 defect is counted there**, and a
  new one goes there first. `HANDOFF.md` is session narrative, not a ledger
- `DECISIONS.md` — where 5.1, 5.3, and the `Slice` vocabulary ruling land
- `website/README.md` — the publication gate, which this file will eventually feed
