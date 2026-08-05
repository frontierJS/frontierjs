# Litestone Studio — Feature Review & Roadmap Recommendations

**Date:** 2026-07-18 · Reviewed: `src/tools/studio.html` (4,417 lines) + the Studio server in `src/tools/cli.js`

---

## Where Studio stands today

Studio is already unusually complete for an ORM-bundled tool — it goes well beyond Prisma Studio's browse-and-edit. Nine panels: **Browse** (cursor-paged grid with inline cell editing, typed cell rendering, FK jump-links, soft-delete awareness, CSV/JSON export), **SQL Query** (raw SQL with timing), **Schema** (interactive draggable ER diagram, per-database coloring, PK/FK/soft/FTS badges), **schema.lite editor** (a real write path with debounced server-side validation — save only lands if the schema parses), **Migrations** (per-database applied/pending/modified/orphaned status plus the pending diff SQL with copy button), **Stats** (per-DB size, WAL mode, freelist pages, statement-cache size, per-table row counts), **REPL** (Litestone JS with autocomplete, history, and a per-command SQL log showing timing, row counts, and param-inlined SQL), **Transform** (a visual pipeline builder that generates runnable transform configs, with preview and run), and **Performance** (a Schema Advisor with severity-ranked issues + fix SQL, and a Query Analyzer scoring EXPLAIN QUERY PLAN output).

It is also genuinely multi-DB aware (filter pills, per-DB diagram grouping, driver badges for jsonl/logger) and auth-aware — the "Acting as" impersonation picker applies real `$setAuth` policies to browse/edit/REPL, which is a standout feature for testing row-level policies interactively.

## Fixed during this review

The review surfaced concrete bugs, all fixed and verified (studio boots, all 1156 tests + 15 CLI smoke tests pass):

| Bug | Impact | Fix |
|---|---|---|
| Cell edit & new-row coercion still checked type names `'Integer'`/`'Real'`, but the parser now emits `'Int'`/`'Float'` | **Numeric edits were submitted as strings** — STRICT-mode tables reject them; non-strict tables silently store text | Updated to the new names |
| `parseInt(v) \|\| null` coercion | **Editing a cell to `0` saved `NULL`** — silent data corruption | NaN-checked parsing; 0 stays 0 |
| `filterRows()` never updated `filteredRows` | CSV/JSON export ignored the active filter; sorting while filtered reverted to unfiltered rows | Kept in sync |
| Cell editing not blocked on jsonl/logger tables | Double-click edit called `/row/update` on append-only drivers → error | Edit blocked (delete button was already hidden) |
| `node.advice` rendered unescaped in the Query Analyzer; FK jump-link `onclick` used raw `JSON.stringify(val)` in an HTML attribute | HTML-injection point; string FK values containing `"` broke the link | Both escaped |
| Sidebar active-highlight matched by `startsWith` | Selecting `user` also highlighted `users` | Exact match on `data-table` |
| **Studio listened on all interfaces** (Bun.serve default 0.0.0.0) | Studio exposes raw SQL, a JS REPL (arbitrary code execution), and schema-file writes — on your network | Binds `127.0.0.1` by default; `--host=0.0.0.0` opt-in for containers/LAN |

---

## SHIPPED — Tier 3

All five Tier 3 recommendations plus the polish batch, verified by a 13-assertion browser e2e (`bench/studio-ui-test3.mjs`), regression-green on the Tier 1/2 e2e suites and the full 1156-test suite.

