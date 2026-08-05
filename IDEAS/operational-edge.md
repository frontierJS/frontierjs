# Idea — The operational edge: what Encore has that FJS does not

**Status: ASSESSMENT + FUTURE WORK.** Dated 2026-08-03. Probed against the tree
(`VERIFYING.md`). Three items here are explicitly flagged by the maintainer as
things to explore: **infrastructure provisioning**, **preview environments**, and
the living architecture view.

Companion to `IDEAS/ecosystem-gaps.md`, which compares against Laravel. That
comparison is about *breadth of batteries*. This one is about the **operational
edge** — what happens between "the code is written" and "it is running in
production, observable, in an environment per pull request."

---

## The two bets

**Encore's bet — infrastructure from code.** You declare a database, a Pub/Sub
topic, a cron job or a cache inline in service code. A compiler statically analyses
the source, builds an application model, and provisions the real thing: locally, in
per-PR preview environments, and in your own AWS or GCP account. That same app model
powers automatic distributed tracing, API documentation and generated architecture
diagrams.

**FJS's bet — derive the app from a schema, and reduce infrastructure to near
nothing.** One `.lite` file, SQLite, one binary beside one file
(`IDEAS/offline-first-and-release.md`).

These are not competing answers to one question. Encore assumes distributed services
on a cloud account; FJS assumes a portable, self-hosted application. **A team
choosing between them is choosing between those two worlds, not between two
implementations of the same idea.** That framing matters for everything below: the
goal is not to become Encore.

---

## Correction — FJS already has an app model

Written before probing, this document was going to say FJS has no equivalent to
Encore's generated architecture view. That is wrong.

- **`fli project:map`** (`packages/cli/commands/project/map.md`, 219 lines) — a
  structural snapshot of the project: schema, services, resources, migrations. It
  supports `--json`, `--out`, and `--layer schema|api|ui|migrations`.
- **`fli project:view`** (`view.md`, 335 lines) — opens **FJSChain**, a visual map
  of the project's chain of responsibility, served in the browser.

So the "living architecture" idea is built, and `project:map --json` **is an
application model**. What is missing is not the model — it is everything
operational that could be driven from it. That reframes the whole gap: this is not
"build an app model", it is "use the one that exists."

The website's `journey.html` and `showroom3.html` hand-draw the request path and the
named seams. Those should eventually be *generated* from `project:map`, not
maintained by hand — a diagram that can drift from the code is a diagram that will.

---

## Where Encore is genuinely ahead

| | Encore | FJS |
| --- | --- | --- |
| Infra provisioning | Databases, queues, caches, cron — provisioned from declarations | **Nothing.** No provisioning anywhere in `fli` |
| Distributed tracing | Automatic, real spans, zero instrumentation | `correlationId` only (`core/context.ts:207`, from `x-request-id`) — correlation, not tracing |
| Preview environments | One per pull request | **None** |
| Service-to-service | Typed RPC across processes | `app.service('x').call()` — in-process only |
| Dev dashboard | API explorer, live traces, architecture diagram | Devtools overlay + `project:view`; no traces |
| Languages | Go and TypeScript | JS/TS only |
| Runtime | Encore.ts ships a Rust runtime | Bun |

## Where FJS is genuinely ahead

- **Authorization.** Encore has auth handlers; authorization is code in handlers,
  as everywhere else. Gates on the model plus row policies compiled into SQL is a
  structurally stronger position and should stay the lead claim.
- **A UI realm exists.** Encore is backend-only — it generates a typed client and
  you bring a frontend. Mesa, Sierra, the component kit and the design system are an
  enormous breadth difference.
- **A seed a human can read.** Encore's app model is a compiler artifact you cannot
  open. FJS's is thirteen lines of `.lite`. Better for people, and better for agents.
- **Self-hosting is the default path**, not the escape hatch. Encore is a
  VC-backed company with a cloud product; `encore build docker` exists but is not
  the happy path.

---

## The three to explore

### 1. Infrastructure from declarations

**The strongest idea to take, and closer than it looks.** Encore extracts
infrastructure declarations by statically analysing source code. FJS does not need
to, because **its declarations are already explicit and already parsed**:

| Declared today | Infrastructure it implies |
| --- | --- |
| `schema.lite` + `@@db(name)` | databases, one per block, per tenant |
| Caravan `defineJob` + cron | queues and scheduled work |
| Conduit targets | outbound network egress, and the credentials it needs |
| Junction `channel:` | realtime transport |
| `.env.example` | required secrets |
| Litestone migrations | the ordering constraint on cutover |

`project:map --json` already collects most of this. Nothing reads it and provisions.

An FJS version could be **better than Encore's** on one specific axis: Encore's
declarations are recovered by a compiler from application code, so the app model is
an artifact. FJS's are written by a human in a file a human reads — so the plan can
be shown, reviewed, and diffed before anything is created. That is the same
principle Litestone migrations already follow: *diff first, apply second, never
silently*.

Design constraint that falls out of `IDEAS/offline-first-and-release.md`:
**provisioning must degrade to nothing.** The single-binary target needs no
provisioner at all. If `fli deploy` grows a provisioning step, the SQLite-and-one-file
path must remain the shortest one, or the framework has traded its best property for
its competitor's.

### 2. Preview environments

One per pull request, torn down on merge. Mostly a naming and lifecycle problem on
top of `fli deploy`, which already infers environment from the git branch — preview
environments are the same inference with an ephemeral namespace and a TTL.

Interacts with item 1: a preview environment is exactly where "provision from
declarations" pays off, because nobody hand-configures a throwaway.

Open questions: what happens to the database (seed fresh, clone, or share?), how
secrets are scoped, and who is allowed to spend the resources.

### 3. Tracing, and generating what is currently drawn by hand

- **Spans, not just a correlation id.** The correlation id exists and is threaded;
  what is missing is the tree — which hook, which query, how long. Junction already
  has the seam list to instrument, and `IDEAS/framework-shape.md` item 4 wants
  request-correlated logging anyway. Same work, done once.
- **Generate the diagrams.** `project:map --json` plus the bridge index is enough
  to emit the request-path view that `website/journey.html` currently hardcodes.
- **A local dev dashboard** that puts `project:view`, the devtools overlay, traces
  and an API explorer in one place. This is Basecamp's local counterpart
  (`IDEAS/offline-first-and-release.md`), and probably the same codebase.

---

## Verdict

Against Laravel, FJS is behind on breadth of batteries. Against Encore it is **more
coherent and much broader in scope, and well behind at the operational edge.**

Encore is a better *backend platform*. FJS is a better *application framework*. The
difference that matters is that Encore made deployment and operations a first-class
product, while FJS still has Release as the one realm with no package — now the
**third** independent analysis arriving at that same conclusion
(`IDEAS/framework-shape.md` item 3, `IDEAS/offline-first-and-release.md`, and this).

Three documents pointing at one hole is not a coincidence. It is the next thing to
build.

## See also

- `IDEAS/offline-first-and-release.md` — the Release realm, and the tension with provisioning
- `IDEAS/ecosystem-gaps.md` — the Laravel comparison (breadth of batteries)
- `IDEAS/framework-shape.md` — item 3 (Release) and item 4 (observability)
- `packages/cli/commands/project/map.md`, `view.md` — the app model that already exists
