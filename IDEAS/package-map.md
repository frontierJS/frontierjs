---
id: package-map
status: assessment
dated: 2026-08-04
---

# Idea — The package map: what exists, and what should

**Status: ASSESSMENT + PROPOSAL.** Dated 2026-08-04. The "exists today" column was
read off the tree; everything under *Proposed* is unbuilt and the names are
suggestions, not rulings. Do not cite the proposed section as describing behavior —
see `VERIFYING.md`.

This is a register, not a roadmap. It answers one question — *what top-level
packages should this project have?* — and gathers proposals that are currently
spread across six `IDEAS/` files plus two that had no home.

---

## Naming

The existing names are a westward-expedition vocabulary: **litestone, junction,
sierra, mesa, caravan, conduit, jetty, basecamp, orion**. Proposals below stay in
it, on the argument that a consistent naming register is worth more than each name
being individually self-describing — the framework already accepts that trade.

**`packages/orion/` is an empty directory.** It is inside the `packages/*` workspace
glob, contains no files at all, and appears in no document in the repo. Either it is
a reservation that should be named for what it is, or it should be removed before
someone reads it as a package that failed to install.

---

## Exists today

| Package | Realm | Note |
| --- | --- | --- |
| `litestone` | Data | published, 1.1.0 |
| `junction` | API | the largest surface |
| `sierra` | UI meta | routing + build |
| `mesa` | UI substrate | true leaf — keep it that way |
| `css` | UI | design system |
| `ui` | UI | component kit over `css` |
| `email-kit` | UI / email | ships as `@frontierjs/email-kit` |
| `auth` | D6 | native provider; no OAuth |
| `caravan` | D5 | jobs + cron |
| `conduit` | D4 | outbound boundary |
| `notifications` | slice | the closest thing to a vertical slice today |
| `cli` (`fli`) | D1 | markdown-native runtime |
| `jetty` | UI container | browser-extension shell |
| `frontierjs-vscode` | D1 | editor support |
| `basecamp` | app | **not a library** — the dogfooding surface |
| `orion` | — | **empty directory** (see above) |

---

## Proposed

### Tier 0 — the framework is incomplete without these

| Name | Realm | What it is | Source |
| --- | --- | --- | --- |
| **`foundry`** | UI | **Schema → UI.** `<AutoForm resource={posts}>`, `<AutoTable>`, `<AutoFilter>`, and a gate-aware generated admin. Absorbs and replaces `fli admin:generate`, which emits `.svelte` and is drifted past usefulness. | `framework-shape.md` item 1; `PROS_AND_CONS.md` con 6 |
| **`depot`** | Release | The realm with no package. Artifact kinds first-class (single binary / container / static+API / PWA), preview environments, provisioning from declarations — degrading to nothing for the one-file path. | `offline-first-and-release.md`, `operational-edge.md`, `framework-shape.md` item 3 |
| **`assay`** | Testing | The Suite noun. Junction's test kit extracted, `createTestEnv`, factories from field rules, a browser harness, and **derived per-model suites**. The plug slices' `suite/` part needs. | `testing-and-ci.md` |
| **`create-frontier`** | — | `npm create frontier@latest`. Unglamorous and the highest-leverage adoption surface any framework has; today there is no path from the website to a running app that does not involve cloning a monorepo. | `ecosystem-gaps.md` § starter kits |

**Why `foundry` is first.** The expensive half is built — the browser already has
the constraint table, the relations, the gate and the validator. What is missing is
the visible half, and nothing else on this list changes how the framework *reads* to
a newcomer as much. It is also what makes a Slice's `resource/` part worth shipping
at all (`slices.md`, `framework-shape.md`).

### Tier 1 — an app cannot reach production without these