**Tenant registry browser (#10).** Studio auto-detects `tenants-registry.db` next to the schema (or `tenants:` config in litestone.config.js) and shows a Tenants panel: every tenant with metadata, DB file size, and open-connection count, plus a fleet-wide "Migrate all". "Open in Studio →" re-points Browse, SQL, REPL, Stats, Query Log, maintenance, and perf tools at that tenant's database — a header badge shows the active tenant and clicking it returns to the main project.

**Critical bug found while building it:** the tenant registry had a cross-tenant isolation hole — in multi-DB schemas, `createClient`'s `db:` override is ignored in favor of the schema's database-block paths, so *every tenant opened the same shared files* and saw each other's data. Fixed in `tenant.js` by overriding every sqlite database to the tenant's own file. Two more tenant bugs fixed alongside: `create()` didn't await `apply()` (migrations ran against a closing handle), and its DDL fallback only created `main`'s tables, leaving other databases' tables missing from tenant files.

**Row detail drawer (#11).** Select a row and hit ☰ (or `i`): a side drawer shows the full record (long text and JSON readable), its `belongsTo` parents resolved by name with open→ links, and every model referencing it with live row counts and view→ links. Esc closes.

**Saved queries + history (#12).** The SQL panel gained named saved queries (persisted in a `_litestone_studio_queries` table — invisible to introspection/migrations), a session history dropdown (last 25), and an explicit "runs as system" label documenting that raw SQL bypasses row policies.

**Schema editor upgrades (#13).** A ⚕ Codemod button migrates renamed types in place, and — the headline — a live diff pane: as you edit, Studio diffs your draft against the actual databases and shows "this edit would change: ~ users [alter]…" before you save. Editing and seeing consequences are now one motion.

**ER diagram export (#14).** ⬇ SVG / ⬇ PNG render the diagram (current positions, per-database colors, field lists, FK links) to a standalone file — no external libraries.

**Polish batch:** `--readonly` flag (server-enforced: blocks row writes, imports, REPL, non-SELECT SQL, schema saves, migrations, maintenance except integrity check; UI hides the controls), `--token` auth for non-loopback exposure (`?token=` or bearer header), transform preview now passes the output config, and REPL autocomplete learned `upsertMany`/`findFirstOrThrow`/`findUniqueOrThrow`/`optimizeFts`/`exists`/`aggregate`/`groupBy`. One CLI help fix: `--readonly` is a bare flag read via `flag()`, not `getFlag()`.

---

## SHIPPED — Tier 2 (same day)

All four Tier 2 recommendations implemented and verified (1156 tests + 15 CLI smoke tests green; 10-assertion browser e2e in `bench/studio-ui-test2.mjs`, zero JS errors).

**Query Log panel (#6).** A new sidebar tool backed by a server-side ring buffer (`$tapQuery`, capped at 2,000 entries) that captures every ORM operation through Studio's client — Browse, edits, imports, REPL — plus raw SQL-panel queries. Live-polls incrementally (only new entries) every 2 s while open, with pause/clear, a text filter (sql/model/operation), and a minimum-duration filter (≥5/20/100 ms) with slow-query coloring. Clicking any entry inlines its bound params and opens it in the Query Analyzer pre-filled and already analyzed — the "see slow query → explained plan + index advice" workflow is now one click.

**Maintenance actions (#7).** The Stats panel gained a toolbar: **Backup** (hot `$backup` with VACUUM INTO, timestamped destination, per-DB sizes reported), **Vacuum** (reports freed bytes from page counts), **Analyze** (bounded, `analysis_limit=400`), **Checkpoint** (`wal_checkpoint(TRUNCATE)` with page counts), **Integrity** (`quick_check` per database), and **FTS** (segment merge on every `@@fts` model). Results render inline per database; destructive actions confirm first.

**Disk usage + index info (#8).** `/api/perf/sizes` uses SQLite's `dbstat` when available; Bun's build omits it, so a sampled-payload fallback (byte lengths over up to 1,000 rows, scaled, labeled "estimated") kicks in automatically. The Stats panel renders per-table bars with table + index bytes and index counts per database, top-20 by size.

**Encryption key rotation (#9).** When the schema has `@secret`/`@encrypted` fields, the Stats panel shows a rotation section: lists affected models, validates the 64-hex key client- and server-side, confirms, runs `$rotateKey` (now transactional and fast from the perf round), and reports per-model rows/fields rotated plus a reminder to update the environment key.

---

## SHIPPED — Tier 1 (same day)

All five Tier 1 recommendations below were implemented and verified: all 1156 tests + 15 CLI smoke tests pass, and a 13-assertion headless-browser e2e suite (`bench/studio-ui-test.mjs`) exercises the new UI end-to-end with zero JS errors.

**Server-side filtering & sorting.** The Browse search box now compiles to a real `WHERE` on the server (substring on String fields, exact match on numerics, prefix on DateTimes) — it searches the whole table, not the loaded page, debounced at 300 ms. Column-header sort is a real `ORDER BY` with an id tie-break for stable cursor pagination (click cycles asc → desc → off). A page-size selector (25/50/100/250) was added, the page info now shows the true filtered total ("N rows matching · page 2"), and FK jump-links use the server search — eliminating the old 300 ms-setTimeout race. Rapid filter/sort/toggle changes are also protected by request sequencing so a stale response can never overwrite a fresher grid.

**Restore + bulk operations.** The grid has a checkbox column with select-all; the delete button operates on the selection (soft on `@@softDelete` models, with count in the label and confirm dialog), and a new ↺ restore button un-deletes selected soft-deleted rows. Single-row flows still work via click-highlight. New endpoints: `/api/row/restore`, `/api/rows/bulk` (delete / hardDelete / restore by PK list, capped at 10k).

**Full-table export + import.** ⬇ CSV/JSON now stream the entire table server-side (cursor-paged internally, RFC-4180 quoting), honoring the active search and show-deleted state — previously only the loaded page exported. ⬆ Import accepts CSV or JSON files: client-side parse (proper quoted-CSV handling), column mapping against the model (unknown columns reported and dropped), per-type coercion, a confirm summary, chunked upload, and per-row error reporting with row numbers — a failed batch falls back to row-by-row so one bad row doesn't sink 500.

**Migration actions.** The Migrations panel now has ▶ Apply pending (runs migration files, per-database), ✍ Create migration (writes a timestamped file from the pending diff, per-database subdirs in multi-DB), and ⚡ autoMigrate (dev; confirm dialog shows the exact SQL first). Buttons appear only when actionable. Verified end-to-end: edit schema → diff appears → create writes the file → apply lands it → panel shows in-sync.

**Bonus bug found by the e2e test:** `createClient`'s fresh-database bootstrap was running the *full-schema* DDL into every new database file — in multi-DB schemas, `main` got the analytics tables (and vice versa), which then appeared as permanent phantom drift in every migration diff. Now scoped per database via `generateDDLForDatabase`. Also: the filtered total respects the show-deleted toggle.

---

## Recommendations

Ranked by how much they'd matter to someone actually managing a production Litestone app. Effort: S (hours), M (a day-ish), L (multi-day).

### Tier 1 — gaps a user hits in the first session

**1. Server-side filtering and sorting (M).** The Browse filter and column sort only operate on the currently loaded page — filtering a 100k-row table searches just the ~50 rows in memory, which quietly lies to the user. Send `where`/`orderBy` through the existing `/api/table` endpoint (the client API already supports both); keep the instant client-side filter as a "filter this page" refinement. Add a page-size selector while in there.

**2. Restore for soft-deleted rows (S).** Studio can *view* deleted rows ("show deleted") but the only way to un-delete is the REPL. A restore button on struck-through rows — `restore({ where })` already exists — completes the soft-delete story.

**3. Bulk operations (M).** Selection is single-row only. Checkbox multi-select with bulk delete/restore (and bulk edit of one column) is the most-missed feature coming from any other DB tool. `removeMany`/`updateMany`/`deleteMany` already exist server-side.

**4. Full-table export, and import (M).** Export currently writes only the loaded page. Stream the whole (filtered) table server-side into CSV/JSON. Then the reverse: CSV/JSON import into a table with a column-mapping preview — Studio has no data-in path at all today, and it's half of what people open a DB GUI for.

**5. Apply migrations from the Migrations panel (S–M).** The panel shows status and the pending diff but is read-only — you can see exactly what's wrong and can't do anything about it. Buttons for "Apply pending" (`apply()`), "autoMigrate now" (dev), and "Create migration file from this diff" (`create()`), with a confirm dialog showing the SQL it's about to run.

### Tier 2 — the performance/ops story (your stated focus)

**6. Persistent query log panel (M).** The best observability feature already exists — the REPL's SQL log — but it only captures REPL commands. Wire `onQuery` into a server-side ring buffer (say, last 2,000 queries across all Studio traffic) and give it a panel: filterable by model/operation/duration, slow-query highlighting, click-through to the Query Analyzer with the SQL pre-filled. That last part turns the existing Analyzer from a manual tool into a workflow: see slow query → one click → explained plan + index advice.

**7. Maintenance actions on the Stats panel (S).** Stats already *shows* freelist pages, WAL mode, and sizes but offers no actions. Add buttons — each is one existing call: **Backup** (`$backup`, with optional vacuum), **VACUUM** (show reclaimable bytes from the freelist count first), **ANALYZE** (bounded, `analysis_limit=400`), **WAL checkpoint** (`wal_checkpoint(TRUNCATE)`, showing current WAL file size), **Integrity check** (`PRAGMA quick_check`), and **Optimize FTS** for `@@fts` models. This is the difference between a viewer and a management tool.

**8. Per-table size on disk + index usage (M).** Row counts are shown but not bytes. SQLite's `dbstat` virtual table gives real per-table/per-index disk usage — a treemap or simple bar list answers "what's making my DB 2 GB". Pair with `sqlite_stat1` contents so the Schema Advisor can flag *unused* indexes (write cost, no reads), not just missing ones.

**9. Encryption key rotation UI (S).** `$rotateKey` is now fast (82 ms/10k rows) but CLI/code-only. A Stats-panel action showing which models have `@secret` fields, with progress and the per-model stats result, makes rotation an operation someone will actually perform.

### Tier 3 — bigger bets, in order of leverage

**10. Tenant registry browser (L).** Studio binds to one client; `createTenantRegistry` deployments manage hundreds of DBs with zero visibility. A tenant panel — list with metadata/sizes, click to open one tenant in Studio (re-pointing the existing panels), fleet-wide migration status with an "migrate all" action, and aggregate row counts — would be the single biggest differentiator, since nothing else in the SQLite ecosystem does this.

**11. Row detail drawer with relations (M).** Click a row → side drawer showing the full record (long text/JSON readable), its `belongsTo` parents, and `hasMany` children with counts ("referenced by: 12 posts, 3 sessions"), each jumpable. The FK-jump link exists; this generalizes it and also fixes the current 300 ms-setTimeout race in `jumpToFK` by passing the filter through the load call properly.

**12. Saved queries + history in the SQL panel (S).** The REPL has history; the SQL panel has none. LocalStorage isn't available in all embeddings, so persist server-side next to the DB (a `_litestone_studio` table or a JSON file). Also: the SQL panel ignores the "Acting as" impersonation — either scope it or label it "runs as system" so the inconsistency with Browse/REPL is at least explicit.

**13. Schema editor upgrades (M).** The editor validates but is a bare textarea. Syntax highlighting for the `.lite` DSL (the migrations diff viewer already has a highlighter to reuse), a "codemod" button for type renames, and — the killer feature — showing the *migration diff this edit would cause* live next to the editor, so saving the schema and seeing the consequences become one motion.

**14. ER diagram export (S).** The diagram is good enough that people will want it in docs — add "Export SVG/PNG" (serialize the existing SVG, inline the styles).

### Smaller polish worth batching in

A `--readonly` flag that disables row writes, raw SQL DML, the REPL, and the schema editor in one switch (for pointing Studio at production); the transform preview passing `outPath`/`filenameFn` so preview matches run; the transform builder loading the *source* DB's table list when it differs from the current DB; REPL autocomplete adding the missing `upsertMany`/`findFirstOrThrow`/`findUniqueOrThrow`/`optimizeFts` methods; and an auth-token option (`--token`) when `--host` is non-loopback.

---

## Suggested build order

If you do only three things: **#1 server-side filter/sort**, **#7 maintenance actions**, and **#6 the query log** — together they convert Studio from "inspect and poke" into "manage and tune," which is the gap you asked about. #5 (apply migrations) and #2/#3 (restore + bulk ops) round out daily-driver status; #10 (tenants) is the strategic one to schedule when there's a real multi-tenant deployment to design against.
