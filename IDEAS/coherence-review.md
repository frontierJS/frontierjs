---
id: coherence-review
status: assessment
dated: 2026-07-31
---

# Idea — The coherence review: eight findings across twelve packages

**Status: ARGUED, NOT ADOPTED.** Dated 2026-07-31/08-01 and unchanged since —
this is the synthesis half of the twelve-package audit, kept verbatim. Twelve
parallel explorers, each given `ARCHITECT.md` §6 verbatim, each returning the
same template; synthesized per §7. The method is in `ARCHITECT.md` §6 and is
reusable; this is what it found.

**It is the argument behind [`FJS-D06`](../ISSUES.md), which is still open.**
Three neighbouring questions were ruled 2026-08-06 and are no longer part of
that row — read `DECISIONS.md` before treating any proposal here as pending.
Parts of the eight have moved on their own since, which is the argument for
reading the register first: §2's *jetty hardcodes Feathers-style names* closed
as `FJS-059` (a colon is the bus spelling, the wire carries a space, and a
channel is not an event), while its *litestone `onEvent` has zero listeners*
half is still open as `FJS-010`, blocked on `FJS-D04`. §8's *no tsconfig
outside vscode* closed as `FJS-035` — every workspace member has one now.

**Not a register.** Nothing here is open by being here. A finding still open has
an `FJS-###` in `ISSUES.md`; a settled one has a ruling in `DECISIONS.md`. The
per-package half of the audit is not kept: each package's `PROJECT_STATE.md` is
the live version, and the appendix bug list was superseded by `ISSUES.md` before
this record was made.

*This record was `drift-report.md` at the repo root until 2026-08-15. The
resolution log and the twelve per-package sections went with it —
`DECISIONS.md` § Repo conventions says why.*

---

## The eight, ranked by cost of being wrong

**1 · `Hook` is one word for five mechanisms** — phase chain (junction
before/after/around/error; sierra resource hooks), boundary checkpoint (sierra
`beforeNavigate`; gate enforcement), transport Request→Response wrappers
(junction "middleware" — the forced `rateLimit` vs `rateLimitHook` rename is
the receipt), fire-and-forget observers (`ConduitHooks`), required single-slot
delegates (auth's `onPasswordResetRequested`). Litestone alone has three
(transform hooks / plugin veto interceptors / post-commit notifications).
Proposed split, by "can it change the outcome?" and "is it required?":
**Hook** (mutate/halt) / **Guard** (allow-deny only) / **Observer**
(fire-and-forget) / **Delegate** (required performer). Junction's four-field
context split (`auth` frozen+propagates, `client` read-only+propagates,
`route` router-only, `locals` fresh-per-call) is the done convergence work for
§5's "hook context shape" item — promote it.

**2 · Real-time has three origins and two dead ends** — litestone `onEvent`:
zero listeners; junction emits each lifecycle moment twice (`svc:created` on
`app.events` vs `svc created` on channels; the browser parses only the space
form); jetty hardcodes Feathers-style names nothing declares; auth emits
nothing; caravan emits telemetry only. Concrete failure: an `asSystem()` write
in a job emits an event nobody hears. Fix shape: Data realm is the single
origin (junction subscribes to litestone `onEvent` and derives), event names
declared not assumed, colon/space collapsed, **Event** vs **Trace** (telemetry)
split in vocabulary.

**3 · `Resource` is the weakest core noun** — sierra files its own primary noun
under `src/junction/` as an integration detail; jetty hand-copied the
implementation (already diverged); junction's client has a third, thinner
`resource()` contract; three reactivity idioms coexist. Proposals: UI realm
gets a second noun **Component** (what the UI *is* — Mesa) beside Resource
(what the UI *gets* — Sierra); **Binding** names the reactive seam
(`watchProxy`); extract a shared `resources-core` to end the jetty/sierra copy.

**4 · One missing concept, invented independently four times** — a swappable
implementation of a contract: auth "provider" (`IAuth`), notifications
"driver", junction mail "adapters", conduit transports. One vocabulary entry
(**Provider**: "a Plugin adds; a Provider replaces"). Related nameless
load-bearers: **Envelope** (junction's result shape — its namelessness caused
the `protect()` password leak), **Transport** (notifications' "channel"),
**Target** (conduit), **Job** (caravan).

**5 · `Plugin` does double duty** — small composable extension vs whole domain
facility attaching via the protocol (caravan/conduit/auth). "One plugin, one
job" is meaningful for the first and meaningless for the second. Also: the
plugin protocol itself violates principle 2 (every `register()` mutates the
host app; `_metricsProviders` reach-through) — bless named attachment points
(`app.registerMetricsProvider(...)`) or write the exception down.

**6 · Remaining word collisions** — `Channel` broadcast-set vs delivery-medium
(both load-bearing in one notifications file); `Boundary` realm↔realm vs
app↔world (**Edge** proposed); `Manifest` claimed by Deployment noun, MV3
`manifest.json`, and sierra's route table (cede to MV3: Deployment noun →
**Release**, sierra's → **Route Table**); `Gate` = ordinal check vs SQL policy
(litestone's own docs call them orthogonal: **Gate** vs **Policy**);
`Trust Hierarchy` appears zero times in code (code says `LEVELS`).

**7 · The domain map lacks an axis** — realm and domain are orthogonal
coordinates forced into one field; nearly every package is a cross-cut
(junction hosts seams of D3/4/5/6/7; the CLI owns the Deployment realm).
auth and notifications are a *shape* the map can't express: vertical
**Slices** (schema fragment + service + plugin + resource as one unit) —
add as a second axis, which also predicts what `fli add <slice>` scaffolds.
Domain 8 is a junk drawer; jetty/css/mesa-vite/vscode are unmapped; Orion and
Basecamp are mapped but absent.

**8 · The dependency graph is prose** — the stated direction is real but wired
by peer-deps, dynamic imports, duck-typing, and copies. Sierra: three
undeclared workspace deps + two hand-rolled exports-map resolvers guarded by
11 tests. No tsconfig outside vscode, so declared-type bridges are never
checked. Every convention-wired bridge found was broken somewhere; every
named/typed one had survived.

**Principle revisions the code argues for** — P1's "and nothing more" is
falsified by shipped Litestone (topology, retention, FTS, state machines);
real content is "no UI behavior, no business logic" + a named exemption for
framework-owned storage (jobs table, `conduit_targets`, sessions), and the
seed's canonical path should be owned by litestone, not asserted by sierra.
P3 needs stated carve-outs (transport directives `ctx.dispatch`/`statusCode`;
sierra `provideSlot`; LSP pushes; build pipelines). §5's query-param entry was
wrong (`$skip` exists nowhere; the gap is only the `$` prefix).
