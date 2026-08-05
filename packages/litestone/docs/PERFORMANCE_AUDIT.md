# Litestone Performance Audit

**Date:** 2026-07-18 · **Version audited:** `@frontierjs/litestone` 1.0.6 · **Runtime:** Bun 1.3.13 (Linux x64)

---

## FIXES APPLIED (same day)

The seven highest-priority findings were fixed and verified. **All 1156 tests pass** after the changes, plus 12 new driver sanity checks (`bench/jsonl-sanity.mjs`).

| Finding | Fix | Before → After |
|---------|-----|----------------|
| H1 `$rotateKey` per-row auto-commit | One `BEGIN IMMEDIATE` transaction per database; rowid-paged iteration instead of full-table `.all()`; cached UPDATE statements | 10k-row rotation: ~10.5 s (projected) → **82 ms** end-to-end (incl. 20k AES ops) |
| H2 `@sequence` outside batch tx | `applySequences` + inserts now inside one `tx.wrap` for `createMany`/`upsertMany`; `nextSequenceValue` collapsed to a single `ON CONFLICT ... RETURNING` statement (also fixes counters staying committed when the batch fails) | 5k-row `createMany`: 148 ms → **50 ms** (plain model: 10 ms) |
| H3 `$setAuth` full rebuild | Tables built lazily on first access (`makeLazyTables` + `installScopesLazy`) — $setAuth is now O(models touched), not O(all models) | 105.3 µs → **4.2 µs** per fresh-user call (15 models) |
| H4 GatePlugin `getLevel` per op | Resolver cached in `WeakMap<ctx, resolver>` — now matches the documented "once per model per request"; `OP_KEYS` hoisted to module scope | 200 gated reads: 200 calls → **0 calls** (resolved once per scoped client) |
| H5 `autoMigrate` no short-circuit | DDL checksum stored in `_litestone_meta`; on match, skips pristine build + double introspection entirely. `{ force: true }` opt-out for out-of-band DDL drift | 4.0 ms → **0.3 ms** per startup call |
| H6 JSONL full scan per query | Per-table parsed-record cache with append-only tail re-parse (external appends and compaction rewrites detected via size/mtime); one fd per index query instead of per row; `count()` via cache or index; `createMany` = one buffer append + one index transaction; cached index statements | Warm `count()`: 148 ms → **~0 ms** · warm `findMany`: 301 ms → **~0 ms** (cold first load unchanged — once per process) |
| H7/M9 Tenant registry | In-flight open memoization (`Map<id, Promise>`) kills thundering-herd duplicate opens + handle leaks; `tenants.migrate()` now **awaits** `apply()` (was fire-and-forget against a closing DB, always reporting 0) and counts applied migrations correctly; migration file reads/splits cached by path+mtime across tenants | correctness + O(tenants × files) → O(files) I/O |

Core-path regression check after all fixes: `findUnique` 1.28 µs/op, `create` 9.2 µs/op, `findMany` (100 rows) 38.4 µs/op — unchanged within noise.

## FIXES APPLIED — ROUND 2

A second pass fixed the medium-impact findings and quick wins. **All 1156 tests still pass.**

