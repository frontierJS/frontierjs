---
id: performance-regression-watch
status: proposed
dated: 2026-09-12
---

# Idea — Nothing watches the numbers, and what a performance claim should be

**Status: PROPOSAL, with a measurement attached.** The drift below was measured
2026-08-18 on x64 / bun against `4f46e5b` and is reproducible by §Method. The
three-tier shape in §What a performance claim is was added 2026-09-12 from the prior
art in §What the field does, ahead of alpha; nothing in it is built.

`packages/litestone/bench/audit-bench.mjs` exists, covers eleven cases, and is run by
hand. It has been run twice: at the audit that produced it (`docs/PERFORMANCE_AUDIT.md`,
2026-07-18) and at the re-verification recorded in that file's header (2026-08-06).
No CI phase calls it, no pre-push hook calls it, and nothing compares one run to the
last. **A benchmark nobody runs is a benchmark that reports the tree it was written
against**, which is the same failure `snapshots` exists to prevent one realm over.

---

## What twelve days cost

Between the 2026-08-06 re-verification and 2026-08-18, litestone's `src/` took ten
commits and **+15,494 / −3,636 lines** — `client.js` +4,548, `parser.js` +1,333,
`policy.js` +593, plus four new files (`access.js`, `release.js`, `mutate.js`,
`tenancy.js`). Interleaved A/B against a worktree at `762cb76`, the last tree the bench
had been run on, with the bench file byte-identical on both sides:

| case | 762cb76 | 2026-08-18 | reading |
| --- | --- | --- | --- |
| `findUnique` by PK | 2.51 µs | 2.52 µs | flat |
| `upsert()` M1 fast path | 21.4 µs | 21.5 µs | flat |
| `create()` single row | 13.8 µs | 16.6 µs | **+20%**, higher in 5 of 6 rounds |
| `findMany` where+limit 100 | 54.4 µs | 63.9 µs | **+17%**, clean separation in the quiet rounds |
| 200 gated `findMany` | 29.1 µs (min) | 34.8 µs (min) | **+20%**, higher in 6 of 7 rounds |

Every fix the audit claims still holds — `GatePlugin` resolves `getLevel` **0** times
across 200 gated reads, `autoMigrate` in-sync is 0.3 ms, warm JSONL reads are ~0 ms,
`upsert()` issues one statement. **Nothing regressed structurally.** What moved is the
per-call cost of the write path and the policied read path, by roughly what a
declaration or two would cost per `speed-and-footprint.md`'s ablation table — which is
the point: it is small enough that only a comparison finds it, and no comparison was
being made.

**The drift is undiagnosed.** It is not attributed to a commit or a code path here, and
`policy.js` growing 593 lines is a suspicion rather than a finding.

## The useful negative result

A first pass read the absolute numbers as **2× worse than `PERFORMANCE_AUDIT.md`
records** — `findMany` 64 µs against a documented 38.4. That is the machine, not the
tree: the 762cb76 worktree reads 54 µs on the same hardware in the same minute. The
audit file already warns about this in bold and it was still the first wrong conclusion
reached. **A committed absolute number is a statement about one laptop**, and the
durable artefact is therefore a runner, never a table of microseconds.

## The half the bench cannot see

Grepped against `audit-bench.mjs`, the count of cases touching each declaration added
since the bench was written is **zero** for all of: `tenancy`, `@@allow`, `@@transitions`,
`db.$audit()`, `@version`. Two of those are hot-path on every request in an app that
declares them:

- **Row tenancy desugars into `@@deny` plus a `@default(auth().…)` stamp**, so every
  read on every tenanted model carries an extra compiled predicate. Fifteen of
  basecamp's models declare one.
- **The soft-deleted `@unique` pre-check** (`client.js:3111`) adds work to `create()` on
  any model with both `@@softDelete` and a `@unique` column — the shape most identity
  tables have.

