---
id: conversion-sstime
status: assessment
dated: 2026-10-08
---

# Assessment — Converting SSTime, ELA's time clock, onto FrontierJS

**Status: ASSESSMENT.** Dated 2026-10-08. It reads
`/home/j/code/CLIENTS/elitelawncare/sstime` (read-only) and the only database
copy on disk, `tmp/elitelawncare.sstimeclockapp.com_20221121.sql`, a MariaDB 10.5
production dump **four years old**. Every count below came from that dump on this
date. Nothing here may be cited as behavior of either system — see
`VERIFYING.md`. Stressor #25 in `stressors.md` points here.

---

## The headline

**SSTime is the Connecteam stressor (#2) with real rows.** Employees punch in and
out from a phone or a wall tablet; the punch is classified by which device sent
it and where it stood; managers approve; a timesheet splits each punch into
company-timezone days, deducts automatic breaks and scores the hours against
Service Autopilot's billable hours. Connecteam answered Q1–Q7 against imagined
rows (`fjs-prototypes/connectteam/PLAN.md`); SSTime grades those answers.

**And it is the far end of a seam ELA already has.** ELA embeds SSTime in an
iframe (`web/src/routes/sstime/`), maps users by `users.ela_id`, receives
clock-in/out and user webhooks, and pulls `/api/v1/admin/reports/timereports`
into `UserDaily.hours` and `meta.shifts` (`sstimeclock.actions.js`). The ELA
port's Phase 2 is parked with *SSTime* on its list of what is left.

---

## What the application is

| Surface | Scale | Note |
| --- | --- | --- |
| `api/` | Laravel 6 · PHP 7.3 · MySQL 5.7/MariaDB · Passport · ~8.7k lines | 17 models, 27 controllers; `User.php` (754 lines) holds the punch, the device rules and the timesheet |
| `webapp/` | Ember 2.17 classic · ember-data · Bootstrap 4 · Leaflet | 47 routes, 48 components, 96 templates; built into `api/public/app` |
| integrations | Nexmo SMS · SA via a `hooks` repo shelled out to · outgoing webhooks to ELA | `getExternalBillableHours` runs `php artisan` in another checkout with `Process` |
| deploy | per-company subdomain (`elitelawncare.sstimeclockapp.com`), settings in `.env` | timezone, office location, geofence radius, trusted-tag name, webhook URLs |

---

## What the 2022 data says

| Table | Rows | What it resizes |
| --- | --- | --- |
| time_entries | 42,487 | 2018-02 → 2022-11. Every one is `type = normal` — **breaks were never used**; drop `break` and the four break routes. 71 open, 145 longer than 16 h (forgotten clock-outs), 3,087 cross a UTC date |
| — status | submitted 23,325 · approved 18,583 · disapproved 480 · unauthorized 56 · requires_approval 23 · in-progress 20 | `unauthorized` is the device/geofence verdict; `requires_approval` is a *forgot to clock in* entry |
| — geolocation | 34,664 `Success`, 733 denied, 7,070 none | the clock-in carries lat,lng as one `"lat,lng"` string |
| users | 277 — **249 soft-deleted** | seasonal crews: 28 live. 274 have a PIN, **270 of them 4 digits** |
| devices | 494 — 458 `unauthorized` | a device registers ITSELF on first punch (`getTimeEntryAuthStatus`); 23 authorized, 13 `authorized_geotrust`, 39 kiosks |
| taggables | 21,337 — 21,089 on TimeEntry, 248 on User | polymorphic `(taggable_type, taggable_id)`; tag groups `admin` 22 · `user` 17 |
| notification_batches · notifications | 2,042 · 14,036 | *work available* SMS: 12,766 opened, **8,265 accepted**, 584 declined, through a public `/n/{uuid}` link |
| oauth_access_tokens | 90,601 | Passport residue; not moved |
| trackings | 186 | absences only (excused, no-call-no-show, vacation, sick, tardy) |
| external_billable_hours · sa_efficiency_report_entries | 562 · 2,862 | SA's billable hours per user-day; `status` `xp`/`xt` excludes a day permanently or for N days |
| time_off_requests · invites | 25 · 83 | small, ordinary |

**The 2022 dump is a shape, not the truth.** `work_activities` (2025-12) and
`ela_id`/`external_id` (2024-07) postdate it. A current dump is owed before
Phase 3.

---

## What SSTime breaks, and the record each piece grades

1. **A write that is accepted and CLASSIFIED rather than refused.** A punch from
   an unknown device, with no geolocation, or inside the shop geofence by an
   untagged user, is stored as `unauthorized` and counted apart. Invariant 6 puts
   access in the schema; this is not access — the actor may write — it is a
   verdict on the write, computed from request context that is not the principal
   (device, position, a tag). Grades `@@transitions`, `ctx.system`, connectteam
   Q4.
2. **An act attested by a device, not a session.** Kiosk mode: a PIN on an
   enabled device mints a one-scope token (`createToken('pin_login',
   ['clock-in'])`). Connectteam Q4 said the seam opens and the attestation has
   nowhere to go; 39 kiosks and 270 four-digit PINs are the real case.
3. **The day is the company's, the punch is an instant.** The timesheet walks
   company-zone days and clips each entry to them; ELA keys `UserDaily` on that
   same wall-clock day. Grades `FJS-D143`, connectteam Q2 and ELA's D14 (one
   offset for every date).
