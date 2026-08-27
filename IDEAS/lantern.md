---
id: lantern
status: idea
dated: 2026-08-26
---

# Idea — `lantern`: the request trace that explains the decision

`IDEAS/overview.md` 2.4 has said *real spans, not just a `correlationId`* since
it was written, and sized the work `M` on the strength of the emitters already
existing. Probed against the tree on 2026-08-26 (`VERIFYING.md`): the emitters
are further along than the row implies and the gap is somewhere else. **Junction
already correlates a query to the call that ran it.** What it cannot do is
remember, carry an id past the call boundary, or say a single word about why a
caller was refused.

The parity half of this — record the request, keep it for twenty minutes, click
into it — is Telescope's, and Telescope is twelve years of prior art with three
first-party successors. It is worth building and it is not a position. **The
position is the second half**, and it is one nobody else can take: *which
`@@gate` refused, which `@@allow` compiled into the WHERE that emptied the
screen, which transition fired and under whose standing.*

---

## What is already here

Measured, not read off a status file.

| Piece | Where | State |
| --- | --- | --- |
| Call spans | `packages/junction/src/core/service.ts` | `junction.call.start` / `.end` — service, method, transport, userId, id, `durationMs`, status, error. `junction.call` is a back-compat alias |
| Hook spans | same, `runPipeline` | `HookTelemetryEvent` — phase, `hookName`, index, `durationMs`, status |
| **Query → call, correlated** | `packages/junction/src/core/litestone.ts` | junction taps the scoped client's `$tapQuery`, stamps `ctx.telemetryId`, re-emits as `litestone.query`, and registers the unsubscribe on `ctx._cleanups` |
| The query event itself | litestone `QueryEvent` | model, database, operation, **sql, params**, duration, actorId |
| The zero-cost gate | `telemetryEnabled()` | `hasListeners()` false → no UUID, no event object, no `performance.now()`. Litestone has the same check in `fireQuery` |
| A viewer | `packages/junction/src/plugins/devtools/` | its own server on 8503, a **200-entry in-memory ring**, a `redact` list, the jobs panel, `/api/state`, `/api/health`. Refuses to bind under `NODE_ENV=production` with no `auth` |
| Policy source text | `policyExprToString`, `packages/litestone/src/core/policy.js` | round-trips an `@@allow`/`@@deny` AST back to the syntax it was written in. Already feeds `db/access.snapshot.md` |
| Policy debug | `plog`, same file | `console.log` behind `policyDebug: true \| 'verbose'` — the only channel a denial has today, and it is stdout |
| The declared surface, committed | `access.snapshot.md` · `principal.snapshot.md` · `surface.snapshot.md` | gates, predicates, protected fields, transition gates; who a caller becomes and off which request |

That last row is the reason this is worth building here rather than buying. **The
static half of the answer is already generated and already gated by CI.** What is
missing is the runtime half and the join between them.

## The five holes

1. **Nothing is kept.** A 200-entry ring in one process, gone on restart. The
   whole of Telescope's value is *twenty minutes ago*, and there is no version of
   this feature that does not need a store.
2. **The id stops at the call boundary.** `telemetryId` is minted per
   `callService`, so a nested call gets a fresh one with no link back.
   `correlationId` exists on `RequestMeta`, seeded off `x-request-id`, and reaches
   no telemetry event at all. Caravan's jobs table records the **principal** who
   asked for the work and nothing about the call that dispatched it; the outbox
   row is the same. So *this job, and the request that caused it* is not a
   question the tree can answer.
3. **It is a list, not a tree.** Hook events carry an `index` and no parent.
   Bypass calls (`_find`, `_get`) emit an end event with `telemetryId: undefined`
   — deliberate, documented, and a hole in the trace either way.
4. **A decision emits nothing.** A gate refusal is a bare `throw Unauthorized`. A
   row policy compiles into the WHERE and says nothing on any channel. `checkCreatePolicy` and
   `checkPostUpdatePolicy` throw `AccessDeniedError` with no event beside it.
   Every one of these is silent by construction — which is the same sentence
   `IDEAS/diagnostics.md` opens with, one layer down.
5. **No sampling, no retention, no export.** Fine while the store is a ring
   buffer; not fine the moment there is a database behind it.

---

## Prior art, and the shape of the field

Four tiers, and everybody sits in exactly one.

**Record the request.** Laravel Telescope, Symfony's Web Profiler, Django Silk,
Rails' ~50 built-in `ActiveSupport::Notifications` events. Requests, queries,
jobs, mail, a dev-time store, click into the past. This is the tier FJS lacks
entirely, and it is the tier people mean when they say they miss Telescope.

