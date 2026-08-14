# FrontierJS — Architect

The mental model and its vocabulary. This is the *what*; the layers around it:
`PHILOSOPHY.md` (the axioms — why), `DECISIONS.md` (dated rulings — settled),
`CLAUDE.md` (the map — where), `drift-report.md` (the current gap between this
document and the code — audited 2026-07/08 against all twelve packages).

Do not paraphrase the vocabulary. Do not invent parallel terms.

---

## 1. The Mental Model

FrontierJS has one mental model: **three realms, three nouns.**

| Realm | Primary Noun | Concern                                    |
| ----- | ------------ | ------------------------------------------ |
| Data  | **Model**    | What exists and what rules govern it       |
| API   | **Service**  | What operations are exposed and how        |
| UI    | **Resource** | How the UI binds to and consumes a service |

Two further realms describe what an application *becomes*:

| Realm      | Primary Noun           | Concern                            |
| ---------- | ---------------------- | ---------------------------------- |
| Deployment | **Manifest / Release** | How the application ships and runs |
| Testing    | **Suite / Test**       | How the application is verified    |

A developer who understands Model, Service, Resource should be able to predict
how any feature works before reading its docs. Keeping that model small is the
point of the whole framework — predictability is the product.

The full-repo audit confirmed the triad holds for *the application a developer
writes*. It also found the vocabulary stops at the application boundary: the
framework's own machinery (jobs, outbound targets, providers, rendering
substrate) has concepts the table below cannot yet name — see §2's
under-review list and `drift-report.md` §synthesis.

---

## 2. Vocabulary — Non-Negotiable

Use the left column. Never the right.

| Use                         | Not                                         |
| --------------------------- | ------------------------------------------- |
| **Realm**                   | layer, tier, side                           |
| **Model**                   | table, entity, record type                  |
| **Service**                 | controller, endpoint, handler               |
| **Resource**                | store, state manager, data hook             |
| **Hook**                    | middleware, interceptor, lifecycle callback |
| **Boundary**                | layer boundary, API boundary (generic)      |
| **Channel**                 | room, topic, subscription                   |
| **Event**                   | message, notification                       |
| **Gate**                    | permission, policy, ACL                     |
| **Trust Hierarchy**         | roles, permissions, access levels           |
| **Plugin**                  | middleware, extension, addon                |
| **Context**                 | request context, state, payload             |
| **Chain of Responsibility** | pipeline, middleware stack, flow            |
| **Signal**                  | observable, atom, ref, store (for the cell) |
| **Projection**              | (nothing — new noun, see below)             |

Clarifications settled by the code:

- **Signal is not Event, and both are legal words.** A **Signal** is Mesa's
  reactive cell; an **Event** is Junction's announcement. *signal* used to sit in
  the Event row's "not" column, which was aimed at "signal" meaning
  *notification* and accidentally banned the word Mesa's runtime, docs and White
  Paper use for their core primitive. The ban now reads: never call an Event a
  signal. A Signal never crosses a Boundary; an Event exists only to. (Ruled
  2026-08-06 — `DECISIONS.md`.)
- **Projection** is a *stored or served* second shape of the same truth — a
  materialised view, a serialised subset, a report. What a compiler or a
  component computes and throws away stays **derived**. If it has no independent
  existence, it is not a Projection. (Ruled 2026-08-06.)
- **Policy has two meanings and will not get a third.** Gate = the ordinal
  per-operation check; policies = `@@allow`/`@@deny` row/field predicates. A
  proposed third sense ("declarative business rule vs imperative mechanism") is
  refused — the words for that are already **Declaration** and **Hook**.
  (Ruled 2026-08-06.)

- **Gate** is the ordinal per-operation level check (`@@gate`, resolved against
  the Trust Hierarchy, enforced by default when declared). Row/field predicates
  (`@@allow`/`@@deny`, compiled into SQL) are a second, orthogonal mechanism —
  Litestone's docs call them **policies**. Don't use one word for both.
- **Trust Hierarchy** is the 0–9 scale (`STRANGER`…`LOCKED`) implemented as
  `LEVELS` in `packages/litestone/src/plugins/gate.js`. Named levels are the
  canonical way to write gates (`@@gate(read: READER, write: USER, …)`).
- Model naming: **PascalCase, singular — always**; `@@external` models exempt.
  (Ruled — `DECISIONS.md`.)

**Two channels, kept separate.** When you *describe* the codebase, use these
words and only these words. When you *evaluate* the vocabulary itself, do it
explicitly — never silently substitute a better word into a description. The
vocabulary is mandatory for describing and fully open for challenging.

