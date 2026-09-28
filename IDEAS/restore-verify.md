---
id: restore-verify
status: shipped
dated: 2026-09-27
---

# Idea — `litestone restore --verify`: what proves a restored copy is good

**Status: SHIPPED 2026-09-27** as `litestone restore --verify` (`FJS-1395` closed), with Q5's keyless guard (`FJS-D501`). Dated 2026-09-27. Do not cite this
file as behavior — see `VERIFYING.md`. It is the verify half `FJS-D477` split from
`FJS-552`, filed as `ISSUES.md` `FJS-1395`, and step 3 of
`IDEAS/frontier-cloud.md`.

**The question:** a restore now comes back all or nothing (`litestone restore`).
What does it take to say the copy that came back is one the app can run on?

---

## The premise that does not hold

`FJS-D477` and `IDEAS/time-travel.md` § Backup both say *restore into a temp
directory and run the app's own suite against it*. An app suite cannot run
there. It arranges its own rows with factories and asserts on what it made —
basecamp's `expect(read.lead.count()).toBe(0)` — so against a real restored copy
it fails on a correct backup, and a suite that writes would write into the copy
it is grading. Making suites data-agnostic would mean rewriting every one of
them. The proof has to come from somewhere every app already has: the schema.

## What it checks

Every check is derived; an app writes nothing to get one. Each restored file —
every declared SQLite database, the tenant registry, every tenant it names —
gets each row that applies to it.

| Check | Owner it reuses | Fails the verify |
| --- | --- | --- |
| `PRAGMA integrity_check` (full, not litestream's `quick`) | SQLite | yes |
| `PRAGMA foreign_key_check` | SQLite | yes |
| The file's tables match the schema — no missing table or column | `buildPristine` + `introspect` + `diffSchemas`, as `migrate status` runs them | yes |
| Every stored row passes the schema's own rules | `validateRows()` — `litestone validate` | yes |
| Every model reads through a real client, `@encrypted` columns decrypting | `createClient` over the restored paths | yes, with the key |
| Replica lag — the age of each replica's last write | `litestream ltx`, as `--at` reads it | no — reported |
| jsonl/logger directories came back from `--from-backup` with their files | the restore itself | yes |

**Lag is reported, never graded.** A tenant nobody has written to since Tuesday
has a replica from Tuesday, and that is correct; a threshold would fail every
quiet tenant. The newest write across the set is the number an operator reads
as *how far behind is this backup*.

**Without the key, encrypted columns are NOT checked, and the report says so.**
The probe answered it: a client under a key that is not the one a value was
written with throws on that column, naming both key ids, and reads every other
column. So a keyless verify opens its client with a throwaway key and reads
around every `@encrypted` and `@secret` column — `validateRows({ keyless })` —
and ends in a warning naming them, never in a pass.

## The shape

```bash
litestone restore --verify <dir> [--url=…] [--at=…] [--from-backup=<dir>] [--json]
```

- **`<dir>` is where the copy goes, and the live paths are never touched.** It
  is the restore run with every target moved under `<dir>` — `main.db`,
  `tenant-registry/<file>`, `tenant-files/<id>.db`, the logger directories —
  the layout `litestone backup` already writes. `--force` is refused with it.
- **The same all-or-nothing restore, then the checks.** A restore that cannot
  bring every file back fails before any check runs.
- **Exit 0 only when every graded check passed.** `--json` prints the report:
  per file, each check's verdict; the lag per replica; the columns not checked.
- **`<dir>` is removed after a pass** and kept after a failure, so the copy the
  report is about is there to open.

Scheduling and alerting are not here. Until Basecamp shows backups per app
(step 5), a drill is a cron line on the server running this; the exit code is
the alarm.

## Open questions

- ~~**Q1 — What proves a restored copy is good, given an app suite cannot run on real data?**~~ **Answered 2026-09-27 (`FJS-D497`): A — Derived checks only: integrity, foreign keys, schema match, `validateRows`, a client read of every model, and replica lag reported.** Amends `FJS-D477`, whose ruling says the suite runs.
  - **A** — Derived checks only: integrity, foreign keys, schema match, `validateRows`, a client read of every model, and replica lag reported.
  - **B** — The derived checks, plus an optional app file of business facts (`db/drill.ts`) run after them.
  - **C** — The app suite, in a new read-only mode that suites are rewritten to be data-agnostic for.
  - **Recommend A** — it works for every app on the day it ships and adds no file convention; B stays open as a later addition once a real app wants a fact the schema cannot state.
- ~~**Q2 — Does the verify need the real encryption key?**~~ **Answered 2026-09-27 (`FJS-D498`): A — Optional: with it every `@encrypted` column is decrypted; without it the report names those columns as not checked, as a warning and never a pass.**
  - **A** — Optional: with it every `@encrypted` column is decrypted; without it the report names those columns as not checked, as a warning and never a pass.
  - **B** — Required: no key, no verify.
  - **C** — Never: encrypted columns are skipped.
  - **Recommend A** — a lost key makes every backup useless, so the proof has to be available, but whether a drill host holds the production key is the operator's call, and absence must be loud rather than silent.
- ~~**Q3 — Under database tenancy, which tenants does each verify restore?**~~ **Answered 2026-09-27 (`FJS-D499`): A — All of them, every run.**
  - **A** — All of them, every run.
  - **B** — The registry plus a rotating sample, covering every tenant within a cycle.
  - **C** — The registry plus one tenant.
  - **Recommend A** — a complete proof at the scale every current app is at; the cost is one download per tenant, revisited past hundreds of them.
- ~~**Q4 — Who runs the verify on a schedule and raises the alarm?**~~ **Answered 2026-09-27 (`FJS-D500`): A — Nobody yet: the command, its exit code and its JSON report; scheduling and alerting arrive with Basecamp's per-app backups (frontier-cloud step 5), and until then a cron line.**
  - **A** — Nobody yet: the command, its exit code and its JSON report; scheduling and alerting arrive with Basecamp's per-app backups (frontier-cloud step 5), and until then a cron line.
  - **B** — Each app, as a Caravan cron job that notifies.
  - **C** — Outpost, reporting to Basecamp.
  - **Recommend A** — B hands every app bucket credentials and a download it does not otherwise need; C is the right home but waits on Outpost's first run on a real machine (step 4).

- ~~**Q5 — Who decides that a verify runs without the key?**~~ **Answered 2026-09-27 (`FJS-D501`): A — The operator, every time: in a terminal it asks; with no terminal it refuses unless the command says `--without-key`. A key present asks nothing, and a schema with no `@encrypted`/`@secret` column needs no key.** Amends `FJS-D498`. A keyless verify exits 0 with a warning, and a cron line reads only the exit code — so a drill whose environment lost `ENCRYPTION_KEY` would stop checking every encrypted column and go on passing every night.
  - **A** — The operator, every time: in a terminal it asks; with no terminal it refuses unless the command says `--without-key`. A key present asks nothing, and a schema with no `@encrypted`/`@secret` column needs no key.
  - **B** — Detect it: run keyless only when the environment looks like a test (`NODE_ENV`, a hostname, a marker file).
  - **C** — As ruled: keyless is allowed and warned about.
  - **Recommend A** — nothing in an environment reliably says *this run is ours*, and any variable B reads is one anybody sets; a flag typed into the cron line is the statement, and its absence cannot be mistaken for it.

## See also

- `ISSUES.md` `FJS-1395` — the row this answers
- `packages/litestone/docs/replication.md` § Restoring — the command this extends
- `IDEAS/frontier-cloud.md` — steps 3 and 5
- `IDEAS/time-travel.md` § Backup — where the verify half was first argued
