---
id: time-and-recurrence
status: idea
dated: 2026-08-12
---

# Idea — Time: the hardest thing in the job, and the seed says nothing about it

**Status: IDEA, PARTLY RULED (`FJS-D143`, 2026-08-25). Nothing here is built.**
The ruling settles the axis this record deliberately left open — the kind is
declared by an ATTRIBUTE, `DateTime` keeps its name, and a zoned comparison is a
window the framework binds rather than a predicate SQLite evaluates — and
`FJS-D144` settles what a schedule does at a DST boundary. What is still open is
the spelling and the recurrence subset. Dated 2026-08-12, from a sweep asking a
different question than the earlier ones: not *what step of the lifecycle is missing*
and not *what application cannot be built*, but **what hard part of ordinary web
development does a developer still have to wire up by hand, because FJS does not
address it.** Every claim below was probed against the tree.

This is the answer that came back first and by the widest margin.

> **Re-audited 2026-08-25**, by running the tree rather than reading it. Three of
> the evidence bullets below were wrong in the same direction — **there is more
> foundation here than this file claimed and less test coverage** — and the
> corrections are inline. Two defects came out of the pass and have ids:
> `FJS-522` (`@time` never reaches the client) and `FJS-521` (the one retention
> window that ships runs at boot and never again).

---

## The evidence

- **The word `timezone` appeared nowhere in `IDEAS/`** when this was written. It now
  appears in four records and three of them are this one, `datetime-kit.md` and the
  index — so the gap is filed, not addressed.
- **There is no date/time code in the tree.** `packages/datetime-kit/` was a
  `README.md` and nothing else; 2026-08-15 it folded into `@frontierjs/toolbelt` as the
  `/datetime` kit — intent in `packages/toolbelt/docs/datetime.md`, prototype parked at
  `packages/toolbelt/mockup/datetime/` (nine source files, a non-member of the
  workspace glob, run by nothing). **Still true on 2026-08-25**: toolbelt exports
  eleven subpaths and `./datetime` is not one of them. `FJS-411` — three copies of a
  *2h ago* ladder in basecamp — is the open cost of that, blocked on whether a kit
  that reads the clock can live in a package whose standing is purity (`FJS-D26`).
- ~~**The whole repo holds exactly one timezone concept**~~ — **two, and the second one
  has already decided something this record treats as open.** The first is
  `packages/caravan/src/cron.ts`: an optional `timeZone` threaded into
  `Intl.DateTimeFormat` so a cron expression can be evaluated somewhere other than the
  host. The second is `@frontierjs/ui`'s `DateTimeInput`, which reads `Intl` for the
  **browser's** zone, converts an instant to a wall clock and back at each edge, and
  labels the control with the zone being shown. That component is a standing answer to
  *whose zone resolves it* for every `DateTime` column in every app — the viewer's —
  reached by having no other option. A design here inherits it rather than starting
  from nothing.
- **The cron half is correct and it is not tested.** `grep timeZone packages/caravan/tests`
  returns four hits, every one of them asserting that a stored `timeZone` was passed
  through; nothing anywhere runs a clock across a transition. Measured by hand on
  2026-08-25 against `America/New_York`, and the evaluator does the honest thing in
  both directions — see failure 3 below for what that costs.
- **`DateTime` stores ISO-8601 TEXT** (`CLAUDE.md` § Live hazards), which is a good
  choice and a neutral one: it records an instant and says nothing about what the
  instant *meant* to whoever entered it. `example` and `basecamp` hold **141 `DateTime`
  columns** between them and not one of them says which kind of time it is.

So the framework has a storage format for time and no semantics for it. That is the
same shape as every other framework, which is why every application re-derives the
same four bugs.

---

## Why this is hard for everyone, stated as the four failures

Not a feature list. These are the specific ways time goes wrong in applications
people have already shipped.

**1. An instant and a wall-clock time are different kinds of value, and one column
holds both.** `createdAt` is an instant — it happened at a point on the timeline and
every viewer agrees on it. *"The shop opens at 09:00"* is not an instant; it is a
wall-clock time in a place, and it names a different instant every time the offset
changes. Stored the same way, the second one silently becomes the first, and it goes
wrong twice a year.

**2. A future event stored as an instant is a bet on politics.** Governments move
timezone boundaries and abolish daylight saving with months of notice; the IANA
database ships several releases a year. A meeting eleven months out, stored as UTC,
moves when the rule changes — because the *instant* was never what the user chose. The
correct storage for a future zoned event is the wall-clock time plus the zone, resolved
to an instant at the moment it matters. **Almost nobody knows this until it bites**,
and by then the rows are already wrong.

