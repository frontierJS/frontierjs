---
id: production-grading
status: proposed
dated: 2026-09-07
---

# Idea — Production grading: `fli check`, aimed at a machine

**Status: IDEA.** Probed against the tree 2026-09-07 (`VERIFYING.md`).

Everything in this repo that grades anything reads **files**. `fli check` reads
the file tree, `fli proves` reads a diff, `fli register:check` reads three
markdown registers, `litestone mutate` mutates a schema on disk, and
`access.snapshot.md` is a text file compared to another text file. That is a
strong position and it is the whole of it: **nothing here asks a running system
whether it still matches what was declared.**

The gap has a shape rather than a size. Grading is one of the two best-covered
areas in the framework and it cannot see production — not because grading is
weak, but because the thing it would grade never arrives. `IDEAS/lantern.md`,
`IDEAS/logbook.md` and `IDEAS/traffic-analysis.md` are each a way OUT of a
running process; none of them is a way for a running process to be **asked a
question**. Build the graders without that and the arc does not close.

---

## What it is not

Three neighbouring records, and each is a different question. Getting this wrong
makes a fourth spelling of one fact, which is the failure shape this repo files
most often.

| Record | Question | Audience | Unit | Output | Kept for |
| --- | --- | --- | --- | --- | --- |
| `lantern.md` | why was **this caller** refused | a developer already looking | one request | a span tree to click into | twenty minutes |
| `logbook.md` | what did the process **say** | a developer, after the fact | one line | a searchable log | a retention window |
| `traffic-analysis.md` | what **traffic** is this app taking | an operator | one request | counts by route and status | a retention window |
| **this** | does what **runs** match what was **declared** | nobody — it runs unattended | the deployment | a verdict, `fli check`'s own shape | forever |

The last column is the one that separates it. The interesting fact about a
declaration that stopped holding is **when it stopped**, which a twenty-minute
ring cannot answer and a verdict history can.

## The questions it would ask

Each of these is answerable about the tree today and about no running app.

- The Release on this machine claims a schema version. **Does the database on
  that machine actually have that version's tables?** `fli check` grades the
  schema against the migrations beside it; nothing grades either against the
  file the process opened.
- `access.snapshot.md` says a model reads at a given gate. **Is the process
  serving it at that gate?** A hand-edit, a stale image, or a swap that finished
  half way makes the two differ, and the committed snapshot goes on being green
  because it is a fact about the branch.
- An attachment was declared bound. **Is it bound now**, rather than at boot?
  `packages/junction/tests/attachments.test.ts` grades the refusal and
  `deployJournalCycle` grades the operator reading it — both at start-up.
- `invariants.snapshot.md` records which invariants resolve to an enforcer.
  **Do those enforcers run in the deployed build?** A build that dropped one is
  indistinguishable from one that kept it, from every document.
- A `@@transitions` model declares its terminal states. **Is any row sitting in
  a state the running machine has no path out of?**

None is exotic. Every one is the same sentence: *a claim this repo already
generates, asked of a process instead of a directory.*

## What already exists, and it is the larger half

**The declared side is generated and CI-gated already.** `access.snapshot.md`,
`principal.snapshot.md`, `surface.snapshot.md`, `release.snapshot.md`,
`jsonschema.snapshot.md`, `ddl.snapshot.sql` and `invariants.snapshot.md` are
each written by a named command and rechecked by the `snapshots` phase. So this
is not *build a model of the app*; the model is committed. What is missing is a
second reading of the same model taken from somewhere else, and a comparison.

The running side has pieces and no entrance:
`app.registerHealthCheck` and `app.registerMetricsSource` exist, `GET /metrics`
merges what was registered, `junction/db/metrics.lite` keeps readings over time,
and `x-fjs-build` already tells a browser which build it is talking to. What no
app has is an endpoint that answers *what do you believe you are enforcing*.

## Sequence, and what it waits on

**After `lantern`, not instead of it.** `lantern.md`'s holes 1 and 5 — nothing
is kept, and no sampling, retention or export — specify the store this needs,
and building two stores would be the same defect this record exists to name.
The order is: lantern's store, then an endpoint that reports the running
declaration, then the comparison and its verdict history.

The cheapest first slice is the narrowest question with the worst failure mode:
**the gate ladder.** One route that answers the gate each accessor is being
served at, compared to `access.snapshot.md` for the Release the process reports.
It reuses a snapshot that already exists, needs no store, and the thing it
catches — a deployed process enforcing a different ladder than the branch says —
is silent by construction today.

## Open questions

- **Who asks.** A `fli` command run against a host, a Basecamp engine polling
  its fleet, or the app grading itself on a schedule and reporting the verdict
  as a metric. The third needs no new transport and is the one an app with no
  control plane can use.
- **What the endpoint costs.** *What am I enforcing* is a description of the
  access surface, which is exactly what an attacker would like. It cannot be a
  public route, and `devtools()`'s answer — refuse to bind under
  `NODE_ENV=production` with no `auth` — is the wrong one here, because
  production is the only environment where the question means anything.
- **Whether a verdict is a metric.** Folding it into
  `registerMetricsSource` gets retention, alerting and a history for free from
  work already specified. It also makes a boolean into a time series, which is
  what `MetricType` has no member for.
- **What it does about drift it cannot explain.** `verify:studio:access` already
  names which side moved when a schema and its snapshot disagree. The same
  answer is owed here and is harder: the two sides are a file and a machine.

## See also

- `IDEAS/lantern.md` — the store and the export this waits on
- `IDEAS/deploy-plane.md` — build once and promote a digest, which is what makes
  *the Release on this machine* a question with one answer
- `invariants.snapshot.md` · `packages/cli/core/invariants.js` — the register of
  what fails when an invariant stops being true, and the closest existing thing
  to a verdict with a history
