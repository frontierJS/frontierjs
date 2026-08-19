---
id: speed-and-footprint
status: assessment
dated: 2026-08-13
---

# Idea — Speed and footprint: where the time actually goes

**Status: MEASURED. Dated 2026-08-13.** The numbers below are measurements, not
estimates; the *idea* is only what to do about them. Everything was probed on the tree
as it stood, x64, bun 1.3.11, against `example/db/schema.lite` unless a row says
otherwise. Re-run before citing — see §Method.

The investigation started as *how big is litestone and how much RAM does it take*, and
the answer redirected it: **the package is heavy in code and light in memory, and the
only number with real headroom is the write path.** Two thirds of this file is
therefore a record of where *not* to look, which is the more useful half.

---

## The finding: batching, and nothing close to it

On a file-backed database — the shape anything real runs on — writing 5,000 rows three
ways:

| how | µs/op | vs the loop |
| --- | --- | --- |
| `create()` in a loop | 84.7 | — |
| `create()` inside `$transaction()` | 17.7 | **4.8×** |
| `createMany()` | 3.3 | **26×** |

**The loop pays one WAL commit per row.** That is the whole gap. On `:memory:` the same
comparison reads 26.3 → 7.2 µs and looks like a tuning detail, which is exactly how it
gets missed — the benchmark everyone reaches for first is the one that hides it. Put
the database on an SD card and the gap widens again, because fsync is the slowest thing
on the device.

**Nothing needs building.** `createMany()` and `$transaction()` both ship and both
work. The gap is adoption: a seeder, a fixture load, a Caravan job and a
sync-from-upstream all loop `create()` today and pay 26× for it.

Where the framework should push the batch rather than leave it to a caller who will not
find it:

- `Seeder` / `Factory` / `loadFixture()` batch internally, always. These are the call
  sites with the largest row counts and the least excuse.
- A Junction service handed an array should reach `createMany()`, not a loop. The bulk
  `{data, errors}` protocol already exists at the transport; **whether it batches
  underneath is unverified** and is the first thing to check.
- Say it in the docs at the point of `create()`. This is the largest number in the
  whole investigation and it is a *usage* fact, not a code fact — no amount of
  optimising the framework recovers it for a caller who writes the loop.

---

## The per-write floor: 6.7 µs of framework on every row

20,000 inserts, `:memory:`, so the database cost is near zero and what is left is ours:

| | µs/op |
| --- | --- |
| raw `bun:sqlite` insert | 4.3 |
| litestone `create()`, bare schema (no gate, policy, audit, default) | **11.0** |
| litestone `create()`, `example` schema | 27.4 |

**6.7 µs is paid on every write forever**, before a single declaration is added: the
proxy trap, the argument destructure, `extractNestedWrites`, `extractEdgeWrites`,
`processBelongsToNested`, the hook check, `writeData`, and the envelope wrap. Six-odd
object allocations and walks to insert three columns.

The shape of a fix, if this is ever worth doing: precompute a **frozen write plan per
model at `createClient` time** — which fields can be nested, which are edges, which
need stamps — so the hot path branches on booleans instead of re-walking the data
object on every call. That is the defensible half of the AOT idea; see §Dead ends for
the half that is not.

**Reads need no work.** `findMany` of 20 rows is 110.7 µs against a raw-sqlite floor of
98.2 — **1.13×**. `findFirst` by id is 8.0 µs. There is roughly 12 µs of total headroom
in the read path and no way to spend a month there profitably.

---

## The feature ablation: the costs are inverted from the intuition

Each declaration added alone to an otherwise bare schema, 20,000 inserts:

| declaration | +µs/op vs bare |
| --- | --- |
| `@length` / `@email` / `@gte` validators (three of them) | **+0.0** |
| `@@gate("0.4.4.5")` | **+0.5** |
| `@@allow('all', …)` policy | **+0.7** |
| `@default(now())` DateTime | +1.9 |
| `@@log(audit)` | +3.1 |
| `@unique` | +3.7 |

**Gates and policies together cost 1.2 µs — about 4% of an `example`-schema write — and
validators are free.** Any plan that trades the access guarantees for speed is trading
the most load-bearing thing in the framework for nothing measurable. This closes the
question; it does not need re-opening.

The two worth attention are both unglamorous:

- **`@@log(audit)` +3.1 µs** is a second write per mutation, and that is with the cheap
  `logger` driver. Point audit at a SQLite `database` and it costs more. A sampling or
  batching knob on the audit stream is the lever.
- **`@default(now())` +1.9 µs** is constructing a `Date` and formatting ISO-8601 **per
  row**, because litestone stores `DateTime` as ISO TEXT. In a `createMany()` of 5,000
  rows the timestamp is identical to the millisecond. **Compute it once per batch** —
  cheapest real win on this list, and it compounds with the batching work above.

`@unique` +3.7 is genuine SQLite index maintenance and is not ours to remove.

---

## Dead ends — measured, closed, do not look here again

Each of these was a plausible lead that the numbers killed. They are recorded so the
next person spends their week somewhere else.