| Finding | Fix | Result |
|---------|-----|--------|
| M1 `upsert()` read-then-write | Single-statement `INSERT ... ON CONFLICT(col) DO UPDATE ... RETURNING *` fast path when no hooks/plugins/policies/events/logs/transitions/soft-delete/filters/sequences/nested writes apply and `where` targets one unique column; falls back to the original path otherwise (including on cross-column unique conflicts) | 20.3 → **13.0 µs/op** (1 statement instead of 2–4; remaining cost is transforms + validation, which run on both branches by design) |
| M2 SigV4 no signing-key cache | Derived signing key cached per (date, region, service, secret-shape) as an imported `CryptoKey`; HMAC accepts pre-imported keys | 291 → **156 µs/op** per presign; output verified byte-identical to the old implementation |
| M3 `remove()` overhead | Dropped the unconditional pre-`SELECT *` (soft path reconstructs the log "before" snapshot from RETURNING; hard path now uses `DELETE ... RETURNING *`); cascade BFS computed once per table; leaf cascade children skip the PK readback SELECT (applied to remove/removeMany/restore) | Soft-delete remove is now 1 statement (was 2); cascade with N leaf children saves N+1 statements per call; behavior verified incl. `@hardDelete` branches |
| M8 File/ExternalRef update path | Static `buildWhere` import (was a dynamic `await import` per field); ONE combined SELECT for all file fields' old refs (was one per field); old-version cleanup now `Promise.all` (was sequential S3 round trips); `keepVersions` semantics preserved | K-file-field update: K+K statements+imports → 1 SELECT; N-item array replacement cleanup: N round trips → ~1 |
| Finding 9 unbounded ref cache | `ExternalRefPlugin._cache` is now a bounded LRU (`config.cacheSize`, default 1000) with hit-reordering | Memory leak closed for payload-caching subclasses |
| M10 unbounded ANALYZE | `PRAGMA analysis_limit=400` before ANALYZE in both `apply()` and `autoMigrate()` | Post-migration stats pass is bounded row sampling instead of full index scans |
| M12 retention startup cost | `compactJsonl`: statSync size pre-check + first-line timestamp pre-check skip the full read entirely on the no-op path (files are append-only ⇒ oldest-first); the `maxSize` trim's O(n²) `shift()` loop replaced with a single reverse pass + slice | No-op startup on a 50k-row fresh file: full parse → **1.5 ms**; first-over-limit trim no longer quadratic |
| Low: dead code | Unused `inClause` in `search()` deleted | — |
| Low: event emitter | Merged listener arrays precomputed once; `setTimeout(0)` → `setImmediate` | No per-write spreads or timer-heap entries; faster event delivery |
| Low: policy debug | Debug string + per-param `JSON.stringify` now built only when `policyDebug` is on | Removed per-query waste on every policied read/write |
| Low: timing guards | `aggregate`/`groupBy`/`findManyAndCount` now use the same `needsTiming()` guard as `findMany` | Zero-cost observability consistent across all ops |
| Low: `$transaction` lock mode | `BEGIN` → `BEGIN IMMEDIATE`, matching the doc comment | Write lock taken up front; avoids mid-transaction upgrade `SQLITE_BUSY` under concurrency |

Still open (larger refactors, schedule when the transform pipeline is next touched): H8 transform set-based SQL (`ALTER TABLE`/`UPDATE` instead of whole-table JS materialization; `sample`/`limit` via one `DELETE ... WHERE rowid NOT IN (...)`), H9 attach-based sharding + persistent worker pool, JSONL cold-first-load streaming early-exit, S3 streaming/multipart for very large files, and the remaining low-impact list below (read-path clone reduction, policy SQL precompilation, tokenizer charCode dispatch, tenant meta getter, seeder batching).
**Method:** Full static review of `src/` (~21.5k lines) across four areas (client hot path; query/policy/plugins; parser/migrations/tenant; drivers/storage/transform), followed by micro-benchmarks that confirm or refute each suspected hotspot. All 1156 tests pass on the audited tree.

---

## Executive summary

The core read/write path is in very good shape. `findUnique` by PK measures **1.1 µs/op**, single-row `create` **8.6 µs/op**, and a 100-row filtered `findMany` **36 µs/op** — these are excellent numbers, driven by real architectural strengths: a prepared-statement LRU, precompiled fast paths, batched (non-N+1) include resolution, `RETURNING *` everywhere, policies compiled into SQL `WHERE` rather than filtered in JS, and zero-cost observability guards.

The problems live at the edges of that hot path, and a few of them are large:

1. **`$rotateKey` runs one auto-commit UPDATE per row with no transaction** — measured **~1,300× slower** than the same statements inside one transaction. Its own doc comment claims it runs in a single transaction; it does not.
2. **`createMany` on a `@sequence` model is ~16× slower than it should be** (148 ms vs 9 ms for 5k rows) because sequence counters are bumped with two auto-commit statements per row *outside* the batch transaction.
3. **`$setAuth` rebuilds every table closure on every call** — ~105 µs per call on a 15-model schema, ~550× the cached path. Since `req.user` is a fresh object per request in typical web usage, the WeakMap identity cache never hits, so this is a per-request tax that grows with schema size.
4. **GatePlugin calls `getLevel()` once per operation, not once per request** (contradicting its own comment). If `getLevel` hits a DB or session store, every ORM call gains a lookup.
5. **`autoMigrate` has no in-sync short-circuit** — 4 ms per call at 15 models (full pristine `:memory:` build plus double introspection) on every startup, on the exact path documented as "safe to call on every startup."
6. **The JSONL driver reads and parses the whole file on every query** — 273 ms for a `findFirst` on a 200k-row file, and it only gets slower as logs grow.
7. **The transform pipeline and tenant registry have asymptotic issues** (whole-table JS materialization; full-DB copy + VACUUM per shard; thundering-herd duplicate opens) that matter at production scale.

Two suspected issues were **refuted by measurement** and should *not* be spent effort on: no-op plugin hook dispatch (zero measurable delta) and `@regex` recompilation per write (zero measurable delta at 20k rows).

---

## Benchmark results

All benches in `bench/audit-bench.mjs` (run with `bun bench/audit-bench.mjs [filter]`).

| # | Benchmark | Result | Verdict |
|---|-----------|--------|---------|
| 1 | `$setAuth` with fresh user object, 15 models | 105.3 µs/call | Confirmed — per-request rebuild |
| 1 | `$setAuth` same object (WeakMap hit) | 0.19 µs/call | 553× gap |
| 2 | `getLevel()` invocations across 200 gated reads | 200 calls | Confirmed — no per-request cache |
| 3 | `findFirst` with 0 vs 3 no-op plugins | 4.17 vs 3.99 µs/op | **Refuted** — no measurable overhead |
| 4 | `createMany` 20k rows, without vs with `@regex` | 46 vs 43 ms | **Refuted** — no measurable overhead |
| 5 | `autoMigrate` on an already-in-sync DB, 15 models | 4.0 ms/call | Confirmed — no short-circuit |
| 6 | JSONL `findFirst` on 200k-row (~30 MB) file | 273 ms | Confirmed — full scan per query |
| 6 | JSONL `count()` on same file | 148 ms | Confirmed |
| 6 | JSONL `create()` append | 8 µs/op | Acceptable (unindexed) |
| 7 | `presignUrl` throughput | 291 µs/op | Confirmed — no signing-key cache |
| 8 | `createMany` 5k rows on disk, plain model | 9 ms | baseline |
| 8 | `createMany` 5k rows on disk, `@sequence` model | 148 ms | Confirmed — **16× slower** |
| 9 | 10k UPDATEs auto-commit (the `$rotateKey` pattern) | 10,538 ms | Confirmed |
| 9 | Same 10k UPDATEs in one transaction | 8 ms | **~1,300× faster** |
| 10 | `upsert()` (read-then-write) | 20.3 µs/op | Confirmed |
| 10 | Native `INSERT ... ON CONFLICT ... RETURNING` | 3.4 µs/op | 6× headroom |
| 11 | `findUnique` by PK (fast path) | 1.13 µs/op | Core is fast |
| 11 | `findMany` where + limit, 100 rows | 36.3 µs/op | Core is fast |
| 11 | `create()` single row (`:memory:`) | 8.6 µs/op | Core is fast |

---

## High-impact findings

