# Ideas — the overview

**Status: INDEX. Derived, not authoritative.** Dated 2026-08-04. Every row here is a
summary of something argued properly in another file; **when this disagrees with a
source file, the source wins.** Nothing listed is built unless the Status column
says otherwise. See `VERIFYING.md`.

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
| **Status** | `idea` · `partial` (something exists and is incomplete) · **`defect`** (something shipped is wrong today) |

**Edge is the column that should drive the roadmap.** A `stakes` item is why someone
leaves; an `only` item is why someone arrives. A plan made of one and not the other
fails in a predictable direction.

---

## Wave 0 — repairs

Shipped behaviour that is wrong. These are not features and they are not optional;
they are listed here because each is argued in an ideas file rather than a ledger.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1 | **Automated CI** — no `.github/` exists; every landmine in `CLAUDE.md` was found by hand | S | ●●●● | stakes | T | idea | `testing-and-ci.md` |
| 0.2 | **Live-store filter leak** — `resource()` upserts every event regardless of query; a patched row that leaves the filter stays and goes wrong silently | S | ●●●○ | — | A U | **defect** | `live-queries.md` |
| 0.3 | **Audit logger writes 0 rows** — schema-declared audit should be flagship; broken is worse than absent | S | ●●●○ | edge | D | **defect** | `framework-shape.md` 4 |
| 0.4 | **`admin:generate` repair-or-retire** — emits `.svelte`, wrong paths, lowercase-plural model. Either the fastest route to schema→UI or dead weight advertising a feature that does not run | S | ●●○○ | — | U | **defect** | `ecosystem-gaps.md` |
| 0.5 | **`fli doctor`** — the live-hazard catalogue as an executable rule set. Every entry was found by hand and every one will be found again by every person who builds on this. Compounds with 0.1 | M | ●●●● | **only** | — | idea | `diagnostics.md` |

---

## Wave 1 — make the thesis visible

The framework's central claim is two-thirds delivered. Nothing else changes how it
*reads* to a newcomer as much as this wave.

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.1 | **Schema → UI (`foundry`)** — `<AutoForm>`, `<AutoTable>`, derived admin. Every input is already in the browser bundle and nothing consumes it | L | ●●●● | **only** | D U | partial | `framework-shape.md` 1 |
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
| 2.8 | **Streaming responses** — no SSE, no chunked body; every response is buffered whole. **Hard prerequisite for 4.2** — an agent surface that cannot stream is a demo. Forces a ruling: does a stream sit outside the envelope, or does the envelope grow a third kind? | M | ●●●○ | stakes | A | idea | `ecosystem-gaps.md` 12 |
| 2.9 | **Rate limiting** — nothing anywhere. `ctx.client.ip`, `ctx.auth` and `app.cache` are the substrate; `ctx.directives.limit` is the thing to clamp, and nothing bounds it today. Urgent once 4.2 exists — an agent calls `find` in a loop by default | S | ●●○○ | stakes | A | idea | `ecosystem-gaps.md` 11 |

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

---

## Wave 4 — the differentiators

The reasons to choose FJS rather than not-leave it. Most are cheap *because the
decisions that make them possible are already made.*

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4.1 | **State machines (`@@transitions`)** — legal transitions declared in the seed, enforced at the Data boundary, `resource.transitions()` in the UI. Radiates into all three realms, which is the bar for the seed | M | ●●●● | **only** | D A U | idea | `state-machines.md` |
| 4.2 | **Agent surface (`herald`)** — MCP derived from the seed, with the gate as the permission model and tool visibility computed per session level. Answers the industry's actual unsolved problem, which is scoping | M | ●●●● | **only** | A | idea | `agent-surface.md` |
| 4.3 | **Permission diff in CI** — "this PR widens `User.email` from level 5 to 2". Nearly free, and the most persuasive single artifact the framework can produce | S | ●●●○ | **only** | D T | idea | `compliance-from-the-seed.md` |
| 4.4 | **Static-safety proof** — the build fails rather than publishing gated data as a public HTML file. One comparison between two things already known | S | ●●●○ | **only** | D U | idea | `static-safety.md` |
| 4.4a | **Scoped SQL** — raw queries run against a view derived from `@scoped`/`@@allow`/`@guarded`/`@@softDelete`, never the base table. `@guarded` columns are *absent from the view*, so `SELECT *` cannot return them. Unblocks SQL for 4.2 and reporting generally. **Fixes a live hole: `$setAuth(user).sql` is byte-identical to unscoped `sql`** | M | ●●●○ | **only** | D | **defect** | `scoped-sql.md` |
| 4.5 | **`warden` — orthogonal permissions** — named roles over the 0–9 ladder. Until this exists, the best feature caps out the moment an app needs two permissions that are not comparable | L | ●●●● | edge | D A | idea | `package-map.md` |
| 4.6 | **Live queries** — query-scoped subscriptions with a client-side matcher derived from the schema. No server registry, unlike Remult | M | ●●●○ | edge | A U | **defect** | `live-queries.md` |
| 4.7 | **Compliance (`marshal`)** — `@pii`/`@retain`, data map, DSAR, erasure cascade. The rare area where the buyer is not the developer | L | ●●●○ | **only** | D | idea | `compliance-from-the-seed.md` |
| 4.8 | **Offline-first (`compass`)** — client-side SQLite, mutation queue, local gate evaluation, `@@sync` conflict policy. One engine on both sides is the strongest structural advantage over Prisma and Drizzle | XL | ●●●● | **only** | D U | idea | `offline-first-and-release.md` |
| 4.9 | **`atlas` — the app model as a product** — generated architecture diagrams, permission matrix, drift detection, outbound-surface report. `project:map --json` already *is* an app model and nothing reads it | M | ●●●○ | **only** | — | partial | `operational-edge.md` |
| 4.10 | **Preview environments** — the same branch inference `fli deploy` already does, plus a namespace and a TTL | M | ●●●○ | parity | R | idea | `operational-edge.md` 2 |
| 4.11 | **Provisioning from declarations** — FJS's declarations are written by a human and already parsed, so the plan can be *reviewed before it runs*. Must degrade to nothing for the one-binary path | L | ●●○○ | edge | R | idea | `operational-edge.md` 1 |

