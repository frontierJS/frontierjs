---
id: data-layer-v1
status: proposed
dated: 2026-10-03
---

# Idea — The data layer's V1: every feature the field has, and which ones it keeps

**Status: PROPOSED. Nothing here is built.** Dated 2026-10-03. The prior art was
read from each tool's own docs and changelogs; the *FJS today* column was read off
`IDEAS/` and package docs and was not run. Do not cite this file as behavior — see
`VERIFYING.md`.

---

## Trigger

[`FJS-D228`](../DECISIONS.md#fjs-d228) ruled that FrontierJS owns the data layer, and
`analytics-and-warehouse.md` phased it so that ingest from foreign sources waited
*until something strains*. **This file takes the other position: the data layer is
built as a product of its own**, so data arriving from outside is in V1. That is
the source's phase 3 overturned. Its bound still holds: *analytics for the app,
not an enterprise data warehouse.*

The product has three jobs: **pull data in, normalize it, and report on it** with
`.mesa` templates. A report is either dynamic, viewed in the UI, or static, emailed
or printed as a PDF.

**The 80/20 rule:** V1 is one complete, solid path through the stages below, and
nothing beside it. Every feature the field offers is listed, so a cut is a
decision someone made rather than something nobody thought of.

---

## How to read the tables

One table per stage, in the order data moves: **Intake → Land → Transform →
Semantic → Query → View → Render → Send**, then the concerns that cross every
stage. The IDs are stable, so a build plan can cite them.

- **FJS today** — ✅ exists · ◐ partial, or proposed in another file · ✗ nothing.
  ★ marks the features where the gate, tenancy or `$readAs` already running
  through every stage puts FJS ahead of the field.
- **V1** — **Keep** · **Simpler**, which builds a smaller version (named in the
  cell) in place of the field's version · **V2** · **Cut**, with the reason.

**The hardest items, hardest first:** I8, L10, Q1, S1+S2, I1/I2 as a catalog,
S6+Q7, V9, V4, T4/T5, deletes under incremental sync (L6), L3. Every one of them is
cut, deferred or done the simpler way.

---

## 1. Intake — connect and extract

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| I1 | Connector spec: each source declares its auth and config | Airbyte spec, Singer tap | ◐ conduit, outbound only | **Simpler** — a small protocol (config schema, `streams()`, `read(cursor)` as an async iterator), not a catalog |
| I2 | Discovery: a source lists its streams and their schemas | Singer catalog, Airbyte discover | ✗ | **Simpler** — folded into I1's `streams()` |
| I3 | Incremental sync with a saved cursor | Singer STATE, dlt incremental | ✗ (caravan's resumable batch is close) | **Keep** — one cursor column per stream |
| I4 | Sync modes: full replace / incremental append / incremental dedupe | Airbyte | ✗ | **Simpler** — two modes: full replace, or incremental upsert on a key |
| I5 | Declarative REST source: pagination, auth and rate limit as config | dlt `rest_api`, Airbyte low-code | ✗ (conduit's per-target policy covers retries and timeouts) | **Keep** |
| I6 | File intake: CSV, JSON, XLSX, folder globs | Sling, Rill, DuckDB `read_*` | ◐ `bulk-data.md` | **Keep** — CSV and JSON |
| I7 | Push intake: webhooks, event capture | Segment, PostHog | ◐ `inbound-integrations.md` | **V2** |
| I8 | Change data capture from a foreign database | Debezium | ✗ · ✅★ the app's own writes: `$tapEvents` | **Cut** — every engine's log differs, plus ordering and replay; a product of its own |
| I9 | Query in place without copying | Steampipe, DuckDB `ATTACH` | ◐ [`FJS-D248`](../DECISIONS.md#fjs-d248) allows read-only `ATTACH` | **V2** |
| I10 | Scheduled syncs with retry and backfill | Airbyte, Dagster | ✅ caravan cron and idempotency | **Keep** |
| — | SQL pull from another database | Sling | ✗ | **Keep** — the third built-in source, beside file and REST |

**The long tail of vendor connectors is a treadmill.** Each vendor is its own
package ([`FJS-D153`](../DECISIONS.md#fjs-d153)); V1 ships the protocol and three
sources.

## 2. Land and normalize

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| L1 | Infer the schema from the data, at runtime | dlt | ✗ | **Simpler** — generate a draft `.lite` from a sample once; a person reviews and commits it |
| L2 | Schema contract: evolve / freeze / discard, per table or column | dlt | ✗★ maps naturally onto `.lite` | **Simpler** — freeze by default; an unknown column lands in a JSON overflow column |
| L3 | Nested JSON becomes child tables with a parent key | dlt, Fivetran | ✗ | **Simpler** — nested data stays in a `Json` column; a `view` flattens it |
| L4 | Type coercion and naming normalization | dlt naming conventions | ◐ `coerceToSchema` | **Keep** |
| L5 | A raw landing zone kept apart from cleaned data | dbt sources | ◐ `@@external`, `database` blocks | **Keep** — one landing table per stream |
| L6 | Sync bookkeeping columns | Fivetran, dlt | ✗ | **Simpler** — `_syncedAt` and `_loadId`; deletes are caught by a full replace only, because a cursor never sees a deleted row |
| L7 | Merge or dedupe on the primary key | dlt merge | ◐ | **Keep** |
| L8 | Data tests: not null, unique, accepted values | dbt tests, Soda | ◐ `@@check` and constraints | **Keep**, plus **a rejects table** — a row that fails coercion is set aside and the load goes on |
| L9 | Tag or mask personal data as it lands | Fivetran column hashing | ✅★ `@encrypted` / `@guarded` / `@secret` | **Keep** |
| L10 | Identity resolution across sources | Segment Unify | ✗ | **Cut** — fuzzy matching, merge and unmerge; sold as a product of its own |

## 3. Transform and model

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| T1 | Layered models: staging → intermediate → marts | dbt | ◐ `view` exists, with no convention | **Keep** — as a convention |
| T2 | Materialization strategies | dbt | ✅ `@@materialized`, `@@refreshOn`, [`FJS-D245`](../DECISIONS.md#fjs-d245) | **Keep** |
| T3 | Refresh views in dependency order | dbt `ref()` | ◐ dependent views are dropped and recreated on migration | **Keep** |
| T4 | Column-level lineage | SQLMesh | ✗ | **Cut** — needs a SQL parser |
| T5 | Preview a change and apply it as a plan, in a virtual environment | SQLMesh | ◐ the migration differ | **Cut** |
| T6 | History snapshots (slowly changing dimensions, type 2) | dbt snapshots | ◐ the audit trail, `time-travel.md` | **V2** |
| T7 | Facts and dimensions | Kimball | — | **Cut** — a docs convention, not a feature |
| T8 | One activity-stream table | Narrator Activity Schema | ◐ the audit trail, `$tapEvents` | **V2** |
| T9 | Rollup columns that can be filtered and sorted | — (dbt has no equivalent) | ✅★ `@derived` / `@from` | **Keep** |
| T10 | Time-series rollups | — | ◐ `metric-store.md` | **V2** |
| T11 | One expression language, compiled to SQL or evaluated in JS | — | ✅★ `compileSql` / `evalJs` | **Keep** |

## 4. Semantic layer

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| S1 | Measures and dimensions declared once | Malloy, LookML, Cube, Rill | ✗ | **V2** — a report queries views with `aggregate`/`groupBy`, and shared logic lives in the view |
| S2 | Joins declared once, with aggregates that do not double-count | Malloy, Looker | ◐ relations exist | **Cut** — the hard core of LookML and Malloy |
| S3 | Time dimension with grains and a timezone | Cube, Rill | ✗ | **Simpler** — a date-bucketing directive (day / week / month, zoned), not a layer |
| S4 | Derived ratios, period-over-period comparison | Rill, MetricFlow | ✗ | **V2** |
| S5 | Row-level security in the metric layer | Cube, Lightdash | ✅★ the gate | **Keep** |
| S6 | Pre-aggregations, cached rollups | Cube | ◐ `@@materialized` | **Cut** — it is cache invalidation, and SQLite is fast enough at this scale |
| S7 | Serve the same metrics over REST, SQL and MCP | Cube | ◐ junction and mcp | **Cut** — Junction is the one serving path |
| S8 | Nested queries | Malloy | ✗ | **Cut** |

**Read Malloy and Cube for the language design** when S1 comes up for V2. Neither
is a product to rebuild.

## 5. Query and explore

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| Q1 | Point-and-click builder that saves a structured query | Metabase MBQL, Looker Explore | ◐ `compileSegment` in `example`, the filter bar | **V2** — V1 reports are files, and a viewer changes only their params |
| Q2 | Saved reports kept as rows | Metabase | ✗ | **V2**, with Q1 |
| Q3 | Typed params with defaults, cascading | Metabase filters, Grafana variables, Evidence inputs | ◐ `page.query` / `page.directives` | **Keep** |
| Q4 | SQL editor for end users | Metabase native, Redash | ◐ raw SQL is `asSystem()`-only (`FJS-005`), `scoped-sql.md` | **Cut** — it is the unscoped-read hole |
| Q5 | Drill from an aggregate to its records | Metabase, Looker | ◐ `resource.record` | **Keep** |
| Q6 | Pivot / crosstab | Perspective, Metabase | ✗ | **V2** |
| Q7 | Query result cache | Metabase, Evidence | ✗ | **Cut**, with S6 |
| Q8 | A question in plain language becomes a query | Metabot, Cube MCP, Rill | ◐ `packages/mcp` | **V2** |
| Q9 | Preview a report as a given user | — | ✅★ Studio's *Acting as* ([`FJS-D230`](../DECISIONS.md#fjs-d230)) | **Keep** |

## 6. View — the dynamic UI

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| V1 | A report is a file in git: its query plus its components | Evidence, Observable, Rill | ◐★ the `.mesa` resource shape | **Keep** |
| V2 | Dashboard: cards with shared filters wired to each one | Metabase, Superset | ✗ | **Simpler** — a dashboard is a `.mesa` page composing report components, with shared params from `page.query`; no layout editor |
| V3 | Chart components configured by props | Evidence, Vega-Lite | ✗ | **Keep** — pure SVG, so R5 and R6 need nothing more |
| V4 | Cross-filtering between charts | Superset, Rill | ✗ | **Cut** |
| V5 | Data table: sort, paginate, virtual scroll, column formats | — | ✅ `Table.mesa`, `resource.list()` | **Keep** |
| V6 | Locale formatting: money, percentages, dates | Evidence `fmt` | ◐ `@money`, `datetime-kit.md` | **Keep** |
| V7 | Conditional formatting and thresholds | Metabase | ✗ | **Simpler** — written in the template, not configured |
| V8 | Live-refreshing views | Grafana | ◐★ `live-queries.md` | **V2** |
| V9 | A database engine in the browser, so filtering is instant after load | Evidence (DuckDB-wasm) | ✅★ litestone runs in a browser ([`FJS-D305`](../DECISIONS.md#fjs-d305)) | **V2** — the snapshot shipped to the browser becomes a security boundary: whose standing, and when it expires |
| V10 | Embedding with signed per-tenant tokens | Metabase, Cube | ◐ the `widgets/` surface, `bearer-access.md` | **V2** |

## 7. Render — print, PDF, email

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| R1 | Run the queries at build time and ship a snapshot | Evidence, Observable data loaders | ◐ sierra prerender | **Keep** |
| R2 | One template rendered once per param value | Quarto params, SSRS | ✗ | **Keep** — X5 is built on it |
| R3 | Banded layout: report, page and group headers and footers | Jasper, Crystal, SSRS | ✗ | **Simpler** — mesa components plus R4; a group break is `break-before` |
| R4 | CSS print pagination: `@page`, running headers, page X of Y | Paged.js, Prince, WeasyPrint | ✗ | **Keep** — check whether Chromium's native `@page` margin boxes are enough before adding Paged.js |
| R5 | HTML → PDF engine | Gotenberg (Chromium), WeasyPrint | ◐ a CDP harness, in tests only | **Keep** |
| R6 | Charts rendered on the server as SVG or PNG | Metabase static viz, Vega-Lite | ✗ | **Simpler** — V3's SVG prints as is; Chromium screenshots it to PNG for email, where SVG does not render |
| R7 | Email-safe HTML | MJML | ✅ email-kit, `renderComponent` `target: 'email'` | **Keep** |
| R8 | One source → HTML / PDF / XLSX / DOCX | Quarto, SSRS, Carbone | ◐ the `renderComponent` targets | **Simpler** — HTML, PDF and CSV; no XLSX or DOCX |
| R9 | Templates users can edit | Carbone | ◐ `stored-templates.md` | **Keep, unsafe on purpose** — see below |
| R10 | Branding per tenant | — | ◐ css tones and the theme | **V2** |

**One headless Chromium on the server covers R5, R6 and X4.** That is three
features for one dependency, and its cost is operational: Chromium has to be
installed where the app runs.

## 8. Send — export and deliver

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| X1 | File export with a manifest, at the caller's standing | — | ✅★ `@@export` (CSV, NDJSON) | **Keep** |
| X2 | Streamed HTTP export | — | ✅ `exportPlugin` | **Keep** |
| X3 | Scheduled subscriptions: cron, timezone, recipients, channel | Metabase, Grafana reporting | ◐ caravan cron; no subscription | **Keep** |
| X4 | Attachments: a PDF or CSV, inline chart images | Metabase 63 (July 2026) | ✗ | **Keep** |
| X5 | Each recipient's copy rendered at that recipient's own standing | — (Metabase sends every recipient the same file) | ◐★ `app.runAs`, as webhooks grade an audience ([`FJS-D193`](../DECISIONS.md#fjs-d193)) | **Keep** — this is what makes the product FJS's own rather than a smaller Metabase |
| X6 | Slack and webhook delivery | Metabase | ◐ conduit | **Keep** |
| X7 | Alerts: threshold, goal, results exist | Metabase, Grafana | ◐ the metric-store alert evaluator | **Simpler** — X8: a scheduled report that returns rows only when a threshold is crossed *is* an alert |
| X8 | Skip the send when there is nothing in it | Metabase | ✗ | **Keep** |
| X9 | Reverse ETL: push models into SaaS tools | Census, Hightouch | ◐ conduit | **Cut** |
| X10 | Public link, or a signed URL that expires | Metabase | ◐ `bearer-access.md` | **V2** |
| X11 | Delivery log: who got what, and when | Grafana | ◐ notification records, the audit trail | **Keep** |
| X12 | Parquet to S3 or a lake | dlt destinations | ✗ | **Cut** |

## 9. Across every stage

| # | Feature | Best at | FJS today | V1 |
| --- | --- | --- | --- | --- |
| C1 | Orchestration: retry, idempotency, partitions | Dagster | ✅ caravan | **Keep** |
| C2 | Freshness: last sync, row count, last failure per source | dbt source freshness, Fivetran | ✗ | **Keep** — a stale source is otherwise silent |
| C3 | Catalog and lineage UI | DataHub, dbt docs | ◐ of the schema only: `/api/catalog`, `ws:atlas` | **Cut** |
| C4 | Access governance from intake to send | Cube | ✅★ the gate | **Keep** — the edge |
| C5 | Tenancy carried through every stage | — | ✅★ | **Keep** |
| C6 | Retention, where an aggregate outlives its rows | — | ◐ `compliance-from-the-seed.md`, `forgetting.md` | **V2** |
| C7 | Reports in version control and CI | Evidence, Rill, dbt | ✅ they are files | **Keep** |

---

## R9 is kept, and kept unsafe on purpose

`stored-templates.md` weighed three designs for a template stored in a row and
refused **A**: full Mesa, compiled in-process, behind a staff gate. Its probe
showed that a Mesa template with no `<script>` still reaches `process.env` and the
`Bun` global, so whoever can write the row can run code with the API's
credentials. Its target is **C**: Mesa markup whose `{…}` is parsed by the `.lite`
expression grammar and evaluated, never executed.

**V1 prototypes A anyway, and locks down to C later.** The adjudication is
*ergonomics vs. strictness*, and strictness follows what a mistake destroys. A
prototype over data that is not real destroys nothing. The same mistake on a
deploy holding real credentials destroys the process. So three things keep the
later lockdown cheap and the meantime honest:

- **Author templates in C's subset from the first one** — no `<script>`, no
  `{@html}`, no `import`, only component tags registered by name, and braces
  holding only what the `.lite` expression grammar can parse. Locking down then
  means swapping the compiler, and no template has to be rewritten.
- **The prototype does not run on a deploy that holds production secrets or
  data.** Until C lands, writing a template row is the same as deploying code.
- **The test is owed before it ships:** `stored-templates.md`'s escape rows,
  each refused at compile time, each paired with a legitimate expression one
  character away that still renders. Until that test exists, the answer to
  *can this be wrong without anything saying so* is `none`.

This file's later date overturns `stored-templates.md`'s refusal of A **for a
prototype only**. C stays the target.

---

## What this owes before it is built

- **No new noun — answered by the owner, 2026-10-03.** `Report`, `Source` and
  `Subscription` are model names in the data product's own schema, not framework
  vocabulary. The source file's *coin no noun yet* holds.
- **Who owns intake — answered by the owner, 2026-10-03: split by the question
  each part answers.** *How we reach them* is conduit's: a REST source names a
  conduit target, so the credential, retry, breaker, rate limit and trace are
  declared once. Conduit gains nothing, and one request stays one send.
  *What we keep* is the product's: `streams()`, the cursor, the sync mode,
  **pagination** (it shares the cursor on most APIs — Stripe's `starting_after`),
  landing, rejects and freshness. *When it runs* is caravan's. A file or SQL
  source never touches conduit. Consistent with `FJS-D177` (we dial) and with
  `inbound-integrations.md` (a polled feed is a cursor, not a route).
- **The product drives FJS from outside it — answered by the owner, 2026-10-03.**
  The product is **Transit** (stressor #21) and its own code lives in
  `fjs-prototypes/transit`, never committed here. **Every framework feature or fix it needs lands in FJS**, and
  that is the point of building it: the Keep rows above are the framework's
  worklist, and the product is what proves each one. **After V1, the likely
  next step is a rig** — as `orion` is for automations — baked into
  `example` and `basecamp`. Nothing before V1 waits on it.
- **A source's schema is a row — the owner's direction, 2026-10-03, probed.** A
  `Source` row holds `.lite` text, and the landing database is built from it on
  the fly. `createClient({ schema: text, db: ':memory:' })` works today: rows
  load and a `view`'s `@@sql` reads them back, with no litestone change (probe
  run 2026-10-03, not kept as a test). What it owes:
  - **A memory database holds full replace only.** A restart empties it, so an
    incremental cursor has nothing to resume against. Incremental sync needs a
    file per source, built the same way.
  - **`@@sql` names the TABLE, not the model**: `model StripeCharge` lands as
    `stripe_charge`. A view written against the model name fails at query time,
    not at parse.
  - **A schema row is code a row-writer runs**, the same class as R9: `@@sql` is
    raw SQL. The blast radius is the source's own database, which holds only
    what that source landed. Prototype-only on the same three terms as R9.
  - **Who grades it.** A side client does not know the app's principal; X5's
    `runAs` must reach it by `$setAuth`, and the row's own `@@gate` is what
    grades. Unprobed.
  - **A schema edit is a rebuild, not a migration** — which is the appeal, and
    is only true while the database is disposable.
- **X5 reuses the owner that exists — answered by the owner, 2026-10-03; the
  owner was misnamed here.** It is `app.runAs(userId, fn)`, not the broadcast's
  `gradeRecipients`: that grades ONE row against open sockets, and a report is a
  query whose aggregates a post-filter cannot correct — a sum over rows the
  recipient may not see is wrong however it is redacted afterwards. Run the
  report's query inside `runAs`, re-resolved at send time, as webhooks already do
  for an audience (`FJS-D193`). What follows from it:
  - **One run per recipient in V1.** The broadcast's cohort key is the
    principal's value, and a value carries the user's id, so two people never
    collapse. Collapsing them needs a coarser key — what the report's models
    actually grade on — which is new grading work. V2.
  - **A template never reads its recipient.** The greeting and the unsubscribe
    link go in the per-recipient envelope, so cohorts stay possible later without
    a template being rewritten.
  - **A recipient with no user row** — an outside address — is graded at the
    standing of whoever subscribed them, the webhook rule. ~~Owed: whether adding
    one is gated beyond *could have forwarded it anyway*.~~ Answered by
    [`FJS-D570`](../DECISIONS.md#fjs-d570): no `$protectedFields` in its copy,
    and nothing sent until the address confirms once.
  - **A subscription records its tenant.** A cron has no host or headers, so
    `runAs(actor, { tenant })` is told it.
  - **An app's `getLevel` that reads a login-only field** grades an emailed copy
    differently from the screen. Webhooks share this today.
  - **A deleted or unresolvable recipient** is skipped and logged (X11), never
    sent.
- **Chromium is severable — answered by the owner, 2026-10-03.** One render
  worker behind one seam, so an app that sends no PDF does not install it.

---

## The nine questions

- **Another origin of truth?** No. Landed data is typed by `.lite`, a report's
  params by the schema, and a chart's PNG by the same SVG component the screen
  draws. The *FJS today* column above is a copy and is dated, not authoritative.
- **Concept budget?** Zero. Report, source and subscription are the product's
  model names, not framework nouns.
- **Complexity ours or the problem's?** The problem's, where it is kept. Every
  item whose complexity is the field's enterprise scale is cut, and the reason
  is in its row.
- **Predictability?** Better: one report file gives three outputs (screen, PDF,
  email) from one template.
- **Derived instead of restated?** Param controls come from `controlFor`, landing
  types from the schema, static charts from the live component.
- **One owner?** Existing owners for scheduling (caravan), rendering (mesa),
  export (`@@export`), per-recipient standing (`app.runAs`) and outbound
  delivery (conduit). New ones: the landing contract and the PDF render worker.
- **Boundary explicit?** The landing contract is the boundary between foreign
  data and `.lite`, and the rejects table makes every crossing that failed
  visible.
- **Failure proportional?** A row that fails coercion is quarantined and the load
  goes on. R9's failure is not proportional, which is why it is confined to the
  prototype.
- **Wrong without anything saying so?** Three ways. A stale source — C2 is the
  artefact. A send that leaks across standings — the artefact is a test with two
  recipients at different standings receiving different files. A template that
  escapes — `none` until R9's paired test exists.

**Adjudications.** *Ergonomics vs. strictness* for R9. *Batteries vs. smallness*
for Chromium. *Familiarity vs. precision* for prior art: take Evidence's
report-as-a-file and Metabase's subscription, and refuse their words where they
half-fit.

**Tier.** Assessment. Nothing here may be cited as behavior.

---

## Open questions

- ~~**Does R9 still prototype A, now that the escape test it owes cannot pass under A?**~~ **Answered 2026-10-03 (`FJS-D569`): A — keep the A prototype on § R9's three terms, and ship Phase 5 with the escape test written and failing until C lands.**
  Under A a template's braces are JavaScript, and
  `"".constructor.constructor(…)` contains no forbidden word, so a compile-time
  refusal over JavaScript is the denylist `stored-templates.md` calls a false
  guarantee. The paired escape test passes only against C (Transit's PLAN Q9,
  2026-10-03).
  - **A** — keep the A prototype on § R9's three terms, and ship Phase 5 with
    the escape test written and failing until C lands.
  - **B** — drop A. Write the escape test now as C's spec, and make Phase 5 the
    smallest C: the policy-expression parser moved into toolbelt, a mesa
    expression mode where a `{…}` is evaluated and never executed, formatters
    from `/units` only, and a registered component allowlist.
  - **C** — move R9 to V2, and leave stored templates out of Transit's V1.
  - **Recommend B** — A only defers C, and § R9's own done condition (the
    escape test) cannot be met without C, so A ships an unsafe path whose exit
    criterion it can never reach. Templates authored in C's subset from the
    first one lose nothing in the switch. It costs predictability in one place:
    a `{…}` in a stored template accepts less than one in a `.mesa` file, so
    each JavaScript habit it refuses is refused by name, naming the
    equivalent. C is the fallback if the parser move proves bigger than
    Phase 5.
- ~~**What does an emailed copy carry to an address with no user row, and who must agree to it?**~~ **Answered 2026-10-03 (`FJS-D570`): C — B, and the address confirms once, by a link, before its first send. An unconfirmed address is skipped and logged in the delivery log (X11), never mailed.**
  X5 grades every copy at the subscriber's standing, re-resolved at each send,
  so a demoted or deleted subscriber's feed stops. What is open is what an
  outside copy may hold, and whether the address has a say (Transit's PLAN Q8,
  2026-10-03).
  - **A** — the subscriber's full standing and nothing more: *could have
    forwarded it anyway*. `@encrypted`, `@guarded` and `@secret` fields are
    mailed in plain text, and anyone who may subscribe can point the app's
    sender at any address on a cron.
  - **B** — A minus `$protectedFields`: `FJS-D193`'s floor for a webhook URL,
    applied to an address, because an address is not a principal either.
  - **C** — B, and the address confirms once, by a link, before its first
    send. An unconfirmed address is skipped and logged in the delivery log
    (X11), never mailed.
  - **D** — no outside recipients in V1: every recipient is a user, invited,
    graded at a standing of their own.
  - **Recommend C** — B closes the data half, and the confirmation closes the
    other: the app's mail sender can reach only an address that asked. D is
    stricter and has no special case, but makes *send our accountant the
    numbers* an access grant, which is a flow V1 does not otherwise need. A
    mailed copy cannot be recalled, so strictness follows what a mistake
    destroys. What must stay true has no artefact yet: Phase 4's two-recipient
    test gains an outside address, asserting no protected field in its copy and
    no send before confirmation.

## See also

- `analytics-and-warehouse.md` — the ruling this builds on, the defects already
  closed, and the bound.
- `stored-templates.md` — R9's three designs and the probe.
- `tenant-authored-queries.md` — why a stored query compiles to a `where` and a
  stored transformer has no owner.
- `bulk-data.md`, `inbound-integrations.md`, `metric-store.md`,
  `live-queries.md` — the rows marked ◐ above.
- Prior art: Evidence.dev (report as a file), Metabase (subscriptions, PDF
  attachments since v63), dlt (schema contracts, nested JSON), Malloy and Cube
  (measures, when S1 comes up for V2), Paged.js and Gotenberg (print).
