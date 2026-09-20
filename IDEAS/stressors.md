---
id: stressors
status: assessment
dated: 2026-09-20
---

# Ideas — stressors: products worth trying to build here

**Status: ASSESSMENT.** Dated 2026-09-20. A list of exercises, not a roadmap and
not behavior. Nothing here is committed to. See `VERIFYING.md`.

**Why this is not `reference-library.md`.** That file is a corpus of schemas to
**read** — fetched, parsed by `litestone import`, graded on the Data axis, no
application built. This one is a list of products to **build**, where the whole
stack is the instrument and the answer is usually a seam rather than a model.
The two do not overlap and neither subsumes the other: a schema corpus cannot
find a missing API-realm owner, and a built product tells you almost nothing
about how a 2.9 MB schema behaves. Chatwoot appears in both, for different
questions.

---

## What makes a good stressor

- **It must be picturable.** *A help desk* is; *a multi-tenant event-driven
  platform* is not, and the vague one produces a vague finding.
- **It must be gradable.** You know when it works, and the way you know it works
  is a drive somebody else can run.
- **The point is the seam, not the app.** The deliverable is filed ids and, at
  most, one design record. A half-built product kept in the tree for its own sake
  is a third app paying CI minutes forever.
- **Rank by what it breaks**, never by how impressive it is.

---

## The list

**Ranked by what each one breaks, and the order is the preferred one** — top of
the table is what to run next. *Existing record* is what would be extended rather
than started.