---

## Wave 5 — coherence

Cheap, mostly rulings rather than code, and each removes a place where the framework
teaches two things at once. **Interleave these; do not schedule them as a block.**

| # | Item | Effort | Payoff | Edge | Realms | Status | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.1 | **Rule the Context shape** — adopt Junction's split as the base; conforming subsets elsewhere. Needs a `DECISIONS.md` entry more than it needs code | S | ●●●○ | — | — | idea | `one-mental-model.md` 3 |
| 5.2 | **One frontmatter parser** — three call sites, one zero-dep leaf. The concept users touch most often | S | ●●○○ | — | — | idea | `one-mental-model.md` 2 |
| 5.3 | **Litestone Plugin gets a `name`; rename the concept** — the missing identity blocks introspection, ordering and `/metrics` | S | ●●○○ | — | D | idea | `one-mental-model.md` 1 |
| 5.4 | **Name Mesa's target set publicly** — documentation and an API over code that already works. Highest vision-value per unit of effort | S | ●●●○ | edge | U | partial | `one-mental-model.md` 5 |
| 5.5 | **One target axis in Sierra; jetty becomes `extension`** — de-forks the hand-copies and makes desktop/mobile cheap later | M | ●●●○ | edge | U | idea | `one-mental-model.md` 6 |
| 5.6 | **Type-check the derivation end to end** — nothing verifies that Junction's service types agree with the generated Model declarations. The quiet threat to the whole thesis | M | ●●●● | — | — | partial | `framework-shape.md` 5 |
| 5.7 | **Upgrade codemods (`shift`)** — a reviewable diff, never a silent rewrite. The `Integer→Int` rename is the reference test case; a tool that cannot do it automatically is not worth shipping | L | ●●●○ | **only** | — | idea | `ecosystem-gaps.md` 10 |
| 5.8 | **Documentation as a product** — excellent docs for maintainers, essentially none for users. Laravel's moat is not features | XL | ●●●● | stakes | — | partial | `ecosystem-gaps.md` |
| 5.9 | **Cascading fields (`@@cascade`)** — declare "when this field changes here, carry it to related rows"; `once` for one-way stamps, `mirror` for flags. `@@softDelete(cascade)` is already this feature with the column frozen to `deletedAt`; generalising it makes one mechanism where there are two, and fixes the shipped cascade's missing transaction and missing child audit entries on the way | S | ●●○○ | edge | D | idea | `cascading-fields.md` |

---

## Reading the table three ways

**Cheapest high payoff — do these first.** All `S`, all ●●●+:
0.1 CI · 2.1 storage drivers · 1.2 `create-frontier` · 3.1 bare-specifier `.lite`
imports · 4.3 permission diff · 4.4 static safety · 1.3 factories · 5.1 context ruling.

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
2.8 (streaming) is a hard prerequisite for 4.2, and 2.9 (rate limiting) becomes
urgent the moment 4.2 ships ·
4.5 (`warden`) blocks the ceiling of 4.2 and 4.7.

**The agent-surface cluster.** 4.2 reads as a standalone `M` and is not one: without
2.8 it cannot stream, without 2.9 it is a self-inflicted denial of service, and
without 4.5 its permission model inherits the linear ladder's ceiling. Budget the
cluster, not the item.

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
  § Live hazards and the `HANDOFF.md` ledger. Wave 0 here is the subset that *is*
  argued in an ideas file, which is an artefact of where things were written down
  rather than a meaningful distinction.
- `packages/orion/` — an empty directory in the workspace glob, mentioned in no
  document. It is either a reservation that should be named or a thing to remove.

## See also

- `IDEAS/package-map.md` — the same material organised by package, with names
- `PROS_AND_CONS.md` — the design-level assessment several wave-4 and wave-5 items
  come out of
- `HANDOFF.md` — the issue ledger; defects belong there as well as here
- `DECISIONS.md` — where 5.1, 5.3, and the `Slice` vocabulary ruling land
- `website/README.md` — the publication gate, which this file will eventually feed
