# Basecamp — project state

Last reviewed by running: **2026-08-24**.

> **Picking up this app?** `surface.snapshot.md` is the API contract. Run `bun run verify` before
> changing anything — it drives all three realms in a real browser.

Basecamp is an **FJS application, not a library** — fleet operations: provision
servers, ship releases, install appliances. It is the largest thing FrontierJS
has ever been used to build, which is why its divergences matter more than the
usual drift note: **every one of them is evidence about the framework.**

`docs/VISION.md` describes what Basecamp is meant to be and says so at the top.
This file describes what it currently does.

## Snapshot

| Realm | State |
| --- | --- |
| **Data** (`db/`) | **Real.** `schema.lite` is the seed — `db/access.snapshot.md` (`litestone access`) is the generated, checkable count of models, gates and policies rather than a number retyped here; 0 parse errors and one standing warning. **Every model declares `@@gate`**, graded per WORKSPACE by `api/src/core/gate.ts`. **Three carry a declared state machine** — `Server`, `Deployment` and `Job` — so a status move is a compare-and-swap with its own authority level rather than a from-list in a service file. Row scoping is the declared `tenancy { }` block rather than hand-written allows: some models declare `@@tenant(none)` by name, most are scoped by their own `workspaceId`, and the rest are scoped through a parent — inferred, not declared, and reported as that one warning. `@@tenant(via: rel)` is the wrong answer for a model with two scoped parents: they get one deny each and they are AND'd, so naming one drops the other |
| **API** (`api/`) | **Real.** Services and job files on Litestone accessors, zero raw SQL. Most are workspace-scoped; a few are not and each says so in the schema rather than in a hook — `hub` (over no model), plus `blueprints`, `hub-config`, `backups` and `notification-preferences`, whose models are `@@tenant(none)`, which is what makes junction's `tenantClaimGuard` exempt them. Several sit behind `requireSystemAdmin`; `blueprints` reads at VISITOR(1), because browsing the catalog is what a person with no workspace yet is doing |
| **UI** (`web/`) | **Real.** Sierra SPA over every service, driven end to end in a browser by `bun run verify`, and the BUILT output probed by `bun run verify:build` |

## How to run it

```bash
bun run dev          # API on :8120, UI on :8020
bun run db:seed      # an example fleet to look at
bun run verify:screens # blueprints · registry · backups · hub settings · your settings
bun run verify       # drive the whole thing in a browser (add --reset)
```

Sign in as `sam@example.com` / `hunter2hunter2` after seeding, or use the setup
wizard on an empty database.

## Open

Open defects are in `../../ISSUES.md`. What is owed here without an id:

### Adapters — four screens, each waiting on one (2026-08-30)

**Every boundary is declared and nothing is behind any of them.** `IEdge` and
`ICloudSpend` were added and `IGit` was widened on 2026-08-30, so all ten
providers now have an interface, a stub and a portal entry — and `/dns/`,
`/cloud-spend/`, `/git-activity/` and `/observability/` each report their own
adapter's state off that portal rather than hardcoding it.

What is left per adapter is the same two steps: a `@frontierjs/conduit` target
with its token as a `Secret`, then a service in front of it. **No service before
an adapter** — one returning stub emptiness makes the screen render an empty
table, which is indistinguishable from a vendor with nothing to report and is the
exact failure those skeletons exist to avoid.

`docs/ADAPTERS.md` is the pick-up doc: the ten, what each of the four costs, the
decisions already made (money in minor units, `forServer` keyed on
`providerServerId`, the job-not-vendor naming, stubs that answer empty) and the
four drive assertions that go red the day one is wired — which is correct, and
the fix is a fake vendor on a port of its own, the way `verify:stripe` does it.

## Verification

| | |
|---|---|
| `bun run test` | the data layer (schema, gates, who may write the columns the gate is graded from, encryption, auth compatibility) and the API tier through `@frontierjs/testing`, which is where the standing rules are graded: schema, gates, who may write the columns the gate is graded from, encryption, auth compatibility, the alert-delivery join, what an API key's table may not contain, where a volume's tenancy comes from, that the widget vocabulary is one list rather than two, and that a recipe run keeps the script it ran while the reclaim vocabulary has exactly one home |
| `bun run verify` | browser checks across all three realms, incl. an a11y pass on every screen |
| `bun run verify:build` | the PRODUCTION build — the tags survive comment-stripping, and the page comes up in a real browser |
| `bun run verify:screens` | browser checks on a database it seeds in a temp directory — the Phase 13 and 14 screens, the audit window, and the adapter states `/admin/adapters/` reports |
| `bun run db:check` | fails if the migration has drifted from `db/schema.lite` |
| `bun run typecheck` | at the committed baseline (`scripts/typecheck-baselines.json`) |
| `bun run db:types` | regenerates `db/schema.d.ts` from the schema (`audience=system`). `bun run test` fails if the committed file is stale |
| `bun run db:seed --force` | the only thing here that writes every model — and `db/test/seed.test.ts` runs the script itself, from a throwaway directory, so it cannot rot unnoticed again |

Nothing in this file was established by reading. The data claims were verified
against a live database, the API claims over HTTP, and the UI claims by driving
a real browser.
