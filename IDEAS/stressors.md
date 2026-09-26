---
id: stressors
status: assessment
dated: 2026-09-21
---

# Ideas — stressors: products worth trying to build here

**Status: ASSESSMENT.** Dated 2026-09-21. A list of exercises, not a roadmap and
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
| 2 | **Connecteam** — field workforce coordination | a shift that recurs in a wall-clock zone; [`FJS-1215`](../ISSUES.md#fjs-1215) in four shapes at once; a reminder that has to reach a phone; and a write nobody may attribute | `field-workforce.md` · `time-and-recurrence.md` · `overview.md` 2.17 |
| 3 | **Linear / Plane** — issue tracker | *(premise struck — see below)* cross-model search; and a replay refusal with four mutations queued behind it | `homestead.md` · `tenant-authored-queries.md` |
| 4 | **Notion** — collaborative documents | concurrent editing, and per-block sharing, which a ladder cannot express | `permission-sets.md` · `html-over-the-wire.md` |
| 5 | **Chatwoot / Zendesk** — help desk | receiving mail; one person across channels that disagree who a person is | `inbound-integrations.md` · `stored-templates.md` · `chat-surface.md` |
| 6 | **Lago / Stripe Billing** — metered invoicing | double-entry, per-row currency, and a rendered document | `declared-semantics.md` § money · `billing.md` |
| 7 | **Vercel / a CI runner** | a cancellation that must interrupt work already in flight; log streaming; secrets at rest | `operational-edge.md` · `chat-surface.md` § Part 1 |
| 8 | **PostHog** — product analytics | write rate, and a query a tenant wrote | `analytics-and-warehouse.md` · `tenant-declared-fields.md` |
| 9 | **Moodle** — course platform | i18n as a declaration; media; a long-lived attempt | `lexicon.md` · `accessibility.md` |
| 10 | **Etsy with payouts** — marketplace | split money and a phone; geo is no longer one of its unknowns | `declared-semantics.md` · `FJS-D38` |
| 11 | **A status page** — the cheap one | cron precision against a public prerendered surface | — |
| 12 | **JazzHR** — applicant tracking | a record the law says to forget, beside a report that must outlive it; a stranger who owns an application; and a hire that crosses into another app | `compliance-from-the-seed.md` · `bearer-access.md` · `state-machines.md` |
| 13 | **remnant** — a maid.tech fork with a scripture study corpus beside it | read-only reference data that belongs to no tenant and ships with the app; relations keyed on natural keys; search over Greek and Hebrew | `conversion-maid-tech.md` (the CRM half) · `lexicon.md` |

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

### 2. Connecteam — the one that closes a loop rather than opening a realm

Shifts assigned to people at places, a clock that proves who was where, forms
filled on site. **`example` already owns the far end of that loop and asserts
its input**: `weeklyGross` is `rate * hoursPerWeek`, a contracted constant on the
employment window, and `PayComponentKind.overtime` is an enum value nothing in
the application produces. So the payroll realm is built, gated, driven three
ways — and has never been fed by a measured hour.

Most of the product is schema: `@point` and `toolbelt/geo` are geofencing,
`@@transitions` is timesheet approval, `recursive` is the org chart, `@@sync(append)`
is already exactly a clock event. **What it breaks is time and delivery.**
`time-and-recurrence.md` says the zoned wall-clock column is unbuilt for want of a
caller; this is four callers that disagree at the DST boundary. `FJS-1215` asks
whether *no overlapping range* deserves a declaration; only a product with four
of them — shift/shift, shift/leave, shift/availability, clock/clock — can answer
whether one word carries all four. And it is the first exercise here that is
*wrong* rather than merely lesser when a notification stops at a browser tab,
which is overview 2.17 arriving with a bill attached.

Two questions in `field-workforce.md` have no record anywhere else: **an
anonymous write**, where the gate needs a principal and `onLog` stamps one on
every row, and **an act attested by somebody holding no session**, which is what
a wall tablet taking forty clock-ins a morning is.

### 3. Linear — the discovery exercise, on a premise that has moved

**Struck 2026-09-21, and the rank is now unargued rather than wrong.** This row
was written against *there is a browser engine and no sync engine*, and that
stopped being true: Homestead is built through phase 5 (`IDEAS/homestead.md`),
`@@sync` declares the policy per Model, `packages/sierra/src/junction/pending.js`
owns a mutation that has not reached the server, and `@version`'s 409 is no
longer the only answer — `@@sync(field)` merges per column against the base row
the device read (`FJS-D334`, `FJS-D338`). `example`'s `verify:offline` drives all
of it.

What is left of the exercise is real and smaller: **cross-model search**, since
FTS is per model and `db.user.search()` has no sibling that spans three; saved
views; and a queue nobody is watching, where the open question is not what holds
a mutation but **what happens to the four behind it when the first is refused at
replay** (`FJS-D300` grades one, and says nothing about its successors).
Per-workspace custom fields 4.29 already built and measured.

**Somebody should re-rank this row against what remains** rather than trust the
position it holds, which was earned by a break that is now closed.

### 4. Notion — where the gate ladder stops being enough

A ladder answers *how much authority does this principal have*. A document shared
with three named people answers *which rows*, per row, per person — which is
`permission-sets.md`'s question arriving with a product attached. Concurrent
editing is the other half and it is honestly out of scope for a first pass; the
useful narrower exercise is **a block tree with sharing**, leaving the text
merge alone.

It also forces 4.20's unresolved ruling, because a comment thread and a cursor are
channel payloads that are not records, and a rendered or free-form payload cannot
be filtered per subscriber the way a row can.

### 5. Help desk — the direct sequel to the chatbot

Conduit sends and `packages/conduit/CLAUDE.md` states plainly that receiving is
not built. A help desk is mostly receiving: a mail drop, a webhook, a widget, and
the same human across all three under three different identities. `chat-surface.md`
already argues the visitor-facing half and human handoff, so this exercise starts
further along than the others.

### 7. CI runner — and the one measured detail worth carrying

Caravan has `cancel(id)`, and `packages/caravan/src/db.ts` says what it does with
precision: it allows cancelling a pending **or** running job, and *a running job
still completes its attempt*. That is right for a queue of ordinary work and it is
not what a build cancel button means. So this exercise names a real question —
**does anything here own interrupting work already in flight**, and if not, is that
Caravan's problem or the app's? Pair it with log streaming, which is
`chat-surface.md` § Part 1 paying for itself a second time, and with secrets at
rest, already named as unowned.

### 11. Status page — the one that fits in a week

Cron precision (measured-correct and untested under DST), the `site/` prerendered
surface, an incident as `@@transitions`, notification fan-out. Small enough to
finish, and it exercises four realms with no new framework concept. The right
exercise for someone with a week rather than a month.

### 12. JazzHR — the one that has to forget

*Added 2026-09-22, from the pricing page and a read of connectteam. Nothing is
measured yet, and the rank is only where it was appended.*

Jobs, candidates moving through stages, interviews with scorecards, an offer
signed by somebody with no account. **It is not Connecteam's sequel.**
connectteam's schema has no job, candidate, application or offer. The two
products meet at one row: an accepted offer is the `Employee` that connectteam's
HR adds by hand today.

**Most of the product has been argued elsewhere, and that narrows it.** Per-job
custom stages are `tenant-authored-workflows.md`, measured in the linear
stressor. A recruiting team per job is `permission-sets.md`'s question, and that
file is built. Knockout questions are `tenant-authored-queries.md`, and résumé
upload is `untrusted-bytes.md`. The integrations (job boards, LinkedIn, résumé
parsing, calendar sync, eSignature vendors) are what the product charges for,
and they are integration work, not questions about this framework. The
exclusion of *a CRM* below does not cover it, because the part left over is
not a CRM question.

**What it breaks first is forgetting.** An applicant who was not hired is
personal data with a legal expiry date. A hiring product has to delete it and
still answer *how many applied from LinkedIn last quarter, and how long did each
stage take*, the source and timing reports it sells. `compliance-from-the-seed.md`
says no `@pii` or `@retain` exists in the grammar, and its item 3 is *erasure
that actually cascades*. The question nothing else on this list forces is **can
a report outlive the rows it counts**: an aggregate kept as a declaration, a
tombstone, or a row stripped to what the report needs. Every other stressor
here only ever grows its data, so none of them reaches this.

Two more, each with a record:

- **The applicant is a stranger who owns a record.** They apply without an
  account, check their status from an emailed link, and upload documents later.
  That is the portal half of `bearer-access.md`, the half it says is not built.
  `FJS-D344` (*graduating to an account is the app's act*) gets its first
  real caller the day a candidate is hired.
- **An offer is a process, not a field.** Drafted, approved, sent, signed by
  someone holding no session, then the hire. That spans requests and people,
  which is the remainder `state-machines.md` names as unbuilt. The signature is
  connectteam's wall-tablet question again (*an act attested by somebody
  holding no session*), but for a legal document instead of a clock-in.

**The seam worth the most is the handoff.** Run it as its own app beside
connectteam and let an accepted offer create the `User` and `Employee` there.
Then the exercise asks what one FrontierJS app should call to create a principal
in another. No record owns that question yet.

### 13. remnant — the half of a real app that maid.tech does not have

*Added 2026-09-23, from a read of `~/code/Z/remnant/remnant` (schema at
`db/prisma/schema.prisma`) and its production backups. Nothing is built yet, and
the rank is only where it was appended.*

**Most of it is not a new exercise.** remnant is a mid-2024 fork of maid.tech on
the old `@frontierjs/*` line: Feathers + Prisma + Svelte, with the same
`Account`/`Client`/`Property`/`Board`/`List`/`Card`/`Action` core, the same
`queue.js` action machine, the same stored-Prisma `Report`, the same lead-capture
`embeds/` and the same git-backed `Site`/`Page` CMS. Twenty of its 29 models are
maid.tech's. `conversion-maid-tech.md` has already assessed that core against
this framework, and nothing in remnant changes those answers. Its newest
production backup (2024-06-10) is the same shape at a smaller size: 56 accounts,
21,978 clients (20,212 of them leads), 20,209 cards, 19,943 form responses and
3,393 pages across 26 accounts. Porting the CRM half would re-derive a finished
assessment.

**The stressor is the other nine models.** They are a scripture study corpus:
`Book`, `Verse`, `Word` (one row per original-language word, with
transliteration, gloss and morphology code), `Lemma` (Strong's entries),
`Morpha`, `Translation` (a verse's text in thirteen English versions, one column
each) and `Father`/`FathersOnVerses` (the Ante-Nicene Fathers, cross-referenced
to verses). A `/bible` route reads it with a reader, lemma panel, parallel
translations, search and a history. **No migration creates any of these tables,
and none of them exists in any production backup.** The corpus half was
schema-only, so the questions it asks are unanswered in the original too.

**What it breaks first is data that belongs to nobody.** Every corpus model
carries a required `accountId`. That column is the old app's tenancy hook
demanding a tenant for a row that has none: the Greek New Testament is identical
for every account, read-only, and tens of megabytes. Here, `@@tenant(none)`
spells *belongs to no tenant*. Nothing spells the other half, which is **a
dataset that ships with the application**. It is not seeded like a fixture and
not written by users. It is versioned with the release, and a correction to it is
a data release rather than a migration. `FJS-D164` covers reference data that
changes over time (a row with a validity window). It does not cover reference
data that is published once and replaced whole. Three questions come with it:
does a read-only corpus live in the app's database or beside it as a second
attached file, what refuses a write to it at the Data boundary, and how does
`fli deploy` ship a new version of it.

Two more, both measurable on the first day:

- **Relations keyed on natural keys.** `Word.verseId → Verse.verseId` (a
  `@unique` column, not the id), `Word.strongsTag → Lemma.strongsTag`,
  `FathersOnVerses.chapterRef → Father.chapterRef`. `litestone import --from
  prisma` read all 29 models with no changes and no losses (15 `sti-candidate`
  notes, all on `type` columns). It also passed a contradiction without a note:
  `Morpha.strongsTag` is `@unique`, which makes the relation one-to-one, while
  `Lemma.morphas Morpha[]` declares it one-to-many. Measure whether the parser or
  the client refuses that shape, or whether it is a silent wrong answer.
- **Search over another script.** A reader searches polytonic Greek and pointed
  Hebrew, where a match has to ignore accents, breathings and vowel points, and
  also searches transliteration and English gloss. `@@fts` offers `unicode61`,
  `ascii`, `porter` and `trigram`, and no `remove_diacritics` or
  `tokenchars` argument. Whether `unicode61` folds Greek and Hebrew combining
  marks is unmeasured. Search that spans `Verse`, `Word` and `Lemma` is Linear's
  leftover question (cross-model search) arriving with a second caller.

`Translation`'s thirteen columns (one per version) are the one part that looks
like `lexicon.md`'s territory and is not. They are parallel texts, not
localizations of one string, so a locale mechanism is the wrong answer. Record
that as a cleared suspicion rather than open a row for it.

**Run it as a narrow exercise.** Import the schema, keep the CRM half as
maid.tech's, and build only the corpus and the `/bible` reader. The data is
public (the app has a `tagnt` service, which points at STEPBible's tagged Greek
NT, and Strong's lexicon), so the stressor needs no production copy.

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

### What the first run learned about running one

*Folded back from the calendly stressor, 2026-09-21 — twenty-four ids and one
design record. Generic only; anything that was about scheduling stayed in that
app's `PLAN.md`.*

**One SESSION per phase, and let `PLAN.md` carry the rest.** Measured on the
first run: the conversation re-read **418M** tokens of itself against **3.9M**
of new file content — about 107:1 — because every turn re-reads everything
before it. A request costs in proportion to how much conversation precedes it,
not to how hard it is: the same size of request read **36M** of context mid-run
and **2.5M** after a compaction, fourteen times cheaper for comparable work. So
the plan file is not documentation, it is the HANDOFF, and a phase that ends
should end a session. Phase granularity and no finer — the ninth question was
answered well partly because the same session still held `FJS-D143` and the
first question's answer, and a boundary drawn per-task would have cost that.

**Give the sharpest question its own phase, before any screen exists.** Rank the
questions by what the answer is worth and run them in that order, not in the
order a product would be built. Calendly's hardest question needed no UI at all,
and a UI-first plan reaches it in week three or never. This is the single rule
that cost the most to learn and the one most worth copying.

**Name the question before building the feature, and pick the hard version of
the feature on purpose.** Reminders could be *24 hours before* or *08:00 on the
morning of, in the invitee's zone*. The first is easy precisely because a
duration needs no zone — building it would have produced a working feature and
no finding. When two shapes of a feature exist, the one that touches the seam is
the one to build, and saying so in the plan stops it being quietly traded away
later.

**Open every generated page once, and CHANGE a value while you are there.** A
walkthrough that only presses buttons with their default values proves the page
renders. It does not prove the page works: a `<Select>` whose handler discarded
what you picked survived a drive that pressed *Add window* without touching a
field. Type into every control, pick a non-default option, submit.

**An assertion about one layer is evidence about that layer and nothing else.**
A form was verified twice at the API — a `POST` without the field created the
row — and shipped unsubmittable, because the resource's `validate` step runs in
the BROWSER and refused first. If a person will use it through a screen, the
evidence has to come from the screen.

**Clearing a false candidate is a result, and it belongs in the row.** One of
the strongest-looking findings of the last run dissolved on measurement — a
queue's `delay` takes a duration while its table stores an instant, which looks
exactly like a known category error and turned out to be exact to the
millisecond. Writing *not a finding, measured, here is the number* into the row
is what stops the next person spending a day re-suspecting it. A weak row is
worse than none; a cleared suspicion is worth keeping.

**A gap needs a RULING, not only a row.** An `FJS-###` says *this cannot be
done*. It does not say whether it should be possible, so it sits `open` forever
and the next stressor re-derives it. The deliverable line says *and at most one
design record* for this reason — when the run is over, look at the ids and ask
which one is a decision wearing a bug report's clothes. Usually exactly one is.

**The run does not end when the phases do — and this is the cheapest phase
there is.** Seven of the last run's twenty-four ids were found AFTER it closed,
by somebody using the app for ordinary reasons. **Measured, per finding:** a
bug reported from the screen cost 20–55k output tokens and produced a filed id
apiece; the big open-ended build phases cost 100–210k each and produced ids at
several times the price. *Use your own app for an hour* reads like a nicety
until the ratio is on the page. Budget for it, and treat *the author using their own app for an hour*
as a phase rather than as an accident. It is also the only phase that finds the
failures that look like the product working: a page reporting *no times
available* over an API it never reached.

### What the second run learned

*Folded back from the connectteam stressor, 2026-09-22 — thirty-three new ids,
ten amended, seventeen suspicions cleared on measurement, and one design record
(`FJS-D349`). Generic only; the product's own answers stay in that app's
`PLAN.md`.*

**The hour of ordinary use needs a brief, because it is the one phase a person
runs.** The run ended its last agent phase with *an hour of ordinary use is
what's left*, and the person who opened the app found no menu (the nav is
hidden until sign-in), no account to sign in with, a tutorial for a home page,
the app on 8001 where the README says 8000 (the port broker moves off a port
another project holds), and a stale dev server from the morning still on 8010,
pointed at an API that was not running. None of that is a finding and all of it
cost the hour. Before handing over: the URL that is actually listening (`ss
-ltnp`, not the README), the seeded accounts with passwords, a scripted fake
week that names the moves, what to write down, and **the defects already filed
that are visible on screen** — the first thing reported was `[object Object]`
in the sites table, filed three phases earlier.

**Make the home page the overview of what has been built, and grow it every
phase.** Seven phases in, `/` was still the framework's tutorial, so the product
had no place to start from, and a person opening it could not tell what the run
had built. The first phase that ships a screen replaces the scaffold's page with
a dashboard. Every phase after that which builds a feature adds a tile for it:
a count of the thing it made, a link to its screen, and one line on what that
screen does. It is the map the person uses in the hour of ordinary use, and it
is also an instrument. The first time connectteam's was opened as an employee,
it showed her colleagues' DRAFT shifts, a read nothing had asked about because
no single screen put them side by side.

**Drive the dev server as well as the build, and in the person's browser.**
Phase 7's instrument drove the production build, which was right for its
question, and the device database never opened under `bun run dev` once. That is
because `--source local` places the framework's files outside Vite's root, and a
file reached by URL rather than by `import` (a worker, via `new Worker(new
URL(…))`) is refused with a 403 by `server.fs.allow`, while every imported
module beside it loads. The person uses the dev server, and Firefox. Firefox
named the failure on every click; Chrome, which every drive used, logged a
warning nobody read.

**A test that pins a defect goes red when the defect is fixed, so write it to
say that.** Three tests asserting `FJS-1216` (*a scoped client has no `$lock`*)
failed the gate when the framework tree gained the method, while `ISSUES.md`
still said `open`. Read as a regression, that red costs a session. A pinning
test's name or message should say *if this fails, re-measure `FJS-###` and amend
the row*, because that red is news about the tracker, not about the app.

**Change one thing per A/B.** `FJS-1281` was found only because a two-variable
comparison (`composed: true` and `populate` removed together) blamed the wrong
one, and the isolation run was what named `composed`. When an experiment moves
two things, the finding attached to it is a guess.

**Age a clock where it is kept, and never sleep through one.** Nobody can wait
out an eight-hour shift. The instrument listed every store that holds a
timestamp: the queue entry's `createdAt`, the list cache, the idempotency
claim, the session. It then aged each one in its own store, and restarted the
API to expire the claim held in memory. Mocking `Date` ages only the clocks
that read it, and the one left un-aged is the finding you did not get.

**The instrument is code, and it fails like code.** A drive that threw left a
browser holding its debug port, and the next run attached to that stale browser
and graded it. Kill by port rather than by pattern, close on every exit path,
and refuse a port that already answers.