`@version` is measured, but only as a prose note in the audit header (+7% create /
+35% update); there is no case, so it cannot regress visibly. And the whole READ side
of access control is unmeasured — [FJS-621](../ISSUES.md#fjs-621): a policy compiling
the target's own policy into a subquery, `@from` as a correlated subquery per row,
`@computed` forcing filter and sort into JS.

**Outside litestone there is nothing at all.** Junction, sierra and css carry no bench;
`packages/mesa/mesa-bench` is a js-framework-benchmark harness excluded from CI by
name. The one byte finding on record, [FJS-904](../ISSUES.md#fjs-904) — 65% of a
static build's JavaScript unreachable from any page — was found by reading a bundle,
not by anything that would have failed.

---

## The repo already has the right half, unnamed

Several suites assert **why** something is fast rather than how long it took, and none
of them is called a performance test:

- `packages/caravan/tests/scale.test.ts` asserts a QUERY PLAN — no `TEMP B-TREE` — and
  its header says why: a millisecond threshold in CI is a coin flip on a loaded machine.
- The audit's H4 counts `getLevel` resolutions (0 across 200 gated reads) and M1 counts
  statements through `$tapQuery` (one per `upsert()`).
- `packages/litestone/test/policy-paths.test.ts` asserts EXPLAIN names no `AUTOMATIC`
  index for a relation hop.

These answer identically on every machine, which is the property a CI gate needs and a
wall-clock number does not have. The proposal below makes that half deliberate and adds
the two halves it cannot carry.

---

## What the field does

Surveyed 2026-09-12. Six patterns recur across mature projects, and each has a
documented failure behind it.

**Gate on a count, not a time.** SQLite's CPU claim per release is `speedtest1` under
cachegrind, repeatable to seven significant digits where wall time repeats to one — the
precision that lets it accept a 0.05% optimization ([sqlite.org/cpu.html](https://sqlite.org/cpu.html)).
rustc-perf defaults to `instructions:u` for the same reason: measured outliers ±1.3%
against ±9% for wall time ([internals](https://internals.rust-lang.org/t/what-is-perf-rust-lang-org-measuring-and-why-is-instructions-u-the-default/9815)).
Django gates on `assertNumQueries`; Vue and size-limit gate on bytes. Every one of them
states where its proxy lies — I/O, parallelism, cache effects.

**Compare in the same job, interleaved.** Shared CI runners differ by up to 3× in level
between builds ([aakinshin](https://aakinshin.net/posts/github-actions-perf-stability/)),
and a 2% wall-time gate on GitHub-hosted runners measured a 45% false-positive rate
([CodSpeed](https://codspeed.io/blog/benchmarks-in-ci-without-noise)). tachometer
round-robins A and B and samples until a 95% CI clears a declared horizon
([google/tachometer](https://github.com/google/tachometer)); benchstat wants ≥10
interleaved runs and uses Mann-Whitney ([benchstat](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat)).

**State the claim as a ratio to a floor.** js-framework-benchmark reports a factor
against vanillajs rather than milliseconds, and rolls up with a weighted geometric mean.

**A threshold per case, never one global percentage.** MongoDB started with a flat 10%
and measured false positives up to 99%, then moved to change-point detection over the
series ([arXiv 2003.00584](https://arxiv.org/abs/2003.00584)). Node's own docs warn
that twenty benchmarks at α=0.05 will show one significant result by chance.

**A person triages.** Rust's weekly triager, MongoDB's Build Baron, Chromium's sheriffs
with Pinpoint bisection. The tooling nominates; accepting a regression is a written
answer.

**Latency is a tail, measured at a constant rate.** A closed-loop load generator stops
sending during a stall and under-samples exactly the tail it should record — coordinated
omission ([wrk2](https://github.com/giltene/wrk2)). SLOs are stated as percentiles
("99% < 400 ms"), never a mean ([SRE book](https://sre.google/sre-book/service-level-objectives/)).

The anti-patterns the same sources name are the mirror: a static global threshold,
absolute wall time across CI builds, a mean, a closed-loop generator, a synthetic
benchmark tuned to (V8 retired Octane for it), and a detector whose alerts come and go
between runs.

---

## What a performance claim is

**Three tiers, named by what they do to a build.** The tier a claim belongs to follows
from how much noise its measurement carries, and only a measurement that repeats may
fail anything — *ergonomics vs. strictness*, where strictness follows what a false red
costs.

### Gated — a count or a byte

A claim whose answer is identical on every machine. Two homes, split by whether the
number is a design fact or a quantity:

- **A design fact is a test** in the package's own suite, the shape `scale.test.ts`
  already has: *one statement per `upsert()`*, *no `TEMP B-TREE`*, *zero `getLevel`
  per gated read*. It changes only when the design does, and a change is a code review.
- **A quantity that features legitimately move is a baseline** that ratchets down only
  — Invariant 14's mechanism, not a new one: `--update` writes an improvement back and
  cannot raise; `--adopt` is the separate verb that can, so a raise is a visible line in
  a diff with a reason beside it.

What each package can count:

| package | design facts (tests) | quantities (baselines) |
| --- | --- | --- |
| litestone | statements per verb, plan shape per policy hop, `getLevel` resolutions | prepared-statement shapes per request, statement-cache evictions over `example` |
| junction | DB reads per request, frames per publish, no body read before the length check | modules loaded at boot |
| mesa | DOM operations per update, recomputations per signal write | compiled output bytes per fixture — reproducible by Invariant 12 |
| sierra | nothing reachable from no emitted page ships | gzip bytes per surface (spa · static · widget), runtime floor bytes |
| css · ui | — | stylesheet bytes |

### Reported — a ratio against the base ref

A timing, compared in the same job and never across jobs. One runner does the worktree
dance §Method describes by hand: check out the base ref, alternate the two sides N
rounds, report the min, the per-round win count and a significance mark, and roll each
package up as a geomean.

**Each case declares its ceiling as a ratio to a floor it measures in the same
process**, and the case file is where that number lives:

- litestone read ≤ 1.25× raw `bun:sqlite` (measured 1.13× in `speed-and-footprint.md`)
- litestone bare write ≤ 3× raw (measured 2.6×)
- each declaration in the ablation ≤ a stated µs delta over the bare schema
- junction request ≤ a stated factor over a raw `Bun.serve` handler
- mesa's js-framework-benchmark operations ≤ a stated factor over vanilla

The first two are starting points read off one measurement, not ratified numbers. A
case with no declared ceiling is refused by the runner rather than run unjudged.

The CI phase **reports and does not fail**, the shape `access` already uses for the
same reason: a timing red on a shared runner trains everyone to skip the phase. What it
reports is read by a person, and a regression kept on purpose gets a line in the
package's `CHANGES.md` saying what it bought.

### Recorded — an absolute, on named hardware, per release

The numbers a device or an operator actually asks about, which no ratio answers:
RSS and `heapUsed` under `--smol`, survival under a `MemoryMax` cgroup, cold start, the
write ceiling on a real file with fsync, and junction's p99 at a constant request rate.

**These go in the release's `CHANGES.md` entry, stamped with machine and bun version** —
a register, because an absolute number is history the day after it is taken, and never
a snapshot, because a `--check` over a timing would fail on noise. Any speed claim the
website or a README makes cites one of these or is not made.
`packages/litestone/docs/performance.md`, untouched since the initial commit and
describing a tree months gone, is retired when the first entry lands.

### The failure this can still hide

**A case that throws, or a filter that matches nothing, reads as a quiet run.** That is
not hypothetical: `gate-getlevel` died on a wrong accessor and was skipped for three
weeks. The runner fails on any case that throws and prints the count of cases it ran
against the count declared — the control the `scaffold` phase keeps for the same
reason, since *nothing moved* and *nothing was measured* are otherwise one answer.

---

## Order

1. **Coverage before any ceiling.** Ablation cases for tenancy, `@@allow` with a
   non-trivial predicate, `@@transitions`, `$audit`, `@version` and the
   softDelete×unique crossing, plus FJS-621's read path — a ceiling written today sits
   on numbers that do not exist. `S`.
2. **The gated tier.** Promote the counts already asserted into named cases, add the
   byte baselines per surface. The only tier that can fail a build, and the cheapest.
3. **The runner and the reported phase.** `bench:core`-sized, since the full file is
   ~35 s and 31 s of it is `autocommit-vs-tx`.
4. **The first recorded entry**, at the alpha release.

Deferred, each on a named trigger: change-point detection once a series exists to run
it over; a dedicated runner once the reported tier's noise is shown to hide a real
regression; CodSpeed once its Bun support is known (§Open).

## Open

- **Does instruction counting work on Bun?** SQLite's and rustc-perf's gate is a
  cycle count, which would move litestone and mesa timings from *reported* to *gated*.
  JSC tiers code up on background threads and GC timing varies, so a count under
  cachegrind may not repeat; `BUN_JSC_useJIT=0` would repeat and measures an interpreter
  nobody ships. **Unmeasured — the spike is the next step.** If it fails, the gated
  tier stays counts and bytes, which is still sound.
- **Is a measured 15–20% drift a defect?** It has no `FJS-###` and per `ISSUES.md`'s own
  rule that means it is not open. Filing it needs a diagnosis, which needs Order (1).

## Decision questions

- *Another origin?* No. Ceilings live in the case, baselines in their file, absolutes
  in `CHANGES.md`; this record carries the shape and no number of authority.
- *Concept budget?* Unchanged. *Baseline* and its ratchet are Invariant 14's; *reports
  rather than judges* is the `access` phase's. The tiers are named by verdict. *Budget*
  is refused as a name — it already means the concept budget.
- *The problem's complexity?* Yes: three noise levels, three tiers.
- *Predictability?* Improves — a red is always real, because only a repeating answer
  can produce one.
- *Derived?* Baselines are written by `--update`, recorded entries by the runner.
- *One owner?* One runner, one baselines file; a design fact stays a test.
- *Boundary explicit?* A case declares its tier and ceiling or is refused.
- *Failure proportional?* Only the tier with a near-zero false-positive rate gates.
- *Wrong without anything saying so?* Yes, by a case that silently stops running — the
  declared-count control above is the artefact.

---

## Method

Reproduce before citing.

- `git worktree add --detach <dir> 762cb76`, then verify the bench file is identical on
  both sides (`diff <(git show <ref>:…) …`) — the bench was itself edited on 2026-08-10
  and comparing two different harnesses measures the harness.
- Alternate: NEW, OLD, NEW, OLD, in one shell, same minute. Never all of one then all of
  the other.
- Six rounds on `baseline`, three on `upsert` and `gate-getlevel`, seven on
  `gate-getlevel` alone. **Report min and how many rounds each side won**, not a mean —
  a single loaded round (round 4 here) moves a mean by more than the effect.
- `bun bench/audit-bench.mjs <filter>` takes a substring of the `run()` name, which is
  not the printed row label: `baseline`, `gate-getlevel`, `upsert`, `plugin-noop`,
  `automigrate`, `jsonl-scan`, `sigv4`, `sequence-createmany`, `autocommit-vs-tx`,
  `setAuth-rebuild`, `regex-validate`.

## See also

- `IDEAS/speed-and-footprint.md` — where the time goes, measured 2026-08-13. Its
  §Method is the ablation shape Order (1) follows, and its dead ends are why memory is
  a recorded number rather than a gated one
- `packages/litestone/docs/PERFORMANCE_AUDIT.md` — the audit and its one
  re-verification; the source of every "before" number quoted here
- `IDEAS/offline-first-and-release.md` § A byte budget — the byte half of the gated
  tier, argued before and never given a number
- `IDEAS/scaling.md` — why the recorded tier's junction number is per process
- `IDEAS/testing-and-ci.md` — 0.1, the same argument for correctness rather than speed