4. **One open interval per person, repaired by the next act.** Clocking in while
   in closes the open entry; clocking out while out invents the clock-in. Grades
   `FJS-1529`'s declared overlap and `FJS-603`'s one-open-row predicate.
5. **A score over a mirrored number with a time-relative exclusion.** Efficiency =
   SA billable hours ÷ clocked hours, where `xt` excludes a day only while it is
   within N days of today — a derived value that changes with no write.
   ELA already mirrors SA; in the port the billable hours come from there, not
   from a second shell-out.
6. **A stranger answers by link.** The work-available SMS carries `/n/{uuid}`;
   opening it marks read and accept/decline writes with no session. Grades
   `bearer-access.md` and `notifications`; the SMS rides #23's Telnyx connector,
   not Nexmo.
7. **Two apps, one person.** ELA and SSTime each hold the employee, joined by
   `ela_id`, kept in step by webhooks one way and a poll the other. JazzHR (#13)
   asked *what one FrontierJS app calls to create a principal in another* with no
   caller; this is the caller.

---

## The import

`litestone import --from=sql` reads Postgres DDL only. The dump's DDL reads as
*found no models*; with backticks, `ENGINE=`, `unsigned`, `COLLATE`,
`AUTO_INCREMENT` and `KEY` lines stripped by sed, it reads 20 models but every
`datetime`/`timestamp` and `tinyint(1)` lands as `String`. Filed as [`FJS-2054`](../ISSUES.md#fjs-2054).
The schema is small enough to write by hand from the migrations; the importer
gap is the finding.

---

## Items that are the application's, not the framework's

For the prototype's `PLAN.md` reference table, as ELA keeps its D-rows.

- **PIN login is enumerable.** 270 PINs are four digits and the only limit is the
  global `throttle:200,1`; with one kiosk's `deviceId` (a UUID on the tablet) the
  space sweeps in under an hour, and a hit is a token for that employee.
- `VerifyDeviceAuthorization` (`verify.device`) is registered and applied to no
  route.
- The hooks token travels in the query string; `/admin/imports/copy-database`
  copies a database over this deployment from `PARENT_PATH`.
- Login posts to its own `/oauth/token` with TLS verification off, and answers an
  admin's email with `incompleteSetup` before checking the password.
- `.env.bak.vessel` is tracked in git; its contents were not read for this file.

---

## Decisions — ruled 2026-10-08 (Jordan)

1. **Where it lives: its own repo, `fjs-prototypes/sstime`, merged into ELA
   later.** It is built to ELA's names, `User` and tenancy, so the merge is a
   move rather than a rewrite. Item 7 holds until the merge.
2. **Tenancy follows ELA:** `@@tenant`, row strategy on `accountId`. This comes
   from ruling 1 rather than being chosen on its own.
3. **Devices keep registering themselves, and an admin enrolls them**, as the
   reference does today. Promoting a device re-files its `unauthorized` punches
   as `submitted`.
4. **Exports are deferred.** What renders an xlsx here is still unmeasured.

The prototype's `PLAN.md` carries these as its rulings 1–4.

---

## The gameplan

One session per phase, `PLAN.md` the handoff, the sharpest question before any
screen (`stressors.md` § *Setting one up*).

| Phase | Questions | Done when |
| --- | --- | --- |
| 0 — ground | — | Jordan pulls a current dump; it loads into a scratch MariaDB (`api/docker-compose.yml`) and the reference API boots on it; `fli new sstime --source local --full --auth --yes`; schema written from the migrations; `PLAN.md` with Q1–Q7 |
| 1 — the punch | items 1, 2, 4 | clock in, clock out, kiosk PIN, device trust and the geofence as services with tests; the four statuses produced by the Data boundary, not a controller; no screen |
| 2 — the timesheet | item 3, 5 | `timesheet(user, range)` matching the reference to the second for every user over twelve weeks spanning both DST changes — goldens captured from the reference's `timereports` in Phase 0 |
| 3 — the data move | — | `db:move` from the dump (taggables split per target, Passport dropped, morph notifications resolved), `db:compare` against the reference reads |
| 4 — the screens | — | employee punch (phone, geolocation, keypad kiosk), approvals, timesheets, hours report, devices, tags, invites; Ember is rewritten, not ported; opened and CHANGED in a real browser |
| 5 — work available | item 6 | a batch SMS through #23's Telnyx connector, the public accept/decline link, the batch screen |
| 6 — the ELA seam | item 7 | the ELA port reads hours from this app (or Decision 1 B folds it); webhooks and the iframe retired |
| 7 — an hour of use | — | a seeded week, the URLs actually listening, seeded logins, defects already filed that show on screen |

**Golden numbers are the instrument.** The timesheet's arithmetic (day clip,
auto-break deduction, efficiency) is the money; capture the reference's own
output while it runs on the current dump, and the port matches it or a row says
why it should not.

---

## See also

- `stressors.md` #2, #13, #23, #24, #25
- `conversion-ela.md` — the app on the other end of item 7
- `fjs-prototypes/connectteam/PLAN.md` — Q1–Q7, the answers this run grades
