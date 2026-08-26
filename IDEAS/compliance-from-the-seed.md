---
id: compliance-from-the-seed
status: idea
dated: 2026-08-04
---

# Idea — Compliance derived from the seed

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. No `@pii` or `@retain`
attribute exists in the `.lite` grammar, and nothing generates any of the artifacts
below. Do not cite this file as describing behavior — see `VERIFYING.md`.

> **One neighbour DOES ship, added 2026-08-25** — and it is the closest thing in the
> tree to what item 5 below proposes, so read it before designing `@retain`. A
> `database` block takes `retention 30d`, and `tools/retention.js` deletes rows older
> than that from every model in the block carrying a `createdAt`. It is at the wrong
> granularity for this file (a database, not a field) and it is the shape a field-level
> version must not copy: the cutoff is `new Date(Date.now() - ms)` with `d` a flat
> 86,400,000, so there is no calendar and no day boundary, and it runs **once, at
> `createClient`** — a server that stays up never prunes again. `FJS-521`, and
> `IDEAS/time-and-recurrence.md` for why the boundary half cannot be settled here.

---

## The claim

Data-protection work — GDPR, CCPA, SOC 2 evidence — is a recurring, expensive,
manual engineering cost in every application, and every framework makes you do it by
hand for the same reason: **their authorization lives in handlers, so nothing can be
derived from it.** You cannot generate a data map from code that a caller might
route around.

FJS declares three things no other framework declares together:

- **who may read a column** — `@@gate`, `@guarded`
- **whose rows these are** — `@scoped`, and the FK/relation graph
- **where data leaves the building** — Conduit's declared targets

Add two attributes and the seed becomes a compliance artifact.

```
model User {
  email     String   @unique @pii(contact)
  ip        String?  @pii(identifier) @retain(90d)
  notes     String?  @guarded(5)
}
```

## What can be generated

### 1. A data map / Record of Processing Activities

Every field holding personal data, its category, its retention period, the minimum
gate level that can read it, and — via Conduit — which third parties receive it.
This is the document organisations currently maintain by hand in a spreadsheet that
is wrong within a month. Here it is `fli marshal:map`, regenerated on every schema
change, and **wrong is a build failure rather than a discovery during an audit**.

### 2. A subject access request that is correct by construction

"Export everything you hold about this person" is a traversal: start at the subject,
follow `@scoped` and the relation graph, collect every `@pii` field. The schema
already has the graph — `buildRelations()` reads it, and the browser already
consumes it. Today every app writes this by hand and misses three tables.

### 3. Erasure that actually cascades

Same traversal, with `onDelete` semantics the migration already encodes. The
interesting part is what erasure means for columns that *must* survive — an
`AuditEvent` that is `LOCKED` cannot be deleted even by `asSystem()`, which is
correct, and means the schema must be able to express **anonymise** distinctly from
**delete**. That is a ruling to make, not an implementation detail.

### 4. A permission diff on every pull request — **shipped 2026-08-15**

`fli test:access --from origin/main`, and the `access` phase of `bun run ci`,
which prints it per app on every run. Authorization-as-data means a change to who
can see what is **reviewable in a diff**, by a person who is not the author,
before it merges. No framework whose authz lives in middleware can offer this,
because the change is spread across files that do not look like permissions.

```
✗  WIDENS — this change hands callers access they did not have

Against `origin/main` — 5 widen · 0 undecidable · 1 narrow

  widens   model User      gate "4.4.5.6" → "2.4.5.6" — read drops to READER
  widens   model User      @@allow('read') removed
  widens   User.apiKey     @secret removed
  widens   User.role       @allow('write') removed
  narrows  model Order     @@allow('read') added
```

**It cost less than the parse of two schema versions this record budgeted, and
the design was not the obvious one.** `classifyPivot` already compared two
release surfaces, so the cheap move was to point it at the base ref — and that is
wrong, in a way worth recording: the pivot classifier grades *can N-1 and N serve
one database*, and on the five-widening change above **every finding is an
`expand`**, while the one change that narrows is its only `contract`. The two
axes are not correlated and not opposite; they are different questions over the
same declarations. So the finding carries both, one walk produces it, and
`classifyAccess` is a second grading rather than a second traversal — two walks
over one set of declarations being how two answers to one question drift apart.

Two things fell out of building it:

- **A field-level `@allow` was absent from the release surface entirely**, so
  `release:check` could not see it either. It is where the sharpest columns in
  this repo are guarded — `isSystemAdmin`, `role`, `emailVerified` — which made
  it the one omission that would have discredited the feature on its first real
  use. It is a compatibility change as well as a permission one, so both axes
  gained it.
- **The direction of a `@@transitions` change depends on whether the field was
  constrained at all.** The first transition declared on a free enum column
  refuses every other move; the second permits one more. The two read identically
  as a single added row and are counted per field instead.

What it deliberately refuses to answer is a predicate whose text moved:
`@@allow('read', total > 0)` → `total > 100` is reported as undecidable, because
two expressions are not comparable by reading them and a guess in this direction
is the one that ships. Same limit at the field level.

Not built: posting it as a PR comment. The workflow calls `scripts/ci.mjs` and
nothing else, deliberately, so a GitHub-shaped surface would be the first thing
in CI that does not run identically on a laptop.