**3. Daylight saving makes some times not exist and others happen twice.** A daily job
at 02:30 runs zero times in spring and twice in autumn. Every hand-rolled scheduler
gets this wrong once; Caravan's cron already handles the evaluation half correctly and
nothing above it knows the question exists.

> **Measured 2026-08-25** — `nextFireTime` against `America/New_York`, both boundaries.
> The evaluator is right and both consequences are live:
>
> | expression | crossing | fires |
> | --- | --- | --- |
> | `30 2 * * *` | spring forward, 2026-03-08 | **skipped** — next fire is 2026-03-09 |
> | `30 1 * * *` | fall back, 2026-11-01 | **twice** — `05:30Z` and `06:30Z`, both *1:30 AM* |
> | `0 9 * * *` | neither | `14:00Z` = 09:00 EST, correct |
>
> The second row is the one with a cost attached, and the queue's own idempotency does
> not cover it: a cron fire is dispatched under `cron:<job>:<epoch-minute>`
> (`FJS-294`), and the two 1:30 AMs are different minutes, so both queue a row and the
> job really runs twice. That is defensible — they are two real occurrences — but it is
> *unstated*, untested, and not a decision anybody made. It is the sharpest instance in
> the tree of the gap this record is about: the evaluation is correct and **nothing
> above it can express what the answer should be**.

**4. "Today" is not a range.** A report filtered to *today* means a different eight
hours to a viewer in Auckland than to one in Los Angeles, and a report grouped by day
is a different grouping per viewer. Row policies, `@@softDelete` windows, retention
under `@retain` (`IDEAS/compliance-from-the-seed.md`) and every dashboard in basecamp
sit on top of this and currently resolve it against whatever zone the process happens
to run in. The one retention window that **already ships** does not even reach a day
boundary to be ambiguous about — see *What it unblocks* and `FJS-521`.

---

## Why FJS is placed to declare it

The framework's whole bet is that a fact stated once in the seed is enforced at the
boundary whether or not the caller remembered it. Time is a textbook case: **the
distinction between an instant and a zoned wall-clock time is a property of the
column, not of the code that reads it.** Stating it once is the entire fix; leaving it
unstated is exactly what every framework does and exactly why the bug recurs.

Three things already in place make this cheaper here than elsewhere:

- **The type already travels to the client.** `generateJsonSchema` carries field types
  and `x-messages` through to `field-rules.js`, so a browser that knows a field is
  zoned can render and coerce it correctly without being told a second time — which is
  where the display half of this problem normally leaks back in.
- **Caravan already evaluates a cron expression in a named zone.** The scheduling half
  of recurrence exists — and, corrected 2026-08-25, **is not tested**: every `timeZone`
  assertion in that suite checks a value was stored, not a time was computed. What is
  missing above it is any way for the *application* to say which zone, per row, rather
  than per job definition.
- **`IDEAS/declared-semantics.md` §3 already argues the neighbouring case.**
  Bitemporality — `occurredAt` versus `createdAt` — is the same observation arriving
  from the audit direction: a row holds more than one kind of time and the schema
  cannot tell them apart. These should be settled together or one of them will invent
  a vocabulary the other has to live with.

---

## What already exists and nobody uses

> **Added 2026-08-25.** The record's premise — *the seed says nothing about time* — is
> not quite right, and the part that is wrong is the part a design starts from.

`.lite` already parses **three time-shaped validators** (`parser.js:1319`), each a
format rule on a `String`:

```
signedAt   String @date                    // YYYY-MM-DD
seenAt     String @datetime                // ISO-8601
opensAt    String @time                    // HH:MM, 24-hour, @time(seconds: true) for HH:MM:SS
```

So **a wall-clock time is expressible today** — failure 1's *the shop opens at 09:00*
has a spelling, and it is checked at the Data boundary. What it has no way to say is
the half that matters: which place the clock is in. That is the actual gap, and it is
narrower and more tractable than *no vocabulary at all*.

Two things make this worth knowing before anything is designed:

- **The rungs are wired unevenly, and `@time` is not wired at all.** `@date` emits
  `format: 'date'` into the JSON Schema and `@datetime` emits `format: 'date-time'`;
  `field-rules.js` turns those into `<input type="date">` and the kit's `DateTimeInput`.
  `@time` has **no case in the emitter**, so it validates on the server and reaches the
  browser as a bare string in a plain text box — the rule is discoverable only by
  submitting. Filed as `FJS-522`.