### H1. `$rotateKey` — per-row auto-commit UPDATEs, no transaction, full-table load
`src/core/client.js:5516–5546`

The doc comment above `$rotateKey` says "Runs in a single write transaction," but the implementation loads the entire table with `.all()` (line 5527) and issues one `rawDb.run('UPDATE ... WHERE rowid = ?')` per row (line 5540) with no `BEGIN`/`COMMIT` anywhere in the loop. Each UPDATE is its own implicit transaction — its own WAL frame and lock cycle. Benchmark 9 measures the identical pattern at **10.5 s for 10k rows vs 8 ms wrapped** on disk. A key rotation over a 1M-row table would take hours instead of seconds, and `.all()` holds the entire table in memory while it runs.

**Fix:** wrap each table's update loop in a transaction (the `tx` manager already exists), and iterate with `.iterate()` or paged rowid batches instead of `.all()`. Small change, ~3 orders of magnitude improvement.

### H2. `createMany`/`upsertMany` with `@sequence` — 2 auto-commit statements per row outside the batch transaction
`src/core/client.js:3383–3400` (rows are mapped through `applySequences` *before* `tx.wrap` at 3409); `nextSequenceValue` at 348–361; same pattern in `upsertMany` (~3629)

Each row's `applySequences` executes an `INSERT ... ON CONFLICT` plus a separate `SELECT` against `_litestone_sequences` on the write connection, each auto-committing, before the batched insert transaction opens. Benchmark 8: **5k-row `createMany` goes from 9 ms to 148 ms** when the model has one `@sequence` field — 16× — and the gap widens on slower disks. Side effect: counter bumps are already committed if the batch insert later fails.

**Fix:** move the whole map + insert inside one `tx.wrap`; collapse `nextSequenceValue` to a single `INSERT ... ON CONFLICT DO UPDATE SET lastNum = lastNum + 1 RETURNING lastNum`; for batches, reserve N values per scope with one statement (`lastNum = lastNum + N`) and assign locally.

### H3. `$setAuth` rebuilds every table closure per call; WeakMap cache misses on typical usage
`src/core/client.js:5752–5828`

`$setAuth(user)` runs `makeAllTables(authCtx)` — a full `makeTable` per model (allowed-write-key sets, typed-JSON maps, fast-path statement lookups, ~40 closures per model) plus a Proxy-wrapped scope installation. The `_authClients` WeakMap is keyed on the *identity* of the user object; in a web app `req.user` is deserialized fresh per request, so the cache never hits. Measured: **105 µs per call at 15 models** (scales roughly linearly with model count) vs 0.19 µs on a cache hit. At 60 models that's ~0.4 ms of pure allocation per request before the first query.

**Fix:** split `makeTable` into a static per-model part built once at `createClient` and a thin per-auth view closing over `ctx`; or memoize on a stable key (e.g. `user.id`) with a small LRU instead of object identity.

### H4. GatePlugin resolves `getLevel()` per operation, not per request
`src/plugins/gate.js:137–150, 228–243`

The header comment says "getLevel() is called at most once per model per request — cached on ctx.auth," but `_resolver(ctx)` constructs a fresh `makeLevelCache` (new Map) on every invocation, so nothing survives a single hook call. Benchmark 2: **200 gated reads → 200 `getLevel()` calls.** `onBeforeCreate`/`onBeforeUpdate` call `_resolver` a second time for nested ops, so writes can double it. `getLevel` is user code and frequently async (role lookup from DB or session store) — this turns "one lookup per request" into "one lookup per ORM call."