### 5. The outbound surface report

Already half-argued in `IDEAS/offline-first-and-release.md` under FOSS hygiene:
Conduit's declared targets make "what does this app phone home to" answerable. Here
it joins the data map — a target that receives a `@pii` field is a processor, and
naming it is a legal requirement, not a nicety.

### 6. Support mode — bounded, audited impersonation

Added 2026-08-12, from an ecosystem sweep of the app lifecycle. The word
*impersonation* occurs nowhere in `IDEAS/`, and it is the most common day-two task in
any real application: **a customer says it is broken and nobody can reproduce it.**

Everywhere else this is hand-rolled and frightening, for a structural reason. Where
authorization lives in handlers, there is no way to express *act as this person and no
higher*, so what gets built is a god-mode switch — a support agent browsing as an
administrator, with an audit trail that records the victim rather than the operator.
Every part of that is a breach waiting for a bad afternoon.

FJS can express the bounded version because the bound is already declared:

- **The level is the user's, not the operator's.** `sessionGateLevel` resolves the
  impersonated principal, so a support session cannot exceed what that person can do —
  the ceiling is enforced at the Data boundary by the same mechanism as every other
  request, not by a check somebody remembered to write.
- **Attribution is the operator, not the subject.** The audit entry names who really
  acted, which is the opposite of what a hand-rolled switch produces, and it is what
  makes the feature defensible to the buyer this record is written for.
- **Protected fields stay protected.** Invariant 7 already redacts
  `@encrypted`/`@guarded`/`@secret` in the trail, and support mode must not become the
  one path where a person reads a column the schema says nobody reads. Seeing *what the
  user sees* and seeing *everything about the user* are different features; this is the
  first.
- **It is bounded in time and recorded as an episode**, not a flag on a session — a
  support session has a start, an end, a reason, and a subject who can be told it
  happened.

That last point is where this stops being a convenience and joins the rest of this
file: a subject access request that can answer *who looked at my record, when, and why*
is a stronger artifact than one that only lists the data.

Wants the audit trail to be complete first, so it sits behind the same dependency as
`IDEAS/time-travel.md` — a support episode that a bulk write can escape is not an
episode.

## Why this is a wedge, not a feature

Compliance is the rare area where **the buyer is not the developer**. A framework
that emits a defensible data map, a working DSAR endpoint, and a permission diff in
CI is arguing to a different person than the one comparing DX. It is also the
clearest possible demonstration of why the schema-first bet was worth making —
these artifacts are impossible without it, not merely harder.

Adjacent, and worth stating: this is the same substrate `IDEAS/operational-edge.md`
wants for provisioning and `IDEAS/agent-surface.md` wants for tool scoping. All
three read the same declarations. Build the reader once.

## What would have to be built

1. **`@pii(category)` and `@retain(duration)` in the parser.** Grammar plus
   validation. Both are annotations with no runtime behavior at first, which makes
   them cheap and safe to land early — and every field annotated before the tooling
   exists is a field that does not need revisiting.
2. **`fli marshal:diff`** — parse two schema versions, diff the gate/guard tables,
   exit non-zero on a widening unless acknowledged. Genuinely small.
3. **The subject traversal** — one graph walk, shared by DSAR export and erasure.
4. **`fli marshal:map`** — the report, joining fields to gates to Conduit targets.
5. **Retention enforcement** — a Caravan job per `@retain`, which is the only piece
   with a runtime cost and should be opt-in. **A Caravan job and not a startup pass**,
   which is exactly where the shipping database-level `retention` went wrong
   (`FJS-521`) — and the clock belongs there by ruling, since unattended recurring
   work is the queue's (`FJS-D36`).

Proposed home: **`@frontierjs/marshal`** (see `IDEAS/package-map.md`).

## Open questions

- **Anonymise vs delete.** `LOCKED` models cannot be deleted at all, by design. So
  the schema needs to say what erasure *means* per model, and the honest default is
  probably "refuse, loudly" rather than a silent partial erasure.
- **Is `@pii` a category or a boolean?** A category (contact, identifier, financial,
  special) is what a data map needs, and a boolean is what people will actually
  write. Probably accept both.
- **Does retention interact with `@@softDelete`?** A soft-deleted row still holds the
  data. This is exactly the kind of thing that is obvious in hindsight and missed in
  every hand-rolled implementation.
- **Where does lawful basis live?** It is per-processing-purpose, not per-column, so
  it may not belong in the schema at all — possibly a sidecar file the map joins
  against. Resist putting non-derivable prose in the seed.
- **Does a Slice declare its own PII?** It must — a billing slice contributes
  personal data to the consuming app's data map, and if that does not flow through,
  the map is wrong the moment anyone installs anything (`IDEAS/slices.md`).

## See also

- `IDEAS/package-map.md` — `marshal`, and the packages it shares substrate with
- `IDEAS/agent-surface.md` — the same declarations read for a different purpose
- `IDEAS/offline-first-and-release.md` — the outbound-surface command, in its
  original FOSS-hygiene framing
- `IDEAS/operational-edge.md` — `project:map --json` is the app model this extends
- `CLAUDE.md` § Bridge index — `buildRelations()`, `buildGate()`, and the `@guarded`
  behavior verified against a live db in the Basecamp entry