- **Nothing in the tree declares any of the three.** Zero uses across `example` and
  `basecamp`, against 141 `DateTime` columns. Which is why the hole above has never
  been seen, and why the vocabulary question is genuinely open rather than
  retrofitted: there is no adoption to migrate.

The design question this sharpens: does the answer **grow these** — `@time(zone: field)`,
a zone argument on the validator that already exists — or introduce types beside them?
Whichever wins, the framework must not end up teaching both, which is this record's own
open question arriving with a concrete second candidate.

---

## Prior art — the taxonomy is settled, and the mistakes are named

> **Added 2026-08-25** with `FJS-D143`. Read for where each one lost, not for its
> API.

**Three independent designs converged on the same distinctions**, which is as
strong as prior art gets. TC39's **Temporal reached Stage 4 in March 2026** and is
ES2026 — shipping in Chrome 144, Firefox 139 and Node 26, with JavaScriptCore
still implementing it, so **bun does not have it** (measured: `typeof Temporal` is
`undefined` in bun 1.3.11; node 22 has it behind `--harmony-temporal`).

| meaning | Temporal | java.time | Noda Time | `.lite` today |
| --- | --- | --- | --- | --- |
| a point on the timeline | `Instant` | `Instant` | `Instant` | `DateTime` |
| wall date + time, no place | `PlainDateTime` | `LocalDateTime` | `LocalDateTime` | `String @datetime` |
| a date alone (a birthday) | `PlainDate` | `LocalDate` | `LocalDate` | `String @date` |
| a time alone (*opens at 09:00*) | `PlainTime` | `LocalTime` | `LocalTime` | `String @time` |
| wall clock **+ IANA zone** | `ZonedDateTime` | `ZonedDateTime` | `ZonedDateTime` | **nothing** |
| wall clock + fixed offset | — | `OffsetDateTime` | `OffsetDateTime` | **nothing** |

Where the field lost:

- **Postgres `timestamptz`** — the most expensive naming mistake available. It
  reads as *a timestamp with a timezone* and stores an instant with **no zone at
  all**, converting on the way in and out using the session setting; `timestamp`
  beside it is a wall clock with no zone. So Postgres's two types are Instant and
  PlainDateTime and **neither is ZonedDateTime**. The lesson is *name a thing for
  what it stores* — and it is the lesson `FJS-D143` deliberately declines to
  follow on `DateTime`, which is why that ruling has to close the type route too.
- **MySQL `TIMESTAMP` vs `DATETIME`** — the same split, plus a silent UTC
  conversion that depends on the session's `time_zone`.
- **Rails** — `Time.now`, `Time.current` and `Time.zone.now`: one is right, all
  three compile. The distinction lives in *which method you call*, which is the
  failure mode `declared-semantics.md` opens by rejecting.
- **Django** — got there in the end (`USE_TZ` defaults on from 5.0, naive
  datetimes warn) after roughly fifteen years, and the guard is a runtime warning
  rather than a schema fact.
- **Moment.js** — mutable, and declared legacy by its own maintainers. Every
  successor wraps `Intl`. This record's *do not write a date library* is the same
  conclusion, and Temporal now removes the excuse.
- **Airflow** — the canonical scheduler failure and a naming one: `execution_date`
  meant *the start of the interval*, not *when it ran*, and DST plus catchup
  produced duplicate and missing runs. Airflow 2 renamed it to
  `data_interval_start`/`_end`, because the name was the bug.
- **RFC 5545 `RRULE`** — 200 pages, and implementations disagree in the field:
  negative `BYSETPOS`, `BYSETPOS` under sub-daily frequencies, vendors stricter in
  some places and looser in others. **Temporal spent nine years on time and left
  recurrence out.** This record's instinct to refuse the general RRULE is the
  field's own verdict, not caution.

And the one that got it right, which is the closest prior art we have:

- **Vixie cron**, `man 8 cron`, verbatim: forward jump — *those jobs which would
  have run in the time that was skipped will be run soon after the change*;
  backward jump — *those jobs that fall into the repeated time will not be
  re-run*; **only** jobs at a particular time are affected, wildcards follow the
  new wall clock; a shift of more than three hours is a clock correction. Caravan
  does the opposite on both boundaries (measured — see failure 3), has no wildcard
  carve-out and no correction threshold. Adopted as `FJS-D144`, filed as
  `FJS-525`.
