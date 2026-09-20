---
id: package-map
status: assessment
dated: 2026-09-19
---

# Idea — The package map: what exists, and what should

**Status: ASSESSMENT + PROPOSAL.** Dated 2026-08-04, **re-graded against the tree
2026-09-19** and restructured, because the original axis was wrong. What exists is
not restated here — root `CLAUDE.md` § Packages is the state and
`exports.snapshot.md` is what publishes. Everything under *Still proposed* is
unbuilt unless struck. Do not cite this file as describing behavior — see
`VERIFYING.md`.

This answers one question — *what top-level packages should this project have?*

**What the re-grade found.** The map was organized by urgency (tier 0/1/2), and
urgency turned out to be the least predictive thing about a row. Of eleven names
proposed in the first two tiers, **one shipped under its own name** (`@frontierjs/mcp`);
**six were absorbed** into a package, a command or a kit that already existed; and
**one was refused as a package outright** ([`FJS-D297`](../DECISIONS.md#fjs-d297)).
Nothing was built because the map said it was tier 0. So the axis here is now KIND,
which is the thing that actually decided every row.

---

## The test

[`FJS-D297`](../DECISIONS.md#fjs-d297) settled it while answering the offline row,
and the sentence generalizes: **a battery must be severable, and nothing that is the
default is severable — so anything heading for the default is core, and core
decomposes by owner rather than by package.** `PHILOSOPHY.md` § IV, batteries vs.
smallness, is the standing adjudication; this map never weighs it fresh.

Run against a proposed name, it sorts into five outcomes, and only the last is a
package:

| If the thing is… | It ships as | Precedent |
| --- | --- | --- |
| a rule at the Data boundary | `.lite` syntax | `warden` → `@@capabilities` ([`FJS-D147`](../DECISIONS.md#fjs-d147)) |
| markup | a component in `@frontierjs/ui` | `foundry` → `<Form>`, `<Table>`, `<FilterBar>` |
| a workflow somebody types | an `fli` command | `depot` → `fli deploy`; `atlas` → `fli ws:atlas` |
| a pure function with many possible answers and one right one | a `@frontierjs/toolbelt` subpath | `chronos` → `/datetime` ([`FJS-D26`](../DECISIONS.md#fjs-d26)) |
| **something an app can decline, carrying code somebody else wrote** | **a package** | `conduit-*` ([`FJS-D153`](../DECISIONS.md#fjs-d153)) |

**The last row is the whole of it.** A package earns its name by being *declinable*
and by carrying a dependency the core must refuse. Everything else on this page is
an idea's name, not a module's.

---

## Naming

The existing names are a westward-expedition vocabulary: **litestone, junction,
sierra, mesa, caravan, conduit, jetty, basecamp, orion**. Proposals below stay in
it, on the argument that a consistent naming register is worth more than each name
being individually self-describing — the framework already accepts that trade.

**`orion` and `oracle` are claimed folders, not packages** — V2 applications built
on the framework, ruled [`FJS-D14`](../DECISIONS.md#fjs-d14).

**A name may also be the name of the WORK.** `Homestead` is
[`FJS-D297`](../DECISIONS.md#fjs-d297)'s, for offline-first; `Lexicon` is the same
shape for i18n. Naming the work is how a decomposed effort stays discussable
without a module implying it is severable.

---

## Absorbed, shipped or refused — do not build these

Each row was probed against the tree on the date above.

| Name | Fate | Where it lives now |
| --- | --- | --- |
| ~~**`foundry`**~~ | **absorbed into `@frontierjs/ui` + sierra.** Not severable — a derived form is the paved road | `<Form>`, `<Table>`, `<FilterBar>`, `<FormField>`; `resource.columns()` at `packages/sierra/src/junction/resource.js`; `controlFor` / `formFieldList` in the bridge index; `fli admin:generate` |
| ~~**`assay`**~~ | **shipped, decomposed by owner** — the Suite noun has three homes and no package would have had a seat between them | `@frontierjs/testing` (the API tier), `createTestEnv` + `autoFactories` + the five executed checks in litestone, the CDP harness in mesa |
| ~~**`depot`**~~ | **absorbed into `fli`.** A workflow somebody types is a command | `fli deploy` — `plan`, `journal`, `revert`, `rollback`, `pause`, `setup`, `doctor` — plus `release:mint` / `release:check` |
| ~~**`atlas`**~~ | **shipped as two commands** | `fli ws:atlas` (the workspace), `fli app:atlas` (one app's answerable surface), `fli ws:invariants` |
| ~~**`warden`**~~ | **seed syntax** | `@@capabilities` — [`FJS-D139`](../DECISIONS.md#fjs-d139) · [`FJS-D140`](../DECISIONS.md#fjs-d140) · [`FJS-D146`](../DECISIONS.md#fjs-d146) · [`FJS-D147`](../DECISIONS.md#fjs-d147) |
| ~~**`chronos`**~~ | **a toolbelt kit.** The row asked whether it was a package at all and answered itself | `@frontierjs/toolbelt/datetime` ([`FJS-D268`](../DECISIONS.md#fjs-d268)); instant vs. zoned is `FJS-D143`, recurrence refused by `FJS-D144` |
| ~~**`stow`**~~ | **retired 2026-08-12.** litestone already shipped S3/R2/B2/MinIO over hand-written sigv4, with `File` columns and presigned URLs | `packages/litestone/src/plugins/file.js`. What remains is not a package: junction's separate local-disk `IFileStorage` is a **second** abstraction for one job (Invariant 4), to be delegated or retired |
| ~~offline / sync engine~~ | **refused as a package** — the ruling that produced the test above | Core, six owners. **Homestead** is the name of the work ([`FJS-D297`](../DECISIONS.md#fjs-d297)) |
| ~~**`@frontierjs/mcp`**~~ | **shipped under its own name** — the one proposal that was package-shaped and got built | `packages/mcp/`, ruled [`FJS-D258`](../DECISIONS.md#fjs-d258); `herald` withdrawn |
| ~~**`create-frontier`**~~ | **shipped** | `npm create frontier@latest`, an entry point over `fli new` |

**`warden`'s ceiling was real** and is worth keeping: basecamp graded a `billing`
role to READER(2) under a comment the ladder could not express. The fix was
syntax, not a package — which is the first time this map's own test ran.

---

## Still proposed, and package-shaped

**One.** A package earns its name by being declinable and by carrying code the core
must refuse to carry, and after the re-grade exactly one row still answers both.

| Name | Realm | What it is | State |
| --- | --- | --- | --- |
| **`conduit-<vendor>`** | API | The official connectors — one package per boundary, named for the boundary rather than the vendor. Conduit owns the mechanism and never the vendor, which is the whole reason these are severable. Ten proposed and ranked; the second is chosen for how much it **disagrees** with the first, because one implementation answers a connector interface by accident | Ruled [`FJS-D153`](../DECISIONS.md#fjs-d153). **Zero built** — the sharpest unbuilt row on this page |

---

## `media` — not a package, because the runtime already ships the codec

**Withdrawn as a package name 2026-09-19.** The row was written on the belief that
image work means a libvips binding, which makes the codec a dependency, which makes
it declinable, which makes it a package. `IDEAS/bun-natives.md` had already measured
otherwise on 2026-09-09: **`Bun.Image` is a runtime native** — `resize`, `rotate`,
`flip`, `flop`, `modulate`, `avif`/`webp`/`jpeg`/`png`/`heic`, `metadata()` and
`placeholder()`, chainable and terminal at `.bytes()` / `.blob()` / `.dataurl()` /
`.write()`. An 811 KB PNG resized and re-encoded to a 30 KB webp in ~25 ms, with no
dependency to install and nothing to decline. A package over that would be a name
wrapped around a global.

So `media` decomposes like every other row on this page:

- *Which variants exist for a column* — a litestone declaration on a `File` column,
  so the set is derived from the seed. **This is also the security boundary**: a
  declared set means a stranger cannot mint a derivative by typing a width into a
  URL, which is what an on-the-fly transform server is.
- *What a variant is called and what box it fits* — a `@frontierjs/toolbelt` kit.
  Pure, argument-only: parse a spec, compute the target box from a fit mode, derive
  the cache key, negotiate a format from an `Accept` header. The split `/cron`
  already makes against caravan.
- *Turning bytes into other bytes* — a capability the `FileStorage` plugin is
  **given**, not one it imports. Default `Bun.Image` where the runtime has it,
  refused by name where it does not (litestone is proved on Node against
  `node:sqlite`, and a `Bun.` reference in the import graph would break that).
  Injection is also what lets the suite run with no codec — outpost's runner, one
  realm over.
- *Rendering the set* — an `<Image>` in `@frontierjs/ui` reading the declared
  variants into a `srcset`. Markup.

**The transformer is `Bun.Image` and the runtime carries it** —
[`FJS-D311`](../DECISIONS.md#fjs-d311). Nothing is installed, nothing is wrapped,
and the seam exists so an app on another runtime, or one wanting sprites and
watermarks, passes its own.

### It is opt-in per COLUMN, and that is the doctrine rather than a concession

A column with no declared variants derives nothing, stores nothing and costs
nothing: `serialize()` is what it is today. `PHILOSOPHY.md` § III — *if a
declaration exists, it binds; if it doesn't exist, nothing is implied; the
framework never activates machinery no declaration asked for.* So the default is
save-the-one-file, and opting in happens where somebody knows whether the column
holds a product photograph or a signed PDF.

**A per-CALL skip is refused.** `create({ photo, skipVariants: true })` makes the
column's declaration sometimes-true, which is
[FJS-1184](../ISSUES.md#fjs-1184) in a second place — a declaration that binds
except when a caller says otherwise. § IV, paved road vs. the workaround: a flag
added in answer widens the shoulder and records nothing.

**And the latency everyone reaches for the flag over is mostly not the encode.**
`Bun.Image` measured ~25 ms for open → metadata → resize → encode; each variant
also costs a `put` over the network, so four variants is four extra round trips.
If that bites, the answer is option C above — a job, not a flag.

### The nine, against eager derivatives in litestone

Answered 2026-09-19, before any of it is built.

1. **Another origin?** No — bytes derived from bytes, never a second claim stored beside them. **One trap**: an `<Image widths={[320,1200]}>` taking widths as props would be one. The component reads the declared set.
2. **Concept budget?** One attribute. No new noun — a variant is a key in the store that already exists.
3. **Whose complexity?** The problem's. A catalog needs a thumbnail whatever the runtime; the added complexity would be the on-the-fly transform server this refuses.
4. **Predictability?** Improved. *What sizes does this app serve* has no answer today and afterwards is in the seed, and `keyPattern` already makes a variant URL computable with no lookup.
5. **Derived rather than restated?** Yes, and it is what rules out the alternatives: a hand-kept variants table, or widths typed into a component, are each a restatement.
6. **One owner?** Yes, and the codec is deliberately a DIFFERENT one: `FileStorage` owns bytes at rest ([`FJS-D260`](../DECISIONS.md#fjs-d260)) and a derivative is bytes at rest, while the transform is injected. Two owners, one seam.
7. **Boundary explicit?** ⚠️ **Partly — the weakest of the nine.** The provider needs nothing new (`put` and `delete` cover it), but the transformer seam is unnamed: it needs a stated contract — roughly `(bytes, {width, format}) => {bytes, contentType}` — and a test with no codec present.
8. **Failure proportional?** Yes, once one rule is stated: **a failed derive must not fail the upload.** The original is the truth and a variant is convenience, so a derive failure warns and a missing variant is a broken `<img>`.
9. **Wrong silently?** ⚠️ **Yes, three ways**, and this decides the shape: a codec absent so the variant is never made and 404s in production; an original replaced so old variants linger and the storage bill grows quietly; a declared set changed with old rows never backfilled. Three artefacts close it — the declared set in a committed snapshot, a `fli check` rule for *this column declares variants and no transformer is configured*, and `needsBackfill` on the release finding when the set changes. **Without them this fails question nine**, and a check that can only fail open is not a check.

**Verdict: passes.** 7 and 9 are conditions rather than objections, and both are cheap
enough to be part of the work rather than after it. The adjudication in tension is
batteries vs. smallness — the transformer must stay severable, which injection is.

### What `ts-images` / `imgx` is worth here

Read 2026-09-19. A libvips-class toolkit for Bun and Node — compression, WebP/AVIF,
SVG minification, responsive sets, sprite sheets, watermarking, batch processing,
analysis reporting, ThumbHash and dominant-color placeholders, and a dev server
taking `?format=webp&quality=75&size=800x600`.

**It is worth reading for the surface and is not worth depending on.** Three
readings:

- **It validates the seam rather than filling it.** Everything it does past resize
  and encode — sprites, watermarks, SVG minification — is an application's work, not
  a framework's. An injected transformer is exactly how an app that wants those
  reaches for this library without the framework carrying it.
- **Its URL-transform server is the shape this framework refuses**, and the contrast
  is the useful part. An unbounded transform space reachable from a query string is
  caller-supplied input minting server work; a declared variant set is *declaration
  is a contract* answering the same need with a bounded one. Worth stating wherever
  the derivative work lands, because the convenient version is the one everybody
  builds first.
- **ThumbHash is the one idea to steal outright.** Bun's `placeholder()` returns a
  base64 PNG; ThumbHash is ~25 bytes and is small enough to live in the row beside
  the file rather than in a second request.

**One finding is worth filing whether or not any of this gets built**, and
`IDEAS/bun-natives.md` says so already: a stored file's type is currently the
caller's word for it — derived from `extname()` and mitigated with `nosniff`, while
`@accept("application/pdf")` grades the same caller-supplied string. `metadata()`
answers what the bytes *are*, which makes *this `.png` is an SVG* decidable at the
Data boundary. It is not in `ISSUES.md`.

---

## Still proposed, and NOT a package

Kept because each is worth *discussing* under a name. None of them earns a module.

| Name | Ships as | Why not a package |
| --- | --- | --- |
| **`lexicon`** — i18n | **The name of the WORK**, Homestead's shape. Decomposes into five existing homes: a derived key off `@label` (litestone), a string typed into a `.mesa` file (mesa, compile-time — the open half), per-locale routing and prerender (sierra), `db.$setLocale()` as a client flavor (litestone's client), formatting through `Intl` (toolbelt) | Localization is not declinable — it reaches the compiler, the router and the seed at once, which is the seat `Litestone ← Junction ← Sierra` does not have. **V2 per [`FJS-D12`](../DECISIONS.md#fjs-d12)**; alpha owes it six constraints, not a build. **The interface tier is open as [`FJS-D254`](../ISSUES.md#fjs-d254)** — the ruling reaches strings the schema derives and says nothing about the ones a person types, which is most of them |
| **`marshal`** — compliance from the seed | `@pii` / `@retain` as `.lite` syntax, the data map and DSAR as `fli` commands, the permission diff as the `access` CI phase (which already reports) | `warden`'s precedent exactly: a rule at the Data boundary is syntax. Only the erasure cascade is arguably machinery, and it is litestone's |
| **`quarry`** — demo data + a persona per gate level | `fli demo` over litestone's `autoFactories` and `actingAs` / `atLevel`, both shipped | A workflow somebody types. The missing piece is one command and a coherent dataset, not a module |
| **`lantern`** — observability | junction (a span tree over the existing `correlationId` and `traceparent`) plus one `fli` dashboard unifying `project:map --as=serve`, devtools and an API explorer | Tracing is not declinable and reaches every seam; a package holding it would be the core wearing another name |
| **`charts`** | `@frontierjs/ui` — `Sparkline`, `StatCard`, `Bar` and `Progress` already ship over the css tokens | Markup |
| **`porter`** — bulk data | `fli db import` / `fli db export` already exist; what is genuinely new is a screen, which is `ui` | The original row already suspected this and said so |
| **`flags`** | A slice — one model plus a plugin exposing `app.features` | The small test of whether the slice format is real |
| **`ledger`** — billing | A slice — models, service, webhooks, portal route. Built in `example`, never extracted | The canonical first slice, and still the proof the format works |
| **`shift`** — upgrade codemods | `fli` | Deferred for want of a stable surface to move between, not for want of value |
| **geo** | A `.lite` declaration plus a toolbelt kit for the distance math | Never proposed anywhere; **zero hits in the tree**. Named here so the gap has a home |

---

## Sequencing

The old sequence is void — it ranked four names of which three no longer exist as
packages. What is left is short:

1. **One `conduit-*` connector**, to prove the connector interface against a real
   vendor. Then a second that disagrees with it.
2. **`ledger` or `flags` as the first slice**, because `slices.md` has no ruling and
   nothing will settle it but building one.
3. **The `media` decomposition**, and it starts with neither a kit nor a seam: the
   file-type finding is free — `metadata()` makes *this `.png` is an SVG* decidable
   where `extname()` currently guesses — and the derivative store's owner needs the
   nine re-run against litestone's provider seam before anything is built.

Everything else on this page is either shipped, a command someone can write in an
afternoon, or V2.

## Open questions

- ~~**Which placeholder does a `File` column carry?**~~ **Answered 2026-09-19 (`FJS-D311`): A — `Bun.Image.placeholder()`, a base64 PNG blur. No new concept, no decoder to ship, and the same owner as the resize beside it.**
  - **A** — `Bun.Image.placeholder()`, a base64 PNG blur. No new concept, no decoder to ship, and the same owner as the resize beside it.
  - **B** — ThumbHash: ~25 bytes against a data URL's hundreds, small enough to live in the row rather than in a second request, and its decoder is pure enough to be a toolbelt kit.
  - **Recommend A** — a blur is cosmetic, so the failure is proportional and the concept budget decides it. **B reopens on a measurement**: a list response carrying N placeholders is where the byte difference stops being theoretical.
- **When are derivatives made?** Reworded 2026-09-19 from *where does the derivative
  store live*, which was the wrong axis: there is no second store — a variant is the
  same store keyed `<key>@<width>.<format>` — so what is unowned is the deriving and
  the addressing, and the owner falls out of the timing rather than being chosen
  beside it.
  - **A** — eager, at write, in litestone's `FileStorage`. The declared set is derived after the `put`; `resolve()` stays pure URL math and the read path keeps no app in it.
  - **B** — lazy, at read, in junction. A miss derives and stores. Needs a route, so the Data realm's bytes serve through the API realm, and the set must be bounded or the miss path is the transform server this framework refuses.
  - **C** — deferred to a job. Same declared set as A, none of the upload latency. **It has an owner problem rather than a design problem**: dispatching means Caravan, which sits above litestone (Invariant 1), so litestone can only DECLARE what is missing and something above it does the work — `needsBackfill`'s shape, and the migration differ's.
  - **Recommend A** — v1, with C as its own question once a real upload latency is measured. The nine are answered against A in § media below; 7 and 9 pass conditionally and their conditions are part of the work, not follow-up.
- **Is `FJS-D297`'s severability test worth promoting out of one ruling?** It decided
  eight rows on this page and is currently findable only from the offline ruling.
  Either it becomes a ruling of its own about packaging, or this file stays its only
  index — and an assessment is not allowed to be the index for doctrine (§ VII).
- **Which of these are slices rather than packages?** `ledger` and `flags` clearly.
  The distinction matters once `slices.md` gets a ruling.
- ~~**Does everything need to be a package?**~~ Answered by the test above. No.
- ~~**Does `email-kit`'s name/directory mismatch get fixed?**~~ Ruled 2026-08-06: the
  package is `@frontierjs/email-kit` and the directory already agreed.

## See also

- `IDEAS/permission-sets.md` — **`warden`'s own record**, and the first run of this file's test
- `IDEAS/ecosystem-gaps.md` — the Laravel comparison; most of the original tier 1 originates there
- `IDEAS/stressors.md` — products worth building to find a seam. Its three
  no-exercise-needed gaps are i18n, an image pipeline and geo, all three of which land on this page
- `IDEAS/slices.md` — `ledger` and `flags` are slices, not packages
- `IDEAS/agent-surface.md`, `IDEAS/compliance-from-the-seed.md` — the proposals behind `mcp` (shipped) and `marshal`
- `IDEAS/bun-natives.md` — **the measured record behind the `media` row.** `Bun.Image` is
  the one native in Bun 1.4 this workspace can adopt, and the nine rejections beside it
  are the clearest worked example of the test at the top of this file
- `IDEAS/offline-first-and-release.md` — the Homestead work
- `IDEAS/lexicon.md` — i18n's own record, and the source of `FJS-D254`
- `IDEAS/live-queries.md` — query-scoped subscriptions; the WS implementation is interim
- `IDEAS/command-surface.md` — **no package, and the finding is the reverse of most rows
  here.** Sized against oclif, `fli`'s authoring model is ahead and its *distribution*
  model is the gap: a package cannot ship a command, so the CLI's tree hand-copies what
  belongs to `auth`
- `IDEAS/app-manifest.md` — `frontier.config.js` + `frontier.lock`; `fli` rather than a package
- `IDEAS/time-travel.md`, `IDEAS/derived-suspense.md`, `IDEAS/form-actions.md`,
  `IDEAS/server-only-boundary.md`, `IDEAS/declared-semantics.md` — five more proposals
  that want no name of their own, listed so the register does not read as though every
  idea needs one. `declared-semantics.md` holds the one genuinely unnamed noun in the
  tree: a resumable multi-step process, which is neither a Job nor a field machine and
  should not be named until it has a design
- `pros-and-cons.md` — ranked `foundry` and `warden` first; both have since landed as
  something other than a package, which is this file's finding in miniature
- `CLAUDE.md` § Packages — the authoritative state of what exists
