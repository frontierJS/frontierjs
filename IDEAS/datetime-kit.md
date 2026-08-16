# Idea — `datetime-kit`: scope

**Status: IDEA. The code that exists today is not this.** Dated 2026-08-12; scope
unchanged, home changed 2026-08-15 — this is now **`@frontierjs/toolbelt/datetime`**, a
kit inside the substrate package rather than `@frontierjs/datetime-kit`, and the
prototype audited below is parked at `packages/toolbelt/mockup/datetime/`
(`DECISIONS.md` § Repo conventions). Read every `datetime-kit` below as that subpath. Two
decisions are taken and the rest is proposal: the API mirrors a **reduced Temporal**
(five types), and the package ships **with a schema declaration**, not as a standalone
library. Everything else below is argued, not settled.

This is the package-level answer to the question `IDEAS/time-and-recurrence.md` leaves
open — *"Is `datetime-kit` this, or something else?"* It is this. That record states the
problem and the framework-level declaration; this one states what gets built and what
is refused.

---

## What is there now

Audited 2026-08-12 by running it, not reading it. Nine source files, 1859 lines,
published to npm as `@frontierjs/datetime-kit@0.0.10`, imported by nothing in the repo.

- **`extend()` throws on every call** — `regexpDATE` is undeclared, and its
  `datePartial` argument is never read, so the body does not implement the signature.
- **`add(date, '1 day')` throws** — `exports.parseInt` is CommonJS in an ESM module.
  The two-argument form works, and is DST-blind: every unit goes through `setUTC*`, so
  "+1 day" is `+86400000` and a calendar day across a transition is not expressible.
- **`getTimeZoneOffset()` reads today's offset and applies it to any date**, so
  `Relative.date({date: '2026-01-15'})` run in August returns 23:00 on the 14th rather
  than midnight. Every `Range.*` is built on it and is an hour wrong for half the year.
- **`setTimeZone()` is a global mutable singleton**, unusable on a server; the per-call
  form is commented out in the file with `// NOTE: This can't work this way`.
- **`src/cron.js` is a stale fork of `packages/caravan/src/cron.ts`** with the field
  table wrong (`date max 24`, `month max 31`).
- **The test suite passes only in MST** — it asserts the literal `'MST'` and is green on
  a developer's machine by accident of host zone.

The formatter is the salvageable part. `format(date, 'DD.MM.YYYY hh:mm aa')` is a good
token language with real bugs under it, and it is the only piece of this package worth
carrying forward unchanged in spirit.

---

## The bet

**The distinction between an instant and a wall-clock time is a property of the value,
not of the code that reads it** — so it should be a *type*, and the type should refuse
the operations that do not apply to it. Temporal already made these distinctions, spent
years arguing them, and shipped a vocabulary. Inventing a different one would be a
worse version of a solved design problem, and it would strand every developer who
already knows the standard one.

So the library is a **reduced Temporal**: the same names, the same semantics, a smaller
surface. That buys three things a bespoke API does not.

- **The type system does the framework's job before the schema does.** Probed against
  the polyfill: `Instant.from(...).add({days: 1})` throws
  `Duration field day not supported by Temporal.Instant. Try Temporal.ZonedDateTime
  instead.` That is failure #1 of `IDEAS/time-and-recurrence.md` refused at the call
  site, with the fix in the error text, before any column has declared anything.
- **The package has a stated end.** Temporal is not Baseline — absent from node 22.21.1
  and bun 1.3.11 as probed, shipping in Firefox and not the rest — so it cannot be
  depended on for years. When it is universal, this package becomes a re-export and
  application code does not change. A bespoke API has no such exit; it is owned forever.
- **What is learned here transfers.** The docs for this package are, in the parts that
  matter, MDN's.

---

## The library

### Five types

`PlainDateTime`, `PlainYearMonth`, `PlainMonthDay` and non-ISO calendars are out. What
is left maps one-to-one onto things FJS models already hold.