- **`systemd.time`** on spelling: prefer an IANA name to a local abbreviation,
  *because with a local timezone it is possible to specify daylight saving in
  winter*. `Intl.supportedValuesOf('timeZone')` answers **445** of them in this
  runtime, so an unknown zone can be a parse error rather than a runtime NULL.

---

## The shape of the declaration — the question, not the answer

Deliberately not chosen when this was written. **The first two axes were ruled on
2026-08-25 (`FJS-D143`) and are marked below**; the third is still open.

**Which kind of time is this column? — RULED: an attribute.** An instant, a zoned
wall-clock time, a plain date with no time at all (a birthday is not an instant and
never was), or a duration. The form is field-level: `DateTime @zoned(field)` and
siblings.

**And the reason is the name.** `DateTime` keeps it, decided 2026-08-25 — it is what
every reader of a Prisma-shaped schema already types. But `Date`, `Time` and
`DateTime` as sibling TYPES would read as *wall clock, wall clock, and the two
composed*, while the third is an instant: `timestamptz` rebuilt inside `.lite`, one
week after this record called that the field's worst naming mistake. So keeping the
name rules out the type route, and the two halves are one decision rather than two.
Revisiting belongs with a second app.

**Corrected 2026-08-25**: this used to say the type-level form is strongest
*since `Date` and `DateTime` are already separate declarations*, and they are not —
`.lite` has eight scalar types and `DateTime` is the only one of them that is a time
(`parser.js:65`). A `Date` type is a new type, and it costs the six places
`declared-semantics.md` § *The spelling* names. What already exists is a **validator**
of that name, which is the next section.

**Whose zone resolves it? — RULED: all three, and none needs new machinery.** The
row's is a sibling column; the viewer's is a claim on the principal, the seam
`sessionFields` and `toDataPrincipal()` already are; the tenant's is `$.config`,
ruled the same day (`FJS-D126`), where a timezone is one of the named examples. What
a design still has to say is *which, per column*. The three real answers are *the
row's* (an event carries
its own venue's zone), *the viewer's* (a report), and *the tenant's* (a workspace with
a stated business zone, which is what basecamp would want). This is where the design
gets interesting, because the viewer's zone is a per-request fact resolved onto the
principal — **which is exactly the mechanism `applyStanding()` already implements for
membership** (`IDEAS/row-level-tenancy.md`). A zone on the session is the same shape as
a standing on the session, and it should be the same seam rather than a second one.

**What recurs, and where is that stated?** *Every second Tuesday at 09:00 in the
workspace's zone, skipping holidays* is a declaration a model could carry, and today it
is a string in a job definition plus a hand-written expander. Worth being cautious
here: recurrence rules are a genuine rabbit hole — RFC 5545 is large and mostly
unwanted — and the useful subset is small. **Refuse the general RRULE**; the question
is which subset earns a name.

---

## What it must not make impossible

- **A raw instant must stay expressible.** Logs, audit entries, `@version` and the
  journal `IDEAS/release-transitions.md` describes all want an instant with no zone
  attached, and a framework that insists every time is zoned makes those awkward for
  nothing.
- **`Intl` is the implementation, not a dependency to hide.** The platform ships the
  IANA database and the formatting; the value here is the declaration, not a date
  library. A record that ends with *"and we write our own date library"* has gone
  wrong — that is what `datetime-kit`'s README currently implies and it is the least
  interesting version of this idea. **Measured 2026-08-25, and it is smaller than
  this bullet implies**: wall clock plus IANA zone resolves to **0, 1 or 2 instants**
  in about twenty lines of `Intl.DateTimeFormat.formatToParts` — `2026-03-08T02:30`
  in New York is 0 (the hour does not exist), `2026-11-01T01:30` is 2 (it happens
  twice), everything else is 1. That IS Temporal's `disambiguation` vocabulary,
  available now; when bun ships `Temporal` the twenty lines are deleted, which is
  what *declare the distinction, not the representation* buys.
- **The escape hatch is that the column is still a string.** Anyone who wants to
  ignore all of this keeps the current behaviour, and that must remain true.

---

## What it unblocks

- **A clock the test realm can move — and it is WIRING, not building.** `createTestEnv`
  (`IDEAS/testing-realm.md`) has no notion of time, so nothing tests a DST boundary, a
  retention expiry, or a schedule — precisely the bugs that appear on one day of the
  year. **The clock already exists one layer down**: `createClient({ now })` takes it
  and it reaches the compiled WHERE, the create-policy evaluator and `@@softDelete`'s
  stamp; `TestEnvOptions` declares `schema` and `migrations` and cannot pass it
  through. `FJS-524`, and the cheapest item in this record.
