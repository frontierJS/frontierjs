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
| 1.6 | **App manifest — `frontier.config.js` + `frontier.lock`** — declared intent, observed fact recorded *by booting*, and a three-way reconcile against the filesystem. Turns a filename segment into a claim doctor can falsify, gives 1.2 an input, and makes invariant 14's ratchet mechanical. Extends 0.5 with the leg text-scanning cannot reach | M | ●●●○ | edge | A R | idea | `app-manifest.md` |

> **1.1 gates more than anything else on this list.** It is the reason a Slice's
> `resource/` part is worth shipping, the thing `quarry` renders, and the seam
> offline-first has to be built through rather than around.

---

## Wave 2 — production blockers

An evaluator stops at these. None is differentiating; all are disqualifying.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.1 | **Storage drivers (`stow`)** — S3/R2/GCS against an interface that already exists. Blocks every container, serverless and multi-node deploy | S | ●●●● | stakes | A | idea | `framework-shape.md` 2 |
| 2.2 | **OAuth into `auth`** — the `Credential` model already carries `type`/`accessToken`/`refreshToken`/`scope`. The single most likely reason an evaluation ends | M | ●●●● | stakes | A | idea | `ecosystem-gaps.md` 1 |
| 2.3 | **Release story (`depot`)** — artifact kinds first-class: single binary, container, static+API, offline PWA. Found independently by three analyses | XL | ●●●● | edge | R | idea | `offline-first-and-release.md` |
| 2.4 | **Observability (`lantern`)** — real spans, not just a `correlationId`; request-correlated logs through transport → service → db | M | ●●●○ | parity | A | idea | `operational-edge.md` 3 |
| 2.5 | **Billing (`ledger`)** — the canonical first slice, and the proof the format works | L | ●●●● | parity | D A U | idea | `ecosystem-gaps.md` 2 |
| 2.6 | **2FA / TOTP** — `IAuth` declares `setupTotp`; nothing implements it | S | ●●○○ | stakes | A | partial | `ecosystem-gaps.md` 6 |
| 2.7 | **Media processing** — resizing, thumbnails, formats. Pairs with 2.1 | S | ●●○○ | stakes | A | idea | `ecosystem-gaps.md` 9 |
| 2.8 | **Streaming responses** — **SSE already ships**: `ctx.sse()` returns a real `text/event-stream` response with `send`/`close`/`onDisconnect` (`junction/src/transport/http.ts:636`), tested. What is missing is the *contract* — does a stream sit outside the result envelope, or does the envelope grow a third `kind`? — and a chunked-body path for non-event payloads. A ruling, not a build | S | ●●○○ | stakes | A | partial — ruling is `ISSUES.md` `FJS-D13` | `ecosystem-gaps.md` 12 |
| 2.10 | **Form actions — a mutation declared beside its page, working without a bundle** — `<Form>` (shipped 2026-08-06) is JavaScript-only, and a bundle that 404s leaves a form that looks complete and does nothing. Every piece exists already: Junction parses `urlencoded` and `multipart`, `redirectResponse()` ships, the schema's per-field messages are the same sentence on both sides, and `<Field>` already takes an errors map. What is missing is the declaration. Also what makes the `static` target an application rather than a brochure | M | ●●●○ | parity | A U | idea | `form-actions.md` |
| 2.9 | **Rate limiting** — **two implementations already exist** and neither is on by default: `rateLimit()` middleware (`transport/middleware.ts:206`) and `rateLimitHook` (`core/hooks.ts`), both tested, which is itself an instance of the middleware-vs-hooks split. What is genuinely absent: a default, and any clamp on `ctx.directives.limit`. Urgent once 4.2 exists — an agent calls `find` in a loop by default | S | ●●○○ | stakes | A | partial — see `ISSUES.md` `FJS-017` | `ecosystem-gaps.md` 11 |

---

## Wave 3 — the ecosystem mechanism

