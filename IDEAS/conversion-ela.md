---
id: conversion-ela
status: assessment
dated: 2026-10-07
---

# Assessment — Converting ELA, maid.tech's sibling, onto FrontierJS

**Status: ASSESSMENT, and a DELTA.** Dated 2026-10-07. It reads
`/home/j/code/CLIENTS/elitelawncare/ela` only for what `conversion-maid-tech.md`
does not already answer — read that file first; its blocker table, its free
upgrades and its § *Running the port* hold here unless a line below says
otherwise. Every count was produced by a command on this date, against
`db/development.db`, which **carries production data** (4.5 GB). Nothing here may
be cited as behavior of either system — see `VERIFYING.md`. Stressor #24 in
`stressors.md` points here.

---

## The headline

**ELA is maid.tech's trunk with the other half grown on it.** Same legacy-FJS
line (Feathers 5 + Prisma + Svelte 5 + Routify 3 + UnoCSS, `@frontierjs/api`
0.0.22), 37 of its service directories share a name with maid.tech's. Maid.tech
is the CRM and client-portal half; ELA is the **field-ops and ledger half** — and
it lives off a system of record it does not own.

So the framework questions are the ones three stressors predicted from imagined
products, now asked of real rows: #2 Connecteam (crews, a day that recurs),
#7 billing (invoices, payments, credits), #23 Quo (Telnyx texting). The port
grades those three rows.

**The names are shared, the code is not.** Diffing the shared services:
`tasks` is 1,277 lines here against 279, `integrations` 1,453 against 160. Reuse
maid.tech's RULINGS (queue.js → caravan, the JSON hooks → `Json` columns, the
account hooks → `@@tenant`, the compiler service → `renderComponent`), never its
ported code.

---

## What the application is

| Surface | Scale | Note |
| --- | --- | --- |
| `api/` | 33 models · 59 services · ~46k lines of JS | `queue.js` (130 lines, node-cron) runs actions and a 3CX poll tick |
| `web/` | 358 `.svelte` files under `routes/` | `_`-prefixed files are route-local, never routes (its `CLAUDE.md`) |
| `embeds/` | 6 public widgets | lawn estimator, two lead forms, mechanic request, user invite, form split testing — the `widgets/` surface |
| `db/` | 4.5 GB SQLite | 2.27 GB of it is `uploads`, 466 MB `routes`, 291 MB `jobs` |

ELA keeps its own registers in `.project/` (`ELA-###`, `ELA-D##`, 15 IDEAS).

---

## What the data says

| Table | Rows | What it resizes |
| --- | --- | --- |
| accounts | 4 | **Effectively single-tenant**: 387 of 390 users and all 17,802 clients are on account 1. The other three are stubs (two landscapers, Kobami) |
| actions | 305,760 | 282,075 are `get` — polling Service Autopilot. 99% `success`; 8 open right now. This is caravan's job, at a real rate |
| jobs | 66,725 | mirrored from SA by `externalId`; `original` keeps the raw payload |
| userDailies / crewDailies | 36,569 / 7,517 | keyed by `day` as `'YYYY-MM-DD'` text, 2024-06-24 → 2026-09-29 |
| routes · visits | 8,668 · 11,143 | one `data` JSON blob each — route segments, visit jobs with lat/lng |
| invoices · payments · credits | 4,127 · 4,282 · 28 | mirrored, `Float` amounts, `String` dates |
| uploads | 3,658 | **2.2 GB of raw SA payloads stored in `data`**, one row per import batch |
| calendar | 36,890 | a date dimension table — one row per day with weekday, ISO week, quarter |
| cards · lists · boards | 52,644 · 21,097 · 919 | the kanban half is heavily used, as in maid.tech |

**`createdAt` is stored two ways in one column**: integer epoch-ms and
`'YYYY-MM-DD HH:MM:SS'` text — jobs 2,748 text, userDailies 26,565 text,
uploads 1,643 text. The data move normalizes it before Litestone reads a row.

---

## What ELA adds, and the record each piece grades

1. **A system of record it does not own.** Service Autopilot is the CRM; ELA
   mirrors its clients, employees, crews, jobs, invoices, payments and credits by
   `externalId`, keeps each batch's raw payload in `uploads`, and polls on a
   schedule. Six integrations beside it: QDS surveys, SSTime time-tracking,
   Microsoft + Outlook mail, Telnyx messaging, 3CX phone. Grades
   `data-layer-v1.md` and Transit #21 (a sync cursor across a conduit target),
   `external-field-cache.md`, `conduit-connectors.md`. **Where a 2 GB history of
   raw payloads belongs is the first question** — not in a row is the likely
   answer; `untrusted-bytes.md` is the nearest record.
2. **Money it mirrors rather than originates.** Invoice ↔ payment and
   credit ↔ invoice are many-to-many; a credit carries `crewPercentage` (a
   commission). Grades #7 and `declared-semantics.md` § money — a mirrored ledger
   is the case that record has not met, since the money is never computed here.
3. **The day as a key.** `UserDaily`, `CrewDaily` and `Tracker` key on a
   wall-clock date; `UserDaily → CrewDaily` is a **composite foreign key on
   `(crewId, day)`**, which the importer noted. Grades `time-and-recurrence.md`,
   `effective-time.md`, `datetime-kit.md` — and whether a date dimension table is
   something an app should still hand-roll.
4. **Crews in the field.** Crews with lat/lng and commission, routes, visits,
   drive time from an external routing lookup (`UserDaily.drive`), `@turf/turf`
   in the browser, ATTOM property lookups behind the estimator. Grades
   `field-workforce.md` and `geo.md`.
