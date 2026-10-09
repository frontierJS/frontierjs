---
id: specifications
status: proposed
dated: 2026-09-14
---

# Idea — Specifications: the truths FrontierJS is one implementation of

**Status: PROPOSED. A north star, not a plan, and nothing here is owed before the
framework settles.** Dated 2026-09-14. Every "held today" pointer was checked to
exist on that date; owners move, so treat each one as a lead (`VERIFYING.md`).
Do not cite this file as behavior. When an entry is finally written up, that
entry becomes its own paper and this file points to it.

---

## Trigger

*A working framework is good, but the thing underneath it that has always been
the goal is the universal truths: specifications that any framework could adopt,
eventually governed by a committee, with FrontierJS as one implementation.*

Mesa's reactive model, Conduit's provider contract, Litestone's model, Caravan's
queue, and Junction's envelope, service and bridge contracts were named first.
This file is the complete list, read off the tree.

---

## The finding, in one line

**Much of the framework is already spec-shaped, because the doctrine forces a
single owner, and a single owner is the thing a specification needs to point
at.** Toolbelt's own purpose is "facts with many possible answers that must have
one". Most of the bridge index is a list of translations with exactly one owner
each. The committed snapshots (`errors.snapshot.md`, `jsonschema.snapshot.md`,
`surface.snapshot.md`) and the vectors (`datetime-vectors.json`, the policy oracle
between `compileSql` and `evalJs`, `verifyTransportParity`) are test vectors
that nobody has pulled out of the implementation yet.

---

## What makes something a specification here

An entry belongs on this list when it can have all four of these. An entry that
cannot have the first is an implementation choice and belongs in § *Stays
implementation*.

1. **Host-neutral semantics.** Stateable without SQLite, Bun, TypeScript or
   either of this repo's languages.
2. **A JSON form.** The document a second implementation reads or writes: a
   schema IR, a descriptor, a row, an envelope, a record. The prose spec
   describes the JSON; the JSON does not describe the prose.