| Type | What it is | What holds one today |
| --- | --- | --- |
| `Instant` | A point on the timeline. Everyone agrees on it. | `createdAt`, `updatedAt`, audit entries, `@version`, every log line |
| `ZonedDateTime` | A wall-clock time **in a place**. Names a different instant when the rules change. | Nothing. This is the gap. A meeting, a scheduled report, "the shop opens at 09:00" |
| `PlainDate` | A calendar date with no time and no instant at all. | Nothing. A birthday is a `DateTime` today, which is failure #1 in a column |
| `PlainTime` | A wall-clock time with no date. | Nothing. Opening hours |
| `Duration` | A length of time. Serialises `P90D`. | Nothing. `@retain(90d)` in `IDEAS/compliance-from-the-seed.md` is a string |

Immutable, every operation returns a new value, no global state, no mutable
configuration singleton, no `Date` subclass, no prototype extension.

### The one hard part, and its size

Everything rests on a single primitive: **wall-clock fields plus a zone to an instant.**
The forward direction is one `Intl.DateTimeFormat.formatToParts` call and is exact. The
inverse has no platform API and is where every hand-rolled library goes wrong, because a
wall-clock time can name two instants (autumn) or none (spring).

It is small. A prototype was written and graded against the Temporal polyfill as oracle
over eight zones — including `Australia/Lord_Howe` for its 30-minute DST shift,
`America/Santiago` for a midnight transition, `Asia/Kolkata` for a `:30` offset and
`Pacific/Auckland` for the southern hemisphere — across DST edges and ordinary days,
in all three disambiguation modes.

**1176 of 1176 agree with Temporal, in 43 lines.** The method: read the zone's offset
24 hours either side of the target, project the wall-clock fields back through each
candidate offset, and keep the ones that round-trip to the fields asked for. Two
survivors is an ambiguous time; none is a gap. That test is the shape the real suite
should take — the polyfill is a dev-dependency oracle, never a runtime dependency.

This is worth stating plainly because it changes what the package is: **the timezone
problem is 43 lines and a good test, not a library to depend on.** The rest of the
work is API surface and formatting.

### Method surface

Roughly thirty methods total, Temporal's names and Temporal's semantics.

```
Instant        from · fromEpochMilliseconds · until · since · add · subtract
               (time units only — days and larger are refused, on purpose)
               toZonedDateTime · compare · equals · toString

ZonedDateTime  from · with · add · subtract · startOfDay · round
               until · since · compare · equals · toInstant · toPlainDate · toString

PlainDate      from · with · add · subtract · until · since · compare · toString
PlainTime      from · with · compare · toString
Duration       from · total · round · add · subtract · negated · compare · toString

Zone           current · list · offsetAt · isValid
```

`add({days: 1})` and `add({hours: 24})` are different questions and give different
answers across a transition — verified: `2026-03-07T12:00[America/Denver]` goes to
`12:00-06:00` and `13:00-06:00` respectively. That divergence is the feature.

`from` takes `{disambiguation: 'compatible' | 'earlier' | 'later' | 'reject'}`. The
default is `'compatible'`, matching Temporal, and `'reject'` is the one an application
that cares should pass.

### Formatting stays, and gets fixed

The token language is this package's one good idea and it survives, applying to all
five types rather than to `Date` alone.

```js
format(zdt, 'DDDD, MMM DD, YYYY [at] h:mm aa')   // 'Sunday, Jan 09, 2022 at 7:05 AM'
```

Four defects to close, all confirmed by probe:

- **Bare text is mangled.** `format(d, 'Today is DDDD')` currently returns
  `'Todin the afternoony i1 Sunday'`, because every unbracketed letter matching a token
  is substituted. The fix is a real tokeniser rather than a chained `String.replace`;
  the README's own examples do not bracket their literals and would break today.
- **The locale is hardcoded `'en'`** in three places, while the README claims the
  library respects the user's locale and shows Spanish output. Take a locale.
- **`mm` and `ss` do not pad** — `'5'` and `'1'`, because `Intl` ignores `2-digit` on
  minute and second unless `hour` is also requested. The current test asserts the bug
  with a `//TODO` beside it. Pad in the formatter, do not ask `Intl` to.
