# FrontierJS — Architect

The mental model and its vocabulary. This is the *what*; the layers around it:
`PHILOSOPHY.md` (the axioms — why), `DECISIONS.md` (dated rulings — settled),
`CLAUDE.md` (the map — where), `ISSUES.md` (the gap between this document and the
code, one id at a time). `PHILOSOPHY.md` §VII says which kind of document this is
and what a sentence in it may say.

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
| Deployment | **Release**            | How the application ships and runs |
| Testing    | **Suite / Test**       | How the application is verified    |

A developer who understands Model, Service, Resource should be able to predict
how any feature works before reading its docs. Keeping that model small is the
point of the whole framework — predictability is the product.

The triad holds for *the application a developer writes*. The framework's own
machinery — jobs, outbound targets, providers, the rendering substrate — has its
own nouns, and the table below names the ones that are ruled.

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
| **Gate ladder**             | roles, permissions, access levels           |
| **Plugin**                  | middleware, extension, addon                |
| **Context**                 | request context, state, payload             |
|   ↳ *plural by realm*       | each package documents its own by LIFETIME (`FJS-D03`); see its `CLAUDE.md` |
| **Chain of Responsibility** | pipeline, middleware stack, flow            |
| **Signal**                  | observable, atom, ref, store (for the cell) |
| **Projection**              | (nothing — new noun, see below)             |
| **Guard**                   | hook (for a thing that only answers allow/deny) |
| **Observer**                | hook, listener (for a thing that cannot act) |
| **Provider**                | adapter, driver, integration                |
| **Transport**               | channel (for the delivery medium)           |
| **Target**                  | endpoint, integration, service (for a Conduit declaration) |
| **Job**                     | task, worker, cron                          |
| **Release**                 | manifest, deploy, build (for the immutable artefact) |

Clarifications settled by the code:

- **Signal is not Event, and both are legal words.** A **Signal** is Mesa's
  reactive cell; an **Event** is Junction's announcement. *signal* used to sit in
  the Event row's "not" column, which was aimed at "signal" meaning
  *notification* and accidentally banned the word Mesa's runtime, docs and White
  Paper use for their core primitive. The ban now reads: never call an Event a
  signal. A Signal never crosses a Boundary; an Event exists only to
  (`FJS-D44`).
- **Projection** is a *stored or served* second shape of the same truth — a
  materialised view, a serialized subset, a report. What a compiler or a
  component computes and throws away stays **derived**. If it has no independent
  existence, it is not a Projection (`FJS-D46`).
- **A custom service method is a Method, not an Action.** A Service answers
  CRUD plus whatever else it declares, in one `methods:` list; *custom* is the
  adjective for the ones the CRUD set does not name, and there is no noun for
  them. Dispatch is settled and unchanged: the `X-Service-Method` header,
  case-preserved. On the browser client, `svc.invoke(name, id, data, query)`
  (`FJS-D02`, `FJS-D07`).
- **Policy has two meanings and will not get a third.** Gate = the ordinal
  per-operation check; policies = `@@allow`/`@@deny` row/field predicates. A
  proposed third sense ("declarative business rule vs imperative mechanism") is
  refused — the words for that are already **Declaration** and **Hook**
  (`FJS-D45`).
- **Gate** is the ordinal per-operation level check (`@@gate`, resolved against
  the gate ladder, enforced by default when declared). Row/field predicates
  (`@@allow`/`@@deny`, compiled into SQL) are a second, orthogonal mechanism —
  Litestone's docs call them **policies**. Don't use one word for both.
- **The gate ladder** is the 0–9 scale (`STRANGER`…`LOCKED`) implemented as
  `LEVELS` in `packages/litestone/src/plugins/gate.js`. Named levels are the
  canonical way to write gates (`@@gate(read: READER, write: USER, …)`).
- Model naming: **PascalCase, singular — always**; `@@external` models exempt
  (`FJS-D42`).
- **A Hook has three tiers and a new `on*` states its tier** (`FJS-D06`). A
  **Hook** may mutate the arguments or halt the operation; a **Guard** answers
  allow/deny and nothing else; an **Observer** receives and cannot act. There is
  no fourth tier: a required single-slot callback is a Hook that throws.
- **A Plugin attaches a capability; a Provider is a third party the app speaks
  to** (`FJS-D06`). The registration unit is always Plugin, protocol and all.
  `Adapter` is refused.
- **A Channel is a broadcast set; the delivery medium is a Transport**
  (`FJS-D06`).
