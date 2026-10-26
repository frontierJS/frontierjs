# litestone — what bites here

The full hazard catalog for `@frontierjs/litestone`, moved out of `CLAUDE.md`. The traps that bite most often stay there as one-liners; this is every one, verbatim, plus the rules a change must keep in their full form with the test that pins each.

## Rules a change must keep

Each names its pin. The failure behind each is `docs/internals.md`.

- **Litestone's edge is what is true about a row** (`FJS-D635`): its shape, who
  may read and write it, what moves it may make, how its shape changes. Object
  storage, replication, transform and Studio are batteries behind a subpath
  (`./storage`, `./replicate`, `./transform`); no axis directory imports one or
  anything under `tools/`, and the main entry re-exports none.
  `test/edge.test.ts` classifies every `src/` directory, so a new one names its
  axis or is a battery.
- **Every path that reaches a row applies every rule that guards it**, in
  `READ_RULES`'s order (`src/core/client.js`, inside `makeTable`) — global
  filter, plugin read filters, soft-delete, templates, the effective window, the
  caller's where, the policy — because positional binds make the order the
  correctness (`FJS-262`, `FJS-216`). A verb folds them through `visibleWhere`
  and a verb the registry does not place is refused at build.
  `test/verbs-rules.test.ts` is the independent oracle.
- **An aggregate strips what `read()` strips**, and a name that is not a column
  is refused (`FJS-202`, `FJS-273`). `test/aggregate-expressions.test.ts`.
- **A row is shaped only by `read()`.** Anything assembling one itself leaks
  `@guarded` and `@encrypted` values (`FJS-223`); a write path re-reads `@from`
  with `read(row, { hydrateFrom: true })`, since RETURNING cannot carry one.
- **A relation joins on every column of its key.** A relation entry carries
  `foreignKeys`/`referencedKeys`, index-aligned, and `pairsOn`/`keyIn`/`tupleOf`
  in `query.js` are the spellings; joined on the first pair, `(scheduleId,
  personId)` answers whichever row shares a scheduleId — in an include, a
  cascade, and a policy path grading the wrong row (`FJS-377`, `FJS-2790`).
  `test/from-correlation.test.ts`, `test/composite-relation.test.ts`.
- **A protected column cannot be named in a `where` or `orderBy`** by a
  non-system caller; a strip alone is recovered one `startsWith` at a time
  (`FJS-393`). `test/guarded-filter.test.ts`.
- **A row policy compiles twice and both halves agree** — SQL for read and
  update, JS for create and the post-update check. The JS half compares with
  SQLite's affinity, not `===` (`FJS-713`); a create policy cannot name a value
  SQLite computes (`FJS-719`). A new form gets a row in
  `test/policy-interpreters.test.ts`.
- **`upsertMany` is a create and an update at once**, policed by both rules
  (`FJS-720`). A bulk write keeps ragged row shapes, and a transitions field is
  refused in a bulk update by name (`FJS-D182`, `test/bulk-transitions.test.ts`).
- **A write event states `row` or `collection` in `scope`**, never inferred from
  `result` (`FJS-307`, `test/write-events.test.ts`). A zero-row write announces
  nothing; a cross-process announcement stores ids, never the row (`FJS-D173`,
  `test/cross-process.test.ts`).
- **`$transaction` decides nesting by async context**, not depth — a nested call
  takes a SAVEPOINT, a concurrent request waits (`FJS-244`). One client per
  database file per process (`FJS-569`, `test/busy-timeout.test.ts`).
- **A value bound into `bun:sqlite` is a primitive.** A plain object voids every
  positional binding in the statement, with no error (`FJS-199`).
- **Anything that writes `.lite` reads back to a fixed point** through `parse()`
  — `test/introspect-roundtrip.test.ts`.
- **A migration drops only what litestone named** (`FJS-183`); a generated
  column is read with `table_xinfo` (`test/generated-rebuild.test.ts`).
- **`@@unique(where:)` never gets `@@softDelete`'s clause and `@@index(where:)`
  always does**; they are named `uniq_` and `idx_`, and the prefix is the
  ownership test (`FJS-614`, `test/index-predicates.test.ts`).
- **`@values` is checked through the caller's accessor**, never `asSystem()` —
  `test/valuesets.test.ts`.
- **An expected verdict is never derived from the code it grades**, and a
  mutant dies only by a verdict disagreement, or by a loader refusal while the
  original builds (`FJS-597`).
- **An unsupported combination is refused by name** —
  `test/matrix.test.ts`. SQLite reads an unknown identifier as a string literal
  and matches nothing, so silence here is a wrong answer.

## What the default gets wrong

- **`parseFile` resolves imports and `parse` does not.** A schema loaded from a
  PATH goes through `parseFile` (`FJS-264`); `parse` is for text with no file.
- **`createClient({ db })` overrides MAIN and nothing else.** Precedence:
  `databases: ':memory:'` > `databases: { main }` > `db` > the declaration.
- **`$setAuth(user)` RETURNS a scoped client.** `asSystem()` bypasses the gate,
  `@@allow`/`@@deny`, `@guarded` and a move's `@gate`/`@system`, and does not lift
  the soft-delete or template filters, a `@check`/`@@check`/`@@arc`, `@immutable`,
  or the `@@transitions` machine — its moves, its compare-and-swap, and a create
  starting at the `@default` (`FJS-D502`, `FJS-D470`). A write that needs the gate
  alone lifted names it: `system: ['@@gate']`, graded per call and never through
  `ctx.isSystem` (`FJS-D575`).
- **Raw SQL keeps the policies only inside a where** —
  ``where: { $raw: sql`price > ${min}` }``. `db.sql` throws once a schema declares
  access rules; `db.asSystem().sql` is the deliberate bypass. `sql` routes on the
  statement's first word, so stored text that may not write goes through
  `sql.read(text, params)` (`FJS-2412`).
- **The clock is `now()`.** A `DateTime` is ISO-8601 TEXT, so `datetime('now')`
  compares wrong for today and is refused by name (`FJS-226`).
- **A bare array in a `where` is membership**; `{ equals: [...] }` is equality.
- **A key set to `undefined` is omitted and only `null` clears.** A single-row
  write returns the row (`null` under `select: false`), a bulk write `{ count }`.
- **`getLevel()` is synchronous and clamped to 0–7.** A schema declaring any
  `@@gate` installs `GatePlugin` itself. `@@allow` holds only on TRUE, `@@deny`
  fires on TRUE or UNKNOWN, and an absent claim is UNKNOWN.
- **Protection refuses by name rather than dropping.** `@guarded` is system-only
  both ways and takes no level; `@encrypted` hides a value and stays writable.
- **Three schemas, and a migration question compares two** — declared, shadow,
  live (`FJS-D123`, `test/migration-history.test.ts`). A column leaving the schema
  is refused without `acceptDataLoss`, because a rename is a drop plus an add
  unless `migrate create` was told it was one (`--rename`, `--operations`;
  `src/core/operations.js`, `FJS-D603`).
- **A `jsonl` model has no update, delete, migration or FTS** — append-only, and
  `findManyCursor` pages it.

### Computed fields

```js
// computed.js — passed as createClient({ computed }), declared `fullName String @computed`
export default {
  User: {
    fullName: row => [row.firstName, row.lastName].filter(Boolean).join(' '),
    initials: {                              // declared inputs narrow the SELECT,
      needs:   ['firstName', 'lastName'],    // and reading anything else throws
      compute: row => `${row.firstName[0]}${row.lastName[0]}`,
    },
  },
}
```

A bare function widens its read to `SELECT *`. A computed field cannot be sorted.