- **Unknown tokens emit garbage** rather than an error: `'YYY'` gives `'22Y'`. An
  unknown token should name itself, the way an unknown `mesa:*` name does.

Also: the formatter must stop writing into the caller's options object, which it does
today — one call turns `{timeZone: 'UTC'}` into `{timeZone: 'UTC', year: 'numeric'}`,
so a reused options object accumulates tokens across calls.

### Relative time, separated into two steps

The thing the current `relative()` gets structurally wrong is doing the arithmetic and
choosing the words in one pass, which is why its `precision` option interacts with its
style option and why the same instant twice returns `''`.

```js
const d = a.until(b, { largestUnit: 'day', smallestUnit: 'hour' })   // Duration P95DT8H
d.format({ style: 'long' })                                          // '95 days, 8 hours'
```

`until`/`since` answer a `Duration`; `Duration.format()` turns it into words.
`largestUnit`/`smallestUnit` is the well-made version of `precision`, and a zero
duration formats as `'now'` rather than the empty string.

### Ranges, rebuilt on correct primitives

`RelativeRanges`' ambition is right — *this month*, *last week*, *rolling 30 days* are
what every dashboard filter needs, and it is failure #4 of `time-and-recurrence.md`.
The mechanism is what is broken. On a correct `ZonedDateTime` it is small:

```js
range('month', 'current', zone)   // [Instant, Instant) — half-open, always
```

Half-open by rule, and always returning `Instant`s, because the pair exists to be
compared in SQLite, which has no zone support beyond offsets.

### Refused, and why

- **Cron.** `packages/caravan/src/cron.ts` owns it, is tested, and is the fixed
  descendant of the copy in this package. Two implementations of one rule is what the
  `structure` CI phase exists to prevent.
- **Recurrence and RRULE.** `time-and-recurrence.md` refuses the general case and it is
  right to; RFC 5545 is large and mostly unwanted. If a subset earns a name later it is
  a separate record.
- **Non-ISO calendars.** Real, and a different project.
- **Prototype extension.** The current README's entire usage section shows
  `date.format(...)`, which the package does not implement. It should not start.
- **A `Date` subclass or a `dt()` wrapper.** One type holding both instants and
  wall-clock times reproduces exactly the bug the declaration exists to remove.

---

## The declaration

The library is the runtime half. Alone it changes nothing at the boundary: an
application still has to remember to use it, which is the failure mode FJS exists to
remove. These are designed together so one set of words covers both.

### The types the seed gains

Litestone has eight scalar types and **`Date` is not among them** — `DateTime` is the
only one, so a birthday is stored as an instant today. Three additions, and one
attribute:

```
model Appointment {
  id          Int      @id
  createdAt   DateTime                          // unchanged — an Instant
  startsAt    DateTime @zoned(venueZone)        // a ZonedDateTime
  venueZone   String   @timezone                // IANA name, validated
  invoiceDate Date                              // a PlainDate — no instant, ever
  opensAt     Time                              // a PlainTime
  retention   Duration                          // P90D
}
```

`DateTime` keeps its exact current meaning. That is not a courtesy — every schema in
the repo and every published app depends on it, and a time type that breaks existing
columns to fix time semantics has traded one silent failure for a loud one.

### Whose zone

`time-and-recurrence.md` names three answers and all three are real. `@zoned(field)`
covers the row's own zone. The viewer's zone is a per-request fact and belongs on the
principal — which is the seam `applyStanding()` already implements for membership, so
it should be that seam and not a second one. In bridge-index terms it joins
`sessionFields` and `toDataPrincipal()`, and **both halves of that hand-copied pair
need it or row policies compare against `undefined` and match nothing, silently.**

### Reaching the client

`generateJsonSchema` emits `x-time: { kind, zoneField }` beside the existing `x-gate`
and `x-relations`, so `sierra/src/junction/field-rules.js` coerces correctly and
`@frontierjs/ui`'s `DatePicker` stops guessing. The display half comes free once the
column states its kind.

