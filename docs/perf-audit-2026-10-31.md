# Hot-path performance and smell audit — 2026-10-31

Three read-only agents traced one verb end to end per realm and measured where a number was cheap: Litestone `findMany`/`findUnique`/`create`/`update`, Junction `GET /api/leads?status=open&$limit=10` and `PATCH /api/leads/:id`, Mesa a signal write into a 1000-row keyed list, Sierra a Form keystroke and a route navigation. Scope was the per-call path only; parser, migrate, studio and the compiler were out, and the 2026-09 audits (`FJS-2309`–`2317`, `FJS-634`–`639`, `FJS-781`–`888`) were not re-reported.

**Every finding is a register row** — this file is the argument, `ISSUES.md` is what is open. Six were fixed in the same change and closed; one is a ruling; the rest are open. Numbers were taken on a box at load average 6–12 (Bun 1.4.4, happy-dom for the UI), so ratios are reliable and absolute µs are ±2x.

## Baselines

| Path | Measured | Floor |
| ---- | -------- | ----- |
| `findUnique` by pk, plain model | 4.4–5 µs | 0.8 µs raw prepared SELECT |
| `findMany` 100 plain rows | 29–34 µs | 37 µs raw `.all()` |
| `update` by id | 22–30 µs | 3.6–8.8 µs raw `UPDATE … RETURNING` |
| `create` | 17.6 µs | SQLite is 44% of it |
| Junction fixed route | 15–18 µs | 2 µs hand-written fetch |
| Junction GET by id / find / PATCH | 60–80 / 200–300 / 150–200 µs | litestone alone 20 / 30 / 35 µs |
| Mesa effect create+dispose | 0.57 µs | — |
| Mesa one write waking one effect | 0.5–1.4 µs | — |
| Keyed list, replace 1 of 1000 rows | 219 µs → 178 µs after fix | — |
| Form keystroke, 20 fields | 65–90 µs → 0 before first blur | — |

The verdict in one line: **the engines are near their floors; what is left is per-call rebuilding of static facts, one algorithmic cliff, and five functions too large to reason about.**

## Fixed in this change

| Row | What | Where |
| --- | ---- | ----- |
| FJS-3742 | `findMany` timed only hydration, so `onQuery`/`$tapQuery` saw ~0 for the most common read | `litestone/src/core/client.js` |
| FJS-3743 | List `COUNT(*)` skipped when a first page comes back short — its length is the total. 50k rows: count cost 74x the page | `client.js` `findManyAndCount` |
| FJS-3744 | `$$eachBlock` rebuilt its `blocks` Map three times per reconcile although the removal pass keeps it current — 56% of a no-change update at n=1000 | `mesa/src/runtime.js` |
| FJS-3745 | `_checkConstraints` humanized the label and recompiled `pattern` per field per validate; label now lazy, both cached per rule | `sierra/src/resource/field-rules.js` |
| FJS-3746 | Form validated the whole record per keystroke and kept nothing until the first blur | `ui/components/forms/Form.mesa` |
| FJS-3747 | pk field re-derived per create/update though `_pkField` exists | `client.js` |

Proof: litestone, mesa, sierra and ui suites green after the change; `count.mjs` confirms `total` equal on short, full and offset pages.

## Open — ranked by gain

1. **FJS-D1713 (ruled)** — a page counts its total by default; `$total: false` skips it for a large list. Build is FJS-3765.
2. ~~**FJS-3748**~~ — closed: an owned Response keeps its body text and is gzipped from it; the rewrap measured ~30 µs, not ~90.
3. **FJS-3749** — the `$` grammar is walked ~6 times per request; owner split across `bridge.ts`, `app.ts`, `toolbelt/directives` (Invariant 4). ~4–6% of a find.
4. **FJS-3750** — `@encrypted` anywhere on a model turns the pk fast path off, 3.7x slower `findUnique`. Check `FJS-223` before widening.
5. **FJS-3751** — cold navigation awaits component, layouts, loader import and `load()` in series: 1–2 RTT lost on a split route. Reasoning only.
6. ~~**FJS-3756**~~ — closed: `bridge.fromFrame`/`toFrame` read and shape a socket call by the HTTP rules; one `callContext()` literal.
7. **FJS-3752** — `buildWhere` rebuilt per call, three closures, fresh SQL string hashed by the statement cache: ~10–15% of update-by-where.
8. **FJS-3753** — `announcementPayload` rebuilds static Sets per announced write; bulk writes do it per row then grade serially.
9. **FJS-3754** — two Proxy unread-watchers per find in production, even for the derived `find`.
10. **FJS-3755** — id writes run the whole `parseQuery`; filter keys validated twice.
11. **FJS-3757** — `$$eachBlock` allocates `keyCount`, `oldBlocks`, `newBlocks` before the head/tail scan can say nothing moved. Another 30–50 µs at n=1000.
12. **FJS-3760** — Form rebuilds `$context.form` and `errors` as fresh objects per change, so every Field re-renders per keystroke. Unmeasured.
13. **FJS-3761** — an app-wide `around` hook exists only to stamp `locals.__channels`.
14. **FJS-3762** — delegated handler defines/deletes `currentTarget` on the Event per node; needs a Chrome bench before acting.
15. **FJS-3759** — the junction bench sends no `content-length`, so it measures a path browsers never take.

## Smells — FJS-3758

| Function | Lines | Jobs |
| -------- | ----- | ---- |
| `createResource` `sierra/src/resource/resource.js:633-3279` | 2,646, ~90 inner fns | `_call` alone is 376 |
| `_callService` `junction/src/core/service.ts:614-1240` | ~630 | gate, scope, idempotency, telemetry, pipeline, announce |
| `prepareUpdate` `litestone/src/core/client.js:3399-3734` | ~335 | preamble copied from `prepareCreate` |
| `_navigate` `sierra/src/router/index.js:734` | 379 | five copies of one error exit |
| `findMany` `client.js:3952-4217` | 265 | recursive-CTE verb inlined |
| `emitScript` / `analyzeScript` / `compile` `mesa/src/compiler.js` | 1,224 / 1,181 / 865 | build-time; `:7475` builds a RegExp per tag over the whole source |

## Refuted — do not spend here

Read hydration (`read()`/`readAll()` within 10% of a hand-written hydrator). AsyncLocalStorage (0.1 µs per `run`, 12–15 `getStore` per write). Gate plugin overhead (unmeasurable gated vs ungated). The signal/effect engine. WS fan-out (already stringify-once per cohort). Toolbelt `inflect`/`directives` (table-first, module-level). Junction's service index (cached by `services.version`). The browser client `_request`. `UPDATE … RETURNING` vs `UPDATE` then `SELECT` (equal).

## Not reached

`include.js` (an `include` findMany ran 108 µs vs 30 without — worth a look). `upsert` (136 µs vs 63 for update) and `updateMany`. `resource.js` `_call`, `tethered.js`, `list-cache.js`. The real `Bun.serve` socket path (all junction numbers are `app.http.fetch`). `$setAuth` per request (~10 µs extra on a `findFirst` under auth). Event delegation under real Chrome. Counting Field re-runs per keystroke in a mounted Form.

Bench scripts from the run were throwaway and live in the session scratchpad only; `packages/mesa/bench/cases.mjs` and `packages/litestone/bench/` are the durable harnesses to extend (`FJS-3546` names what the mesa bench does not cover).