**Watch it live.** Phoenix LiveDashboard, the .NET Aspire dashboard. Metrics,
processes, a call feed, nothing kept. **This is where devtools on 8503 already
sits** — which is why the parity gap is a store and a viewer rather than a
rewrite.

**Aggregate it in production.** Laravel Pulse and Nightwatch, Sentry,
OpenTelemetry into Tempo. Answers *what is slow* and *what is erroring* over a
population. Explicitly not this proposal; the export in phase 5 is how an app
reaches it rather than something to rebuild.

**Explain the authorization decision.** Cerbos writes a decision log naming the
rule that denied and why. OPA logs the inputs and outputs and expects you to
reconstruct the evaluation in its own trace REPL. SpiceDB has `zed permission
check --explain` and a `withTracing` flag that returns the traversal. **All three
are a policy service you call out to**, so the explanation lives in their world
and is joined to your request by a correlation id you maintain — and none of them
can see the query, because the query is yours.

The nearest thing to FJS's actual failure mode is not a framework at all, it is
**Postgres row-level security**, and the literature on it is a list of the same
complaint: RLS fails closed with no warning, so a wrong policy and a correct
empty result are the same screen. The state of the art for debugging it is
`pg_policy`, `EXPLAIN`, and `SET ROLE`, by hand, after you have already suspected
the policy. Nobody ships an answer to *why is this list empty*.

**There is no OpenTelemetry semantic convention for an authorization decision.**
Searched; there is no attribute namespace for it and no proposal. So a trace that
carries one is naming its own attributes, which is a cost and also the reason the
ground is empty.

---

## What FJS can do that the field cannot

Four claims, each resting on something already in the tree.

**1. The decision is inline in the span, not in a second log to be joined.** The
policy engine, the ORM, the service pipeline and the transport are one process
reading one declared seed. Cerbos and OPA cannot reach the query; Postgres cannot
reach the handler. Both ends are held here, which is the one structural advantage
this design has and every other claim is downstream of it.

**2. The predicate and its source line are already recoverable.**
`policyExprToString` exists and `access.snapshot.md` is committed, so a trace can
say *`@@allow('read', ownerId == auth().id)` on `Order` compiled `WHERE ownerId =
?` with `? = null`* and point at the line in `schema.lite`. The prose is not
generated from a template over a rule id — it is the rule, round-tripped.

**3. Standing is explained rather than asserted.** `principal.snapshot.md`
already declares where a level comes from, so a refusal reads *graded READER(2)
from `WorkspaceMember.role = 'viewer'`; `update` on `Deployment` needs
ADMINISTRATOR(5)* instead of `403`. That is the sentence `fli check`'s
`gate-unreachable` makes statically; this is the same sentence about a caller who
actually arrived.

**4. The counterfactual.** Policies compile to SQL, so the same query can be run
again through `asSystem()` and the row delta reported: **17 rows exist, the
policy admitted 0**. No external PDP can do this, because it does not have the
query; RLS cannot do this, because the bypass is a role switch nobody hands a
debugger. It is the single most valuable thing this feature could say and it
costs one extra statement.

One vocabulary note that is not optional: `refusedBy: 'gate' | 'policy' | null`
already exists, on `x-transitions`, and means exactly what a decision event needs
to mean. Reuse it. A second word for the same distinction is the shape Invariant
4 exists to prevent.

---

## The plan

Five phases. The first is an enabler and the second is the position; three and
four are the parity build, and the fifth is how an app leaves.

### Phase 1 — one id, carried (S)

Split the two things `telemetryId` is currently doing: a **`traceId`** for the
request, seeded from the existing `correlationId`, and a **`spanId`** per call
with a **`parentSpanId`** above it. Stamp all three on every telemetry event,
including the hook events, which today can be attributed to a call and not to a
position in a tree.

Then carry it past the process boundary it currently dies at. Caravan's jobs
table takes a cause column and so does the outbox row, so *the job, and the
request that queued it* becomes one query rather than a guess from timestamps.
Both already store the principal, which is the precedent for storing the cause.

The bypass-call hole (`telemetryId: undefined`) closes here or is stated as a
deliberate blind spot in the viewer. It must not be discovered by someone reading
a trace with a gap in it.

### Phase 2 — the decision event (M)

**Owned by litestone, mirroring `$tapQuery` exactly.** `db.$tapDecisions(fn)`,
zero-cost behind the same listener check, with junction stamping the trace id the
same way it already stamps `litestone.query`. The direction is forced —
litestone cannot import junction (Invariant 1) — and the precedent for the shape
is one file over.