| Name | Realm | What it is | Source |
| --- | --- | --- | --- |
| ~~**`stow`**~~ | API | **Retired as a package name 2026-08-12.** It was reserved for object-storage drivers on the belief that none existed; litestone has shipped an S3/R2/B2/MinIO provider over hand-written sigv4 signing for some time, with `File` columns and presigned URLs. What is left is not a package — it is that Junction's separate local-disk `IFileStorage` is a **second** abstraction for the same job (Invariant 4), to be delegated or retired. | `ecosystem-gaps.md` item 3 |
| **`ledger`** | Slice | Billing — models + service + webhooks + portal route. The canonical first slice and the proof the format works. | `ecosystem-gaps.md` tier-1 item 2 |
| **`warden`** | API | **The answer to the linear ladder.** Named permissions and roles layered over the 0–9 scale, so `@@gate("4")` stays the default and orthogonal permissions stop forcing a retreat into hooks. | `PROS_AND_CONS.md` con 2 |
| **`lantern`** | API | Observability — real spans (there is a `correlationId` and a seam list, not a tree), request-correlated logs, metrics, and the local dev dashboard unifying `project:view` + devtools + traces + an API explorer. | `operational-edge.md` item 3, `framework-shape.md` item 4 |
| OAuth → **`auth`** | API | Not a new package. The `Credential` model already carries `type` / `accessToken` / `refreshToken` / `scope`. Plus TOTP and passkeys. | `ecosystem-gaps.md` tier-1 item 1 |

**`warden` is the one with a ceiling behind it.** Without it, the framework's best
feature caps out the moment an app needs two permissions that are not comparable —
which is most apps, fairly early.

### Tier 2 — the differentiators

| Name | Realm | What it is | Source |
| --- | --- | --- | --- |
| **`compass`** | Data + UI | The offline/sync engine — client-side SQLite (OPFS / wa-sqlite), mutation queue, local gate evaluation, `@@sync` conflict policy. Its own package because "one engine on both sides" is the strongest structural advantage FJS holds over Prisma and Drizzle. | `offline-first-and-release.md` |
| **`herald`** | API | The agent surface — an MCP server derived from the seed, with the gate as the permission model and tool visibility computed per session level. | `agent-surface.md` |
| **`marshal`** | Data | Compliance from the seed — `@pii` / `@retain`, the data map, DSAR, erasure cascade, and a permission diff on every pull request. | `compliance-from-the-seed.md` |
| **`lexicon`** | UI | i18n. **V2 — ruled 2026-08-15 (`FJS-D12`).** Its design question is answered without the package existing: `@label` stays a default English string and the key is DERIVED (`Model.field.label`), so the schema never becomes a catalogue. It was never a gate on `foundry` either — a generator authors no string. Alpha owes it six constraints, not a build; when it is built, three things are reserved for it — a seed-derived `strings.snapshot.md`, `db.$setLocale()` as a client flavour, and per-locale prerender. | `ecosystem-gaps.md` tier-1 item 4 · `DECISIONS.md` |
| **`atlas`** | Meta | The app model as a product. `project:map --json` already *is* one and nothing reads it. Generated architecture diagrams (retiring the hand-drawn `website/journey.html`), the permission matrix, drift detection, the outbound-surface report. Shared substrate for `marshal` and `depot`. | `operational-edge.md` |
| **`quarry`** | Data | Demo and seed data. Adjacent to factories, distinct from them: a coherent fake dataset **plus a persona at every gate level**, so `fli demo` boots an app you can click through as STRANGER, USER and ADMIN with no fixtures. This is how the framework gets *shown*, and it is what `foundry` needs something to render. | new |

### Also worth naming

| Name | What it is |
| --- | --- |
| **`charts`** | Dataviz over the `css` tokens. `foundry` will want it immediately; every admin needs it. |
| **`media`** | Image resizing and transforms. Paired with litestone's `FileStorage` plugin, which is where the bytes already are. |
| **`chronos`** | Time semantics from the seed — instant vs zoned wall-clock vs plain date, whose zone resolves a value, and the small useful subset of recurrence. Named here mostly to ask whether it is a package at all: it is probably a litestone declaration plus an `Intl` reader, and the thing to avoid is writing a date library. Note the collision — `packages/datetime-kit/` is a README with no package under it and may be this, or may be a component kit that should not share the name. | `time-and-recurrence.md` |
| **`porter`** | Bulk data — the derived import template, the per-row report, and an export that is a `find` rather than a table scan. Named provisionally and probably wrongly: the template and validator belong beside `foundry`'s generator, the parser already lives in litestone's seeder, and what is genuinely new is a screen. A candidate for *not a package*. | `bulk-data.md` |
| **`flags`** | Feature flags — one model plus a plugin exposing `app.features`. A good early test that the slice format is real, precisely because it is small. |
| **`shift`** | The upgrade codemod tool. Deferred not for low value but because it needs a stable surface to move between; worth reserving the name. |

---

## Sequencing

1. **`foundry`** — makes the thesis visible. Everything else is easier to explain
   once someone has watched a form build itself from a schema.
