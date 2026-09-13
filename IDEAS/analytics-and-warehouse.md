---
id: analytics-and-warehouse
status: partial
dated: 2026-09-07
---

# Idea — Analytics and the warehouse: ruled Core, and most of it already exists

**Status: RULED, NOT BUILT.** Dated 2026-09-07. The scope question is settled —
[`FJS-D228`](../DECISIONS.md#fjs-d228): **FrontierJS owns the data layer**, built as an
application beside `basecamp` and `orion` rather than as a battery inside the core.
`partial` rather than `proposed` because the ruling landed and three defects came out of
the probe that produced it; nothing above the existing pieces is built.

Every claim about what exists was read off the tree (`VERIFYING.md`) and names its file.
**The first version of this file said Transform was empty. That was wrong** and the
correction is the most useful thing here.

---

## What the probe found

**Six of seven categories already exist and are pointed at nothing.** That is what makes
owning this tractable rather than a multi-year commitment — it is not seven things to
build, it is one storage decision and six existing packages given a noun to point at.

| # | Category | What holds it today | Maturity |
| --- | --- | --- | --- |
| 1 | Ingest / EL | `$tapEvents` · `announceDataWrites` · the audit trail — the source COOPERATES, which is everyone else's hardest problem | 3 |
| 2 | **Transform** | **`view` · `@@materialized` · `@@refreshOn` · `@derived` · two compilers over one expression language** | **2** |
| 3 | Warehouse | a `database` block; drivers closed at `sqlite`/`jsonl`/`logger` | 1 |
| 4 | Orchestration | caravan — jobs, cron, idempotency keys, resumable batch | 3 |
| 5 | BI / serving | `aggregate()`/`groupBy()` under policy; Studio's `/api/query`, `/api/stats`, `/api/perf` | 2 |
| 6 | Reverse ETL | conduit — declared targets, per-target auth and encoding | 3 |
| 7 | Catalog | `/api/catalog` · `jsonschema.snapshot.md` · `ws:atlas` — of the SCHEMA, not of the data | 3 |

Maturity is the ladder in the capability draft: 2 is *built, nothing depends on it*, 3 is
*a consumer uses it on the ordinary path*.

---

## Transform is built, and nobody has ever used it

`view` is a first-class declaration — parser ([`parser.js:718`](../packages/litestone/src/core/parser.js)),
DDL for both plain and materialized ([`ddl.js:945`](../packages/litestone/src/core/ddl.js)),
migration handling including drop-and-recreate of dependent views on a table rebuild
([`migrate.js:1005`](../packages/litestone/src/core/migrate.js)), read verbs bound and
writes refused by name.

```lite
view accountStats {
  accountId Int
  total     Int
  @@sql("SELECT accountId, COUNT(*) AS total FROM Event GROUP BY accountId")
  @@materialized
  @@refreshOn([Event])
  @@db(analytics)
}
```

**Read that against dbt.** Declared columns are `schema.yml`. `@@sql` is the model.
`@@materialized` is the materialization strategy. `@@refreshOn` is incrementality.
`@@db` is the target. That is a dbt model in one construct, **with no second language
and no re-declared types** — which is the whole argument for owning this rather than
integrating with it: everywhere else the semantic layer is a reconstruction of facts the
schema already holds.

Beside it, `@derived` / `@from(Order, count: true)` is a **column-level rollup computed
in SQL**, so unlike `@computed` it can be filtered and sorted on. dbt has no
column-level equivalent at all.

Under both, `compileSql` and `evalJs` are two interpreters over one expression language,
already graded against each other as an oracle. That is the hard half of a semantic
layer, already paid for.

**And no schema in this repo declares a `view`** ([FJS-972](../ISSUES.md#fjs-972)).
Built, documented, unit-tested, never run in anger — which is why the two defects below
survived.

---

## The three defects the probe turned up

**[FJS-970](../ISSUES.md#fjs-970) — a `view` has no gate, no row policy and no tenant
scope, and cannot be given one.** `parseView` accepts exactly four attributes and throws
on everything else, so `@@gate` and `@@allow` are parse errors on a view;
`buildTableForView` passes `{ tableName, modelName }` into `makeTable` and nothing else;
and the row-tenancy desugar filters `schema.models`, so a view over a scoped model reads
across tenants. **This one is load-bearing for the ruling** — a view is the transform
primitive the product would be built on, and *the warehouse is where row policy dies* is
the exact thing `FJS-D228` says must not be true here.

**[FJS-971](../ISSUES.md#fjs-971) — `@@refreshOn` rebuilds the whole view on every row
written, inside the writing transaction.** Three triggers per source, each
`DELETE` + full re-`INSERT`, and SQLite fires a row trigger per row, so a `createMany` of
10,000 rows re-aggregates the table 10,000 times. Stated as a deliberate strategy, so the
defect is the **unstated ceiling** rather than the choice; correctness is tested and cost
is not.

**[FJS-972](../ISSUES.md#fjs-972) — nothing has ever declared a view.** The reason both
of the above were invisible to a green suite. Fixed by a caller, not a patch.

---

## What is `only`-edge, and it is none of the seven categories

**Everywhere else an extract is a privileged dump.** The pipeline authenticates as a
service account that reads everything, and every access rule the application spent years
declaring stops at the copy.

Access here is declared at the Data boundary and `db.$readAs` already grades a row per
recipient, so a feed **graded per recipient**, or an extract **stamped with the standing
it was read at**, is structurally available and structurally impossible for a tool that
connects to the database as root.

That is the edge, and it is why the first thing built is the export contract rather than
a warehouse: **today the only way data leaves an FJS app is a human clicking
the CSV button in a development tool** ([`cli.js`](../packages/litestone/src/tools/cli.js)) —
a hole under every possible answer to the scope question, and therefore unblocked by it.

---

## Still open

- **[FJS-D229](../ISSUES.md#fjs-d229) — what holds analytical data. Ruled 2026-09-08 as
  [FJS-D248](../DECISIONS.md#fjs-d248): SQLite.** The trigger this entry named is gone —
  [FJS-971](../ISSUES.md#fjs-971)'s refresh ceiling became a choice in
  [FJS-D245](../DECISIONS.md#fjs-d245) — and the question splits: reading our file with
  another engine (`ATTACH … (READ_ONLY)`) costs nothing and needs no driver, while STORAGE
  also has to be FED, which [FJS-D247](../DECISIONS.md#fjs-d247) measured we cannot do. A
  fourth driver waits on a latency budget missed on real row counts, EXPLAIN recorded.
- **[FJS-D230](../DECISIONS.md#fjs-d230) — where a report stops being Studio's. Ruled
  2026-09-07: Studio PREVIEWS, the app ISSUES.** Filed on the premise that Studio has no
  access story, which is false — its *Acting as* picker is a real `$setAuth`. What it
  cannot reproduce is a principal the REQUEST builds, and it cannot say which of the two
  it just gave you. The line is what happens to the output: a preview is discarded and may
  be approximate, an extract is kept and must carry a standing it can defend.
- **[FJS-D231](../ISSUES.md#fjs-d231) — who owns the write tap.** `orion` wants it to
  ACT, this wants it to RECORD. Not blocking (`FJS-D14` defers orion), filed so it is not
  rediscovered as two implementations.

---

## What must not happen

- **Coin no noun yet.** The product needs a name and the name is a decision of its own;
  every category above is describable without one today.
- **Do not let `database analytics` become the answer by default.** It parses, which
  makes it the path of least resistance, and [FJS-958](../ISSUES.md#fjs-958) is closed
  now — re-check what it covers before leaning on it here.
- **Do not absorb the three neighbors.** `metric-store.md` is readings over time,
  `traffic-analysis.md` is request telemetry, `bulk-data.md` is the import screen a
  person uses. Each is argued elsewhere and each has its own owner.

---

## The order of work

Phased so that each step is provable before the next, and so the storage decision stays
deferred. **Nothing here needs a new package.**

**Phase 0 — make the transform primitive safe.** Fix [FJS-970](../ISSUES.md#fjs-970),
which means ruling how a view inherits or declares access; declare a `view` in `example`
over a gated, tenant-scoped model and put it behind a drive, which closes
[FJS-972](../ISSUES.md#fjs-972) and turns both other rows into executed assertions; state
the refresh ceiling ([FJS-971](../ISSUES.md#fjs-971)). **Everything else is blocked on
this** — a transform primitive that leaks is not one to build a product on.

**Phase 1 — the export contract. SHIPPED 2026-09-07.** `@@export(ndjson | csv [, since:])`
on a model or a view, `litestone export` / `fli db:export`, and a manifest. The design is
in `packages/litestone/docs/export.md`; the argument for it was reviewed as a page first.
**The thing worth carrying forward is that enforcement needed no code**: an export is a
paginated scoped read, so the gate refuses at the first page, a row policy narrows the
FILE rather than failing it, and staff, a shopper and the system take three different
extracts from one declaration. A `@@gate` is required beside `@@export`; protected columns
do not leave even for a caller who may read them; the manifest records what was omitted
and by which rule. 27 unit tests, and `example` declares two datasets.

**Phase 1b — the HTTP endpoint. Shipped 2026-09-07.** `exportPlugin()` in junction, mounting
`GET /exports` and `GET /exports/{dataset}`, streamed and taken as the calling session.
[FJS-D230](../DECISIONS.md#fjs-d230) settled that the surface is the app's. It adds no
enforcement — `runExport` already is the extract — and the one thing that took care is
that a raw route runs BELOW the pipeline where a principal is finished, so it runs the
same around hook and takes back both the client and the merged principal.

**Phase 2 — serving.** A Reports panel in the app, over `aggregate`/`groupBy` and declared
views. No warehouse, no new storage. Studio keeps previewing and gains the disclosure
[FJS-977](../ISSUES.md#fjs-977) is filed for.

**Phase 3 — the rest, only when something strains.** Ingest from foreign sources is the
connector treadmill and `FJS-D153`'s rule applies unchanged: a vendor lives in its own
package. Storage is ruled — SQLite ([FJS-D248](../DECISIONS.md#fjs-d248)) — and a second engine
waits on a measurement rather than on evidence in general.

**The bound to hold on to**: this is *analytics for the app*, not an enterprise data
warehouse. Past a few hundred GB the comparison is with Snowflake and it is lost. Write
that in the product's README on its first day, because an unbounded scope here is how the
whole thing becomes the second product that eats the first.