**One hazard to clear first.** `jsonschema.js` ends its type switch with
`default: return { type: 'string' }`, so a type it does not know degrades to a string
without a word. Adding types means that default becomes an error, or the new types are
invisible on the client while appearing to work.

---

## The open question worth settling early

**What does a `@zoned` column physically store?** Two candidates, and the choice is not
cosmetic.

A single `TEXT` column holding `2026-01-15T09:00:00-07:00[America/Denver]` round-trips
exactly — verified — but SQLite cannot usefully compare, sort or index it, which
collides with `$checkOrderBy` and with any row policy over a zoned column.

Storing an instant plus the zone keeps the instant sortable, and it is what the query
layer wants. But it contradicts failure #2 of `time-and-recurrence.md`: for a *future*
event the wall-clock time is the truth and the instant is a bet on politics that the
IANA database settles several times a year.

The honest resolution is probably that **both are stored and the instant is declared
derived** — recomputable from the wall clock and the zone, refreshed when the zone
database updates, indexed and sorted in the meantime. That gives the query layer what
it needs without making the stored instant authoritative. It wants proving before it is
believed, and it is the first thing to prototype after the library, because it decides
whether `@zoned` is expressible at all.

---

## What happens to the current code

| Today | Then |
| --- | --- |
| `format`, `core.js` `getWeek`/`getQuarter` | Kept, fixed, extended to all five types |
| `relative` / `relativeTo` / `relativeToNow` | Replaced by `until`/`since` + `Duration.format()` |
| `RelativeRanges` `Relative.*` / `Range.*` | Idea kept, rebuilt on `ZonedDateTime`; global `setTimeZone` deleted |
| `cron.js` | Deleted. Caravan owns cron |
| `extend.js` | Deleted. Cannot run, and does not implement its signature |
| `add.js` | Deleted. Subsumed by `add`/`subtract` on the types |
| `getDateAndTime.js` | Deleted. `toPlainDate()` / `toPlainTime()` |
| `package-lock.json` | Deleted — an npm lock in a bun workspace, naming `date-library@0.0.5` |
| Test suite | Rewritten zone-explicit. No assertion may depend on the host zone |

Three repo-level chores fall out, all of them stale claims rather than defects:
`CLAUDE.md`, `scripts/ci-allowances.json` and `IDEAS/time-and-recurrence.md` each
describe this package as "a README and nothing else", which stopped being true on
2026-08-12. The allowance is what currently fails `bun run ci` — the package now has a
`test` script, and an exempt package that has one is an error by design.

---

## Open questions

- **Is `@zoned` an attribute or does the type system carry it?** `Date` versus
  `DateTime` is already a type-level distinction and `ZonedDateTime` could be a fourth
  type rather than `DateTime` plus an attribute. The record above picks the attribute
  because it keeps `DateTime` untouched, which is worth more than symmetry — but the
  framework should not end up teaching both.
- **Can a row policy compare against a zoned column?** SQLite has no zone support, so
  *"rows from today"* as a declared policy may be unrepresentable. Finding out early is
  worth more than designing around it late.
- **Does `Duration` earn a scalar type, or is `@retain(90d)` enough?** The duration is
  a real value; whether an application ever stores one in a column is a different
  question and nothing in the repo does yet.
- **How much of `Instant` should exist at all**, given a bare ISO string already works
  and `DateTime` columns will keep arriving as strings? The escape hatch — *the column
  is still a string and you may ignore all of this* — has to survive.

## See also

- `IDEAS/time-and-recurrence.md` — the problem, the four failures, and the
  framework-level argument this record is the package half of
- `IDEAS/compliance-from-the-seed.md` — `@retain`, a duration needing this settled
- `IDEAS/testing-realm.md` — the movable clock a declared time semantics makes testable
- `IDEAS/row-level-tenancy.md` — `applyStanding()`, the seam a viewer's zone reuses
- `IDEAS/declared-semantics.md` §3 — bitemporality, the same observation from the audit
  direction; settle the vocabulary together or one will constrain the other
- `packages/caravan/src/cron.ts` — the one place in the repo that already gets a zone
  right, and the reason cron is refused here