How other people fill the gaps instead of this project building all of them.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3.1 | **Bare-specifier `.lite` imports** — `parseFile()` already resolves relative imports recursively. Teach it `@scope/pkg/model/schema.lite`. Small, load-bearing, and independently kills the auth schema hand-copy | S | ●●●○ | **only** | D | idea | `slices.md` |
| 3.2 | **The slice installer** — read the directory layout, resolve parts, apply the consumer edits, order by `after` | M | ●●●● | **only** | D A U T | idea | `slices.md` |
| 3.3 | **Suite realm (`createTestEnv`)** — one seeded test environment, gate levels as a first-class axis | M | ●●●○ | parity | T | idea | `testing-and-ci.md` |
| 3.4 | **Derived suites** — gate, constraint, relation and `@guarded` tests generated per model, that re-derive when the schema changes. Also removes the last hand-maintained part of the slice format | M | ●●●● | **only** | D T | idea | `testing-and-ci.md` |
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
| 4.10 | **Preview environments** — the same branch inference `fli deploy` already does, plus a namespace and a TTL | M | ●●●○ | parity | R | idea | `operational-edge.md` 2 |
| 4.11 | **Provisioning from declarations** — FJS's declarations are written by a human and already parsed, so the plan can be *reviewed before it runs*. Must degrade to nothing for the one-binary path | L | ●●○○ | edge | R | idea | `operational-edge.md` 1 |
| 4.12 | **Derived suspense boundaries** — place the boundary at the lowest node whose subtree reads a pending value, instead of hand-wrapping `<mesa:boundary>` and guessing granularity. Mesa already generates per-value `$async` state; React and Solid cannot derive this because their runtimes cannot see which subtree depends on which promise. Do 0.6 first — it is the same narrowing, one level down. **Carries a second half**: `pending` and `failed` are structural and `empty` is still copy-pasted per call site, which is the same problem the element exists to remove — derivable because `kind:'list'` is a discriminator the compiler can test, but a layout decision more than a loading one, so probably derive the condition and leave the placement | M | ●●○○ | edge | U | idea | `derived-suspense.md` |
| 4.15 | **Declared semantics — the categories the seed should know about** — `@version` **shipped 2026-08-06** (optimistic concurrency: `update()` requires the version it read and 409s if it moved; `updateMany`/`upsert` bump but do not require; `asSystem()` skips — 21 tests). Remainder: `Money` (a scalar that is not a float — `example` models money as `Float`), bitemporality (`occurredAt` vs `createdAt`), and a resumable-process noun | M | ●●●● | edge | D | partial | `declared-semantics.md` |
| 4.14 | **The client data lifecycle** — optimism as a transaction (`mutate(fn, { optimistic, rollback })`) over a store keyed by entity id rather than per-`resource()` copy, so five views of one order are five subscribers to one node. The announcement half is already better than the field's — the server says what changed, so you never call `invalidateQueries` — but it is incomplete (`FJS-010`, `FJS-011`) and nothing models a value being *provisional*. Blocked on those two: a store that cannot remove a row on a filter miss cannot roll one back. Also carries `FJS-083` (search params are not reactive and not on `page`, though `ctx.directives` is already the shape they want) and `FJS-084` (the browser client cannot ask for a relation, though the wire, the bridge and Litestone's batched includes all support it) | M | ●●●○ | edge | A U | idea | `client-data-lifecycle.md` |
| 4.13 | **Named checkpoints + time travel** — `fli db:checkpoint` / `db:log` / `db:restore` over the audit trail. Snapshot is the truth, the log is the narrative; replay never reconstructs a redacted value, which keeps Invariant 7. Cheap because history is *declared* (`@@log`) and the Data realm is a file. Blocked on 0.7 — one uninstrumented bulk write ends the invertible history. Unblocks 1.4, 3.3 and half of 4.7 | M | ●●●○ | **only** | D T R | idea | `time-travel.md` |

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
| 5.9 | **Cascading fields (`@@cascade`)** — declare "when this field changes here, carry it to related rows"; `once` for one-way stamps, `mirror` for flags. `@@softDelete(cascade)` is already this feature with the column frozen to `deletedAt`; generalising it makes one mechanism where there are two, and fixes the shipped cascade's missing transaction and missing child audit entries on the way | S | ●●○○ | edge | D | idea | `cascading-fields.md` |

---

## Reading the table three ways

**Cheapest high payoff — do these first.** All `S`, all ●●●+:
0.1 CI · 2.1 storage drivers · 1.2 `create-frontier` · 3.1 bare-specifier `.lite`
imports · 4.3 permission diff · 4.4 static safety · 4.4b route classification ·
1.3 factories · 5.1 context ruling.

Six of those eight are days of work. Two of them (4.3, 4.4) are things no competitor
can do at any price. **0.5 (`fli doctor`) is `M` rather than `S` but belongs in this
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
~~0.7 blocks 4.13~~ — **cleared 2026-08-05**: bulk writes now log, so a bulk op no
longer ends the trail. What 4.13 still owes is *contents*, since a bulk entry
names rows without snapshotting them ·
~~0.6 is the first move of 4.12~~ — **done 2026-08-05**; 4.12 is now the whole
remaining feature, not a narrowing plus a feature.

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