What it emits: a gate refusal and, verbose, a gate pass; a compiled policy filter
carrying the rule's source text, the operation, and how many rules were OR'd; a
create denial; a post-update denial; a field predicate that narrowed a read; a
transition refusal with its `refusedBy`; a `@guarded` or `@system` write refusal;
and an `asSystem()` bypass, which is the one that answers *why did this rule not
apply*.

**Invariant 7 extends to this and it is the constraint that shapes the payload.**
A decision event carries params, and a param can be a `@guarded` or `@encrypted`
value. It goes through `$protectedFields` — the seam exists, junction's audit
path already reads it — or the feature is a way to print secrets into a store
that outlives the request.

### Phase 3 — the store (S)

The ring buffer becomes a declared `database` block of its own. **Deliberately
not `main`**: a rolled-back transaction must not take its own trace with it,
which is `FJS-D35`'s lesson read in the other direction — the outbox row belongs
inside the transaction precisely because the effect should not survive a
rollback, and a trace of a failed call is the thing most worth keeping.

Retention through `$retain()` against the injected clock, so *does a 30-day
window actually drop anything* is a test anybody can write rather than a thing
observed in production. Dev on by default, production off or sampled.

### Phase 4 — the viewer (M)

Extend devtools on 8503 rather than opening a fifth surface; it already has the
server, the auth refusal and the fail-closed behaviour under
`NODE_ENV=production`. Three panes: the span tree; the query with the
policy-contributed part of its WHERE marked as such; and **the decision pane** —
*this call was refused because …*, *this list came back empty because …* — with
the counterfactual behind a button.

The counterfactual re-runs a caller's query as the system client, so it is a
privileged action on a screen that already refuses to bind unauthenticated. It
must be dev-only and it must be explicit; a debugger that silently bypasses the
access rules is a debugger that has to be treated as production credentials.

### Phase 5 — export, and the CLI half (S)

An OTLP exporter mapping the span tree out, with decisions as `fjs.decision.*`
attributes, since there is no convention to follow. Cheap, and it is the whole of
the production story — the answer to *should FJS build Pulse* is no, and this is
what makes that answer defensible.

Beside it, **`fli why`** — the same emitters with no browser. `fli why order 12
--as ops@acme.test` prints the decision trace for one row at one standing, which
pairs with `fli tinker --as` and is the shape an agent can read.

**Order matters in one place**: phase 2 before phase 3. The store's schema has to
hold decisions, and building the store against calls and queries alone means
writing it twice.

## What this owes the repo's own conventions

**A `decisions.snapshot.md`** — the list of decision KINDS the engine can emit,
committed and gated by the `snapshots` CI phase. A kind that stops being emitted
is *nothing happening*, which is exactly the class `FJS-327` and `FJS-328` came
from, and the answer there was the same: commit what is registered so that a
disappearance is a diff.

**A drive.** `example`'s `verify:account` already asks the boundary as three
audiences — nobody, a shopper, staff — which is the only place in the repo where
*the policy is wrong* and *the screen is wrong* are separated by construction. It
is the natural place to assert that a refusal produced a decision event naming
the right rule.

**A sizing correction to `overview.md` 2.4.** `M` holds for phases 1–4 with the
export left out; phase 2 is the largest single piece and the only one whose shape
is not already precedented in the tree.

## Open questions

- **Does this become a package?** Recommendation: not yet. The emitters belong to
  the packages that own the facts, the store and the viewer are junction's
  devtools, and a `@frontierjs/lantern` before there is a second reader is a
  package boundary drawn around one caller. Extract when basecamp wants the same
  trace off a deployed app, which is when it earns the name.
- **Sampling policy.** A head sample loses the trace of the call that failed; a
  tail sample means buffering every span. Probably: keep everything in dev, keep
  errors and refusals always, sample the rest.
- **Does a decision event belong in the audit trail instead?** No — `@@log(audit)`
  records a write and `db.$audit()` records an event, and a refusal is neither. But
  the two want to point at each other, and the trace id is the pointer.
- **What does the counterfactual cost on a large table?** It is a second query
  with the policy filter removed. Bounded by a limit, or refused above a row
  count; unbounded it is a way to make a debugger the slowest thing in the app.

## See also

- `IDEAS/operational-edge.md` § 3 — where this was first raised, as one of three
- `IDEAS/diagnostics.md` — the same *silent failure is the recurring weakness*
  argument, answered statically; this is the runtime half
- `IDEAS/overview.md` 2.4 — the ranking row
- `CLAUDE.md` § Bridge index — the seams a span tree would be built from
- `packages/litestone/docs/access-control.md` § *Combining them* — the rules a
  decision event has to be able to describe