2. **`create-frontier` + `quarry`** — a demo nobody can run is a demo nobody sees.
3. **`depot`** — the Release hole, found independently by three separate analyses.
4. **`herald` and `marshal`** — the two that make FJS *unlike* anything else, and
   both cheap, because the decisions that make them possible are already made.

`warden` interleaves: it is not urgent until an app hits the ladder's ceiling, and
it is very urgent the moment one does.

## Open questions

- **Does everything need to be a package?** `warden`, `quarry` and `flags` are all
  arguably features of `auth`, `litestone` and a slice respectively. The register
  errs toward naming things separately so they can be *discussed* separately; the
  packaging decision is downstream.
- **What is `orion` for?**
- **Which of these are slices rather than packages?** `ledger` and `flags` clearly.
  `marshal` probably is a package with a slice-shaped install. The distinction
  matters once `slices.md` gets a ruling in `DECISIONS.md`.
- ~~**Does `email-kit`'s name/directory mismatch get fixed?**~~ Ruled 2026-08-06:
  the package is `@frontierjs/email-kit` and the directory already agreed. The
  old name survived only in prose and comments, which is the form this kind of
  thing takes once the code is right.

## See also

- `IDEAS/framework-shape.md` — the realm-by-realm gap assessment this indexes
- `IDEAS/ecosystem-gaps.md` — the Laravel comparison; most of tier 1 originates there
- `IDEAS/slices.md` — several entries above are slices, not packages
- `IDEAS/agent-surface.md`, `IDEAS/compliance-from-the-seed.md` — the two proposals
  that had no home before this file
- `IDEAS/live-queries.md` — query-scoped subscriptions; the WS implementation is
  interim and `compass` supersedes it
- `IDEAS/diagnostics.md` — `fli doctor`; a `fli` command rather than a package, but it
  shares `project:map --json` with `atlas`
- `IDEAS/command-surface.md` — **no package, and the finding is the reverse of most
  rows here.** Sized against oclif, `fli`'s authoring model is ahead and its
  *distribution* model is the gap: a package cannot ship a command, so the CLI's tree
  hand-copies what belongs to `auth`. Item 1 is the command-shaped half of `slices.md`
  and item 2 is the CLI half of `herald` — neither wants a name of its own
- `IDEAS/app-manifest.md` — `frontier.config.js` + `frontier.lock`; also `fli` rather
  than a package, and the lock may simply *be* `project:map --json`, committed
- `IDEAS/time-travel.md` — named checkpoints over the audit trail; `fli` commands over
  litestone, and the cheapest thing `quarry` and `assay` can both stand on
- `IDEAS/derived-suspense.md` — a Mesa compiler change, no package; listed here so the
  register does not read as though every idea needs a name
- `IDEAS/client-data-lifecycle.md` — **no package, and that is the finding.** Request
  staleness, optimism and entity identity are three faces of one owner nothing in the
  repo has: sierra's `createResource` is a hook pipeline over a pass-through client
  and has no model of time. Whether that owner is a name of its own or a layer inside
  `sierra/junction` is open — it is small, and it sits under `compass` rather than
  beside it
- `IDEAS/form-actions.md` and `IDEAS/server-only-boundary.md` — **sierra, no new
  package, and they want one design.** Both turn on the same unbuilt thing:
  module scope that runs but does not ship. Today `<script module>` is
  browser-only (Mesa rule 30) and Invariant 18 makes it a Resource's home, so
  splitting it is the real work in either
- `IDEAS/declared-semantics.md` — **litestone, no new package.** Four attributes
  (`@version`, `Money`, `@eventTime`/`@recordTime`) plus one genuinely unnamed
  noun: a resumable multi-step process, which is neither a Job (Caravan) nor a
  field machine (`@@transitions`) and would be built from both. If anything here
  earns a package name it is that one, and it should not be named until it has a
  design
- `IDEAS/forms-from-the-seed.md` — the remainder of `foundry` after `<Form>` shipped
  on 2026-08-06. What is left is the field *list* and a control table with one home,
  which is the same table a UI plugin would contribute to — so this is where the
  `FJS-D17` question about what a UI plugin can contribute gets its first real answer
- `PROS_AND_CONS.md` — `foundry` and `warden` are the two fixes it ranks first
- `CLAUDE.md` § Packages — the authoritative state of what exists
