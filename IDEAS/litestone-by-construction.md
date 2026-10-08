---
id: litestone-by-construction
status: proposed
dated: 2026-10-07
---

# Idea — Litestone by construction: a rule no verb can skip

**Status: PROPOSED. Nothing here has started.** Dated 2026-10-07; every number
below was measured on the working tree that day. It is F9's fix (1) from the
[foundation audit](https://claude.ai/code/artifact/f629d9fc-1ae7-4aaf-b7fe-20a863c41211),
the second phase of the `client.js` split, and the construction half of
`provable-enforcement.md` (4.30), which owns the PROOF half.

## The question this answers

*What would make a defect in litestone hard to WRITE, rather than caught after it
ships?*

Today's answer is detection. The tripwires exist and each one found a live defect
on its first run: `test/verbs-rules.test.ts` (`FJS-720`), `test/matrix.test.ts`,
`test/policy-interpreters.test.ts` (`FJS-719`), the differ residue (`FJS-718`),
`test/undeclared-names.test.ts`. They grade the code after it is written. The code
itself is still built by enumeration, so every new rule and every new verb is
another chance to miss one, and a missed one ships until a grid catches it.

## 1. Where it stands

| Measure | Count | What it costs |
| --- | --- | --- |
| `makeTable`'s span in `src/core/client.js` | lines 329–8282 of 11,797 | one closure, about 15 verbs, each restating the rule sequence |
| `buildPolicyFilter(` call sites in `client.js` | 18 | a new verb owes a call; a missed one is `FJS-720` |
| soft-delete filter call sites | 19 | `FJS-262`, `FJS-216` |
| `tx.wrapExclusive(` / `asConstraintError(` | 10 / 8 | the lock and the error mapping, once per write verb |
| event and log emit calls | 40 | a zero-row write announcing, a bulk write logging nothing (0.7) |
| `params.push(` in `client.js` | 55, of which 31 spread another array | SQL text and its binds built apart; the bind order is the correctness |
| hand-quoted `"${…}"` identifiers in `client.js` | 270 | against 19 `quoteIdent(` uses repo-wide, none in `client.js` |
| distinct `ctx.*Map` names in `client.js` / across `src/` | 33 / 42 | a missing entry reads as *this model has no such rule* |
| `checkJs` | off | the tsconfig comment says 3,131 errors when last tried |

Two of these already have the right shape at a smaller scale. `query.js` has a
symbol-branded fragment, `sqlFragment` and `isSqlFragment`, that carries `{ sql, params }`
together, and `sql` splices it while keeping its binds in place. Today only `now()`
makes one. `FJS-722` already shares one table object across every flavor through an
`AsyncLocalStorage`, so the principal is no longer baked into what gets built, and
nothing below has to revisit that.

Most of the 270 quoted identifiers interpolate schema-derived names, which
Invariant 8 permits. The problem is that nothing tells a schema name apart from a
caller's, so the invariant holds only because someone read each site.

## 2. The steps, in order

Each step lands one verb or one module at a time, with the full suite green
between changes. A step proves itself against the tripwires in § 3, which stay
independent of the code they grade (`FJS-597`'s rule: *an expected verdict is
never derived from the code it grades*).

### Step 0 — tighten the two loose tripwires first

`FJS-1871` says `shared-tables.test.ts`'s bound is 8× the cost it guards, and
`FJS-1872` says nothing drives `ExternalRefPlugin` with two principals. Both are
marked `stale?`. Re-probe them and close or fix them, because a refactor proven by a
loose tripwire is not proven. **Effort S.**

### Step 1 — a fragment is SQL and its binds, together

Promote `sqlFragment` from `query.js` to the internal currency for every clause
litestone builds. Add `and(...frags)`, `or(...frags)`, `join(frags, sep)` and
`ident(name)`; `ident` routes through `quoteIdent`, which stays the one owner
(`FJS-D169`). A clause builder returns a fragment, and a verb assembles fragments.
`whereParams.push(...policy.params)` and the separate SET and WHERE arrays in
`updateMany` disappear.

- **Class removed:** bind-order drift, the kind of mistake behind `FJS-262` and
  `FJS-216`. A placeholder and its value can no longer travel separately.
- **Class removed:** an unchecked identifier. Once `ident()` is the only spelling,
  `"${` inside a SQL string in `src/core` becomes a refusal by name: a test, or a
  `fli check` rule.
- **Start at** `buildSQL` (line 4069) and `updateMany`, the smallest write verb.
- **Effort M.**

### Step 2 — a model's facts in one record: `shape`, completed

A model's facts live in two places today. `makeTable(readDb, writeDb, shape, ctx)`
takes a `shape` holding some of them, destructured with defaults
(`softDelete = false`, `fieldPolicy = {}`). The rest come from 33 `ctx.*Map`s read by
`[modelName]`. In both places a fact nobody passed reads as *this model has no such
rule*.

Grow `shape` into the one record. It is built once per model by one function, every
facet is present, and a facet the model does not declare is an explicit empty
value. The record is frozen, and the defaults in the destructure go away.
`ctx.versionMap?.[modelName]` becomes `shape.version`.

All readers are inside litestone (`client.js`, `args.js`, `field-policy.js`,
`include.js`, `policy.js`, `valuesets.js`, `plugins/gate.js`,
`plugins/capability.js`), and every one moves in the same change. That includes the
plugin `ctx` (`FJS-D03`): a plugin reads `ctx.shapes[model]` and the maps leave the
contract, because nothing outside litestone depends on them (§ IV,
*preservation vs. evolution*).

- **Class removed:** fail-open on a missing fact, and the shape behind *a feature
  is incomplete while only one of those paths knows about it*. The builder either
  answers a facet for every model or refuses to start.
- **Effort M.**

### Step 3 — `checkJs` by directory, ratcheted

Turn `checkJs` on for the modules Phase 1 split out of `client.js` (`args.js`,
`transaction.js`, `stamps.js`, `computed.js`, `field-policy.js`, `include.js`,
`hooks.js`, `audit-log.js`, `databases.js`) and for `query.js`. Record each count in
`scripts/typecheck-baselines.json` (Invariant 14). Steps 1 and 2 get JSDoc types,
so the fragment and `shape` are checked wherever they reach.

A branded `RawRow` and `Row` turns *a row is shaped only by `read()`* (`FJS-223`)
from a rule someone remembers into a type error.

- **Effort S** to start, then ongoing as each module joins.

### Step 4 — rules declared once, and the read path folds them

Each read rule becomes a record:
`{ name, verbs, where(shape, flags) → fragment | null }`. The rules are kept in one
array, in the order `buildSQL` applied them before (now `READ_RULES`): global filter, plugin read
filters, soft-delete, templates, effective-time, the caller's where, the policy.
The order invariant then lives in exactly one place. Every read verb (`findMany`,
`findFirst`, `findUnique`, `count`, `aggregate`, `groupBy`, the cursor, search and
tree paths) asks `rulesFor('read', shape)` and folds the answer into a fragment.

A pair of rule and verb that the registry does not name is refused at load, so the
grid's `-` cells become data rather than silence.

- **Proof:** `VERBS_REPORT=1` prints the same grid before and after.
- **Effort M–L.**

### Step 5 — a write verb plans, and one executor runs the plan

A write verb becomes a pure
`plan(args, shape) → { sql, params, before, after, logs, announce }`.
One `execute(plan)` owns everything the verbs now each repeat:

- the lock (`wrapExclusive`)
- constraint mapping (`asConstraintError`)
- `RETURNING`
- the post-update policy
- the cardinality and exclusion notes
- `emitLogs`
- the announcement

That moves 10 lock sites, 8 error mappings and 40 emit calls to one place. A plan
is a value, so it can be snapshot-tested without SQLite.

- **Order:** `updateMany`, `deleteMany`, `createMany`, then the single-row verbs,
  then `upsert`, and `upsertMany` last, because it is a create and an update at
  once (`FJS-720`).
- **Effort L.**

## 3. Proof for every step

From `packages/litestone`:

1. `bun run test`
2. `VERBS_REPORT=1 bun test test/verbs-rules.test.ts` and
   `MATRIX_REPORT=1 bun test test/matrix.test.ts`, with each grid compared to the
   one printed before the step.
3. `bun run test:browser` when a step touches the engine or host seam.
4. Then `example` and `basecamp` run `bun run verify`, and `sierra` runs
   `bun run test:safety`.

Speed is measured too, because steps 1, 4 and 5 add allocations on every query.
Run `bench/audit-bench.mjs` interleaved A/B before and after each step. The
precedent is `FJS-638`'s 60 → 74 µs per write, which was paid knowingly.

## 4. What stays as it is

- **The policy dual compiler.** It has one expression language and two backends,
  and `policy-interpreters.test.ts` is already the oracle that keeps them agreeing.
- **The parser.** `catalog.test.ts` already fails until a new word has its row.
- **The tripwires.** They are how each step proves nothing moved, so none of them
  is rewritten to read the new registry.

## 5. What would falsify it

- **The fold is enumeration in a new place.** If, after step 4, most rules still
  need a special case for each verb (`upsert` refusing where its bulk sibling
  narrows is already one), the registry adds a layer and removes nothing. Stop
  after step 3, take step 5 alone, and record why.
- **The cost.** If a step regresses `create()` or `findMany` past about 10% in the
  interleaved bench, price it before continuing, against
  `cut-one-level-simpler`: is the simpler version (fragments alone, no registry)
  most of the safety?
- **A grid moves.** Any changed cell in `VERBS_REPORT` or `MATRIX_REPORT` is a
  behavior change. It is either a found defect, filed with an id, or a regression
  that stops the step.

## 6. Order

Step 0, 1 and 2 are cheap and unlock the rest; 3 rides along with them. Step 4
takes the read path, where `buildSQL` is already mostly central, and step 5
goes last, one write verb at a time. Steps 1–3 are worth having even if 4 and 5
never land.

## 7. The nine, answered

These were answered **late**: after the first draft and before any code. Question 6
changed step 2, which first proposed a new `ModelSpec` beside the `shape` that
already exists. The tier is **Assessment**.

1. **Origin.** Origins go down. Rule order moves out of about 15 verb bodies into
   one array, and a model's facts move from `shape` plus 33 maps into `shape`.
2. **Concept.** No new nouns: *fragment* (`sqlFragment`), *shape* and *rule* are
   already the code's own words. *Plan* is internal to `client.js` and stays off
   every public surface.
3. **Complexity.** The problem's own. The field's names for it are the composable
   SQL fragment (postgres.js, Slonik), the interceptor chain, and functional core
   with an imperative shell. The complexity being removed is F9's: enforcement by
   hand-enumeration.
4. **Predictability.** Better. Every verb has one shape, so knowing `updateMany`
   teaches the next one.
5. **Derived.** Rule order is derived from the registry. The grids are restated on
   purpose, because an oracle derived from the code it grades proves nothing
   (`FJS-597`).
6. **Owner.** Existing owners only: `quoteIdent` for identifiers, `query.js` for
   fragments, `shape` for a model's facts, `READ_RULES` for the rules' order.
7. **Boundary.** The one boundary crossed is the plugin `ctx` (`FJS-D03`). It
   changes in the same commit, and step 3 types it.
8. **Failure.** A rule and verb pair the registry does not name is refused at load.
   That is proportional, because the silent version is a row the gate should have
   withheld.
9. **Silence.** What must stay true is that every verb applies every rule; the
   verbs × rules and matrix grids fail when it stops. Every identifier passes
   through `ident()`; the step 1 refusal test fails. A module's type errors only
   go down; `scripts/typecheck-baselines.json` fails. Speed has no automated
   artifact: **none**, recorded as overview 0.9 already records it. The interleaved
   bench in § 3 is run by hand for each step.
