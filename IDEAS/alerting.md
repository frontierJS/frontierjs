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

**The evaluator is built, and it is pure.** `packages/basecamp/api/src/domain/alert/alerting.ts`
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

## Phases

The owner picked two of the four arrangements on 2026-11-15: **outside-in from
Basecamp** for an app that is down, and **the crash handler rings once** for an
app that threw. They cover each other's hole. A process that dies before the
crash handlers install, or hangs without throwing, sends nothing, and Basecamp's
`Monitor` sees the URL stop answering. A process that throws and restarts inside
a sweep interval never looks down to a `Monitor`, and the crash handler sees it.
The other two are not planned: in-app rules (§ The shape) and a dead man's switch
both wait for an app with no Basecamp to ask for them.

### Phase 0 — Prove what Basecamp already does

Goal: a `Monitor` going down rings a phone today, with no new code.
Done when: on a local Basecamp with rung 1 (`NTFY_BASE_URL`) pointed at a local listener, a monitored URL stops answering, `monitor-sweep` moves the `Monitor` down, and the listener receives one POST to the workspace's critical topic at priority 5.

- [x] 0.1 Find the drive that already covers `MonitorDown` → push (`packages/basecamp` `verify:*`), and run it. If none does, drive it by hand as the Done line reads. **Done 2026-11-15:** no drive covered it — `api/test/monitor-sweep.test.ts` stops at the queued `notify:deliver`. Driven by hand on `createTestEnv` with rung 1 at a loopback listener and `sweepMonitors` (the job's body) at stated instants: up, then the target stopped, then down on the second failure (`retries: 1`). The listener received one POST to `/fleet-critical-<suffix>` with `Priority: 5`, `Tags: rotating_light`, `Title: Monitor down`, a `Click` to the monitor and the probe's error as the body.
- [x] 0.2 Anything that does not ring is an `FJS-###` row, and Phase 1 waits on it only if it is in `@frontierjs/notifications`. **Nothing failed to ring; no row filed.**

### Phase 1 — A crash rings once

Goal: a junction app that throws an uncaught error sends one critical ping before it exits, and a crash loop does not ring all night.
Done when: in `packages/notifications`, an app crashed by an uncaught throw delivers one push through the `ntfy()` driver's `deliver` stub before `process.exit`; a second crash inside the window delivers none; an app with no ntfy settings crashes exactly as it does today.

- [x] 1.1 Rule Q1–Q4. (`FJS-D2184`–`FJS-D2187`)
- [x] 1.2 junction: `crashStop` emits the crash on the app's event bus and waits for its listeners under the Q2 cap, before `app.stop()` (per Q4). It runs once: a second throw during the ping does not start a second stop. **Built 2026-11-15:** `app:crash` carries `{ message, error }`; `packages/junction/test/shutdown.test.ts` § app:crash pins the order, the one deadline, a listener that never settles, and the second throw.
- [x] 1.3 notifications: listens, sends one push through `ntfy()` to the Q1 address, and keeps the Q3 record. **Built 2026-11-15:** `packages/notifications/crash.ts`, called from the plugin's `boot()`. `NTFY_BASE_URL` without `NTFY_TOPIC` turns the ping off with a boot line rather than refusing boot, because Basecamp and Workbench set the first for their own pushes and configure this package. The record is `.crash-ping` in the main database's directory, else the working directory. A failed send is counted like a suppressed one and opens no window. `test/crash-ping.test.ts` covers this, including a real process crashed twice against a loopback listener: one ping, then none.
- [x] 1.4 `example`: one drive that crashes the API on purpose against a local listener, run twice inside the window. **Built 2026-11-15:** `example` `verify:crash` (`web/test/verify-crash.mjs`). It runs the API from a scratch copy of the app on 7110, because a `tenancy { strategy database }` fleet is fixed beside the schema file and no setting moves it; a `--preload` fixture throws on `SIGUSR2`, so the app carries no crash switch. One ping at priority 5, then none and `since: 1`. The record lands in `db/shops/`, the directory of the shop file, which `.gitignore` already covers.
- [x] 1.5 `packages/notifications/README.md` § the crash ping, and `example/.env.example` names the settings. **Written 2026-11-15:** README § The crash ping, after § ntfy; `.env.example` § Crash ping.

## Open questions

- ~~**Q1 — Where does a crash ping go in an app with no Basecamp?**~~ **Answered 2026-11-15 (`FJS-D2184`): A — three settings, all or none: `NTFY_BASE_URL`, `NTFY_TOKEN` (optional on a public server) and `NTFY_TOPIC`. Absent, no ping, and the boot banner says so once.** `app.notify` takes a `User`, and an app has no operator row to name. Basecamp's ladder (`api/src/push.ts`) is Basecamp's own and an app cannot import it.
  - **A** — three settings, all or none: `NTFY_BASE_URL`, `NTFY_TOKEN` (optional on a public server) and `NTFY_TOPIC`. Absent, no ping, and the boot banner says so once.
  - **B** — an operator `Recipient` in `notifications` config, delivered through `app.notify` on every transport it has (email too).
  - **C** — public ntfy.sh by default with a random topic printed at boot, as Basecamp's rung 3.
  - **Recommend A** — the spelling Basecamp's rung 1 already reads, so an app Basecamp deploys can be handed the same pair later. B is the more complete answer and needs an operator noun nobody has asked for. C publishes to a server the owner did not choose, from an app that never said it wanted pings.
- ~~**Q2 — How long may the ping hold the exit, and before or after `app.stop()`?**~~ **Answered 2026-11-15 (`FJS-D2185`): A — before `app.stop()`, capped at 3 s and taken out of the shutdown budget (`FJS-D1841`), so ping plus `stop()` is one deadline and `stop()` gets `timeout − 3 s`. A send that fails or runs out of time writes one stderr line and the exit goes on.**
  - **A** — before `app.stop()`, capped at 3 s and taken out of the shutdown budget (`FJS-D1841`), so ping plus `stop()` is one deadline and `stop()` gets `timeout − 3 s`. A send that fails or runs out of time writes one stderr line and the exit goes on.
  - **B** — after `app.stop()`, once the drain is done.
  - **C** — fire and forget. `process.exit` can land before the POST leaves.
  - **Recommend A** — the drain is what a crash waits on longest, and a `stop()` that hangs never reaches a ping queued behind it. 3 s is one ntfy round trip plus the driver's one `fallback` try. Two caps in a row would be 3 s + 9 s under `fli dev`'s 10 s grace, which is why it is one deadline.
- ~~**Q3 — What keeps a crash loop from ringing all night?**~~ **Answered 2026-11-15 (`FJS-D2186`): A — one ping per 10 minutes, recorded as a timestamp file beside the main database file, else in the working directory (`:memory:`, or no client). A suppressed ping is counted into the next one (*crashed 14 times since*).** `--restart unless-stopped` brings the app straight back, and memory dies with the process, so a counter in memory sends one ping per restart.
  - **A** — one ping per 10 minutes, recorded as a timestamp file beside the main database file, else in the working directory (`:memory:`, or no client). A suppressed ping is counted into the next one (*crashed 14 times since*).
  - **B** — the same window, read from the app's own database.
  - **C** — no window: one ping per crash.
  - **Recommend A** — the record that stops the loop must not depend on what may be broken, and the database is the likeliest thing to be. A file needs only a directory the app already writes.
- ~~**Q4 — Who owns the send?**~~ **Answered 2026-11-15 (`FJS-D2187`): A — junction emits `app:crash` on `app.events` and awaits its listeners; notifications listens.** junction owns the crash (`crashStop`), and notifications owns delivery; junction may not import notifications (`AppNotify`'s header).
  - **A** — junction emits `app:crash` on `app.events` and awaits its listeners; notifications listens.
  - **B** — junction calls `app.notify` when a plugin has installed it.
  - **C** — notifications installs its own `uncaughtException` handler.
  - **Recommend A** — one owner each (Invariant 4). C is wrong twice: junction installs its handlers only when `listenerCount` is zero, so a plugin's handler would switch junction's drain off and the app would vanish rather than stop. B needs a `User` (Q1) and puts a delivery decision in junction.

## See also

- `IDEAS/lantern.md` — hole 4, the decision that emits nothing
- `IDEAS/production-grading.md` — the other half of the same missing entrance:
  this record is *tell me when a number moves*, that one is *tell me when a
  declaration stops holding*
- `IDEAS/metric-store.md` — the store this reads
- `IDEAS/traffic-analysis.md` — the same two-questions-called-one opening, one
  record along
- `packages/basecamp/api/src/domain/alert/alerting.ts` — the evaluator, and the four
  reasons a window is not breached