- **Retention and erasure become checkable.** `@retain(90d)` in
  `IDEAS/compliance-from-the-seed.md` is unbuilt — but the **database-block**
  `retention 90d` beside it ships, runs, and is `basecamp`'s audit trail. Read on
  2026-08-25 it is worse than *a duration with no stated boundary*: the cutoff is
  `new Date(Date.now() - ms)` with `d` a flat 86,400,000 and `y` a flat 365 days, so
  there is no boundary at all — the line sits wherever the process last started — and
  it is applied **once, at `createClient`**, so a server that stays up never prunes
  again. `FJS-521`. A legal claim about how long a record is kept currently rests on a
  boot time.
- **Recurrence stops being a Caravan-only idea.** A subscription renewal, an
  appointment and a scheduled report are the same declaration; only one of them is
  currently expressible, and only in a job file.
- **The display half comes free.** Once the column states its kind, formatting it in
  the browser is a lookup rather than a decision every component makes separately —
  and `@frontierjs/ui`'s `DatePicker` currently has to guess.

---

## Open questions

- ~~**Is this a type, an attribute, or both?**~~ **Answered 2026-08-25 (`FJS-D143`):
  an attribute.** The question rested on a false premise — `Date` is not a type here,
  only a validator on `String` — and the answer follows from keeping `DateTime`'s
  name, since sibling types would rebuild the `timestamptz` trap. The *do not teach
  both* half survives as work: `@date`/`@datetime`/`@time` stay as string-shaped
  validators and the docs must say in one line which is which.
- **Does a zone belong on the principal?** Yes for the *viewer's* answer, and it
  joins `sessionFields` and `toDataPrincipal()` — both halves of that hand-copied
  pair, so a bridge-index change rather than a schema one. The *tenant's* answer
  does not go there: it is `$.config` (`FJS-D126`).
- ~~**Can a row policy compare against a zoned column at all?**~~ **Answered by
  measurement 2026-08-25 — not as a predicate, ever.**
  `datetime('now','America/New_York')` answers **NULL** in SQLite: not an error, a
  NULL, which a policy compares against and matches nothing, giving an empty screen
  with a 200. `'localtime'` is the *process's* zone and never the caller's; a fixed
  offset works and is not a zone. So *rows from today* is expressible only as a
  window the framework computes and BINDS — measured, the same three rows are
  "today" 2, 2 or 1 times depending on whose zone the window came from — and only a
  declaration can supply one, because only it knows the column's kind and whose
  zone. **The precedent is already in the tree**: `now()` in a policy is the
  framework's clock, injectable through `createClient({ now })`, and SQLite's own
  clock is already refused inside `$raw` (`FJS-226`).
- ~~**What does `orderBy` mean on a zoned column?**~~ **Answered by measurement: the
  wall clock.** Stored in Temporal's own form
  (`2026-11-01T01:30:00-04:00[America/New_York]`), lexical order puts London 09:00
  (08:00Z) ahead of Kolkata 09:00 (03:30Z) — wall-clock order, not the timeline. So
  `$checkOrderBy` gets a **third** answer beside *no such field* and *opaque*:
  sortable, but not by the thing the caller probably means. `@computed`'s shape, as
  this question guessed — state the limit rather than return a plausible wrong
  order. A shadow instant column is the later option, not the first one.
- ~~**Is `datetime-kit` this, or something else?**~~ **Answered**: it is this, and it
  is a subpath rather than a package — `@frontierjs/toolbelt/datetime`. See
  `IDEAS/datetime-kit.md` for the scope and `DECISIONS.md` § Repo conventions for why
  it is not its own folder.

## See also

- `IDEAS/declared-semantics.md` §3 — bitemporality, the same observation from the
  audit side; §4's resumable process is the sibling remainder
- `IDEAS/compliance-from-the-seed.md` — `@retain`, a duration that needs this settled
- `IDEAS/testing-realm.md` — the movable clock this would make testable
- `IDEAS/row-level-tenancy.md` — `applyStanding()`, the per-request resolution seam a
  viewer's zone would reuse
- `packages/caravan/src/cron.ts` — the one place in the repo that already gets a
  timezone right
- `packages/toolbelt/docs/datetime.md` — the claim, now a kit inside toolbelt (`FJS-D14`, ruled)
