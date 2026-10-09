---
id: litestone-scope
status: partial
dated: 2026-10-07
---

# Idea — Litestone's edge: what it owns, and what it hosts as a battery

**Status: PARTIAL.** Dated 2026-10-07; every count was measured on the working
tree that day. The edge is ruled (`FJS-D635`) and § 3 is built (items 1–5);
`driver jsonl` is still open. It answers *can litestone be feature complete*, by stating the edge
that bounds it.

## The question this answers

*What may litestone grow into, so that "done" is a state the package can reach?*

Data modeling of a row in one database has four axes, and each one has a known end
in the prior art:

- **Shape**: column kinds, relations, constraints, indexes, derived values (SQL's
  type system).
- **Access**: the gate, row policies, protected fields, tenancy (row-level
  security).
- **Life**: transitions, soft-delete, effective time, the audit trail, sealing
  (state machines).
- **Evolution**: migrations, the differ, the release surface (expand and contract).

A feature on one of the four is litestone's. A feature on none of them answers a
different question, and that is where the package has been growing without a stated
limit.

## 1. What is in `src/` and on no axis

| Battery | Lines | Imported by the core? | Known to the core by name? |
| --- | --- | --- | --- |
| object storage: `storage/`, `plugins/file.js` | about 780 | no; only the plugin imports `storage/` | as `File`, a Shape type. A write with bytes is refused unless a plugin `handles('File')` ([client.js:3009](../packages/litestone/src/core/client.js#L3009)) |
| replication: `tools/replicate.js` | 318 | no | no; it drives the litestream binary (`FJS-D31`) |
| transform: `transform/` | about 1,600 | no; the CLI imports it lazily | no |
| Studio: `tools/studio.html`, `cmdStudio`, `tools/assistant.js` | 7,907 + about 2,040 + 345 | no | no; it reads through `createClient` and `$setAuth` |

All four already sit outside the core. What none of them has is a written edge or a
check that keeps it there. Three loose ends:

- **The main entry re-exports the batteries** ([src/index.js:39-52](../packages/litestone/src/index.js#L39-L52)):
  `replicate`, `FileStorage`, the storage helpers, and the transform DSL. The DSL
  includes a `$`, which is not Junction's ambient `$`. The one outside caller is
  `example/api/src/core/db.ts`, importing `FileStorage`.
- **Studio's server is about 2,040 lines inside `tools/cli.js`**
  ([cli.js:2046](../packages/litestone/src/tools/cli.js#L2046)).
- **Studio keeps its saved queries in a `_litestone_studio_queries` table inside
  the app's own database.**

## 2. `jsonl` is the one that is tangled

`driver jsonl` is a second storage engine written into the language. It is 849 lines
of driver, with 34 references in `client.js` and 43 across the parser, the DDL
emitter and the differ. A `jsonl` model has no update, delete, migration, FTS,
cursor or policy engine, and the browser client refuses the driver by name.

It is not a stray battery. **The audit trail is its only real user.** As general
model storage, `driver jsonl` is declared in one schema in the tree,
`packages/litestone/example/schema.lite`. **The audit trail's `driver logger` is
stored through it**: `makeJsonlTable` serves both
([client.js:9533](../packages/litestone/src/core/client.js#L9533)). Basecamp and
`example` both declare a logger database. FJS-D180's lock and FJS-665's compaction
work are the cost of keeping that format correct.

The trail already has a second form that needs none of this. On a SQLite database
it names a real model (`model AuditLog`), which can carry a `@@gate`, an `@@allow`,
an index and a migration — *the whole reason to put a trail in SQLite rather than
in a directory of jsonl* (`parser.js`, the `logModel` check;
`IDEAS/shipped/logbook.md` § 3).

## 3. What `FJS-D635` leaves to build

**Built 2026-10-08**, items 1–4 (`docs/changes-archive/litestone.md`). One thing the test found that this section missed: `src/core/client.js` imported `tools/retention.js`. `@@retention`'s runner was on the axis but filed under `tools/`, so it moved to `core/`.

About a day, and none of it touches the core:

1. **The import test.** It fails if anything under `src/core/` imports
   `storage/`, `transform/`, `tools/` or `plugins/file.js`. Until it lands nothing
   enforces the edge.
2. **Subpaths in place of the main entry's re-exports.** `./storage` already
   exists; `./replicate` and `./transform` join it, and `FileStorage` moves with
   storage. The one outside caller, `example/api/src/core/db.ts`, moves in the same
   change. The transform `$` stops being importable from `@frontierjs/litestone`.
3. **Studio's server out of `cli.js`** (`cmdStudio`, about 2,040 lines) into its
   own file under `tools/`. A file split with no logic change.
4. **Studio's saved queries out of the app's database.** A sidecar file beside the
   database rather than `_litestone_studio_queries` inside it.

The fifth item is the axis column on the catalog, which would let `catalog.test.ts` grade
*a new word names its axis*.

**Priced 2026-10-08.** The catalog has 113 rows in 11
groups, and 12 words sit at two levels (`log`, `check`, `allow`, `scope` and others), so an axis is
keyed by (word, level) and never by word alone. Against the four axes:

- **Four groups are one axis whole.** `identity`, `relate`, `transform` and `validate` are shape:
  40 rows and no judgment.
- **Five groups have a default and a few rows that differ.** `declare` is shape except `claim`,
  `tenancy` and `scope`, which are access. `derive` is shape except `hardDelete` and `keep`, which
  are moves. `protect` is access except `immutable` and `sealed`, which are moves, and `check`,
  which is shape. `access` is access except `transitions`, which is moves. `shape` is shape except
  `softDelete`, `expires`, `effective` and `commitment` (moves) and `external` and `noStrict`
  (migration). That is about 18 rows that differ from their group's default.
- **`operate` has no default.** `sync` is moves, `auth` and `anonymous` are access, and `db`,
  `trait`, `createdBy` and `updatedBy` are shape: 8 rows, one at a time.
- **Three are real judgment calls, not lookups.** `log`/`@@log` and `keepVersions`: the trail is a
  record of moves, but nothing in it decides a move. `version`: is optimistic concurrency a move or
  access? A fourth question comes from the count: migration has two words, because it is mostly
  verbs (`migrate`, `autoMigrate`) and not vocabulary. Whether migration is an axis the language
  has words for, or only a property of the client, needs answering before the column claims four
  values.

**Built 2026-10-08** as `AXES` beside `TIERS` in `catalog.js`, not as a group default with
overrides: with about 26 overrides the default saves little, and a second table to keep agreeing
with `group` is a second origin. The three judgment calls: the trail and `version` are **life**
(a record of moves, and a guard on them), `keepVersions` is a **battery** (a File-storage knob,
with `hardDelete`). Migration stays an axis, `evolution`, holding `@@external` alone; `noStrict`
is shape because it changes the DDL of one table, not how a shape changes. Differs from the
pricing above in three placements: schema-level `scope` is shape (it names what `@@exclude`
serializes on), and `@@createdBy` / `@@updatedBy` are life with their field forms. Test:
`catalog.test.ts` § *axes*.

Cost: about half a day once the three are answered. That covers an axis per group, overrides on
roughly 26 rows, the test (every row resolves to one of the four axes; a new group names its
default), and the reference snapshot regenerated. A column on all 113 rows is the same data
written about 87 more times.

## Open questions

- ~~**What is litestone's edge?**~~ **Answered 2026-10-08 (`FJS-D635`): B — The batteries stay in litestone behind a seam. Nothing under `src/core/` imports them, a test fails if anything does, and each one leaves the main entry for its own subpath (`./storage`, `./replicate`, `./transform`). Studio's server leaves `cli.js` for its own file, and its saved queries leave the app's database. A new `.lite` word, `$` method or `src/` directory names the axis it serves, or it is a battery.**
  Litestone owns what is true about a row in a database: its shape, who may read
  and write it, what moves it may make, and how its shape changes. Object storage,
  moving data between machines, ETL, and showing data to a person are batteries.
  Work over time is caravan's, and invariants spanning rows stay in application
  code (`FJS-D168`).
  - **A** — Each battery moves to its own package. The core's package exports only
    the four axes.
  - **B** — The batteries stay in litestone behind a seam. Nothing under
    `src/core/` imports them, a test fails if anything does, and each one leaves
    the main entry for its own subpath (`./storage`, `./replicate`, `./transform`).
    Studio's server leaves `cli.js` for its own file, and its saved queries leave
    the app's database. A new `.lite` word, `$` method or `src/` directory names
    the axis it serves, or it is a battery.
  - **C** — Admit them into the core and widen the edge to name them.
  - **Recommend B** — § 1 measured all four as already outside the core, so B costs
    about a day and no core surgery. It writes the edge down and gives it a
    failing test (§ V's ninth question), and A stays open as a later move with
    nothing to untangle first. C makes "done" unreachable, which is the question
    this paper set out to answer.
- **How does the catalog carry a word's axis?** § 3's fifth item, priced there.
  - **A** — An axis per GROUP, with an `axis:` override on the about 26 rows that differ from
    their group, and none for `operate`. A test fails on a row with no axis and on a group with no
    default. `log`, `keepVersions` and `version` are ruled first.
  - **B** — An `axis` column on every row. Same test, but 113 cells, and 87 of them repeat the
    group's answer.
  - **C** — No column. D635's edge stays graded by directory and import, which
    `test/edge.test.ts` already does, and a new word's axis is a review question.
  - **Recommend A** — the axis is mostly DERIVED from the group, so writing it on every row is a
    restatement that can drift from the group (§ V's fifth question). C leaves the ruling's third
    sentence (*a new `.lite` word names the axis it serves*) with no artefact, which is the
    `none` answer to § V's ninth question, and the sentence then reads as enforced when it is not.
- **What happens to `driver jsonl`?** **On hold (owner, 2026-10-08):** not to be built or ruled until the owner reopens it. The measurement below stands.
  § 2: a second engine in the language, whose one real user is the audit trail.
  - **A** — Keep both drivers, and move `jsonl` behind the engine seam
    `#sql-engine` already gives `bun:sqlite` and wasm (`FJS-D305`). The core learns
    *an engine answering a subset of verbs* generically, in place of the 77
    references to `jsonl` it has now. Weeks of work, and two engines stay.
  - **B** — Retire `driver jsonl` as general model storage, and keep the format
    only as the logger's private storage, inside the audit-trail code. Removes the
    request-log use (only `packages/litestone/example` declares one); the `logger`
    branches stay.
  - **C** — Retire the format. The audit trail moves to its SQLite form, and
    `drivers/jsonl.js`, `jsonl-index.js`, the jsonl half of `retention.js` and
    `driver logger` go. Basecamp and `example` redeclare their audit database
    (pre-alpha: the old files are deleted, not migrated). One engine; the trail
    gains gates, indexes and migrations, and runs in the browser. Retention
    becomes a `DELETE` plus incremental vacuum rather than a file rewrite.
  - **D** — Move `jsonl` and `logger` together into an audit battery package
    (the first question's **A**, for this one area).
  - **Recommend C, after one measurement** — it is the one-level-simpler version:
    one storage engine, and FJS-D180's lock and the compaction machinery stop
    being litestone's to keep correct. The measurement that could overturn it is
    write cost: a `create()` on a logged model with the trail as a SQLite insert in
    a second database, against the jsonl append, interleaved A/B in
    `bench/audit-bench.mjs`. If the SQLite trail costs much more on the hot path,
    **B** is the fallback.
  - **Measured 2026-10-08: the SQLite trail is cheaper.** `bun run bench
    audit-trail-ab` (§ 13): a `create()` on a logged model, trail write flushed
    and settled inside the timing, 500 per batch, 12 interleaved rounds. Four runs:
    jsonl append 152–163 µs/op, SQLite insert 109–121 µs/op, a ratio of
    0.67–0.74; the hot path before the deferred write is the same for both,
    47–53 µs. Taken on a loaded machine (load 1.7–3.4), so the absolute numbers
    are soft and the ratio held across every run. The measurement that could
    overturn **C** does not, and **B** is not needed as a fallback.

## The nine, for the edge

1. **Origin.** One sentence, in one ruling; the axis column (below) derives from it.
2. **Concept.** *Battery* is § IV's own word; the four axes are named by their
   existing rulings, not coined.
3. **Complexity.** The problem's own: scope creep in a data layer is the
   *batteries vs. smallness* adjudication.
4. **Predictability.** Better. A feature's home is decided by one question.
5. **Derived.** The import test reads the tree, not a list.
6. **Owner.** § IV *batteries vs. smallness* already owns the rule; this applies it.
7. **Boundary.** The subpath exports make the edge visible to a caller.
8. **Failure.** A core import of a battery fails the suite, which is proportional:
   it is a structural change, never an accident worth a warning.
9. **Silence.** What must stay true is that the core imports no battery. The
   import test fails when it stops, and **until that test lands the answer is
   `none`**. A new word naming an axis is graded by `catalog.test.ts` once the
   catalog carries an axis column; until then, also `none`.

**Tier:** Assessment until ruled; the ruling is Register.
