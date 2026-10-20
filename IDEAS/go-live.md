---
id: go-live
status: proposed
dated: 2026-10-19
---

# Idea — go-live: what is checked before an app is live, by category

**Status: PROPOSED. Nothing here is built.** The *Graded by* column was probed
2026-10-19 for `fli deploy:doctor` (its rows were read) and taken from the root
`CLAUDE.md` and `IDEAS/` for the rest, not re-run. Do not cite this file as
behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-19): the categories to cover before deploying,
security being the one already known. `fli deploy:doctor` is the checklist that
exists, and `charter.md` 13 already names it as the last screen before launch and
the first reader of *Checklist* (`FJS-D693`). This record is the catalog that
screen draws from: one table, one row per category, each row saying what grades
it today and what nothing does. **The empty cells are doctor's backlog.**

A category earns a row by having a failure nobody notices until production. A
check earns a cell by naming its owner in the tree, so the table says *who*, never
*that it is handled*. **The category words are the ecosystem's**, none coined
here: an operator arriving from anywhere else reads them without a glossary
(`PHILOSOPHY.md` § IV, familiarity vs. precision).

Prior art, from memory and not fetched: Google SRE's Production Readiness
Review walks a service through much this list before it takes traffic; the
Twelve-Factor App is rows 4 and 8 as rules; OWASP ASVS is row 2 at depth.

---

## The categories

| # | Category | The failure it catches | Graded by today | Not graded |
| --- | --- | --- | --- | --- |
| 1 | **Correctness** | the change does not do what it says | `fli proves` names the drives, `fli prove` runs them, `fli done` says what is left; `bun run ci` | nothing on the deploy path refuses a release whose drives have not run |
| 2 | **Security** | a stranger reads or writes what they should not | `THREATS.md` names each attacker and its test; gates are schema (Invariant 6); doctor: `.env` is gitignored; `ci.mjs` dependency posture; `server-posture.md` (`FJS-2712`–`FJS-2715`) for the machine | headers, CORS and rate limits have no grader; `FJS-2715` — a vulnerable dependency notifies nobody |
| 3 | **Data** | data is lost, or a migration cannot be undone | doctor: migration history builds the schema; Litestream running on the server; `docs/CONSISTENCY.md` says what a write guarantees | a restore has never been drilled (`zero-to-live.md` 5); app backups on a schedule are `FJS-3179`/`FJS-3178` and unbuilt; seed data reaching prod is unchecked |
| 4 | **Configuration** | a dev default runs in prod | doctor: `frontier.config.js` deploy block, `.env.example` reference when `envCheck` is on, Dockerfile installs from `deploy/generated/`; `strictPort` in every vite config; env seeded once per `FJS-D1186` | a debug flag, a dev URL or a test provider key in a prod env has no grader; `envCheck` is off by default |
| 5 | **Observability** | it is down and nobody knows | `$.log`; `app.registerMetricsSource` / `app.registerReadiness`; doctor: `/health` route; `uptime-monitoring.md` (unbuilt) | logs shipped off the box, an error reported to a human, request tracing past `traceparent` — no owner |
| 6 | **Reliability** | one bad call takes the process with it | Caravan retries; a Conduit target declares its own resilience; Outpost's put-back on a failed health check; `ctx.enqueue` + the outbox | graceful shutdown and queue drain on a release are not asserted; a timeout on every outbound call is per target, not graded |
| 7 | **Performance** | it works for one user and falls over at a hundred | `FJS-499` — EXPLAIN asserts no AUTOMATIC index on a policy path; N+1 is the Data boundary's problem by design | no load test anywhere; payload sizes and connection limits are not measured |
| 8 | **Release** | the build on the box is not the build you tested | doctor: image carries no deployment state, deploy lock, working tree clean, commits pushed; `x-fjs-build`; `fli deploy:basecamp` ships one digest (`FJS-D942`); rollback is `fli deploy:rollback` | a rollback has not been drilled on a real box (`zero-to-live.md` Phase 0) |
| 9 | **Infrastructure** | DNS, TLS or disk fails under you | Caddy ACME; Cloudflare `edge` service and `domain:dns` (`cloudflare-edge.md`); Outpost's `disk()` reading and `CleanupRun` | cert renewal, firewall, unattended upgrades, time sync — `server-posture.md`, unbuilt; `zero-to-live.md` 2.4 refuses Flexible SSL, unbuilt |
| 10 | **Compliance** | a person asks for their data gone and nothing can do it | Invariant 7 redacts protected fields in the audit trail; `@personal`; the client-data-lifecycle record (`FJS-D138`) | privacy page, consent, dependency licenses — no grader; deletion path is `FJS-D138`'s to prove |
| 11 | **Operations** | the one person who knows is asleep | `packages/cli/docs/deploy.md` (stale — `zero-to-live.md` 0.5 rewrites it); `fli deploy:journal`, `:status`, `:logs` | no runbook for restore, key rotation or an on-call contact |
| 12 | **Experience** | the error page is a stack trace | Sierra's route table; `ui-hazards` | a 404/500 page, an empty state and an a11y pass are not asserted by any drive |
| 13 | **Integrations** | mail bounces, webhooks point at the wrong host | Conduit declares both ends (`FJS-D177`); `app.conduit.receive` | SPF/DKIM/DMARC, sandbox keys swapped for live, provider quotas — `charter.md` 10 wants keys *checked*, unbuilt |
| 14 | **Cost** | the bill is the alert | Basecamp's `servers.reconcile` finds what is still billing | no spend alert, no runaway-job cap |