| # | Product shape | What it breaks first | Existing record |
| --- | --- | --- | --- |
| 1 | **Calendly** — scheduling | a recurring wall-clock window in one zone booked as an instant from another; and *no two of these may overlap*, which nothing here can declare | `time-and-recurrence.md` ([`FJS-D143`](../DECISIONS.md#fjs-d143) · [`FJS-D144`](../DECISIONS.md#fjs-d144)) · `bearer-access.md` |
| 2 | **Linear / Plane** — issue tracker | local-first write then sync; there is a browser engine and no sync engine | `offline-first-and-release.md` · `tenant-authored-queries.md` |
| 3 | **Notion** — collaborative documents | concurrent editing, and per-block sharing, which a ladder cannot express | `permission-sets.md` · `html-over-the-wire.md` |
| 4 | **Chatwoot / Zendesk** — help desk | receiving mail; one person across channels that disagree who a person is | `inbound-integrations.md` · `stored-templates.md` · `chat-surface.md` |
| 5 | **Lago / Stripe Billing** — metered invoicing | double-entry, per-row currency, and a rendered document | `declared-semantics.md` § money · `billing.md` |
| 6 | **Vercel / a CI runner** | a cancellation that must interrupt work already in flight; log streaming; secrets at rest | `operational-edge.md` · `chat-surface.md` § Part 1 |
| 7 | **PostHog** — product analytics | write rate, and a query a tenant wrote | `analytics-and-warehouse.md` · `tenant-declared-fields.md` |
| 8 | **Moodle** — course platform | i18n as a declaration; media; a long-lived attempt | `lexicon.md` · `accessibility.md` |
| 9 | **Etsy with payouts** — marketplace | split money and a phone; geo is no longer one of its unknowns | `declared-semantics.md` · `FJS-D38` |
| 10 | **A status page** — the cheap one | cron precision against a public prerendered surface | — |

### 1. Calendly — the smallest product that forces a made ruling to get built

The best value on this list, because most of its findings are already argued and
none of them is built.

**Its central object cannot be spelled today.** An availability window is a
recurring **wall-clock** time in the host's zone (*Tuesdays, 09:00–17:00, Europe/
Lisbon*); a booking is an **instant**; the invitee reads both in a third zone.
`FJS-D143` ruled exactly this distinction — the kind is declared by an attribute,
`DateTime` keeps its name, a zoned comparison is a window the framework binds and
never a SQL predicate — and `time-and-recurrence.md` already says the quiet part:
*a subscription renewal, an appointment and a scheduled report are the same
declaration; only one of them is currently expressible, and only in a job file.*
Calendly is that sentence with a product attached, including the DST edges that
make a 02:30 slot exist zero times in spring and twice in autumn.

**It also tests `FJS-D144`'s refusal, which is the interesting part.** The general
RRULE was refused on Temporal's own evidence. Availability is recurring with
exceptions — *weekdays 9–5, not the 24th, half-days in August* — so this exercise
asks whether the refusal holds and something narrower serves, or whether
scheduling is the case that falsifies it. Either answer is worth having, and a
ruling tested by a product is worth more than a ruling tested by an argument.

**And it carries one constraint nothing in the tree names.** *No two bookings on
one calendar may overlap* is uniqueness over a **range**, not over a value.
`@@unique` cannot say it, a `@@check` cannot see another row, and SQLite has no
exclusion constraint — Postgres's `EXCLUDE USING gist` is the thing being missed.
So the correctness of the whole product rests on `db.$lock(key, fn)` plus a
transaction, which exists and has never been load-bearing for anything a user can
double-click. That is the sharpest question here: **is *no overlapping range* a
declaration this framework should own, or is a lock the honest answer?**

Four more it reaches, each already named elsewhere: the invitee is a stranger who
owns a booking and cancels it from a link in an email (`bearer-access.md`, and the
guest-basket shape again); two-way calendar sync is **receiving** as much as
sending, which conduit says it does not do; a public booking page is the
prerender-against-live-data tension on the `site/` surface, where a slot list is
wrong within the minute; and an `.ics` attachment has **zero hits** anywhere in
the tree, which for a scheduling product is the artifact the whole thing is for.

### 2. Linear — the discovery exercise: the largest unowned seam

The browser engine landed recently (`FJS-D305`): the whole Litestone client runs
in a worker over OPFS, and `$transaction` is refused there because the callback
runs on the page. **Nothing has driven that as a product.** An issue tracker is
the shape that would: write while offline, sync on reconnect, and reconcile.

`@version` is the only conflict primitive and it is row-level — it 409s, which is
correct for a form and wrong for a queue of local mutations nobody is watching.
So the exercise asks the question the tree cannot currently answer: **what owns a
local mutation that has not reached the server, and what happens to the four
after it when the first one is refused?** Also reaches cross-model search (FTS is
per model: `db.user.search()` has no sibling that spans three), saved views, and
per-workspace custom fields, which 4.29 already built and measured.

### 3. Notion — where the gate ladder stops being enough

A ladder answers *how much authority does this principal have*. A document shared
with three named people answers *which rows*, per row, per person — which is
`permission-sets.md`'s question arriving with a product attached. Concurrent
editing is the other half and it is honestly out of scope for a first pass; the
useful narrower exercise is **a block tree with sharing**, leaving the text
merge alone.

It also forces 4.20's unresolved ruling, because a comment thread and a cursor are
channel payloads that are not records, and a rendered or free-form payload cannot
be filtered per subscriber the way a row can.

### 4. Help desk — the direct sequel to the chatbot

Conduit sends and `packages/conduit/CLAUDE.md` states plainly that receiving is
not built. A help desk is mostly receiving: a mail drop, a webhook, a widget, and
the same human across all three under three different identities. `chat-surface.md`
already argues the visitor-facing half and human handoff, so this exercise starts
further along than the others.

### 6. CI runner — and the one measured detail worth carrying

Caravan has `cancel(id)`, and `packages/caravan/src/db.ts` says what it does with
precision: it allows cancelling a pending **or** running job, and *a running job
still completes its attempt*. That is right for a queue of ordinary work and it is
not what a build cancel button means. So this exercise names a real question —
**does anything here own interrupting work already in flight**, and if not, is that
Caravan's problem or the app's? Pair it with log streaming, which is
`chat-surface.md` § Part 1 paying for itself a second time, and with secrets at
rest, already named as unowned.

### 10. Status page — the one that fits in a week

Cron precision (measured-correct and untested under DST), the `site/` prerendered
surface, an incident as `@@transitions`, notification fan-out. Small enough to
finish, and it exercises four realms with no new framework concept. The right
exercise for someone with a week rather than a month.

---

## Not on this list, with reasons

- **Figma proper.** Canvas rendering is not a question about this framework; Mesa
  compiles to DOM and the interesting part of Figma is neither.
- **A social feed at scale.** The fan-out question is real and is already
  `analytics-and-warehouse.md`'s and 4.20's between them; a feed adds a follower
  graph and no new seam.
- **An ML training platform, a game, an IDE.** Each stresses a runtime this
  framework does not claim. A stressor that fails for a reason outside the thesis
  teaches nothing about the thesis.
- **A CRM.** `IDEAS/intent-recognizer.md` and `tenant-declared-fields.md` have
  already taken the two sharp questions out of it.

---

## Setting one up

**A stressor lives OUTSIDE this repo.** Settled: the deliverable is filed
`FJS-###` ids and at most one design record, so a third application beside
`example` and `basecamp` would pay CI minutes and a `scaffold` phase forever for
a question asked once. `example` earns its place by being the kitchen sink every
package is driven through; a stressor is not that.

**Point it at the working tree, not at npm.**

```bash
cd /path/to/frontierjs/packages/cli && bun link   # once — `fli` on PATH, this tree
cd ~/work && fli new calendly --source local --full --yes
```

`--source local` writes `link:@frontierjs/*` specs and runs `bun link` in each
package the app needs, so an edit in the framework tree is live in the app with
no reinstall. **The default is `--source npm` and it is the wrong instrument
here**: a stressor exists to find what the tree cannot do, and a published
framework cannot be edited when it turns out it can't do it. Drop `--full` for a
narrower install; add `--site`, `--widgets` or `--extension` when the product
needs that surface — Calendly's public booking page is a `site/`.

**Give the agent both trees.** A scaffold already lands with two files for it —
`AGENTS.md`, the framework's half, and `CLAUDE.md`, the app's own, which imports
it — but both are written against the PUBLISHED framework, and a stressor is a
question about the working tree. An agent that cannot read that tree writes
around a seam instead of reporting it, which is the one outcome that makes the
whole exercise worthless:

```bash
cd ~/work/calendly && claude --add-dir /path/to/frontierjs
```

**Start from a schema, and get it from the conversation rather than the
keyboard.** The `discovery` skill is for exactly this shape — a brief, a
transcript or a product described out loud, turned into `db/schema.lite` with
gates, transitions and tenancy declared rather than added later. For a stressor
the brief is the product being imitated, so *describe Calendly to it* and grade
what comes back: **the first finding is usually in that file**, before a line of
application code exists, because a construct the language cannot spell shows up
as a comment in the schema. `litestone import` is the other door when the
product being imitated has a public schema to read.

Then the ordinary loop: `bun run dev`, `bun run check` (`fli check` + lint +
typecheck), and `fli tinker` to ask the database what it actually did.

**Report as you go, and report against the framework.** A seam that has no owner
is an `FJS-###` in this repo's `ISSUES.md` the hour it is found, not at the end —
half these exercises are abandoned mid-way and the finding is the only thing that
was worth having. A fix lands in the framework tree with a drive in `example/`;
**the stressor itself proves nothing**, because nothing here runs it.
