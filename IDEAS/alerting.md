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

### Phase 2 — The operator picks where a crash goes

Goal: in an app Basecamp deploys, the crash ping reaches the channels the operator picked on the App page, and an app with no Basecamp rings exactly as Phase 1 does.
Done when: an app deployed by a local Basecamp, with a webhook channel picked and crash alerts on, crashes and the webhook listener receives one `AppCrashed` POST and the workspace topic one push; with Basecamp stopped the same crash reaches the ntfy trio directly; a second crash inside the window sends nothing either way.

- [x] 2.1 Rule Q5–Q7. (`FJS-D2272`, `FJS-D2273`, `FJS-D2275`)
- [x] 2.2 basecamp schema: `AppCrashed` in `NotificationKind` and `kinds.ts` (email, in-app, push); the `AppChannel` join; the on/off switch on `App`. Check whether `NotificationContext` needs `App`. **Built 2026-11-23:** `App.isCrashAlerted` (on, `FJS-D2353`), `AppChannel` at `@@gate(2.4)` (`FJS-D2352`), `App` added to `NotificationContext`, `AppCrashed.notification.ts` (push at priority 5), migration `20261123163111_app_crash_alerts.sql`, seed links one production app. No service writes `AppChannel` yet: attach/detach methods on `apps`, after `monitors.attachChannel`, land with 2.5.
- [x] 2.3 basecamp: find the seam that writes an app's env at release, and mint the per-app crash credential there. A raw route takes the crash (typed body, the credential, a rate limit after `FJS-D2183`), queues the fan-out and answers 202 — the app holds its exit for at most 3 s (`FJS-D2185`), so nothing is delivered inline. **Built 2026-11-23:** no credential (`FJS-D2358`): `startBody` in `deployment-run.job.ts` spreads `basecampIdentity(appId)` (`BASECAMP_URL`, `BASECAMP_APP_ID`) after the Variables, so a stored pair cannot redirect it. `POST /hooks/crash/{appId}` (`plugins/app-crash.ts`): 202 `{queued:true}`, 202 `{queued:false}` with alerts off, 400 a bad body, 404 no live App, 429 + Retry-After past 12 an hour per App, 503 the queue refused. The `app:crashed` job tells the members (`AppCrashed`, which also pushes the critical topic) and every picked channel, trigger only. Proved by `test/crash.test.ts` (9) and a `rollback.test.ts` case. **2.4 reads:** `${BASECAMP_URL}/hooks/crash/${BASECAMP_APP_ID}`; a 202 of either kind is final, a 404, a 503 or no answer falls back to the trio, and a 429 does not (the hub has the crash loop already).
- [ ] 2.4 notifications `crash.ts`: the destination is the relay when its settings are present, else the Q1 trio, else off; a relay that fails falls back to the trio; the window stays here (`FJS-D2186`), so a crash loop POSTs once. The boot line names the destination. `crash-ping.test.ts` gains the relay and the fallback.
- [ ] 2.5 basecamp web: the switch and the channel picker on the App page.
- [ ] 2.6 The Done line as a drive, extending `example` `verify:crash`.
- [ ] 2.7 `packages/notifications/README.md` § The crash ping and Basecamp's alerting docs name the relay.

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
- ~~**Q5 — In an app Basecamp deploys, where is the crash ping sent from?**~~ **Answered 2026-11-19 (`FJS-D2272`): A — relay: the app POSTs the crash once to its Basecamp under a per-app credential minted at release; Basecamp records `AppCrashed` and fans out through `fanOutToChannels` as `MonitorDown` does. Basecamp unreachable, the app falls back to the Q1 ntfy trio when it is set.** Q1 hard-wires ntfy, and an operator wants to pick the destination from Basecamp's `NotificationChannel` list (slack, pagerduty, email, webhook, chat) and the workspace push topic.
  - **A** — relay: the app POSTs the crash once to its Basecamp under a per-app credential minted at release; Basecamp records `AppCrashed` and fans out through `fanOutToChannels` as `MonitorDown` does. Basecamp unreachable, the app falls back to the Q1 ntfy trio when it is set.
  - **B** — at release Basecamp writes the chosen channel's settings, credential included, into the app's env, and `notifications` grows slack, pagerduty and webhook drivers.
  - **C** — Outpost sees the container exit and reports it to Basecamp; no app code.
  - **Recommend A** — one origin for destinations and one owner of delivery (Invariant 4); the credential stays an `@encrypted` Secret row, and a change needs no redeploy. B puts a plaintext copy in every app and a second Slack renderer in `notifications`. C catches what an app cannot report (OOM kill, SIGKILL) but has no stack; it complements A rather than replacing it.