- **`Edge` is refused; `Boundary` is qualified at every use** — the Data
  boundary, the app↔world boundary (`FJS-D06`).
- **The Deployment noun is Release, and `Manifest` is ceded to MV3**
  (`FJS-D06`). A Release is immutable and environment-independent; a **Pivot**
  is the transition at which N-1 compatibility ends, and it is the same test for
  a contract migration and a client retention window.

**Two channels, kept separate.** When you *describe* the codebase, use these
words and only these words. When you *evaluate* the vocabulary itself, do it
explicitly — never silently substitute a better word into a description. The
vocabulary is mandatory for describing and fully open for challenging.

### Not yet named

- **Component** (what the UI *is* — Mesa) beside Resource (what the UI *gets*),
  and **Binding** (the reactive seam). `FJS-D06` §3 left these unruled.
- **Envelope** for Junction's result shape. Unruled with the above.
- **Slice** — a package that crosses all realms deliberately (auth,
  notifications). Deferred until `fli add <slice>` is on the table or someone
  outside this repo ships one (`FJS-D06` §7).
- **Environment** and **Audience** in the Deployment realm — proposed in
  `IDEAS/release-transitions.md`; *Audience* may belong to the Data realm beside
  the gate ladder, and *binding* is already Mesa's word.

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
6. **Access is declared, not programed — and declaration enforces.** Gates in
   the schema, resolved against the 0–9 gate ladder, enforced from the
   first request with no further wiring; a shipped default resolver, overridable.
   The converse binds too: a model with no gate is open, honestly. `asSystem()`
   is the audited bypass.
7. **Real-time is core.** Every fact has one origin; change flows outward —
   origin → event → channel → binding. Any parallel sync mechanism or second
   emitter for the same fact is a smell. A write that went through no service
   is announced by the Data boundary's own tap, so the origin is the row and
   never the caller.
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
**This structure is not locked.** Realm and domain are orthogonal axes, and
several packages legitimately cross both; a second axis, the Slice, is deferred
(§2). Maturity per package is the map's to say (`CLAUDE.md` § Packages), not
this document's.

| Domain                           | Concern                                          | Tool(s)                                 |
| -------------------------------- | ------------------------------------------------ | --------------------------------------- |
| 1 — Developer Interface          | CLI, editor tooling, scaffolds                   | `fli` · frontierjs-vscode               |
| 2 — Database                     | Schema, migrations, ORM, gates                   | **Litestone**                           |
| 3 — Configuration & Secrets      | Env config, secrets, runtime context             | per-tool `config/`, `junction.config.js` |
| 4 — Integrations                 | Third-party connections                          | **Conduit**                             |
| 5 — Automation & Orchestration   | Jobs, queues, schedules, workflows               | **Caravan** · Orion (V2, `FJS-D14`)     |
| 6 — Authentication               | Identity, sessions, trust resolution             | `@frontierjs/auth`                      |
| 7 — Observability & Operations   | Monitoring, logging, fleet                       | Basecamp · Outpost · junction telemetry/health/devtools |
| 8 — Application & Infrastructure | The application itself; contains the five realms | **Junction** (API) · **Sierra** (UI meta) · **Mesa** (UI substrate, leaf) |

Placements the original map did not anticipate: **jetty** (a browser-extension
application *container* — UI realm plus its own build/deploy surface),
**css** (presentation — the UI realm's second concern), and
**auth**/**notifications** as vertical slices that ship a schema fragment, a
service, a plugin, and a resource as one unit.

Dependency direction across the core: `Litestone ← Junction ← Sierra`, with
Mesa a strict leaf. Never the reverse, in any package.

---

## 5. What Is Unsettled

Report these accurately; don't treat them as bugs. A defect is in `ISSUES.md`;
what is here is a question the mental model has not answered.

- **The Deployment realm's remaining nouns.** Release and Pivot are ruled and in
  code; Environment and Audience are proposed (`IDEAS/release-transitions.md`)
  and collide with words the Data realm and Mesa already hold (§2).
- **Component and Binding.** The UI realm has one noun, Resource, for what the
  UI *gets*; what it *is* has no ruled name (§2).
- **Slice.** Two exist and both are this repo's; the word waits for a third
  party (`FJS-D06` §7).
- **Auth's routes.** `/auth/*` establishes a session and deliberately bypasses
  the Service abstraction — login cannot be gated by login (`FJS-D20`). Whether
  a second provider inherits that shape unchanged is not yet asked.

---

## 6. Auditing this repo

The method that produced `IDEAS/coherence-review.md`, kept for reuse. One explorer per
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