**Fix:** cache the resolver per ctx: `WeakMap<ctx, resolver>` (the ctx object from `$setAuth` is stable for the scoped client, so this cache actually hits, unlike H3's user-keyed one). Also fast-path non-thenable returns to skip the await.

### H5. `autoMigrate` does the full diff even when nothing changed
`src/core/migrations.js:297–343`

Documented as "safe to call on every startup — no-ops if the DB is already in sync," but the no-op is discovered only *after* building a pristine `:memory:` database (full DDL generation, regex stripping, statement splitting, executing every CREATE), introspecting it (~4 queries/table), introspecting the live DB (~4 queries/table), and diffing. Measured: **4.0 ms per call at 15 models**, every startup, per database — and per tenant in a registry. A `checksum()` helper already exists in `migrate.js` and is unused here.

**Fix:** store a DDL checksum in the live DB (`PRAGMA user_version` or a `_litestone_meta` row); on match, return `{ state: 'in-sync' }` immediately. Turns the recommended startup call into a sub-0.1 ms hash comparison.

### H6. JSONL driver reads and parses the entire file on every query
`src/drivers/jsonl.js:56–66 (loadAll), 273–280, 307–310`

Every non-indexed `findMany`/`findFirst`/`count(where)` does `readFileSync` + `split('\n')` + `JSON.parse` per line, with no cache and no early exit — `findFirst` parses everything because `limit` is applied after full filter/sort. Measured on a 200k-row (~30 MB) file: **273 ms per `findFirst`, 148 ms per `count()`**. Log files grow monotonically, so every query gets slower forever; the documented 500 MB `maxSize` implies multi-second queries and GB-scale transient allocations. Related: `count()` decodes the entire file into a JS string just to count newlines, and indexed reads open/close an fd per row (`readLineAtOffset`, lines 31–53).

**Fix:** stream and stop early for `findFirst`/`limit` without `orderBy`; cache parsed records keyed by `(path, mtimeMs, size)` and re-parse only the appended tail (files are append-only); count newline bytes in fixed buffers or use the index's `COUNT(*)`; open one fd per query on the index path and sort offsets for sequential reads.

### H7. Tenant registry — duplicate opens under concurrency, and "rebuild the world" per open
`src/tenant.js:194–212`; interaction with `src/core/client.js:4859–4905`

Two compounding issues. First, `#open()` has an async gap between the pool check and `pool.set`: K concurrent `get(id)` calls for a cold tenant run K full `createClient`s; the losers' clients are never `$close()`d (leaked SQLite handles holding WAL locks), and at capacity each duplicate evicts an innocent pool entry. Second, every open — including every LRU-churn reopen — re-derives ~20 pure-function schema maps (`buildRelationMap`, `buildPolicyMap`, `buildValidationMap`, …) from the *same shared* `parseResult`, plus a retention DELETE sweep (client.js 4869–4880) that reruns on every reopen of a hot-but-evicted tenant.

**Fix:** memoize in-flight opens (`Map<id, Promise<client>>` cleared in `finally`); cache derived schema maps in a `WeakMap<parseResult, maps>` inside `createClient`; rate-limit retention sweeps (e.g. once per path per hour).

### H8. Transform runner — whole-table JS materialization for operations SQLite can do natively
`src/transform/runner.js:234–295 (applyOpsToTable), 370–411 (sample/limit)`

Column ops (`drop`, `mask`, `set`, `keep`) `SELECT *` the entire table into JS objects, produce a full new array of new objects *per op*, then re-insert every row one statement at a time. `sample(500)` on a 10M-row table loads all 10M rows, Fisher–Yates shuffles them, and rebuilds the table to keep 500. SQLite ≥3.35 (which Bun ships) does most of this natively: `ALTER TABLE ... DROP/RENAME COLUMN`, one `UPDATE` with `substr`/`printf` for masks, and `DELETE FROM t WHERE rowid NOT IN (SELECT rowid FROM t ORDER BY random() LIMIT ?)` for sampling. Cost is O(rows × cols × ops) heap and GC versus milliseconds of set-based SQL. Not micro-benched (asymptotic argument is sufficient); this is the pipeline marketed for `production.db`-sized inputs.

**Fix:** route function-free ops through SQL; reserve row materialization for `setField` with a JS function, and stream with `.iterate()` there instead of `.all()`.

### H9. Split mode — copies the full intermediate DB (then VACUUMs it) once per shard, and spawns a fresh Worker per shard
`src/transform/split-worker.js:18–47`; `src/transform/framework.js:711–773`

Each shard worker does `copyFileSync` of the entire multi-tenant intermediate DB, scopes it down to one entity via the table-rebuild machinery (see H8), and VACUUMs. For 1,000 tenants over a 2 GB intermediate that is ~2 TB of disk writes to produce outputs that might be 2 MB each — total work O(shards × DB size) instead of O(DB size). A brand-new `Worker` (Blob URL + module compile) is also spawned per shard rather than reusing `poolSize` persistent workers.

**Fix:** invert the copy — create an empty output DB, `ATTACH` the intermediate read-only, and `INSERT INTO out.t SELECT ... WHERE <scope>` per table in FK order (no VACUUM needed). Reuse a fixed pool of long-lived workers fed via `postMessage`.

---

## Medium-impact findings

**M1. `upsert()` is read-then-write** (`client.js:3580–3601`) — `findFirst` through the full read pipeline, then `update` or `create`. Measured 20.3 µs/op vs 3.4 µs for a native `INSERT ... ON CONFLICT ... RETURNING` (6×). When `where` targets a unique column and no hooks/nested writes apply, compile to the single-statement form (upsertMany already does this shape).

**M2. SigV4 signing key derived from scratch per request** (`storage/sigv4.js:6–34`) — the 4-step HMAC chain runs per call and every HMAC re-runs `crypto.subtle.importKey`. Measured **291 µs per presign**. The derived key is valid for a whole UTC day per (secret, region, service); caching it as an imported `CryptoKey` removes ~80% of the work. Matters when presigning lists of files (N presigns per page render).

**M3. `remove()` overhead** (`client.js:3687–3721`) — an unconditional `SELECT *` pre-fetch even when the soft-delete path already gets the row from `UPDATE ... RETURNING`; the cascade BFS (`getCascadeTargets`, 714–745) recomputed per call instead of cached per model at table-build time (schema is immutable); and one wasted child-PK `SELECT` per leaf cascade table. A soft delete of a parent with 3 leaf children issues ~4 unnecessary statements.

**M4. Nested writes are sequential and untransacted** (`client.js:2392–2460`) — creating a parent with N children performs N sequential awaited single-row writes (m2m ops each add a `findFirst`), each its own implicit transaction unless the caller wrapped in `$transaction`. Wrap in `tx.wrap`, batch m2m connects with one `IN` SELECT + multi-row INSERT.

**M5. Variable-length `IN (?,?,…)` lists defeat the statement LRU** (`client.js:1216–1298` include path; also `_count`, cascade, search) — every distinct value-count compiles a distinct statement and churns the 500-entry cache. Bucket to power-of-two sizes padded with NULL, or use `IN (SELECT value FROM json_each(?))` for one stable statement. Note: no chunking guard exists for very large lists (SQLite bind-variable limit).

**M6. Read-path row cloning** (`client.js:1834–1888`; `query.js:766–794, 914–923`) — a row can be shallow-cloned up to 4 times (bool/JSON coercion → `@from` deserialize → computed → field policy), and `trimToSelect` iterates all row keys rather than the (smaller) selected set. Rows come fresh from the driver, so a single owned clone mutated in place by all stages is safe. Matters on large result sets (GC pressure); the no-feature fast path is already zero-copy.

**M7. Field-level `@allow('read')` evaluated per field per row via the expression interpreter** (`client.js:1785–1789`) — compile each expression to a closure at table-build time, and hoist auth-only expressions (no row references) to once per query.

**M8. FileStorage/ExternalRef update path** (`plugins/file.js:227–274`; `plugins/external-ref.js:228–277`) — a dynamic `await import('../core/query.js')` inside the per-field loop plus one `SELECT "<field>"` per file field per update; one combined SELECT and a static import suffice. Also: replaced `File[]` old-version cleanup is awaited sequentially in `onAfterWrite` (one S3 round trip at a time) while `onAfterDelete` correctly uses `Promise.all`; and `readValue` buffers whole files in memory (no streaming/multipart in the S3 provider — a 2 GB download costs 2 GB of heap per concurrent request).

**M9. `tenants.migrate()` re-reads and re-splits every migration file once per tenant** (`tenant.js:460–471`) — 500 tenants × 20 files = 10,000 redundant `readFileSync` + splits. **Also a correctness bug:** `apply()` is async but not awaited in the fan-out — `raw.close()` runs immediately, the returned migration count is always 0, and a `.js` migration would execute against a closed DB. Hoist file reads before the fan-out and `await apply(...)`.

**M10. Unbounded `ANALYZE` after every migration** (`migrations.js:210–214`, also autoMigrate) — full-scans every index of every table; on a multi-GB DB this is seconds-to-minutes inside the deploy path, per tenant in fleets. Use `PRAGMA analysis_limit=400` + `PRAGMA optimize` (the SQLite-recommended pattern).

**M11. Transform `getTableStats` recomputes all-table COUNTs per table** (`framework.js:837–902`) — `resolveAllRowCounts` makes percent/bytes modes O(T²) full scans. Memoize one count snapshot per step.

**M12. JSONL/retention startup costs** (`tools/retention.js:73–101, 117–182`; `drivers/jsonl.js:160–165`) — `compactJsonl` reads and JSON.parses the whole file every startup just to discover nothing needs pruning (a `statSync` size check and a first-line timestamp check would skip it), and the `maxSize` trim uses a repeated `lines.shift()` loop that is O(n²) right when the file first crosses the limit. `runSqliteRetention`'s `DELETE ... WHERE createdAt < ?` full-scans unless the user happened to index `createdAt` — auto-create that index when a database block declares `retention`.

---

## Low-impact findings (worthwhile, not urgent)

`$transaction` emits plain `BEGIN`, not `BEGIN IMMEDIATE` as its comment claims (`client.js:988–1018`) — deferred transactions upgrade to write locks mid-flight, which surfaces as `SQLITE_BUSY` retries under concurrency; a throughput issue as much as a correctness one. The write-path event emitter uses `setTimeout(..., 0)` and re-spreads listener arrays per emit (`client.js:1438–1448`) where `fireLog` already uses the better `setImmediate` pattern. `db.query()` batch reads open a write-connection transaction even for read-only batches (`client.js:5444–5465`). `modelToTable` linear-scans `schema.models` inside the include path (`client.js:1094–1097`) — precompute a name→table map. `aggregate`/`groupBy`/`findManyAndCount` skip the `needsTiming()` guard that `findMany` has. `writeData` re-scans field attributes per write for array validators (`client.js:1913–1937`). Scope accessors rebuild their closure set on every property access (`client.js:5337–5390`). Dead code: `search()` computes an unused `inClause` (`client.js:4072`). `buildWhere` re-creates three closures per recursion level and double-allocates `in` placeholders (`query.js:215–246, 299–328`). Policy debug strings and `JSON.stringify` of params are built even with `policyDebug` off (`policy.js:85–89`), and policy SQL is recompiled from the AST per query (`policy.js:159–275`) — compile once to `{ sql, paramFns }` at startup. `introspect()` issues ~4 uncached `db.prepare` queries per table where one upfront `sqlite_master` read would cover half (`migrate.js:25–89`). The tokenizer allocates 2–3 char slices and runs per-char regexes (`parser.js:74–197`) and `splitStatements` uppercases 3–5 char slices per character (`migrate.js:99–158`) — both fixable with charCode dispatch; startup-only. The tenant `meta` getter rebuilds its API object and re-prepares SQL per access (`tenant.js:322–386`). `ExternalRefPlugin._cache` is an unbounded Map — a latent memory leak for subclasses that cache payloads (`external-ref.js:72, 147–154`). Seeder `createMany` is sequential un-transacted single creates (`seeder.js:177–184`) — dev-time, but it taxes every test run.

---

## Refuted findings — do not spend effort here

**Plugin no-op hook dispatch is free in practice.** The base `Plugin` class defines every hook as an async no-op, so the runner awaits them for every plugin on every op — this looked like per-call overhead, but benchmark 3 measured **no delta** (4.17 µs/op with zero plugins vs 3.99 µs/op with three no-op plugins; difference is noise). Bun/JSC handles resolved-promise awaits cheaply enough that partitioning plugins per hook isn't worth the complexity today.

**`@regex` recompilation per write is not measurable.** `validate.js:57` constructs `new RegExp(pattern)` per check, which looked like a classic hotspot, but benchmark 4 measured **no delta** on a 20k-row `createMany` (43 ms with the regex field vs 46 ms without) — the engine's internal regex-compilation cache absorbs identical pattern strings. Hoisting the compile is still tidier, but it is not a performance fix.

These two refutations are why the benchmark step matters: both came out of static review looking like medium-impact issues.

---

## What is already done well

For balance, the audit found the most important architectural performance properties are correct: the prepared-statement LRU (`wrapDb`, 500 entries, finalize-on-evict) means identical SQL never recompiles; `findMany({})` and `findUnique`-by-PK have precompiled fast paths that skip SQL building entirely; include resolution is batched with one `IN` query per relation level — there is **no N+1 read pattern anywhere**; `RETURNING *` eliminates read-after-write; row-level policies compile into SQL `WHERE` fragments rather than fetch-then-filter in JS (the single most important RLS performance property, done right); encryption uses synchronous `node:crypto` with the key normalized once; `createMany`/`upsertMany` (without `@sequence`) run one cached statement inside one transaction; unconfigured logging/tracing costs two property reads; migration table rebuilds are set-based (`INSERT INTO ... SELECT`) inside a single transaction with FKs off; the tenant LRU pool is O(1); parse imports are deduplicated; the transform pipeline's disposable-DB pragmas (`journal_mode=OFF`, `synchronous=OFF`, big cache, mmap) are exactly right; and the JSONL companion-index design (SQLite index → byte-offset seeks) is sound — it just needs the fd and full-scan fixes above.

---

## Recommended priority order

1. **`$rotateKey` transaction wrap + `.iterate()`** (H1) — smallest diff, ~1,300× on a documented production operation.
2. **`@sequence` batch path** (H2) — 16× measured on bulk inserts; also closes a partial-failure consistency gap.
3. **GatePlugin per-ctx level cache** (H4) — small WeakMap change; removes a per-operation user-code call and makes the code match its own comment.
4. **`autoMigrate` checksum short-circuit** (H5) — the `checksum()` helper already exists; startup cost drops to a hash compare.
5. **`$setAuth` static/dynamic table split** (H3) — biggest per-request win for web apps; medium-sized refactor.
6. **Tenant in-flight open memoization + schema-map cache** (H7) — small changes, fixes a handle leak and thundering herd.
7. **JSONL read path** (H6) — streaming early-exit + mtime/size cache; the driver's whole value proposition for queries depends on it.
8. **`tenants.migrate()` missing `await`** (M9) — one-line correctness fix; do it with the file-read hoist.
9. **Transform set-based SQL + attach-based sharding** (H8, H9) — larger refactors; schedule when transform work is next touched.
10. The medium/low items opportunistically, in the order listed.

*Benchmark suite: `bench/audit-bench.mjs` (kept in the repo copy used for this audit). Every high-impact claim above is either benchmarked directly or verified against exact source lines; line numbers refer to the audited 1.0.6 tree.*