- ~~**Q6 — Where does the operator choose an app's crash destinations?**~~ **Answered 2026-11-19 (`FJS-D2273`): A — per app: an on/off switch on `App` and an `AppChannel` join (`appId`, `channelId`), the shape of `MonitorChannel` and `AlertRuleChannel`, picked on the App page.**
  - **A** — per app: an on/off switch on `App` and an `AppChannel` join (`appId`, `channelId`), the shape of `MonitorChannel` and `AlertRuleChannel`, picked on the App page.
  - **B** — per channel: an `isPagedForCrashes` flag beside `isPagedForFleet`, so every app goes to the same place.
  - **C** — follow the app's managed `Monitor`'s `MonitorChannel` picks.
  - **Recommend A** — the operator asked to choose per app. C has no source for an app with no domain (no managed Monitor) and lets the Monitor screen silently govern crashes. B is the reopen path if per-app picks are never used.
- ~~**Q7 — Does an `AppCrashed` page ever resolve?**~~ **Answered 2026-11-19 (`FJS-D2275`): A — trigger only, no `dedupKey`: a person closes the incident.** PagerDuty keeps an incident open until a `resolve` with its `dedupKey`; a crash is an event with no recovery to observe.
  - **A** — trigger only, no `dedupKey`: a person closes the incident.
  - **B** — `dedupKey` per app, resolved after the app has run one crash window without crashing.
  - **Recommend A** — B invents a recovery Basecamp cannot see; the managed `Monitor`'s `MonitorUp` already reports the URL answering again.
- ~~**Q8 — Who may pick an app's crash channels?**~~ **Answered 2026-11-23 (`FJS-D2352`): A — developers: `AppChannel` is `@@gate(2.4)`, the App's own write level, as `MonitorChannel` takes the `Monitor`'s.** Making a channel stays admin's (`NotificationChannel` is `@@gate(2.5)`); writing an `App` is a developer's (`@@gate(2.4.4.4)`), and a `Monitor`'s picks are an admin's because the `Monitor` is.
  - **A** — developers: `AppChannel` is `@@gate(2.4)`, the App's own write level, as `MonitorChannel` takes the `Monitor`'s.
  - **B** — admins: `@@gate(2.5)`, as every other channel join; the App's switch, written at the App's level, then needs its own guard or a developer can still silence what they cannot reroute.
  - **Recommend A** — a join's gate is its parent's in both siblings, and a developer who may delete the app gains nothing by muting it; the credential stays behind the admin-only channel.
- ~~**Q9 — Is a new App's crash alerting on or off?**~~ **Answered 2026-11-23 (`FJS-D2353`): A — on: `App.isCrashAlerted Boolean @default(true)`; with no channel picked a crash still reaches people through the kind's defaults and the workspace push topic.**
  - **A** — on: `App.isCrashAlerted Boolean @default(true)`; with no channel picked a crash still reaches people through the kind's defaults and the workspace push topic.
  - **B** — off until someone turns it on.
  - **Recommend A** — `isPagedForFleet`'s reason: a crash nobody heard about is the failure, so silence is the opt-out.
- ~~**Q10 — What does a release hand an app so it can reach its Basecamp, and does the crash report carry a credential?**~~ **Answered 2026-11-23 (`FJS-D2358`): A — no credential for now: release sets `BASECAMP_URL` (Outpost's name for *where I report to*) and `BASECAMP_APP_ID` (`App.id`), after the Variables so a stored one cannot override them; `notifications` posts to `${BASECAMP_URL}/hooks/crash/${BASECAMP_APP_ID}`, held to a per-app rate limit.** `FJS-D2272` said *a per-app credential minted at release*; no container is told its own App id today (release adds only `FRONTIER_BUILD` and `FRONTIER_PORT_BE` to the Variables).
  - **A** — no credential for now: release sets `BASECAMP_URL` (Outpost's name for *where I report to*) and `BASECAMP_APP_ID` (`App.id`), after the Variables so a stored one cannot override them; `notifications` posts to `${BASECAMP_URL}/hooks/crash/${BASECAMP_APP_ID}`, held to a per-app rate limit.
  - **B** — a per-app token, `App.crashToken @encrypted @system`, minted by the first release that finds it empty and sent as `FRONTIER_CRASH_TOKEN` beside `FRONTIER_CRASH_URL`.
  - **C** — one `FRONTIER_CRASH_URL`, no credential.
  - **Recommend A** — the pair is the app's identity to its Basecamp, which the next feature (metrics, a health report) reuses, where C's URL serves one purpose. The id is not secret — it is in every `/apps/<id>/` link — so anyone who has seen one can page the app's channels; the per-app limit caps that, and B is the reopen path once a forged page happens or a channel costs money per page.

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