5. **Conversations.** Telnyx texts, a 3CX phone poller, Outlook mail, a call
   simulator, an in-app support chat. The Telnyx connector is being built in
   `fjs-prototypes/quo` (#23) — **ELA consumes it rather than building a second
   one.** Grades `inbound-integrations.md` (`FJS-D177`) and `chat-surface.md`.
6. **Public widgets that write.** The estimator and lead forms are strangers
   submitting into the CRM. Grades Sierra's `widget` target and
   `bearer-access.md`.

---

## The import

```
litestone import <ela>/db/prisma/schema.prisma --from=prisma --out=db/schema.lite --report=import.json
```

33 models, 27 `noted`: 21 `sti-candidate`, 5 `composite-unique-over-nullable`,
1 `composite-foreign-key` (`UserDaily.crewDay`). It also emits **73 JSON fields
as plain `String`** and says nothing — the `@default("{}")` convention both apps
share — filed as `FJS-1886`. As with maid.tech, the command is what is kept and
the output is a starting point with no decision applied.

---

## The model is `Contact`, not `Client`

Oracle's entity for the 17,802 clients is `Contact`, with kinds `customer`,
`lead`, `prospect`. As in maid.tech, `clients`, `contacts` and `leads` are three
services over one `Client` model, so the port names it `Contact` and the
services become its kinds — `conversion-maid-tech.md` § *The model is
`Contact`* has the reading.

---

## Items that are the application's, not the framework's

They go in ELA's `.project/ISSUES.md`, not here.

- `api/config/default.json` is tracked and holds a non-empty
  `authentication.secret` — the same item maid.tech has.
- 14 files under `api/src` call `$queryRaw`/`$executeRaw`, which bypass both the
  JSON hooks and the account scoping; with one live tenant the scoping half is
  latent rather than exploitable.

No `node:vm` transformer, which was maid.tech's sharper item.

---

## Running the port

As maid.tech's § *Running the port*, with these differences:

- **The repository is `~/code/FRONTIER/fjs-prototypes/ela`**, scaffolded with this
  tree's `fli` and `--source local`, plus `--widgets` for `embeds/`.
- **The session:** `claude --add-dir ~/code/FRONTIER/frontierjs --add-dir ~/code/CLIENTS/elitelawncare/ela`.
  The ELA tree is read-only; its `development.db` is production data, opened
  `sqlite3 -readonly` or copied.
- **The thin slice is one Service Autopilot sync, not `Client`.** The sync is the
  spine every other table hangs from: `jobs` through conduit, a caravan job,
  `Job` rows, and one crew-daily screen. It proves the realms and the ELA-only
  half in one pass.
- **Findings go to two registers.** A framework seam is `fli file` in this tree,
  the hour it is found; an application defect is an `ELA-###` in `.project/`.
  Questions are `### Qn` in the prototype's `PLAN.md`, as `stressors.md`
  § *Setting one up* says.

---

## Decisions owed before the schema is done

1. **Tenancy.** Keep `@@tenant` for four accounts, three of them stubs, or
   declare ELA single-tenant and leave the trunk's tenancy to maid.tech.
2. **Mirror or own.** Which SA tables become models with their own lifecycle and
   which stay a cache keyed by `externalId` (`external-field-cache.md`).
3. **Raw payloads.** Where an import batch's bytes live, and for how long.
4. **The 21 `sti-candidate` columns**, as in maid.tech.
5. **Money type.** `Float` amounts in a mirrored ledger — keep, or convert on the
   way in.

---

## Open questions

- Is a MIRRORED model a declaration? ELA mirrors seven SA tables (`jobs`, `clients`,
  `employees`, `invoices`, `payments`, `credits`, `crews`) by `externalId`, and `.lite`
  can already say most of it without a new word — the SA columns are `@system`,
  `externalId` is `@unique @immutable`, a model only the sync creates is
  `@@gate("…8…")` with the sync lifting that one call by `system: ['@@gate', …]`
  (`FJS-D575`). What it cannot say: that `externalId` is THE key the sync upserts
  on, and what a row that left the source's window becomes (`missingSince`, which
  window). Both live in the connector's code, and `fli db:advise` asks a mirror's
  `status` for `@@transitions`, which is wrong for a mirror and shows the tool cannot
  tell one from a model the app owns. Transit's sources and quo's carrier state are
  the same shape; maid.tech's 20 shared models are next.
  - **A** — no new word: the three attributes per column and gate 8 as today, the key and the drop-out rule stay in the connector, and `advise` learns nothing.
  - **B** — a model attribute, `@@mirror(key: externalId, absent: 30d)`: the model is declared a mirror, the key is named once, the three per-column attributes and gate 8 are DERIVED from it, `missingSince` is a derived `@system` column the sync maintains, a caller's write to a mirrored column is refused by construction, and `advise` stops asking a mirror for a machine.
  - **C** — a field attribute only, `@externalKey`: names the key the sync matches on and leaves the drop-out rule to the connector, as the smaller first half.
  - *Collision to settle first:* `mirror` is already `IDEAS/cascading-fields.md`'s mode word for a cascade that copies a parent field, so B's spelling takes another name (`@@mirrored`, `@@replica`, `@@source(...)`) or a ruling that the two are one concept. Not decided here.
  - **Recommend B** — the key and the window are facts with one owner that today are restated in three places (schema, connector, advise's guess), and every restatement is silent when it drifts; B is one declaration the other three derive from. C is the honest half if a second caller shows the drop-out rule differs per source — ELA's is a window, transit's is a cursor — in which case `absent:` is the part that waits.

## See also

- `conversion-maid-tech.md` — the trunk; read it first
- `stressors.md` #2, #7, #21, #23, #24
- `tenant-declared-fields.md` · `tables-from-the-seed.md` — maid.tech's two
  records, which ELA's kanban and settings halves also consume
