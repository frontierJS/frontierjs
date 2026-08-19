---
id: time-and-recurrence
status: idea
dated: 2026-08-12
---

# Idea — Time: the hardest thing in the job, and the seed says nothing about it

**Status: IDEA. Nothing here is built.** Dated 2026-08-12, from a sweep asking a
different question than the earlier ones: not *what step of the lifecycle is missing*
and not *what application cannot be built*, but **what hard part of ordinary web
development does a developer still have to wire up by hand, because FJS does not
address it.** Every claim below was probed against the tree.

This is the answer that came back first and by the widest margin.

---

## The evidence

- **The word `timezone` appears nowhere in `IDEAS/`.** Not as a gap, not as a
  question, not in passing. Thirty-one design records and none of them is about time.
- **There is no date/time code in the tree.** `packages/datetime-kit/` was a
  `README.md` and nothing else; 2026-08-15 it folded into `@frontierjs/toolbelt` as the
  `/datetime` kit — intent in `packages/toolbelt/docs/datetime.md`, prototype parked at
  `packages/toolbelt/mockup/datetime/`, nothing exported. The subject is still one
  nothing else covers.
- **The whole repo holds exactly one timezone concept**, in `packages/caravan/src/cron.ts`:
  an optional `timeZone` threaded into `Intl.DateTimeFormat` so a cron expression can
  be evaluated somewhere other than the host. It is correct, it is well-tested, and it
  is connected to nothing else — no model can say what zone its column means, and no
  service can ask.
- **`DateTime` stores ISO-8601 TEXT** (`CLAUDE.md` § Live hazards), which is a good
  choice and a neutral one: it records an instant and says nothing about what the
  instant *meant* to whoever entered it.

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

**4. "Today" is not a range.** A report filtered to *today* means a different eight
hours to a viewer in Auckland than to one in Los Angeles, and a report grouped by day
is a different grouping per viewer. Row policies, `@@softDelete` windows, retention
under `@retain` (`IDEAS/compliance-from-the-seed.md`) and every dashboard in basecamp
sit on top of this and currently resolve it against whatever zone the process happens
to run in.

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
  of recurrence exists and is tested; what is missing is any way for the *application*
  to say which zone, per row, rather than per job definition.
- **`IDEAS/declared-semantics.md` §3 already argues the neighbouring case.**
  Bitemporality — `occurredAt` versus `createdAt` — is the same observation arriving
  from the audit direction: a row holds more than one kind of time and the schema
  cannot tell them apart. These should be settled together or one of them will invent
  a vocabulary the other has to live with.

---

## The shape of the declaration — the question, not the answer

Deliberately not chosen here. Three axes, and they are separable.

**Which kind of time is this column?** An instant, a zoned wall-clock time, a plain
date with no time at all (a birthday is not an instant and never was), or a duration.
The cheapest form is field-level: `DateTime @instant`, `DateTime @zoned(field)`,
`Date`. The strongest form is types, since `Date` and `DateTime` are already separate
declarations and a third is not a new concept.

**Whose zone resolves it?** The three real answers are *the row's* (an event carries
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
  interesting version of this idea.
- **The escape hatch is that the column is still a string.** Anyone who wants to
  ignore all of this keeps the current behaviour, and that must remain true.

---

## What it unblocks

- **A clock the test realm can move.** `createTestEnv` (`IDEAS/testing-realm.md`) has
  no notion of time, so nothing tests a DST boundary, a retention expiry, or a schedule
  — and these are precisely the bugs that only appear on one day of the year. A
  declared time semantics makes *"run this suite as though it were the day the clock
  went back"* a derived test rather than an act of imagination.
- **Retention and erasure become checkable.** `@retain(90d)` in
  `IDEAS/compliance-from-the-seed.md` is a duration with no stated zone or boundary
  today, which is a legal artefact resting on an ambiguity.
- **Recurrence stops being a Caravan-only idea.** A subscription renewal, an
  appointment and a scheduled report are the same declaration; only one of them is
  currently expressible, and only in a job file.
- **The display half comes free.** Once the column states its kind, formatting it in
  the browser is a lookup rather than a decision every component makes separately —
  and `@frontierjs/ui`'s `DatePicker` currently has to guess.

---

## Open questions

- **Is this a type, an attribute, or both?** `Date` versus `DateTime` is already a
  type-level distinction; adding `@zoned` as an attribute puts one axis in the type
  system and another beside it. Whichever wins, the framework should not end up
  teaching both.
- **Does a zone belong on the principal?** If it does, it joins `sessionFields` and
  `toDataPrincipal()`, and both halves of that hand-copied pair need it — which is a
  bridge-index change, not a schema one.
- **Can a row policy compare against a zoned column at all?** A policy compiles into
  SQLite's `WHERE`, and SQLite has no timezone support beyond UTC offsets. So *"rows
  from today"* as a declared policy may be unrepresentable, and finding that out early
  is worth more than designing around it late.
- **What does `orderBy` mean on a zoned column?** Sorting by wall-clock time and
  sorting by instant give different orders, and `$checkOrderBy` currently has no
  vocabulary for the difference. This is the same class of question `@computed` already
  answers — *SQLite can neither sort nor paginate by it* — and it should get the same
  kind of answer.
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
