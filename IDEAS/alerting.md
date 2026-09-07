---
id: alerting
status: proposed
dated: 2026-09-07
---

# Idea — Alerting and error tracking: an app that fails at 3am tells nobody

**Status: IDEA.** Probed against the tree 2026-09-07 (`VERIFYING.md`). The probe
changed this record before it was written: **both halves have more built than
the gap implies, and neither is reachable from an app.**

---

## Two questions people buy as one product

**Alerting** is *a number crossed a line and stayed there.* The unit is a series,
the input is readings over time, and the answer is a verdict with a reason. It
needs a store, a threshold, and a window.

**Error tracking** is *something threw that nobody expected.* The unit is a
stack, there is no series, no threshold and no window, and the first occurrence
is the interesting one — which is the opposite of alerting, where the first
reading is the one you must not fire on.

Sentry sells them together and they are not one mechanism. The rest of this
record keeps them apart, and where they meet is named.

## What already exists — alerting

**The evaluator is built, and it is pure.** `packages/basecamp/api/src/core/alerting.ts`
takes the points the caller read and the instant they read them at: no database,
no clock of its own, no app. Its `Verdict` names four answers, and the three
that are *not breached* are separated rather than collapsed — `no-data`,
`uncovered` and `recovered` — because an evaluator reporting *no breach* for a
series nobody is writing is the exact silence the whole chain exists to break.

**The store is in junction, not in basecamp.** `packages/junction/db/metrics.lite`
keeps readings over time — `MetricSeries` addressed by `labelsKey`, OpenMetrics
1.0's `counter` / `gauge` / `histogram` taken rather than renamed, in `main` for
`FJS-D35`'s reason. Any app that installs junction already keeps the readings a
threshold needs.

**The rule is a model, and it is basecamp's.** `AlertRule` carries the condition
as columns rather than as `Json` — `operator`, `threshold`, `forMinutes` — after
three writers spelled one blob three ways and every seeded rule rendered its
threshold as an em-dash with nothing erroring. It fans out through
`AlertRuleChannel` to a `NotificationChannel`, and it is `@@gate("2.5")` and
workspace-scoped.

**So the gap is exact and small.** junction has the store. basecamp has the
evaluator and the rule. **No app has both**, and nothing an app installs will
ever look at the readings junction is keeping for it. An FJS app today scrapes
itself, stores the result, and no code path reads it back to ask a question.

## What already exists — error tracking

Less, and it is worth stating precisely because *nothing exists* is wrong.

`packages/junction/src/core/app.ts` installs `unhandledRejection` and
`uncaughtException` handlers, each behind two guards — `config.shutdown.crashHandlers`
and a `listenerCount` of zero, because a framework replacing an application's
crash handling is worse than not having any. Each logs through `logger.error` and
calls `crashStop()`, so a crashed process drains and shuts down rather than
vanishing.

**The handler exists, it logs, and the log has no destination.** That is the
same missing entrance the other three Observe records describe: the fact is
produced correctly at the source and there is nowhere for it to go. A refused
call is narrower and worse — `lantern.md`'s hole 4 — a gate refusal is a bare
`throw` and emits nothing on any channel at all.

## The shape

**Point the existing evaluator at the app, rather than write a second one.**
`alerting.ts` being pure is what makes this a move rather than a rewrite: it
has no basecamp in it. Four things follow, and each removes the reason for the
next.

1. **The evaluator moves to where both callers can reach it.** It is a pure
   function over readings and a condition, which is `@frontierjs/toolbelt`'s
   admission test (`FJS-D26`). basecamp keeps `AlertRule`, the workspace scoping,
   the channels and the job; it imports the verdict.
2. **An app declares a rule the way it declares a job.** A `*.job.ts` file is
   the whole declaration of unattended work and the file names the job; the same
   shape holds here, and it keeps a rule out of a database for an app that has
   no console to edit one in. basecamp's `AlertRule` rows stay what they are —
   rules a **person** wrote at runtime — and the two are not one mechanism.
3. **Delivery is `app.notify`, not a new transport.** notifications already
   fans out to a `Recipient` across transports, already has a preference model,
   and already drops email where there is no mailer rather than throwing away
   the in-app copy. An alert whose recipient is an operator is a notification.
4. **A vendor is a connector and lives outside this repo.** `FJS-D153` and
   `FJS-D215` already settled it for every battery that publishes a boundary:
   Sentry, PagerDuty and Opsgenie are `@frontierjs/conduit-<x>`, promoted out of
   an app once a second one exists to argue with. What is in scope here is the
   seam they attach to.

## What this record does not answer

- **Whether an uncaught exception is a series.** Folding error tracking into the
  metric store makes *how many crashes in the last hour* answerable with the
  machinery that exists, and loses the stack, which is the only part anybody
  reads. Grouping — Sentry's event / issue / group split — is the modelling
  decision, and `IDEAS/reference-library.md` already names it as one worth
  reading rather than inventing.
- **Who scrapes.** `registerMetricsSource` collects and `rollupNow()` folds, but
  a single-process app has nothing driving the scrape on a schedule. A cron in
  caravan is the obvious answer and it means an alert cannot fire in an app that
  runs no queue.
- **What fires when the app is down.** Every arrangement above evaluates
  **inside** the process being watched, so the one failure that matters most is
  the one it cannot report. `basecamp` watching a fleet is the answer for an app
  that has a control plane and there is none for an app that does not. A dead
  man's switch — an app that must check in, and a watcher that alerts on the
  silence — is the standard answer and is a second mechanism, not this one.
- **Whether a refusal is an event.** `lantern.md` hole 4 wants a decision event
  for its own reasons. If it lands, *a caller was refused N times in a minute* is
  a series and this record inherits it for free.

## See also

- `IDEAS/lantern.md` — hole 4, the decision that emits nothing
- `IDEAS/production-grading.md` — the other half of the same missing entrance:
  this record is *tell me when a number moves*, that one is *tell me when a
  declaration stops holding*
- `IDEAS/metric-store.md` — the store this reads
- `IDEAS/traffic-analysis.md` — the same two-questions-called-one opening, one
  record along
- `packages/basecamp/api/src/core/alerting.ts` — the evaluator, and the four
  reasons a window is not breached