**Reading the table.** Rows 1, 4 and 8 are mostly covered and doctor is their
owner. Rows 3, 9 and 11 are the ones the owner named as *where it gets tricky once
it is live* (`server-posture.md`), and each already has a record with no build
behind it. Rows 7, 10, 12, 13 and 14 have no grader at all, and a check for any of
them starts from zero.

---

## Plan

### Phase 0 — The table is true

Goal: every *Graded by* cell names a thing that runs, and every *Not graded* cell
is an open issue or a step in another record.
Done when: each cell cites a file, an `FJS-###` or a plan step, and the rows read
against the tree the day they are cited.

- [ ] 0.1 Re-run `fli deploy:doctor --remote` against a real box (after `zero-to-live.md` 0.3) and correct rows 3, 4 and 8 from what it printed
- [ ] 0.2 File an `FJS-###` for each *Not graded* cell with no id — one defect per cell, not one per row

### Phase 1 — Doctor takes the categories

Goal: `fli deploy:doctor` prints its rows under these fourteen headings, so an
empty heading is visible.
Done when: `fli deploy:doctor --json` returns `section` values from this table and
a heading with no rows still prints.

- [ ] 1.1 Rename doctor's sections to the category words here, and the `--json` `section` values with them (the first reader of *Checklist*, `FJS-D693`)
- [ ] 1.2 A heading with no checks prints the row `nothing checks this` as `info`, so the gap is on screen rather than in this file
- [ ] 1.3 The cheapest new probes, one per empty row: a `/404` that is not a stack trace (12), a live-mode key where the config names a provider (13), a spend alert configured on the vendor account (14)

### Phase 2 — The last screen

Goal: `charter.md` 13.
Done when: Charter's last tab shows this table for the app it just planned, read
from `fli deploy:doctor --json`.

- [ ] 2.1 Charter renders the fourteen headings from doctor's JSON, no second copy of the table

---

## Open questions

- **Q1 — Where does the table live once doctor prints it.** Doctor's sections
  would then be the source and this file a restatement.
  - **A** — This file is deleted when 1.1 lands; the categories live as doctor's
    section names and `fli deploy:doctor` with nothing configured is the catalog.
  - **B** — This file stays as the argument for each row (the failure it catches)
    and doctor carries only the names.
  - **Recommend A** — a document and a command naming the same fourteen words
    drift; a `fail` row's hint is where the failure-it-catches sentence belongs.

## See also

`zero-to-live.md` (the machine and the release) · `server-posture.md` (row 9) ·
`charter.md` 13 (row 2 of the plan) · `THREATS.md` (row 2) ·
`docs/CONSISTENCY.md` (row 3) · `packages/cli/commands/deploy/doctor.md`
