---
id: performance-regression-watch
status: idea
dated: 2026-08-21
---

# Idea — Nothing watches the numbers

**Status: IDEA, with a measurement attached. Measured 2026-08-18** on x64 / bun,
against the tree at `4f46e5b`. The measurement is real and reproducible by the method
in §Method; what to *do* about it is the idea.

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
+35% update); there is no case, so it cannot regress visibly.

---

## What to build

1. **Cases for the declarations added since July**, in the ablation shape
   `speed-and-footprint.md` §Method already defines — one declaration on an otherwise
   identical schema, delta against the bare run in the same process. Tenancy, `@@allow`
   with a non-trivial predicate, `@@transitions`, `$audit`, `@version`, and the
   softDelete×unique crossing. This is the larger half of the value and it is `S`.
2. **An A/B runner** — `bench/ab.mjs <ref>`, which does the worktree dance this
   investigation did by hand: check out the ref, run both sides alternating N rounds,
   report min and per-round win counts rather than a mean. Mins, because the noise here
   is one-sided. Nothing to commit but the script.
3. **A CI phase, carefully.** A threshold gate on a shared runner is the wrong shape —
   rounds 4–6 of this measurement had spread wider than the effect. What *is* sound on a
   noisy runner is the same comparison against the **base ref**, both sides on the same
   machine in the same run, reported and not failed — the shape `access` already uses,
   for the same reason. Cost is the run time: the full bench takes ~35 s, of which 31 s
   is the `autocommit-vs-tx` case alone, so a CI phase wants `bench:core` or a new
   filter rather than the whole file.

The register question this raises and does not answer: **is a measured 15–20% drift a
defect?** It has no `FJS-###` and per `ISSUES.md`'s own rule that means it is not open.
Filing it needs a diagnosis first, which needs (1).

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
  §Method is the ablation shape (1) should follow, and its closing line already says
  the durable harnesses belong next to `audit-bench.mjs`
- `packages/litestone/docs/PERFORMANCE_AUDIT.md` — the audit and its one
  re-verification; the source of every "before" number quoted here
- `packages/litestone/docs/performance.md` — untouched since litestone's initial
  commit (2026-04-25) and describing a tree three months gone. Repair or retire it
  alongside (1)
- `IDEAS/testing-and-ci.md` — 0.1, the same argument for correctness rather than speed
