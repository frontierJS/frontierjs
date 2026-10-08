---
id: field-workforce
status: proposed
dated: 2026-09-21
---

# Idea — Field workforce coordination: the stressor that completes a loop `example` already half-owns

**Status: PROPOSED.** Dated 2026-09-21. Nothing here is built and nothing is
committed to; see `VERIFYING.md`. The audit below was probed against the tree
rather than read off the documents.

The shape is Connecteam's: one application for an employer whose staff are not
at desks. Shifts assigned to people at places, a clock that proves who was
where, forms filled on site, and the communications and HR layers arranged
around that loop. `IDEAS/stressors.md` § 2 holds the row; this is the one design
record that row is allowed.

---

## Why this one, with Calendly already running

The break this exercise would have claimed first is already filed by the
exercise in flight: [`FJS-1215`](../ISSUES.md#fjs-1215) — nothing in the
language can declare *no two of these may overlap* — came out of Calendly, with
the design question stated and the `db.$lock` fallback named. This record does
not re-argue it.

What is left after that subtraction is still worth the month, and two of it is
owned by nothing:

- **It is the only shape on that list that completes a loop `example` already
  half-owns.** Every other stressor opens a realm; this one closes one.
- **It supplies the caller `time-and-recurrence.md` says the zoned half is
  waiting for** — and supplies it four times over, which is what decides
  `FJS-1215`'s open question and what one Calendly cannot decide.
- **It is the first product here that fails when a notification does not reach a
  phone**, which is overview 2.17 asking to be built.
- **Anonymity and shared-device identity have no record anywhere in `IDEAS/`.**
  They are § Open questions below.

---

## The joint: `example` owns the back half of this exact loop

The loop, stripped of its marketing:

```
Person → Shift → Job/Location → Time → Proof → Payroll
```

`example/db/schema.lite` has the last arrow and everything it needs — `Employee`,
`PayWindow`, `PayRate`, `PayRun`, `Payslip`, `PayslipLine` posting into
`JournalEntry` — with a state machine whose `approve` is `@gate(5)` and three
drives over it (`verify:employment`, `verify:payrun`, `verify:payroll`).

**And it asserts the hours rather than measuring them.**
[`weeklyGross`](../example/api/src/domain/payroll/employment.ts#L300) is
`rate * hoursPerWeek`, where `hoursPerWeek` is a contracted constant on the
employment window. `PayComponentKind` names `overtime`; nothing in the
application produces one — the only occurrence outside the enum is an arrears
label in [`arrears.ts`](../example/api/src/domain/payroll/arrears.ts#L57).

So the shop proves `calculate → approve → pay → post`, and takes on faith the
one input a workforce product exists to establish. That is the joint. An
exercise that builds the front half is not opening a new realm — it is grading
whether the realm that is built can be fed by anything other than a contract.

---

## What is already spellable

Probed, not assumed. Most of this product is schema.

| The product wants | What already answers it |
| --- | --- |
| GPS stamp on a clock event | `@point(lat, lng)` — one value, two real columns, `verify:geo` |
| Geofence | `toolbelt/geo` — `pointInPolygon`, `isNear`, `boundingBox` (a LIST of boxes, so ±180 and the poles cannot be forgotten) |
| *within 5mi of the site* | `?site[near][lat]=…&[within]=5mi`, one bracket notation and three existing readers (`FJS-D323`) |
| Timesheet and PTO approval | `@@transitions` at the Data boundary with a gate on the move. `PayRun.approve` is already that shape |
| Org chart | `recursive: { direction, via, maxDepth }`, a cycle refused on the write |
| Custom employee fields | `CustomField` + field rules reaching `<Form>` as a declared column does |
| Smart Groups | `customers.segment` over `toolbelt/predicate` |
| Chat, presence, read state | junction `transport/channels.ts` and `transport/presence.ts`, broadcast graded per recipient |
| A photo on a form | `File @accept("image/png, image/jpeg, image/webp")` |
| Recurring dispatch, auto clock-out | caravan cron; ids mint at both ends (`toolbelt/ids`) |
| Automations over the above | orion — triggers, conditions, actions, installed into the app |
| SSO, 2FA | `auth/oauth.ts`, `auth/totp.ts` |

---

## What it breaks

**1. The zoned wall-clock column, with four callers instead of none.**
*Tuesdays, 09:00–17:00, Europe/Lisbon* is the shift, the availability window,
the auto-clock-out and the reminder. `FJS-D143` ruled the axis and `FJS-D144`
the DST boundary; the plain-date half shipped (`FJS-D288`) and
`time-and-recurrence.md` says the zoned half is unbuilt because it has no
caller. This is four, and they disagree with each other at the two boundaries a
year — a night shift that is seven hours in spring and nine in autumn is paid
wrong in both directions by any implementation that stores an instant.

**2. `FJS-1215` in four shapes rather than one.** Shift against shift for one
person; shift against approved leave; shift against a declared availability
window; clock-in against an open clock-in. Calendly can ask whether *no
overlapping range* deserves a declaration. Only a product with four of them can
answer whether **one word carries all four**, which is the open half of that
issue — four services each holding a lock is the measurement that decides it.

**3. Delivery that reaches a phone.** `packages/notifications/drivers/` is
`email.ts` and `inapp.ts`. Overview 2.17 already separates the two halves — SMS
is a Conduit target and an afternoon; push is a design, and its best argument is
that a subscription is a ROW, inheriting `@@gate`, `@encrypted` and Invariant 7
where every hand-rolled version is a plain table with none of it. A shift
reminder that arrives in a web tab nobody has open is not the product, so this
is the first exercise that fails without it rather than merely wanting it.

**4. Not offline.** Homestead is built through phase 5: `@@sync` is declared
across `example`, the queue is
[`pending.js`](../packages/sierra/src/resource/pending.js), the bytes drain as a
second queue behind the row (`FJS-D301`), and a per-column merge against the
base row the device read is `src/core/three-way.js` (`FJS-D334`, `FJS-D338`).
**`@@sync(append)` — already carried by `InventoryMovement` — is exactly a clock
event's shape**, and it is the mode this product mostly needs, so the hardest-
looking requirement is the one already answered. What is genuinely untested is
DURATION: `verify:offline` takes a tab offline for a minute, and the product
needs a device offline for a shift with the app closed. That is an instrument
question, not a seam.

---

## Open questions

- ~~**Can a write be anonymous, when every write has an actor?**~~ **Answered 2026-09-28 (`FJS-D349`): D349 picked A.** An anonymous
  survey is the one row nobody may attribute — and it is not *skip the log*,
  because the employer must still know each eligible person answered exactly
  once. Today the gate grades a principal and `onLog` stamps `actorId` /
  `actorType` on every write. Invariant 7 redacts a protected field's VALUE;
  nothing redacts the WRITER.
  - **A** — `@@anonymous` on the model: the boundary grades the principal, writes
    the row, stamps no actor, and a separate append-only eligibility table
    carries *who has responded*. Two writes, one transaction, neither joinable to
    the other.
  - **B** — the application's problem. The service writes through `asSystem()`
    and keeps its own ballot table.
  - **C** — a field-grain word (`@unattributed`) rather than a model-grain one.
  - **Recommend A** — B's failure is silent re-attribution by whoever adds
    `@@log(audit)` to that model a year later, which is the exact mistake a
    declaration exists to prevent, and the eligibility table is the part every
    hand-rolled version gets wrong. C is the wrong grain: anonymity is a property
    of the row's provenance, not of a column's value.

- ~~**Can an act be attested by somebody who holds no session?**~~ **Answered 2026-09-28 (`FJS-D540`): A — the device is the principal, and `app.runAs(userId, fn)` is the seam that already exists: the kiosk service grades a weak factor against a `@guarded` column on `Employee` and runs one call as that person. No session is ever minted, and the audit trail attributes the row correctly.** A wall tablet,
  forty clock-ins a morning, a four-digit PIN or an NFC tap. Every factor auth
  owns — password, OAuth, TOTP, bearer — mints a session for one principal, and
  a shared device is the case where minting one is the mistake.
  - **A** — the device is the principal, and `app.runAs(userId, fn)` is the seam
    that already exists: the kiosk service grades a weak factor against a
    `@guarded` column on `Employee` and runs one call as that person. No session
    is ever minted, and the audit trail attributes the row correctly.
  - **B** — a real session per clock-in, short-lived.
  - **C** — out of scope; a kiosk is the app's concern.
  - **Recommend A** — the seam is built and named (`app.runAs`, `reenterAs`), so
    the question is whether a weak factor may open it, not whether a mechanism
    exists. B hands a credential to somebody who by construction cannot keep one
    safe, on a device forty people touch.

---

## If it runs

Outside this repo, per `stressors.md` § Setting one up — `fli new` with
`--source local`, the `discovery` skill pointed at the product described out
loud, and the deliverable is `FJS-###` ids in this repo the hour each is found.

**Build order, so an abandoned run still pays.** The clock before the schedule:
`Employee → ClockEvent` with `@point` and `@@sync(append)` is the smallest thing
that produces an hour, and it reaches geofencing, offline duration and the
payroll joint before a single shift exists. The schedule second, which is where
`FJS-1215`'s four shapes arrive together. Forms and comms third and only if the
first two came back clean — they are the part this framework most obviously
already does.

**What would make it worthless**: building the comms layer first. Chat over
`channels` and `presence` is a week of pleasant work that grades nothing, and
half these exercises are abandoned before the interesting part.

---

## See also

- `IDEAS/stressors.md` § 2 — the row, and why a stressor lives outside the tree
- [`FJS-1215`](../ISSUES.md#fjs-1215) — *no two of these may overlap*, open, from Calendly
- `IDEAS/time-and-recurrence.md` — the zoned wall-clock column (`FJS-D143`, `FJS-D144`, `FJS-D288`)
- `IDEAS/homestead.md` — the offline engine, built through phase 5
- `IDEAS/overview.md` 2.17 — push and SMS, one a driver and one a design
- `IDEAS/permission-sets.md` — per-team, per-feature permission, if the comms layer is reached
- `example/api/src/domain/payroll/` — the half that is built
