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
| 6 | **Portal** (codename) — a Kagi-shaped search shell over rented indexes, terminal first | a hedged fan-out (first N of M providers inside a deadline, cancel the rest); a result page that paints while a slow provider is still out; a query that must never be logged; a friend's topic-scoped lens applied to *your* read | `conduit` (per-target policy) · `compliance-from-the-seed.md` · `permission-sets.md` · `FJS-D38` |
| 7 | **Lago / Stripe Billing** — metered invoicing | double-entry, per-row currency, and a rendered document | `declared-semantics.md` § money · `billing.md` |
| 8 | **Vercel / a CI runner** | a cancellation that must interrupt work already in flight; log streaming; secrets at rest | `operational-edge.md` · `chat-surface.md` § Part 1 |
| 9 | **PostHog** — product analytics | write rate, and a query a tenant wrote | `analytics-and-warehouse.md` · `tenant-declared-fields.md` |
| 10 | **Moodle** — course platform | i18n as a declaration; media; a long-lived attempt | `lexicon.md` · `accessibility.md` |
| 11 | **Etsy with payouts** — marketplace | split money and a phone; geo is no longer one of its unknowns | `declared-semantics.md` · `FJS-D38` |
| 12 | **A status page** — the cheap one | cron precision against a public prerendered surface | — |
| 13 | **JazzHR** — applicant tracking | a record the law says to forget, beside a report that must outlive it; a stranger who owns an application; and a hire that crosses into another app | `compliance-from-the-seed.md` · `bearer-access.md` · `state-machines.md` |
| 14 | **remnant** — a maid.tech fork with a scripture study corpus beside it | read-only reference data that belongs to no tenant and ships with the app; relations keyed on natural keys; search over Greek and Hebrew | `conversion-maid-tech.md` (the CRM half) · `lexicon.md` |
| 15 | **Ghost** — blog / publishing | a write that has to rebuild a prerendered page; a transition that fires at a future instant; a stranger's comment held for moderation | `state-machines.md` · `static-safety.md` · `bearer-access.md` |
| 16 | **ksite** — a legacy-FJS static marketing site, being ported | a site authored in Markdown that names components it never imports; a collection read at build time with no database; a client theme written as colors, not tones | `static-safety.md` · `FJS-D38` · `FJS-D127` |
| 17 | **Immich** — self-hosted photo library | a 4 GB upload held in memory whole; one upload fanning out into a pipeline of derived files; a backup from a phone that must resume and never send the same bytes twice | `overview.md` 2.7 · `untrusted-bytes.md` · `offline-first-and-release.md` · `bearer-access.md` |
| 18 | **EventMark** — a staffing schedule written as a Markdown file | a text document that is the record while a screen writes back into it; a staff-to-child ratio broken from either side; a reference to a person who may not exist | `kernel-and-projections.md` · [`FJS-D474`](../DECISIONS.md#fjs-d474) · `time-and-recurrence.md` · `FJS-D305` |
| 19 | **Vaultwarden** — a Bitwarden-compatible password vault server | a server that must never read what it stores; an API whose shape a client someone else wrote already fixed; a grant that takes effect after a wait unless refused | `bearer-access.md` · `state-machines.md` · `untrusted-bytes.md` · `third-party-credentials.md` |
| 20 | **Dragonfly** — a JSON grid editor, jsongrid.com taken further, ported from a Svelte 4 app | one document with two writable views, where a cell edit re-serializes the whole text; a chain of derived stores over every row, re-run on every keystroke; identity for rows that have none; three condition languages beside the one `.lite` has | `@frontierjs/ui` `Json.mesa` · `Table.mesa` · `CommandPalette.mesa` · mesa `{#virtual each}` · `toolbelt/json` · `toolbelt/predicate` · #18 |
| 21 | **Transit** — the data layer as a product: intake, normalize, report to screen, PDF and email | foreign data typed by a `.lite` held in a row and built on the fly; a sync cursor across a conduit target; one template to three outputs; a scheduled query run at each recipient's standing | `data-layer-v1.md` · `analytics-and-warehouse.md` · `stored-templates.md` · #9 |

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

**Cross-model search, second caller (remnant Q3, 2026-09-28): linear's answer
holds.** linear's PLAN.md Q4 answered it on 2026-09-22: N per-model `search()`
calls, grouped by kind, because bm25 does not compare across indexes. Remnant's
one search box spans `Verse`, `Word` and `Lemma` over 495k rows, and it came
out the same: three calls in one service, with `db.query` refusing a `search`
key by name (FJS-1310's fix, measured). Verses are listed in book order and
lemmas as their own group, 1–8 ms median over HTTP. What the second caller adds
is the easy case linear lacked: the corpus has no row policies, so `search()`
through `$.db` is the whole of it. **The spanning verb is still not owed.**

**linear is on `@@fts` too (2026-10-04).** Its `$raw` + bm25 two-step was
the FJS-1289 workaround and outlived the fix; ⌘K is now three graded
`search()` calls and `$search` answers over the wire. Its row policies, which
remnant lacked, exposed [`FJS-1692`](../ISSUES.md#fjs-1692) and
[`FJS-1694`](../ISSUES.md#fjs-1694). What remnant did need that linear did not was
a fold on both sides of the index, [`FJS-1466`](../ISSUES.md#fjs-1466), and
adding `@@fts` to a table that already held rows broke every write to it,
[`FJS-1463`](../ISSUES_ARCHIVE.md#fjs-1463).

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

A page shared across workspaces is a channel two tenants share (Slack Connect's
shape): one row owned by both, which a single `tenancy { column }` cannot state.

### 5. Help desk — the direct sequel to the chatbot

Conduit sends and `packages/conduit/CLAUDE.md` states plainly that receiving is
not built. A help desk is mostly receiving: a mail drop, a webhook, a widget, and
the same human across all three under three different identities. `chat-surface.md`
already argues the visitor-facing half and human handoff, so this exercise starts
further along than the others.

### 6. Portal — the shell of a search engine, on top of somebody else's index

**Codename: Portal.** The stressor, and the app if one gets built. Three other
things in this tree already answer to the word — `<mesa:portal>` (a Mesa
primitive), the customer *portal* in `bearer-access.md` (a stranger with a bearer
link), and Basecamp's *Portal service* — so a search for the bare word finds all
four. Say *Portal, the search stressor* where the sentence could be read as any of
the others.

Kagi rents most of what it searches — Google, Bing, Brave, Marginalia, plus two
small indexes of its own — and sells the merge: dedupe, rerank, and a user who
can push a domain up, down or out. The crawler is off-thesis for the same reason
Figma's canvas is, so the stressor is the SHELL: accounts, plans, lenses, bangs,
domain rules, a summarizer over fetched pages, and one hot read path that fans
out to rented providers. A week to a personal engine, a month to one a friend
pays for; the running cost is per-query provider spend, which is the whole reason
Kagi charges.

**V1 is a terminal.** `cli/` is a surface (Invariant 3) and `FJS-D38` says a
`.mesa` file is every interface, so the first build is lynx-shaped: a query, a
numbered result list, a key to open one, a key to push its domain up or down.
That is the terminal backend's first real app rather than a demo, and it puts the
read path under test before a single web page exists. `web/` is the second
surface over the same schema, not the first.

What it breaks, in the order a build meets them:

- **Hedged fan-out.** Ask five providers, take whoever answers inside a
  deadline, cancel the rest, return anyway. Conduit declares a policy per target;
  whether it has any *first N of M* shape is a claim to probe, not one this file
  makes.
- **Progressive results.** The page must paint provider one while provider three
  is still out. A service returns one envelope. Whether partials can stream over
  the WS to a live store is the CI runner's log-streaming question in its
  consumer-facing form, and it is unanswered here.
- **A write that must never be recorded.** Kagi's pitch is zero query logging.
  This framework announces every write and audits it. `compliance-from-the-seed`
  covers *forget later*; this is *never know*, the inverse seam, and it has no
  declaration.
- **Read-time personalization.** Domain rules reshape another system's results
  per user at read time. Not a gate, not a row policy, not a `@`-attribute — a
  transform layer nothing here names.
- **A cache that belongs to no tenant.** The cached result for a query is not
  tenant data. Every cache here assumes it is.

**Trusted sources — the part Kagi does not have.** A friend graph on the account,
and a lens is something a friend can be trusted FOR. Joe knows golf and keeps ten
ranked sites for club reviews; a query of mine for *best golf clubs* sees the
edge and folds his ranking into my results. Bob's cooking lens never touches my
kitchen searches because the trust is on the topic, not the person, and for
cooking the edge points at Rachel. That is:

- A relation between two users of the same app that is neither tenancy nor a
  role — `permission-sets.md`'s question from the other side, where the grant is
  *read my ranking* and it is scoped by a topic the schema did not know in
  advance.
- A read whose result depends on a second principal's data, applied under the
  first principal's gate. `db.$readAs` reads one row as one principal; this
  merges two principals' preferences into one answer and the audit trail must
  say whose.
- Topic matching: *best golf clubs* → Joe's golf lens is a classification, and
  where that runs — a keyword table Joe named, or a model call — decides whether
  the feature is a schema question or an AI battery question. Start with the
  table; the model call is the upgrade, not the v1.

Picturable, gradable (one query, merged results, under a second, a friend's site
in the top ten when the topic matches and absent when it does not), and the
deliverable is filed ids for the five seams above. Ranked below Connecteam because
nothing here forces a made ruling, and above the runner because it reaches the
same streaming seam through a page a person types into.

### 8. CI runner — and the one measured detail worth carrying

Caravan has `cancel(id)`, and `packages/caravan/src/db.ts` says what it does with
precision: it allows cancelling a pending **or** running job, and *a running job
still completes its attempt*. That is right for a queue of ordinary work and it is
not what a build cancel button means. So this exercise names a real question —
**does anything here own interrupting work already in flight**, and if not, is that
Caravan's problem or the app's? Pair it with log streaming, which is
`chat-surface.md` § Part 1 paying for itself a second time, and with secrets at
rest, already named as unowned.

### 12. Status page — the one that fits in a week

Cron precision (measured-correct and untested under DST), the `site/` prerendered
surface, an incident as `@@transitions`, notification fan-out. Small enough to
finish, and it exercises four realms with no new framework concept. The right
exercise for someone with a week rather than a month.

### 13. JazzHR — the one that has to forget

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

### 14. remnant — the half of a real app that maid.tech does not have

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

**The data release, measured (remnant Q2, 2026-09-28; `fjs-prototypes/remnant/PLAN.md`
Phase 4).** Corpus v2 is 40 corrected glosses, 3 John 1:14 split in two, and two
verses v1 lost, restored. That is 86 changes, each naming the value it expects to
find. Applied as the system in one transaction it took 42 ms on the full corpus.
930 reads over HTTP during it each saw all of v1 or all of v2. A second run is a
12 ms no-op, and one drifted row refuses the whole release. What ships it is the
app's own `db:migrate` script, `migrate apply && bun db/corpus/release.ts`, because
**`fli deploy` has no data step**: the image's only command before it serves is
`db:migrate && start`, and a swap stops the old container first (read, not run),
so under a deploy the release does not run beside live reads at all. The migration history
cannot hold it. A `.sql` data migration works on a database already holding the
corpus, then fails a fresh one, where the history never created the rows it
corrects, and blocks every migration after it. A `.js` one crashes the CLI
([FJS-1472](../ISSUES_ARCHIVE.md#fjs-1472)), and by design stops `migrate create` for
good ([FJS-1474](../ISSUES.md#fjs-1474), which wants a ruling). An `UPDATE` that
moves a natural key commits its orphans ([FJS-1473](../ISSUES_ARCHIVE.md#fjs-1473)).
**`FJS-D164` does not stretch, and no second record is owed.** One question
separates the two: was the old value true in its day? A price that changed was,
so it gets a window, and the consumer names the version. A gloss that was wrong
never was, so it is replaced in place, and the consumer (a study note) names the
row by its natural key. What neither can say is the split: a note on 3 John 1:14
about the greeting that v2 moved to 1:15 is not refused, not dangling and not
re-pointed. It stays on 1:14 and silently means half. Only its author knows which
half it meant, so the release owns recording what split and the app owns telling
the author; nothing enforces it today. The `9` on delete turned out right rather
than a problem: a release that must remove a verse a note names should not
delete it. This is one caller, so a data step in `fli deploy` is not owed yet;
a second app chaining a release into `db:migrate` would be the measurement.

### 15. Ghost — the public half of the status page, taken seriously

*Added 2026-09-27. Nothing is built, nothing measured, and the rank is only where
it was appended.*

**Most of it is the status page (#12) and Notion (#4) at once**, so it earns a slot
only for what neither reaches:

- **A write that must reach a prerendered page.** Publishing a post has to rebuild
  its page, the index, the tag pages, the RSS feed and the sitemap. The `site/`
  surface is prerendered at build time; nothing here names *which* pages a row
  feeds, so the honest answer today is a full rebuild per publish. Measure it at
  1,000 posts.
- **A transition at a future instant.** *Publish at 9am Tuesday* is a
  `draft → scheduled → published` `@@transitions` edge whose trigger is a clock,
  not a caller. Whether that is a Caravan job the app writes by hand or something
  the schema can declare is unruled.
- **A stranger who writes.** Anonymous comments held for moderation: a row with no
  principal, a gate that lets the author see their own pending comment and no one
  else, and a spam refusal before the write lands. `bearer-access.md` is the
  nearest record.
- **A slug that must outlive itself.** Renaming a post keeps the old URL
  answering with a redirect, forever. That is a history table nobody reads except
  the router.

Members-only posts and paid newsletters are Etsy's money question (#11) and add
nothing here; leave them out.

---

### 16. ksite — the static half, from a real client template

*Added 2026-09-28, from a read of `~/code/KOBAMI/SITES/ksite` (v0.5.0). A live
port: ksite is the template every Kobami client marketing site is cut from, and
it is moving onto FJS. Nothing is built yet.*

**What it is.** A markdown-first SSG on the old line: Svelte 5 + Routify 3 +
mdsvex + UnoCSS, prerendered by spank. `site/content/` is the client
(90 `.md` files: `pages/`, `blocks/`, `collections/` of faqs, reviews,
services, team, `menus/`, `settings/site.md` merged into every page, a
`theme.json` + `theme.scss`); `site/src/` is the engine (75 blocks). A page is
mostly `<Hero />` `<Trust />` `<Process />` with no import — the remark
processor resolves each name page-local → `content/blocks/*.md` →
`content/blocks/*.svelte` → `src/blocks/*.svelte`. One server file:
`functions/api/event.js`, a Cloudflare Pages proxy for Plausible. Proof today
is Playwright screenshot baselines per route in `tests/`.

**What it breaks first is authoring, not data.** No schema, no API — the
first FJS app with an empty `db/`, and the question is whether Sierra's
`static` target plus Mesa can hold a site whose author writes Markdown and
never a component:

- **Markdown as a page.** Does a `.md` route with embedded `<Component />`
  belong to Sierra's route table, and who resolves an unimported name — a
  four-level lookup is a resolver, and Invariant 2's lesson is that resolvers
  must agree.
- **Collections without a database.** `content/collections/*` is typed
  content read at build time. Is it a Litestone model over a file driver
  (`jsonl` exists), a Resource with no Service, or neither — and does
  prerender read it the way a live page would.
- **Theme as color tokens.** `theme.json` hands UnoCSS colors;
  Invariant 13 says tone and treatment. Mapping one client's theme onto
  `@frontierjs/css` is the measurement, and the UnoCSS layer is the app's
  opt-in, never the framework's.
- **The edges a static host owns**: `_redirects`, sitemap, `robots.txt`,
  `llms.txt`, JSON-LD, the per-page draft/omit directives
  (`routify:meta omit="production"`), and the analytics proxy — which of these
  Sierra's postbuild/deploy already has and which it lacks.
- **Upgrade story.** ksite ships to clients as a copied framework
  (`fli site:update`, `[ACTION]` lines in its `CHANGELOG.md`). FJS-D33 says a
  config is a dependency, never a copy; a client site is the test of that.

**Gradable** by the baselines it already has: the ported site must match
ksite's own Playwright screenshots route for route. Port in
`fjs-prototypes/ksite`, questions in its `PLAN.md` as below.

---

### 17. Immich — the only stressor whose first break is bytes

*Added 2026-09-29. Nothing is built; the rank is only where it was appended, and
it would sit nearer #5.* ([immich-app/immich](https://github.com/immich-app/immich))

Every other entry breaks on a row. This one breaks on the file the row points
at:

- **An upload larger than the process.** `readValue` in
  `packages/litestone/src/plugins/file.js` turns every `File` or `Blob` into
  one `Uint8Array` through `arrayBuffer()` before the provider sees it, so a
  4 GB phone video is 4 GB of heap per concurrent upload. Nothing streams to
  the provider, and there is no chunked or resumable upload. A phone on a
  train needs both.
- **One write, many derived files.** Each asset produces a thumbnail, a
  preview, a transcode for video, and its EXIF read into columns. That is
  `overview.md` 2.7 (media processing, still `idea`) with a product attached.
  It asks Caravan for a pipeline of dependent jobs per row, a retry of one
  stage without the others, and a rerun over the whole library when the
  thumbnail size changes — which looks like a backfill (`FJS-D157`) but is a
  cursor over files, not over one table.
- **Identity by content.** The phone sends a checksum, and the server answers
  *already have it* before a byte moves. `file.js` computes no hash, and
  nothing in `.lite` declares that two rows with the same bytes are the same
  asset.
- **Sync from a device.** The app's whole job is *send what the server lacks*,
  which is `offline-first-and-release.md` (all absent) and `FJS-D38` (Mesa on
  a phone), reached from the least forgiving direction: the device is the
  source of truth and the server catches up.
- **A share link with a password and an expiry.** An album a stranger opens
  from a URL is `bearer-access.md`, and a partner who sees your whole library
  is Notion's per-object sharing (#4) from a second product.
- **A timestamp with no zone.** EXIF `DateTimeOriginal` is wall-clock, and its
  offset field is often missing. That is an instant nobody can place —
  `FJS-D143` from a direction Calendly never reached, because Calendly always
  knows the zone.

**Cleared before starting:** seeking in a video needs byte ranges, and
`packages/junction/src/transport/static.ts` already serves them (`serveRange`)
for the local provider.

**Leave out the machine-learning half** — smart search, face clustering, the
Python service. It stresses a runtime this framework does not claim, and the
vector column it would feed is already built (`FJS-D328`). If a later phase
wants it, the model is an attached service (`FJS-D158`) and only the seam is
graded.

**Gradable** from a phone, or from a script that acts like one: back up 10,000
photos and a few multi-gigabyte videos, cut the connection halfway through,
resume, and assert that no asset was stored twice, every derived file exists,
and the API's memory stayed flat throughout.

---

### 18. EventMark — a schedule whose record is a text file

*Added 2026-09-29, from a read of `EventMark.jsx`: one React file, a port of an
earlier Svelte prototype (Schedown), kept outside the tree. Nothing is built. The
rank only reflects when it was appended, and most of its surface is Connecteam's
(#2).*

**What it is.** A Markdown-flavored DSL. YAML frontmatter declares `people`,
`attendees` and `locations` by key. Then `# Monday, 8/25` is a day,
`## Location: gym` an event, `@time`, `@ratio 1:4` and `@attendees liam, nora`
annotate it, `### Shift 1 (09:00-12:00)` is a shift, and `- sam` a person on it.
A day/week/month screen drags people from a roster onto shifts, and **every drag
re-serializes the whole document** into the editor beside it. Two samples ship
with it: a volunteer drive, and a daycare whose rooms carry staff-to-child ratios.

Shifts, people and places are #2's questions and are not re-run here. It earns a
slot for these:

- **The text is the record and the screen writes back into it.** The parser drops
  any line it does not match, and `toEventMark` writes back only what was parsed.
  So a comment or an unrecognized line typed into the editor is gone after the
  first drag. In FJS the record is a row, which leaves three shapes: a `Schedule`
  with one text column, where the gate, validation and audit see a blob; a model
  tree `Schedule → Day → Event → Shift → Assignment` with the document as an
  export, where hand-editing the text becomes an import that diffs against rows;
  or both, which is two origins. `PHILOSOPHY.md` § III says *everything is a
  projection*. **Is a text file a projection of rows that may write back?**
  ksite (#16) reads Markdown at build time and never writes it, so this is the
  reverse direction. `kernel-and-projections.md` is the nearest record.
- **A constraint over a count, broken from either side.** `@ratio 1:4` compares
  one shift's staff to the room's enrollment. The prototype shows it as a badge.
  In a licensed daycare, a room below ratio is a violation someone has to answer
  for, and two different writes cause it: removing an adult from a shift, or
  enrolling a ninth toddler. `@@check` cannot see another row, and `@@exclude`
  (`FJS-D474`) is about overlap, not counts. Whether this is a declaration, a
  refusal on both writes, or a validation `warn` is unruled. That is the sharpest
  question here, and it needs no screen.
- **A double-booking the prototype does not see.** In the outreach sample, `kris`
  is on the gym's Shift 1 (09:00–12:00) and on the pool's Morning Outreach
  (09:00–10:30) on the same day. That makes it a caller for `@@exclude(person, …)`,
  whose write path is `FJS-1528` (still open). The daycare sample has `mr_theo`
  ending one room at 12:00 and starting the other at 12:00, which tests the
  half-open boundary. Its ranges are wall-clock strings hung on a free-text day
  label.
- **A reference that may dangle.** `- sam` names a frontmatter key, and an
  unknown key is accepted and shown raw. `addPerson` mints the key from the
  display name, unique only within one schedule. So this is a natural key scoped
  to a parent, and a relation whose target may not exist yet, which is the
  opposite of a foreign key. remnant (#14) has natural keys but never a dangling
  one.
- **A date nobody wrote down.** A day is a label. It is resolved best-effort,
  with the year borrowed from `start_date`, and one it cannot read falls out of
  the month grid. The outreach sample has `Monday, 8/25` and `Tues, 8/25`: two
  days on one date (the 26th was the Tuesday), and nothing notices. The times
  have no zone by design, because a schedule is one site. That is `FJS-D143`
  with the zone authored as absent. Immich's (#17) zone is merely missing.
- **Drag from a roster that keeps its item.** `packages/ui/dnd.js`'s `dndzone`
  moves an item between flow lists: a drop finalizes the origin too. Its header
  says flex-wrap layouts are not built. Both chip rows here are flex-wrap, and
  the roster copies rather than moves. The typed zones, where staff land on a
  shift and children in a room, are what `type` already partitions.
- **A whole app in the tab.** The prototype has no server, just local state and
  a clipboard. `FJS-D305` puts Litestone in a browser worker over OPFS. This is
  the smallest product whose Data realm might never leave the tab, with the
  Markdown file as its export. It mirrors ksite's empty `db/` with an empty
  `api/`.

**Leave out** the hand-rolled YAML subset (use a real parser), and the
role-to-Tailwind-color map, which is ksite's theme question (#16) again.

**Gradable** from the two samples as fixtures, driven in a browser:
`parse(serialize(doc))` is identity, and a hand-typed comment survives a drag or
its loss is refused out loud. `kris`'s overlap is refused. `mr_theo`'s adjacent
shifts are not. Dropping the toddler room to one adult flips it under ratio, and
so does enrolling the ninth child. `Tues, 8/25` is flagged.

---

### 19. Vaultwarden — the server that is not allowed to know

*Added 2026-09-29. Nothing is built; the rank is only where it was appended.*
([dani-garcia/vaultwarden](https://github.com/dani-garcia/vaultwarden))

Vaultwarden is a small reimplementation of the Bitwarden server, and SQLite is its
default. Every other entry assumes the server can read its own rows. This one
assumes it cannot:

- **Ciphertext the server cannot open.** Every name, username, password, note and
  TOTP secret arrives already encrypted as an `EncString` (`2.<iv>|<ct>|<mac>`),
  under a key the server never holds. `@encrypted` is the opposite arrangement:
  Litestone holds the key and decrypts on read. So a vault item is a row whose
  fields are opaque strings to every gate, validator, search and audit entry.
  Invariant 7's redaction has nothing to redact. Two questions follow. Can `.lite`
  declare *client-sealed*, as distinct from *server-encrypted*, and have the
  framework refuse to index, sort or `@@fts` it? And what is left for a gate to
  decide once it can only read the envelope: owner, folder, org, revision date?
- **An API someone else already specified.** The clients are Bitwarden's: the
  browser extension, the phone apps, the CLI. They expect `/identity/connect/token`
  with an OAuth2 password grant, `/api/sync` returning the whole vault in one
  shape, and their own error JSON. None of it is Junction's result envelope
  (Invariant 4), `$`-directives (Invariant 10) or the `/auth/*` routes. Either the
  whole surface is raw routes, which leaves services with nothing to do, or a
  service can declare that it speaks another protocol's wire format. **Is a
  foreign wire format a transport, a plugin, or out of scope?** Nothing else on
  this list asks it, because every other stressor owns its client.
- **Login where the server never sees the password.** `prelogin` returns the
  user's KDF parameters (PBKDF2 or Argon2id, with an iteration count), the client
  derives a master key, and the server receives only a hash of a hash. That hash
  goes through `auth`'s own hash, and the second factor is TOTP, which
  `packages/auth/totp.ts` already has. Passkeys are still open in `auth`'s
  `PROJECT_STATE.md`. So the stress here is per-user KDF settings on the user
  model and a login that is not `/auth/login`. The crypto is not the hard part.
- **A membership that is not usable until a second client acts.** An org's
  symmetric key is wrapped once per member with that member's public key. A new
  member is *invited*, then *accepted*, then *confirmed*. Confirmation happens
  when an admin's client, not the server, wraps the org key for them. That is
  `@@transitions` where one step needs something only a client can produce and
  the server can only check it arrived. Collections then give per-item sharing
  inside an org, which is Notion's (#4) ladder question again, from a vault.
- **Rotation is one write that must name everything.** Rotating the account key
  re-encrypts every cipher, folder and send on the client and posts them in one
  request. The server must replace all of them atomically and **refuse the
  request if any cipher is missing**, or the vault ends up half under a key
  nobody has. No shape here declares that a batch must cover a set completely.
- **A grant that takes effect unless refused.** Emergency access gives a trusted
  contact the vault after N days of waiting, unless the grantor rejects it in
  that time. That is Ghost's (#15) future-instant transition, with the default
  inverted: silence approves.
- **A share that counts its own opens.** A Send is a link with an expiry, a
  deletion date, an optional password and a maximum access count. The count
  means every open is a write, and the last one must be refused under
  concurrency. That is `bearer-access.md` with a budget attached.
- **The server fetches a URL a user chose.** The icon service fetches favicons
  for whatever domains the vault names, and it has to refuse private and
  link-local addresses, because otherwise it is an SSRF probe into the host's
  network. Conduit's targets are declared; this one is typed into a form.
  `untrusted-bytes.md` covers the bytes but not the fetch.
- **Sync is a push over someone else's socket.** Clients subscribe to
  `/notifications/hub` using SignalR framing, sometimes MessagePack. Junction's
  channels have their own protocol, so this is the foreign-wire question again,
  on WebSocket.

**Leave out** the admin panel, which is `sysadmin-console.md`'s, and SSO, which is
`third-party-credentials.md`'s. Also leave out MySQL and Postgres: Vaultwarden
supports them, and Litestone does not claim them.

**Gradable** with the real clients and no custom UI. Point the official Bitwarden
CLI (`bw config server …`) at the app and script this: register, log in with
TOTP, create 1,000 items, sync from a second session, share one into an org and
confirm a second member, rotate the key, and assert every item still decrypts. A
rotation with one cipher missing is refused and changes nothing. A Send with
`maxAccessCount: 1` opens exactly once under ten concurrent requests. An icon
request for `169.254.169.254` is refused. The database file is grepped for a
known plaintext password and it is not there.

---

### 20. Dragonfly — the first stressor whose first break is the UI realm

*Added 2026-10-01, from a read of `~/code/Z/json.maverickmade.tech` (codename
jsonfire): a Svelte 4 app, about 3,700 lines across seven components and six
stores, plus a 3,061-line `App-single.svelte` it was split out of. Three commits,
February 2026. `fjs-prototypes/dragonfly/dragonfly-json-editor.jsx` is a React
copy of its `Editor.svelte` and nothing more. Nothing is built. The rank only
reflects when it was appended.*

**What it is.** jsongrid.com taken further. A JSON array is typed on the left
and shown as a grid on the right, and both sides edit it. A nested object or
array in a cell opens in place as a key/value table, or as a sub-grid when it
is an array of objects. Around that sits a lot of tooling:

- sort, a global search, and a per-column filter written in a small DSL
  (`>N`, `N..M`, `^start`, `/re/`, `[a,b]`, `!` negates);
- frozen, hidden, resized and drag-reordered columns, and a stats row;
- conditional formatting rules, an inferred per-column schema with violations
  highlighted, and a flatten that works as a view or as a rewrite;
- row selection with bulk delete, duplicate, export and set-value;
- a user-written JS transform over the rows, find and replace, and a command
  palette;
- sessions in `localStorage`, and the whole state shareable as a base64 `#s=`
  URL.

Every other stressor breaks in Data or API first. This one has an empty `db/`
and an empty `api/`, so everything it tests is Mesa's runtime and
`@frontierjs/ui`. That is why it earns a slot. It is not the IDE that *Not on
this list* rules out: it is DOM, a table and a text box, which is the runtime
this framework claims. The kit already has many of its parts:

- `Json.mesa`: tree and raw modes, diff, search, edit, undo, and a
  `role="treegrid"` keyboard;
- `JsonInput.mesa`'s buffer rule;
- `Table.mesa`, `CommandPalette.mesa`, and `{#virtual each}`;
- `toolbelt/json`, `toolbelt/glow` (the same lineage as its `glow.js`), and
  `toolbelt/search`.

The question is whether those parts make this app, or whether it has to be
built beside them.

- **The text is the record, and a cell edit rewrites all of it.** `jsonText` is
  the source and `parsed` is derived from it. A cell edit goes the other way
  through `syncToText()`, which re-serializes the whole document at two-space
  indent. A condensed document comes back pretty-printed. **Every row's keys are
  also reordered to the column order**, so one edit changes every line of the
  file. Splicing the text at the cell's source range instead needs a parser
  that reports positions. `toolbelt/json`'s `tryParse` reports an error
  position, never a value's range. **Is the text a projection of the document,
  or the record?** That is EventMark's question (#18), asked at keystroke rate.
- **Two history policies on one stack.** A keystroke in the text pushes a
  snapshot after 600 ms of quiet. A keystroke in a cell calls `updateCell` on
  `input`, which re-serializes and pushes at once, so typing `Austin` into a
  cell is six undo steps. The stack holds texts. `Json.mesa`'s holds documents
  compared by value. Which one owns ⌘Z when both views are open?
- **A derived graph over the whole document, re-run on every keystroke.** One
  keystroke in the text re-parses it, re-merges the key set, and re-highlights
  all of it into `{@html}`. It then walks this chain: `parsed` → `sortedRows` →
  `visibleRows` → `gridRows` → `txRows` → `schemaViolations` →
  `schemaViolationMap` → `violationCount`, with `colStats` and `cfStyles` off
  `txRows`. Each stage is O(rows × columns), and `txRows` is set from a
  module-level `subscribe` rather than derived. The nested editors deep-clone
  the whole document per keystroke (`JSON.parse(JSON.stringify($p))`), so every
  row gets a new identity. The grid is an index-keyed `{#each}` with no
  windowing. **This is the measurement Mesa's signals exist for.** Does a
  cell edit in a 10,000-row document touch one row's DOM, and does a keystroke
  in the text re-derive only what changed? Copy-on-write through `setIn` shares
  untouched rows, and a `MutationObserver` can count the rest.
- **Identity for rows that have none.** Selection, open cells
  (`expandedKeys`, `${ri}::${col}`), raw-edit buffers, formatting and violation
  maps are all keyed by array index. Deleting row 0 moves every open cell and
  every selected row onto its neighbor. Sort and filter carry the index along
  correctly, but insert and delete do not. FJS rows have a primary key. The
  question is what keys a list whose data has no id, and `eachDefaultKey` is
  the index.
- **A second condition language, three times.** The column-filter DSL,
  conditional formatting (which reuses it) and the inferred schema
  (`string`/`number`/`boolean`, `required`) are each a way of saying *which
  values are acceptable*. FJS already has two owners for that:
  `toolbelt/predicate` is the `.lite` expression grammar (`FJS-D271`, *one
  grammar*), and `toolbelt/query` owns what a filter value means
  (Invariant 10). The port either spells these in that grammar or is the case
  for a terse column dialect that compiles to it. *Infer schema from data* is
  also `litestone import`'s problem on a JSON array, and its answer could be a
  `.lite` model.
- **Views that are writes, and writes that are views.** Sort is view-only and
  keeps the source index. Flatten has both forms: `viewFlat` changes the view,
  and `toggleFlatten` rewrites the document while holding the original aside.
  The JS transform is view-only, but bulk set-value writes, and it accepts an
  arrow function that is `new Function`'d. The kit has no move operation
  (`Json.mesa` says so), and column drag-reorder is a write here. Each gesture
  needs a stated side.
- **A share link runs code it carries.** `captureState()` puts `transformCode`
  and `transformActive` in the `#s=` hash. `initFromUrl()` → `applyState()` →
  `applyTransform()` then compiles and runs it as soon as the page opens. So a
  link someone sends you runs their JavaScript in your session. That is an
  app bug and needs no ruling. The FJS-side question is narrower: what does a
  static Sierra page do with state that arrives in a URL, and is a transform a
  thing that may arrive that way at all (`static-safety.md`).
- **Colors where tones belong.** `CF_PRESETS` and the schema highlights are
  hex pairs, and conditional formatting gives people a color picker.
  Invariant 13 says a tone and a treatment. Is a user-chosen highlight a
  tone, or the one place a literal color is the data? This is ksite's theme
  question (#16) with the user as the author.

**Leave out** the React file, which is one component of this app. Leave out
the Tauri wiring as well: `@tauri-apps/*` is in `package.json` but there is no
`src-tauri/`. A desktop build would be FJS's `desktop/` surface, and it is a
later question. Leave out persistence beyond what exists: if sessions move off
`localStorage`, that is `FJS-D305`'s Litestone in a worker over OPFS, the same
whole-app-in-the-tab shape as #18.

**Gradable** in a browser, against the app's own three-row sample, a generated
10,000 × 20 array, and a document nested four levels deep:

- A cell edit changes only that row's lines in the text, and a
  `MutationObserver` sees one row change in the grid.
- Typing a word into a cell is one undo step.
- Text that does not parse leaves the grid on the last good document and
  reports the error's line.
- Deleting row 0 leaves the open cells and the selection on the same records.
- One keystroke in the 5 MB fixture stays inside a frame.
- The ported filter `>80` and the `.lite` expression `score > 80` select the
  same rows.
- A shared link carrying a transform does not run it until the person
  viewing it asks.

Port in `fjs-prototypes/dragonfly`, with questions in its `PLAN.md`, as below.

### 21. Transit — the data layer, built as a product

*Added 2026-10-03. The feature list, with the owner's V1 verdicts on every row,
is `data-layer-v1.md`; this entry does not repeat it. Nothing is built. The rank
only reflects when it was appended.*

**What it is.** Pull data in from outside, normalize it, and report on it with
`.mesa` templates — on screen, as a PDF, or emailed on a schedule, each
recipient's copy at that recipient's own standing. Evidence's report-as-a-file
plus Metabase's subscriptions, with the gate running through every stage.

**What it breaks first.** Every other stressor's data starts inside the app.
Transit's starts outside, so it breaks at the boundary nothing owns yet: a
source's `.lite` held in a row and built into a database on the fly, a
cursor and pagination across a conduit target, the rejects table where
coercion fails. Then the render path: one template to three outputs, and a
headless Chromium that must stay severable. Then the send: a query run under
`app.runAs` per recipient, which no scheduled job has done before.

**Not PostHog (#9).** That one breaks on write rate and a query a tenant wrote;
Transit breaks on intake, render and send. They share
`analytics-and-warehouse.md` and nothing else.

**Where this one departs from the list's rule.** The rule says a half-built
product is not kept in the tree. Transit is not: its code stays in
`fjs-prototypes/transit` and is never committed here, and every fix it needs
lands in FJS. After V1, the likely next step is a vertical slice, as `orion` is
for automations, built into `example` and `basecamp`. That slice is the design
record, not a copy of the product.

Build in `fjs-prototypes/transit`, with questions in its `PLAN.md`, as below.

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
was worth having. **The register is worked through `fli`, run from inside the
framework tree** — from the app it finds no register: `fli find <terms>` answers *is it filed already* with ids
and titles, `fli amend <id> --detail "…"` adds a second sighting to the row
that names it, and `fli file --sev S3 --area <pkg> --title "…" --detail "…"`
files what is new — each takes the next id, the table and the date itself.
Measured over the first seven stressors: 712 calls and 1.35M characters of
output went to reading and patching `ISSUES.md` by hand (`FJS-1546`). A fix
lands in the framework tree with a drive in `example/`;
**the stressor itself proves nothing**, because nothing here runs it.

**Write each question in `PLAN.md` as `### Qn — <question>` with a
`**Status: …**` line under it, and name the ids its answer produced.** The
questions are worth collecting across runs (`stressor-questions.md`), and that
shape is what lets a reader extract them without keeping a second copy.

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