**Memory is bun's, not litestone's.** At full plateau after 20,000 rows: RSS 203.7 MB,
but `heapUsed` **6.1 MB** and `external` 2.9 MB. Litestone's live footprint is under 10
MB; the rest is JSC declining to return pages to the kernel. An empty `.mjs` file is
already 68.7 MB RSS while `bun -e ''` is 29.8 MB, so ~39 MB is bun's file-module
machinery — four times the whole package's live memory. **Optimising litestone for RSS
is optimising the wrong process.**

**SQLite pragmas are not the memory cost.** `client.js` sets `cache_size = -32768`
(32 MB) on both the write and read connections and `mmap_size = 256 MB`, which reads
like the obvious culprit. Trimming both to 2 MB and 0 moved the plateau from 177.5 MB
to 177.9 MB — **no change**, because `cache_size` is a ceiling a small database never
reaches. Closed.

**`bun --smol` is the whole memory story and it is free.** Same workload: plateau
203.7 → **147.5 MB**, and under a hard `MemoryMax=128M` cgroup it survives where plain
bun is OOM-killed. One flag, no code change, larger than anything the package could win
by shrinking itself.

**Build-time dead-code elimination buys parse time, not memory.** The full `index.js`
bundle minifies to 357 KB and `createClient` alone to 270 KB, so the entire export
surface is only 87 KB over the client. `index.js` does eagerly pull 24 modules / 918 KB
— including `typegen`, `introspect`, `replicate`, `retention` and `migrate`, none of
which a running server calls — and lazy-importing those is worth doing for cold start
and for tidiness. But the ceiling on the whole exercise is roughly 10 MB of RSS, which
is smaller than `--smol` gives for free. Do the lazy imports; do not build a
schema-driven `--define` specialisation pass expecting a memory result.

**If a feature-stripping build is ever built anyway, it must carry a boot guard.** A
build flag that removes gate enforcement is precisely the fail-open shape Invariant 6
and the `@@gate` hazard exist to prevent, now with a build step in between where nobody
looks. The artefact must record the feature-set hash of the schema it was compiled for
and refuse to boot against a schema whose hash differs. Loud crash, never silent
permissiveness.

**Rewriting ORM call sites to `$raw` SQL at build time is unsafe and does not apply.**
Two independent kills. First, raw statements enforce no `@@gate`, `@@allow`,
`@guarded`, `@scoped` or `@@softDelete`, so a textual swap silently starts returning
soft-deleted rows and other tenants' rows with no error, ever — the worst failure class
in this repo. Second, most real call sites are not static: a Junction service calls
`find(ctx.query)` and `autoFilter` builds the `where` from HTTP parameters at runtime,
so there is nothing to compile. The compilable fraction of a real API codebase is
small, a runtime fallback must therefore exist, and the builder can never be deleted —
so the idea cannot pay off in size either. What survives from it is the write-plan
precomputation in §The per-write floor, which keeps every semantic.

**Do not port off bun to node for footprint.** Node's floor is 42.0 MB against bun's
29.8 MB, and the `bun:sqlite` coupling at `client.js:8` would have to be abstracted to
lose the comparison.

**Do not optimise the read path.** 1.13× the raw-sqlite floor, stated above and
repeated here because it is the lead most likely to be picked up again by someone
reading only the write numbers.

---

## Loose end worth a counter

The prepared-statement cache is capped at `maxCacheSize = 500` (`client.js:168`). An
app with more than 500 distinct SQL shapes — many models crossed with many `where`
shapes from `autoFilter` — begins evicting and re-preparing on the hot path, and
nothing reports it. A hit-rate counter would turn a silent cliff into a number before
it reaches anyone.

---

## Not measured

Named so that nobody reads absence as a clean result:

- **`include` relation loading.** Untouched, and the likeliest remaining N+1.
- **Whether Junction's bulk protocol actually reaches `createMany()`.** Assumed above
  that it may not; unverified either way, and it gates the largest recommendation here.
- **ARM.** Everything is x64. The allocator behaviour behind the memory findings in
  particular may differ on a Pi.
- **`bun build --compile`.** The plausible answer to bun's 39 MB file-module overhead,
  and the one number in the memory section nobody has run.

---

## Method

Reproduce before citing. All harnesses were throwaway; the durable ones belong in
`packages/litestone/bench/` next to `audit-bench.mjs` if this work continues.

- **Timing**: N ≥ 5,000 operations per figure, `performance.now()` around the loop,
  µs/op reported. `:memory:` for isolating framework cost from disk, a file database
  for anything about batching or commits — the two disagree by design and the file
  number is the one that matters.
- **Ablation**: one declaration added to an otherwise identical generated schema, fresh
  client per variant, delta reported against the bare run in the same process.
- **Memory**: `process.memoryUsage()` at named points, `Bun.gc(true)` before any
  plateau reading. **Report `heapUsed` and `external` alongside RSS** — RSS alone is
  what made this look like a litestone problem for the first hour.
- **Ceilings**: `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0`. Survival
  under a cap is the question a device actually asks; RSS is a proxy for it and a poor
  one.