3. **Conformance vectors.** Input → expected output as data, runnable against
   any implementation (test262's shape). Each vector set pairs a positive case
   with its negative control and asserts its own count, because a vector file
   that loads nothing passes.
4. **A second implementation.** A spec with one implementation is a README.
   Nothing here is frozen until something other than FrontierJS passes the
   vectors.

**Where a standard already exists, FrontierJS implements it or writes a
*profile* of it** (a narrowing plus the semantics the standard leaves open), and
does not author a competitor. § *Already a standard* lists those.

---

## The spine

**Ten entries carry the rest, in dependency order: each one leans on the ones
above it.** The owner ranked them on 2026-10-04. § *The list* below keeps its
realm grouping and numbering; this is the order to write them in.

1. **Model description** (1). The root everything derives from, and the most
   blocked: no JSON IR separate from `.lite` exists (§ *Tensions to carry*).
2. **Gate ladder** (2). The API, the UI, broadcasts and the agent surface all
   read it. It is the new idea, since RBAC, Zanzibar and Cedar are not ordinal.
3. **Row and field policy** (3, with field protection (5) folded in).
4. **Expression language** (4). Policies and flows are both written in it;
   check CEL before authoring one.
5. **Write announcement** (8). Audit, channels and live data hang off it.
6. **Service description** (11). CRUD plus declared methods and who may call,
   the part OpenAPI has no field for.
7. **Result envelope** (12). One shape on both sides of the wire.
8. **Error contract** (13). `errors.snapshot.md` is already its vector table.
9. **Directives and query values** (14, with ordering and paging (15) folded
   in). Together they are what a list request means.
10. **Transport binding** (16). HTTP/WebSocket parity is the conformance test.

**Next in line:** events and channels (23) and the live node store (24), the
API → UI half of live data, then Resource (34), which the rest of the UI realm
sits on. **Conformance from the seed (39) is the meta-entry rather than a
rung**: it is how every rung gets its vectors.

**The first write-ups come from off the spine.** Provider (25) is the smallest
entry, with its tables already closed, and Queue (28) is the most novel, with no
standard to profile. Nothing on the spine depends on either, so either can be
written while the Model entries wait for the kernel.

`website/site/content/routes/specs.mesa` states this order publicly; a change
to the ranking moves the page with it.

---

## The list

Grouped by realm. Each entry says what the spec would state, where FrontierJS
holds it today, and the nearest neighbor outside.

### Data realm — the Model

#### 1. Model description (the schema IR)

**Would state:** what is worth declaring about a model. Fields and types,
including exact numbers (`@scale`, `@money`), `File`, `Json`, enums with labels,
and named `type T` shapes. Identity, including tuple keys and their key order.
Relations, exclusive foreign keys (`@@arc`) and polymorphic relations.
Constraints (`@check`, `@@check`, `@@unique(where:)`). Defaults, transforms and
validators, and the order they run in. Derived values: template (`@generated`),
queryable (`@derived`), and computed with declared reads (`@computed`). Views
(`@@materialized`, `@@refreshOn`). Human labels (`@label`, `@@label`). Value sets
and their strength (`required` · `open` · `suggested`). Write-only (`@transient`)
and application-written (`@system`) fields. Composition (`@@trait`,
`extend model`).
**Held today:** `packages/litestone/src/core/parser.js` ·
`packages/litestone/docs/schema.md`. The JSON form nearest to existing is
`generateJsonSchema` and its `x-*` keywords (`packages/litestone/docs/jsonschema.md`).
**Neighbor:** Prisma schema and ZenStack's ZModel for shape, and Ash resources
for shape plus behavior. **Lead to verify:** JSON Schema 2020-12 supports
declared vocabularies (`$vocabulary`), so the `x-*` keywords could become a
registered vocabulary rather than a new format.

#### 2. The gate ladder

**Would state:** an ordinal access scale, with sentinel levels that are not
compared with `>=`. A gate written as four positions (read, create, update,
delete). Grading a session into a level. And the two-sided rule: an answer on
the client is an affordance where unknown means permissive, and the Data
boundary enforces regardless.
**Held today:** `@frontierjs/toolbelt/gate` (`FJS-D197`, `FJS-D239`).
**Neighbor:** RBAC, Zanzibar and Cedar. None of them is ordinal, which is the
part that is new here.

#### 3. Row and field policy

**Would state:** `@@allow`/`@@deny` predicates over a row and over fields. One
evaluator with two outputs: a verdict when every input is known, and a residual
predicate when row data is not. The `refusedBy` answer (`gate` · `policy` ·
`null`). **A broadcast is not a select**: shaping an already-read row for a
named principal (`$readAs`) fails closed.
**Held today:** `packages/litestone/src/core/policy.js` · `db.$readAs` ·
`IDEAS/kernel-and-projections.md` § 2.
**Neighbor:** Cedar and OPA partial evaluation, and PostgreSQL row-level security.

#### 4. The expression language

**Would state:** the lexer, and the grammar in two dialects: the policy dialect
over one record, and the flow dialect with paths, calls and lambdas. Also the
evaluation semantics against a record, including null.
**Held today:** `@frontierjs/toolbelt/predicate` (`FJS-D271`, `FJS-D287`).
**Neighbor:** Google's CEL (Common Expression Language), the closest existing
spec to compare against before writing one.

#### 5. Field protection and redaction

**Would state:** what `@encrypted`, `@guarded`, `@secret` and a hashed field
each promise. That a protected field is redacted in every audit entry and
snapshot. That a schema has two audiences, the client row and the system row,
and a protected column does not exist in the client's.
**Held today:** `db.$protectedFields` · Invariant 7 · `ServiceTypes`'s audience split.

#### 6. Lifecycle semantics

**Would state:** state machines (`@@transitions`), with a gate per move and the
shape of "which moves are legal for this row". Optimistic concurrency
(`@version`) and how the version travels on a write. Soft delete and how it
interacts with uniqueness. **Patch semantics: an explicit `null` clears.**
**Held today:** `packages/litestone/docs/schema.md` § Lifecycle, § State
machines · Invariant 9 · `IDEAS/shipped/state-machines.md`.

#### 7. Tenancy

**Would state:** the tenancy strategies, how a request resolves its tenant from
host, headers and principal, and that a signed-in principal with no tenant claim
is refused rather than shown an empty list.
**Held today:** `resolveTenancy` · `registry.tenantFor` ·
`packages/litestone/docs/multi-tenancy.md`.

#### 8. Write announcement

**Would state:** the event every write emits: `create` · `update` · `remove` ·
`transition`, `scope: row | collection`, and a bulk write's `announce` mode.
The rule that the origin is the row and never the caller.
**Held today:** `$tapEvents` (`FJS-D34`).
**Neighbor:** CloudEvents, as the envelope this could be a profile of.

#### 9. Audit trail

**Would state:** the entry shape. The actor is whoever asked, including through
deferred work. A correlation id joins the entry to the request. Redaction
follows entry 5.
**Held today:** `packages/litestone/docs/audit-logging.md`.

#### 10. Schema evolution

**Would state:** classifying a change between two schemas (compatible, pivot,
refused), and the *expand → backfill → contract* sequence a pivot requires, with
the backfill named by model and field.
**Held today:** `packages/litestone/src/release.js` · `needsBackfill` (`FJS-D157`).
**Neighbor:** Atlas (ariga) schema diffing.

### API realm — the Service protocol

#### 11. Service description

**Would state:** a service is CRUD plus declared methods, and a custom method
may address a record or the collection. A method's input names a declared type.
Declaring methods narrows the surface. The introspection document says what a
service is.
**Held today:** `svc.describe()` → `ServiceDescription` · `collectCustomMethods` ·
`validateInput` · `surface.snapshot.md` · `IDEAS/declared-method-contract.md`
(`FJS-D02`, `FJS-D07`).
**Neighbor:** OpenAPI, which Junction already generates. The spec is the part
OpenAPI has no field for: who may call, and what a call announces.

#### 12. The result envelope

**Would state:** `{ kind, object, data, errors, total, limit, offset }` plus the
window edge (`endCursor`, `hasMore`). `kind` is the discriminant and is never
inferred. A list keeps its envelope and a single record unwraps. One function
wraps and unwraps on both sides of the wire.
**Held today:** `packages/junction/src/core/envelope.ts`.
**Neighbor:** JSON:API, and OData's collection responses.

#### 13. The error contract

**Would state:** how a thrown value becomes a status (the precedence order), the
error categories, `retryable` (a race to re-read versus a refusal to show), and
the field-error shape a form reads.
**Held today:** `packages/junction/src/core/errors.ts` ·
`packages/junction/errors.snapshot.md`, which is already a vector table ·
`toFieldErrors`.
**Neighbor:** RFC 9457 (Problem Details for HTTP APIs), the obvious thing to
profile.

#### 14. Directives and query values

**Would state:** the directive table (`$limit`, `$offset`, `$orderBy`,
`$select`, `$after`). No prefixed key survives the boundary, and an unknown one
is refused on a request and dropped on a URL. What a query-string value means:
number only if it round-trips, `true`/`false`/`null`, bracket notation for
structure, quotes as the escape.
**Held today:** `@frontierjs/toolbelt/directives` · `@frontierjs/toolbelt/query` ·
Invariant 10 (`FJS-D125`, `FJS-D237`).
**Neighbor:** OData system query options, PostgREST and FIQL.

#### 15. Ordering and paging

**Would state:** how `orderBy` parses and compares, including nulls and mixed
types. A keyset window whose tiebreaker is the model's id when the ordering is
not total, with `total: null` on that path. **A list whose ties cannot be broken
carries no edge rather than a wrong one.**
**Held today:** `packages/junction/src/core/query-values.ts` · `findWindow` (`FJS-D145`).

#### 16. Transport binding

**Would state:** one call over two transports. The HTTP mapping (REST verbs,
custom methods by header) and the socket frame. The call-header allow-list,
since a socket has no per-call headers. The build a client compares against.
**Parity is the conformance test**: the same call on both transports gives the
same answer.
**Held today:** `packages/junction/src/transport/bridge.ts` · `setCallHeader` ·
`x-fjs-build` (`FJS-D160`) · `verifyTransportParity`.
**Neighbor:** JSON-RPC 2.0 for the frame, and RFC 9110 for the HTTP half.

#### 17. Call context and principal

**Would state:** the session shape and the principal a policy reads. The request
metadata (correlation id, idempotency key, locale, carried trace). **Deferred
work stores an id, not a session, and re-resolves it when it runs.** An app with
no declared system principal gets `null`, never an invented privileged one.
**Held today:** `packages/junction/src/core/context.ts` · `toDataPrincipal` ·
`app.runAs` · `SessionVerifier` (`FJS-D10`).

#### 18. The hook tiers

**Would state:** Hook (may mutate or halt), Guard (allow/deny), Observer
(receives, cannot act). The phases (before · after · around · error), and whether
anything answered.
**Held today:** `@frontierjs/toolbelt/hooks` · `svc.pipelines` (`FJS-D06`).
**Neighbor:** Ash's action lifecycle.

#### 19. Idempotent calls and the durable effect

**Would state:** an idempotency key claimed once per call across both
transports, with the replay not re-running the pipeline. An effect enqueued
inside the call's own transaction and relayed at least once under the enqueued
row's id.
**Held today:** `packages/junction/src/core/idempotency.ts` ·
`packages/junction/src/core/outbox.ts`.
**Neighbor:** the IETF `Idempotency-Key` header draft, and the transactional
outbox pattern.

#### 20. Session establishment

**Would state:** routes establish a session and everything after is a service. A
sign-in answers a session or a challenge, told apart by the absence of a user.
The session-verifier contract a transport accepts.
**Held today:** `packages/auth` · `client.auth` (`FJS-D20`, `FJS-D261`).
**Neighbor:** OAuth 2.1 and OpenID Connect cover the protocol to an identity
provider, not the app-side contract.

#### 21. Host lifecycle and self-report

**Would state:** the plugin protocol (`name`, sync `register`, `boot`, `ready`,
`shutdown`, `requires`) and one ordered startup phase list. What a plugin
contributes to health, metrics and the manifest.
**Held today:** `packages/junction/src/core/app.ts` · `runStartPhases` ·
`registerHealthCheck` / `registerMetricsSource`.
**Neighbor:** the IETF health-check response draft, and OpenMetrics.

#### 22. Attachments

**Would state:** the app declares what it needs and does not own, and the
environment binds it. One declared service's keys are all present or none are,
and a defaulted key is not evidence of a binding.
**Held today:** `checkAttachments` (`FJS-D158`).
**Neighbor:** the Service Binding Specification (servicebinding.io).

### API → UI — live data

#### 23. Events and channels

**Would state:** event names (`created` · `updated` · `removed` · `changed` · a
move's own name), and that a custom method announces under its own name. **A
channel is a subscription, not a permission**: every frame is graded per
recipient.
**Held today:** `packages/junction/src/transport/channels.ts` (`FJS-D44`, `FJS-D175`).
**Neighbor:** Phoenix Channels, and Hasura's subscription cohorts.

#### 24. Live membership and the client node store

**Would state:** whether a pushed record still belongs in a query's results,
answered true, false, or `null` (*ask the server*). One node per row keyed by
model, with a list as a view over nodes. Composed reads where the node is the
trigger rather than the value. **A push moves the value and never the
remembered version.** A mutation stored as intent.
**Held today:** `@frontierjs/toolbelt/match` · `packages/junction/src/client/nodes.ts`
(`FJS-D138`, `FJS-D161`) · `IDEAS/live-queries.md`.

### Integration and machines

#### 25. Provider

**Would state:** the target descriptor, and the per-target policy numbers that
fall back one field at a time. **A send never throws**, and its error kinds form
a closed table with `retryable` and `indeterminate`. **An idempotency key (the
target collapses duplicates) is a different claim from `replayable` (repeating
costs nothing).** A credential is a reference resolved at send time and fails
closed. Body encoding is owned by the transport, because the signer hashes the
same bytes.
**Held today:** `packages/conduit/README.md` § Core concepts ·
`packages/conduit/src/types.ts`. The word is Provider, and Adapter is refused
(`FJS-D06`).
**Neighbor:** resilience libraries (policy only, no result taxonomy).

#### 26. Signed machine requests

**Would state:** the canonical string (method, path, sorted query, timestamp,
nonce, body hash), the freshness window, the nonce store, and a replay check
that runs last.
**Held today:** `@frontierjs/toolbelt/signature` (`FJS-D220`, which weighed
Standard Webhooks). **Not yet weighed: RFC 9421 (HTTP Message Signatures)**,
which covers the same ground as an IETF standard.

#### 27. Outbound webhooks

**Would state:** a delivery is graded as the principal that registered it, and
signed per entry 26.
**Held today:** `FJS-D193`.
**Neighbor:** Standard Webhooks.

### Work and time

#### 28. Queue and Job

**Would state:** the job states (pending · running · done · failed · cancelled).
A stated `id` is idempotent for all time, while `unique` locks only work in
flight. At-least-once delivery through a lease, a heartbeat, and a completion
that lands only if its instance still owns the row. **Leaderless cron: a fire is
dispatched under a key naming the job and the minute.** The retry ladder repeats
its last delay. The actor is recorded as an id and re-resolved at run. **A pause
stops claiming**, survives a restart, and can be scoped to a holder. App verbs
are separate from operator verbs.
**Held today:** `packages/caravan/README.md` (`FJS-D36`, `FJS-D198`).
**Neighbor:** BullMQ, Sidekiq, Oban and Temporal all answer these differently.
**No standard exists**, which makes this the most novel entry.

#### 29. Cron expressions

**Would state:** which instants a five-field expression admits. The day-of-month
and day-of-week fields OR together; the other fields AND.
**Held today:** `@frontierjs/toolbelt/cron`.
**Neighbor:** Vixie cron, as a de facto standard to profile.

#### 30. Run

**Would state:** bounded work that finishes, can be interrupted, and resumes (a
backfill, a pay run, a deploy), as distinct from a standing Queue.
**Held today:** unnamed (`ARCHITECT.md` § *Not yet named*). A concept before it
is a spec.

#### 31. Flows

**Would state:** triggers, conditions and actions, and the flow dialect of
entry 4.
**Held today:** `packages/orion` (`FJS-D269`) · `IDEAS/orion-port.md`. Being
ported. Wait for it.

#### 32. Notifications

**Would state:** a `Recipient` as the unit of address, a notification type that
is persisted and so is a contract, and fan-out across transports.
**Held today:** `packages/notifications`.

### UI realm

#### 33. Reactive scheduling

**Would state:** not the signal cell, but the scheduling above it. Writes
coalesce to one flush. **DOM-building runs before user effects.** Derivations
settle outside-in, so a guard tears down before a memo inside it recomputes.
Ownership and cleanup (`createRoot`). A server render has no reactive graph. **A
Signal never crosses a boundary and an Event exists to.**
**Held today:** `packages/mesa/src/runtime.js` · `packages/mesa/docs/VISION.md`
§ 4.7 (`FJS-D44`).
**Neighbor:** TC39 Signals owns the primitive. Write this as a profile over it,
with the flush-order cases as vectors.

#### 34. Resource

**Would state:** how a UI binds to a service. `load(query, directives)`.
`save(data, { mode })`, which decides create or patch by the model's own id
field. `options(field)` answering `{ options, total, truncated, error }`, where
`error` separates *there are none* from *could not ask*. `record(id)`. The
version carried back on a patch.
**Held today:** `createResource` · `FJS-D114`.

#### 35. Field → control

**Would state:** a schema rule maps to a control name, or to `null` with a
reason. Value-set strength picks the control. A contributed control crosses the
boundary as a name. The form's error sources and the order they merge in.
**Held today:** `packages/sierra/src/resource/field-rules.js` · `$context.form`
(`FJS-D17`, `FJS-D120`).

#### 36. Design vocabulary

**Would state:** style with a tone and a treatment, never a color. One canonical
markup block per term. The theme is a class on the root element.
**Held today:** `packages/css/vocabulary.js` and `ANATOMY` · Invariant 13.
**Neighbor:** the W3C Design Tokens Community Group format, which covers tokens
but not vocabulary.

#### 37. Publishable prerender

**Would state:** a route built ahead of time proves the data it reads is
publishable against the gate, fails closed, and has a stated escape.
**Held today:** Sierra's static target · `IDEAS/static-safety.md`.

### Deployment and verification

#### 38. Release

**Would state:** a Release is immutable and environment-independent, and an
unchanged redeploy mints the same Release. A Pivot is where N-1 compatibility
ends. A deploy has a journal and a revert.
**Held today:** `IDEAS/release-transitions.md` · `fli deploy` (`FJS-D06`).
**Neighbor:** the OCI image spec for the artifact, and SLSA and in-toto for
provenance.

#### 39. Conformance from the seed

**Would state:** the checks a schema implies (gate ladder, constraints, field
protection, row policies, tenant isolation), generated for any app, each with a
negative control. The access diff between two Releases.
**Held today:** litestone's `verify*` checks · `litestone mutate` ·
`litestone access --from` · `IDEAS/kernel-and-projections.md` § 3.
**This is the meta-entry**: it is how every other entry gets its vectors.

#### 40. Agent surface

**Would state:** how a seed projects to agent tools. The gate is the permission
model, tool visibility follows standing, and schemas are generated for the
client audience.
**Held today:** `packages/mcp` · `IDEAS/agent-surface.md` (`FJS-D258`).
**Neighbor:** MCP is the standard and FrontierJS implements it. The spec is the
projection rule.

---

## Already a standard: implement, do not author

- **JSON Schema 2020-12**: the shape half of entry 1.
- **W3C Trace Context**: carried verbatim, never re-parsed.
- **Temporal and the IANA zone database**: time, plain dates and zones
  (`FJS-D268`). RFC 5545 recurrence is refused, not profiled.
- **RFC 9110 (HTTP semantics)** and **RFC 9457 (Problem Details)**, under
  entries 13 and 16.
- **OpenAPI**: generated, and never the source.
- **MCP**: under entry 40.
- **TC39 Signals**: under entry 33, while it is still a proposal.

---

## Stays implementation

These are FrontierJS's own answers and never go into a spec. **They include the
two languages**: `.lite` and `.mesa` are syntaxes over entries 1 and 33
(`FJS-D266`), and a spec describes the JSON the syntax compiles to. Also: SQLite
and Bun specifics; `fli`; file-tree routing; the app layout (Invariant 3); the
port formula; filename conventions (`*.job.ts`, `*.notification.ts`); the
default gate resolver; Mesa's `let`/`const`/`var` semantics; and the vocabulary
rulings, which a spec would *propose* rather than impose.

---

## Tensions to carry

- **Spec the IR, not the syntax.** A clean JSON model IR separate from `.lite`
  does not exist yet. `generateJsonSchema` is the nearest thing, and it is a
  projection, not an IR.
- **The Model entries wait for the kernel.** Entries 3 and 6 are the pipeline's
  order, and `IDEAS/kernel-and-projections.md` steps 1 and 2 are not built.
  Writing them before that means specifying the insertion sites.
- **Preservation vs. evolution** (`PHILOSOPHY.md` § IV). A spec freezes things
  and pre-alpha does not. Nothing is written until the framework settles, and
  nothing is frozen until a second implementation passes the vectors.
- **Not vocabulary-neutral** (`PHILOSOPHY.md` § VI). A committee needs words
  others will adopt. Gate, Target, Queue and Resource go in as proposals.
- **§ VII has no document kind for a normative spec.** Adding one is a
  `decision-rules` act and a ruling, taken when the first entry is written up.

---

## Measuring spec vs. glue

*With AI writing the code, code is a liability and the specification is the
asset. So how much of the tree encodes a spec decision, and how much is wiring?*
On 2026-10-06 there were about 311k lines of non-test JS/TS under `packages/`.
**This cannot be measured until the entries are written**, because without a
spec to measure against, sorting the code is only a judgment about what the spec
ought to be.

Two buckets are too few. Sort the code into four:

- **Spec semantics.** A second implementation of the entry would need this code.
- **An unclaimed decision.** It carries a `DECISIONS.md` ruling or an Invariant
  that no entry claims yet. This bucket is where new spec candidates turn up.
- **Host adapter.** It is needed on this host and replaced on another: Bun,
  Vite, SQLite, argv.
- **Plumbing.** Duplication, workarounds for one host's quirks, and wiring that
  exists only to connect the pieces. This bucket is the liability.

The line between them blurs. Invariant 4's "one owner per translation" is a
decision about the wiring itself.

There are three instruments, strongest first:

1. **Vector coverage.** Run an entry's conformance vectors with coverage on. The
   lines the vectors reach are spec semantics, and every other line falls in one
   of the other three buckets. This is the only true measurement. Its
   prerequisite is criterion 3.
2. **The second-implementation question, sampled.** For each sampled function,
   ask whether a different framework implementing this entry would need it. Two
   classifiers work independently, and their agreement rate shows whether the
   buckets can be told apart at all.
3. **The cheap proxy.** Count code that cites an `FJS-D` ruling or an Invariant,
   or that takes or returns a JSON form. It is fast, and it undercounts.

**Pilot on entry 14 (Directives).** One owner holds it (`toolbelt/directives` +
`toolbelt/query`) and its semantics are sharp. Run instrument 1 on that entry,
add a sample of about 50 functions under instrument 2, and do it before measuring
the rest of the tree.

---

## Questions for when FrontierJS settles

- Where do vector files live: beside the owning package, or in one neutral
  directory a second implementation can clone alone?
- Is entry 1's JSON form a JSON Schema vocabulary, or its own document that
  JSON Schema is projected from?
- What is the cheapest credible second implementation per entry? For example: a
  Postgres emitter from the IR, a `SKIP LOCKED` queue runner, a non-JS Provider
  client, or a scheduler over the TC39 Signals polyfill.

---

## See also

- `kernel-and-projections.md`: the kernel these entries are the outside of
- `review-prior-art.md`: Ash, the closest shared bet
- `one-mental-model.md`: the extension-point catalog
- `.claude/skills/bridge-index/SKILL.md`: the seams most API entries were read from