### Under review — found by the audit, not yet adopted

These concepts exist in the code without names, or share a name that is doing
two jobs. Arguments in `drift-report.md` §synthesis; status in `DECISIONS.md`
§Open. Do not use them as settled vocabulary yet:

- **Hook split** — Hook (may mutate/halt) / Guard (allow-deny) / Observer
  (fire-and-forget) / Delegate (required single-slot). Today "Hook" covers
  five mechanisms.
- **Provider** — a swappable implementation of a contract (`IAuth`, mail
  adapters, notification drivers, conduit transports). "A Plugin adds; a
  Provider replaces."
- **Job** (Caravan), **Target** (Conduit), **Envelope** (Junction's result
  shape), **Transport** (delivery medium vs Channel's broadcast set).
- **Component** (what the UI *is* — Mesa) beside Resource (what the UI *gets*),
  and **Binding** (the reactive seam, `watchProxy`).
- **Edge** (app↔world seam) vs Boundary (realm↔realm); Deployment noun →
  **Release** (ceding "Manifest" to MV3); **Slice** (a package shape that
  crosses all realms deliberately — auth, notifications).
- **The Deployment realm's four nouns**, proposed in
  `IDEAS/release-transitions.md` and unbuilt: a **Release** is immutable and
  environment-independent (image, config values, secret *references*, schema
  version, asset manifest, declared pivot); an **Environment** is mutable but
  generational and provides bindings only; an **Audience** is a named set of
  principals a Release may be served to — cohort routing, not a percentage
  canary; a **Pivot** is the transition at which N-1 compatibility ends, which
  is the same test for a contract migration, a client retention window and a
  gradual rollout. Two open collisions before any of it is settled: Audience is
  a set of principals and may belong to the Data realm beside the Trust
  Hierarchy, and *binding* is already claimed by Mesa's reactive seam in the
  list above.

---

## 3. Core Principles

Standing rules the framework is designed against.

1. **The schema is the seed.** `db/schema.lite` declares everything that is
   true about the data over its whole life — fields, types, constraints,
   relations, access, lifecycle, even storage topology. What it never encodes:
   UI behavior and business logic. Growth happens outward; it all traces back.
   *Named exemption:* framework-owned storage (job queues, outbound-target
   registries, session stores) deliberately lives outside the seed — that gap
   is intentional, not drift.
2. **Boundaries are checkpoints, not walls.** A realm affects another realm
   through hooks at the boundary, never by reaching into its internals — and a
   checkpoint that exists only in prose is a wish: name it, type it, test it.
3. **The chain has a direction.** Requests travel down as `data + query`;
   responses travel up as `result or error`. Pushing data upstream is a smell,
   with three named exceptions that are *not* smells: transport directives
   (`ctx.dispatch`, `ctx.statusCode`), render-time composition (a page
   providing a snippet to its layout), and build pipelines that accumulate
   state — those are different shapes, not violations.
4. **Hooks are the extension mechanism.** If behavior belongs at a boundary,
   it is a hook.
5. **Plugins extend realms without modifying core.** One plugin, one job.
   Plugins compose. (Known strain: whole domain facilities also attach via the
   plugin protocol — see §2 under-review.)
6. **Access is declared, not programmed — and declaration enforces.** Gates in
   the schema, resolved against the 0–9 Trust Hierarchy, enforced from the
   first request with no further wiring; a shipped default resolver, overridable.
   The converse binds too: a model with no gate is open, honestly. `asSystem()`
   is the audited bypass.
7. **Real-time is core.** Every fact has one origin; change flows outward —
   origin → event → channel → binding. Any parallel sync mechanism or second
   emitter for the same fact is a smell. (The current code is known to
   fall short of this — three origins for "a row changed"; the consolidation
   is sequenced in `drift-report.md`.)
8. **The UI binds, it does not own.** The browser holds a reference to data,
   never a second copy of the data model.
9. **Solve for the 80, leave an escape for the 20.** Every decision needs a
   documented escape hatch — and the paved road must remain the best road: an
   escape hatch that outperforms the default means the default has failed.
10. **Everything composes.** Consistent interfaces are what make composition
    possible.

**The guiding question for every design decision:** *Does this reduce the
inertia between developer intent and running software — without enlarging the
mental model?*

**Accidental gaps** (systems that should share an origin and don't) are
eliminated. **Intentional gaps** (genuinely different concerns) are respected
— and written down as intentional. Do not confuse the two.

---

## 4. The Domain Map

Beyond the application sits the FJS World — the operational environment.
**This structure is not locked**, and the audit showed its main weakness:
realm and domain are orthogonal axes, and several packages legitimately
cross both (a possible second axis — the **Slice** — is under review).

| Domain                           | Concern                                          | Actual tool(s)                          |
| -------------------------------- | ------------------------------------------------ | --------------------------------------- |
| 1 — Developer Interface          | CLI, editor tooling, scaffolds                   | `fli` (working) · frontierjs-vscode (stub) |
| 2 — Database                     | Schema, migrations, ORM, gates                   | **Litestone** (shipped)                 |
| 3 — Configuration & Secrets      | Env config, secrets, runtime context             | `frontier.config.js` + per-tool configs (unconsolidated) |
| 4 — Integrations & Messaging     | Outbound third-party connections                 | **Conduit** (shipped, narrow)           |
| 5 — Automation & Orchestration   | Jobs, queues, schedules, workflows               | **Caravan** (working) · Orion (planned, absent) |
| 6 — Authentication               | Identity, sessions, trust resolution             | `@frontierjs/auth` (working)            |
| 7 — Observability                | Monitoring, logging, environment awareness       | Basecamp (planned, absent) · today: junction telemetry/health/devtools |
| 8 — Application & Infrastructure | The application itself; contains the five realms | **Junction** (API) · **Sierra** (UI meta) · **Mesa** (UI substrate, leaf) |

Placements the original map didn't anticipate: **jetty** (a browser-extension
application *container* — UI realm plus its own build/deploy surface),
**css** (presentation — the UI realm's unbudgeted second concern), and
**auth**/**notifications** as vertical Slices that ship a schema fragment, a
service, a plugin, and a resource as one unit.

Dependency direction across the core: `Litestone ← Junction ← Sierra`, with
Mesa a strict leaf. Never the reverse, in any package.

---

## 5. What Is Unsettled

Report these accurately; don't treat them as bugs.

- **Authentication** — working; developer-facing API not finalized. Auth's own
  `/auth/*` routes intentionally bypass the Service abstraction (login cannot
  be gated by login).
- **Custom service methods** — called `actions`; the *name* is under review;
  the dispatch is settled: `X-Service-Method` header, case-preserved
  (`DECISIONS.md`).
- **Multi-tenancy** — db-per-tenant implemented at the Litestone level; config
  API under design; row-scoped tenancy has no primitive yet.
- **Hook context shape** — differs across realms; Junction's four-field split
  (`auth` frozen-propagates · `client` read-only-propagates · `route`
  router-only · `locals` fresh-per-call) is the candidate framework standard.
- **UI plugin system** — limited today.
- **JSON Schema → UI** — drives `make()` only; validation and transformation
  still to come.
- **Query params** — `$limit`/`$offset` at UI/API vs `limit`/`offset` in
  Litestone; the gap is exactly the `$` prefix (`$skip` exists nowhere).
- **`@@strict`** — per-model escalation of read-warnings to errors: parked.
- **Deployment** — the realm with no package. What a deploy may *promise* is
  argued in `IDEAS/release-transitions.md` (five invariants, a phased build, and
  two claims from the research that were falsified and are recorded as such);
  what a Release may *be* is argued in `IDEAS/offline-first-and-release.md`
  (artefact kinds). Neither is ruled. The one line both agree on: provisioning
  must degrade to nothing, or the portable path becomes the special case.

---

## 6. Auditing this repo

The method that produced `drift-report.md`, kept for reuse. One explorer per
package, this document as shared context, each returning the same shape:

```
package / realm+domain / one-liner (in the vocabulary)
declares:  what the developer writes        realizes: what the framework produces
exports:   public surface     deps in/out (verified by grep, not inferred)
bridges:   NAMED handoff points to other realms, with files
state:     shipped | working | stub | aspirational — with evidence
drift:     divergence from this doc, each with a verdict —
           code-wrong | model-wrong | intentional — argued, cited
friction:  where this doc made the package hard to describe
proposal:  concrete changes to terms/boundaries — the doc is the thing under test
```

Then answer, across all reports: Is any term doing two jobs? Is any real
concept missing a term? Do three nouns still predict the system? Where does
the domain map fail? Does declaration → realization hold? Which principles
does the code contradict — and is the code right? Disagree in specifics,
propose rather than diagnose, and rank by cost of being wrong. Deferential
agreement is the one useless outcome.
