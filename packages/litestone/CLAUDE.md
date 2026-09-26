# Litestone — Project Context

`@frontierjs/litestone` is the Data realm: a schema-first SQLite ORM for Bun and
for a browser worker over OPFS. Plain ESM JavaScript; the one runtime dependency
is `@frontierjs/toolbelt`, which depends on nothing (`FJS-D26`). One `.lite`
schema drives DDL, the client, policy, JSON Schema, migrations, introspection and
tests, and **a feature is incomplete while only one of those paths knows about it.**

## Rules a change must keep

Each names its pin. The failure behind each is `docs/internals.md`.

- **Every path that reaches a row applies every rule that guards it**, in
  `buildSQL`'s order — global filter, plugin read filters, soft-delete,
  templates, the caller's where, the policy — because positional binds make the
  order the correctness (`FJS-262`, `FJS-216`). `test/verbs-rules.test.ts`.
- **An aggregate strips what `read()` strips**, and a name that is not a column
  is refused (`FJS-202`, `FJS-273`). `test/aggregate-expressions.test.ts`.
- **A row is shaped only by `read()`.** Anything assembling one itself leaks
  `@guarded` and `@encrypted` values (`FJS-223`); a write path re-reads `@from`
  with `read(row, { hydrateFrom: true })`, since RETURNING cannot carry one.
- **A `@from` correlates on every column of its relation's key**, in three
  places (`FJS-377`). `test/from-correlation.test.ts`.
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

## Proving a change

```bash
bun run test                    # test:smoke is the CLI alone
bun run test:browser            # a change to a seam — Chrome over OPFS
VERBS_REPORT=1  bun test test/verbs-rules.test.ts   # fill the grid from this,
MATRIX_REPORT=1 bun test test/matrix.test.ts        # never by hand
```

Then, because every other package sits on this one: `example` and `basecamp`
`bun run verify`, and `sierra` `bun run test:safety`.

| A change that adds… | …joins |
| --- | --- |
| a read method | `test/litestone.test.ts` § *every read applies the filter, the policy and the gate*, and `test/verbs-rules.test.ts` |
| a column kind or an operation | its row or column in `test/matrix.test.ts` — a missing cell fails |
| an aggregate argument naming a field | `test/litestone.test.ts` § *an aggregate names a column* |
| a write method | `test/write-events.test.ts`; `test/valuesets.test.ts` derives its list from `client.js` |
| a policy form | `test/policy-interpreters.test.ts` — both compilers, same rows |
| an access rule | one row admitted and one refused, through a real scoped client |
| a `@map`-sensitive path | `test/column-mapping.test.ts` — mapped and unmapped, compared |
| a `.lite` word | `test/catalog.test.ts` fails until the catalog has its row |

## What the default gets wrong

- **`parseFile` resolves imports and `parse` does not.** A schema loaded from a
  PATH goes through `parseFile` (`FJS-264`); `parse` is for text with no file.
- **`createClient({ db })` overrides MAIN and nothing else.** Precedence:
  `databases: ':memory:'` > `databases: { main }` > `db` > the declaration.
- **`$setAuth(user)` RETURNS a scoped client.** `asSystem()` bypasses the gate,
  `@@allow`/`@@deny` and `@guarded`, and does not lift the soft-delete or template
  filters, a `@check`/`@@check`/`@@arc`, or `@immutable`.
- **Raw SQL keeps the policies only inside a where** —
  ``where: { $raw: sql`price > ${min}` }``. `db.sql` throws once a schema declares
  access rules; `db.asSystem().sql` is the deliberate bypass.
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
  is refused without `acceptDataLoss`, because a rename is a drop plus an add.
- **A `jsonl` model has no update, delete, migration, FTS or cursor.**

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

## The context in this package

**One, and it is not a request context** (`FJS-D03`). A plugin's `ctx` is the
**client's compiled state** — `relationMap`, `policyMap`, `typeMap`,
`computedFns`, `softDeleteMap`, `schema`, `now`, `tx`, and about forty more —
plus `auth` and `isSystem`. It is built once in `createClient`, and `asSystem()`,
`$setAuth()` and `$scopedBy()` each SPREAD it with `auth`/`isSystem` changed.
There is no `ctx.query`, `ctx.method` or `ctx.locals`; a hook gets `model`,
`args` and `rows` as its own arguments.

**`ctx.auth` is the principal that scoped the CLIENT**, which is why `$setAuth`
returns a new one. One table object per model serves every flavor, so a cache
keyed on the ctx answers the first caller's value to everybody (`FJS-722`) — key
on `ctx._flavor ?? ctx`. `enc` is a CELL for the same reason: a spread copies a
string by value, so `$rotateKey` would leave every derived client on the old key.

## Two seams

`#sql-engine` and `#host` resolve by package CONDITION, so the client is the
same code on either runtime (`FJS-D305`), and `test/engine-seam.test.ts` grades both.

- **`#sql-engine` is what runs the SQL** — `src/core/engine.js`. **The contract
  is synchronous**: an engine answering promises is refused at registration,
  because `.get()`/`.all()` are called from ~270 sites that do not await.
  `engines/bun-sqlite.js` is the only file naming `bun:sqlite`.
- **`#host` is everything else the runtime provides.** A module in the browser
  graph reaches a builtin through `#host`, never by its own name — a bundler
  replaces a bare `fs` with a proxy that throws on first access.
- **The browser client is a worker running one call at a time**, and a page
  proxy that refuses `$transaction` and releases the worker on `pagehide`
  (`FJS-1179`). `engines/` runs SQL; `drivers/` is where one model's rows live.

## Where to look

| Question | Answer |
| --- | --- |
| What a `.lite` word means, accepts, and where it is legal | `docs/reference.snapshot.md` · `litestone explain @word` · `catalog.snapshot.md` groups every word and holds the visibility table |
| How a feature is used | `docs/README.md`, one file per feature; `docs/cli.md`; `docs/testing.md` |
| Why the code is shaped this way | `docs/internals.md`, by path |
| Correct-but-surprising behavior at the Data boundary | the `data-hazards` skill |
| Who owns a cross-package seam | the `bridge-index` skill |
| Open defects, rulings, proposals | `ISSUES.md` · `DECISIONS.md` · `docs/roadmap.md` |

<!--
The layout below is for `fli done`'s layout-named check, which reads this file raw.
Claude Code strips a block-level HTML comment before injecting the file, so an
agent pays nothing for it. It must stay outside a code fence, since a comment
inside one is kept.

src/
  index.js · index.d.ts — public API re-exports · the hand-written declarations
  core/
    parser.js — .lite to AST; the lexer and condition grammar are toolbelt/predicate's
    catalog.js — every word a .lite file can hold; what explain, Studio and the reference read
    advise.js — legal-and-WRONG combinations; every rule in it parses
    opportunities.js — legal-and-MISSING: a word that would have said it better
    schema-maps.js — the schema read once into the maps the client runs on
    ddl.js — AST to CREATE TABLE / INDEX / TRIGGER; isStoredField, isUpdatedAtField
    client.js — createClient, makeTable, every verb, hooks, events, the flavors
    errors.js — every error the client throws; junction builds them by name
    engine.js — the SQL engine seam
    pragmas.js — busy_timeout, the one owner
    db-path.js — where a relative database path lands
    backup.js — how a live file is copied, for $backup and migrate apply
    query.js — buildWhere, buildOrderBy, coercion
    policy.js — @@allow / @@deny / field @allow to SQL (compileSql) and JS (evalJs)
    plugin.js — Plugin, PluginRunner, AccessDeniedError
    validate.js — field validators, ValidationError, EXACT_INT_MAX
    valuesets.js — @values, enforced through the caller's accessor
    capabilities.js — what a capability IS, derived from the seed (FJS-D139)
    cardinality.js — @minItems/@maxItems on a relation, graded at the outermost commit (FJS-D347)
    commitment.js — @@commitment due times, in SQL and in JS, graded against each other
    seal.js — which states of a machine are sealed, derived from @seals
    three-way.js — @@sync(field)'s per-column merge (FJS-D334)
    cross-process.js — announce crossProcess (FJS-642)
    encryption.js — @encrypted/@hashed + comparisonEncoderFor: value to stored bytes, one owner
    vector.js — float32 layout and the JS half of comparing two (FJS-1193, FJS-D331)
    ids.js — who assigns an @id; the generators are toolbelt/ids
    migrate.js — introspect, buildPristine, diffSchemas, residue
    migrations.js — file migrations, buildShadow, historyGap, autoMigrate
    tenancy.js — resolveTenancy + tenantFrom; four readers, one answer
  plugins/
    gate.js — GatePlugin
    capability.js — the capability grid, ANDed with the gate as its floor (FJS-D146)
    reach.js — which models a call touches beyond the one it names
    file.js — FileStorage
    external-ref.js — ExternalRefPlugin base
  engines/ — bun-sqlite.js · sqlite-wasm.js · none.js
  host/ — node.js · browser.js
  browser/ — worker.js · client.js
  drivers/ — jsonl.js · jsonl-index.js (the sidecar index AND the write lock, FJS-D180)
  storage/ — index.js · sigv4.js · providers/s3.js · providers/local.js
  import/ — index.js · prisma.js · rails.js · sql.js · frappe.js · tiers.js · polymorphic.js · wide-int.js
  tools/ — cli.js · repl.js · studio.html · introspect.js · typegen.js · retention.js · replicate.js ·
           assistant.js · eject.js · ddl-snapshot.js · jsonschema-snapshot.js · catalog-snapshot.js ·
           catalog-reference.js
  transform/ — CLI-only: framework.js · runner.js · run.js · split-worker.js · split-worker.source.js
  access.js — the declared access surface as data and prose
  release.js — the release surface; classifyPivot and classifyAccess
  mutate.js — schema mutation testing
  device-schema.js — the schema a DEVICE gets
  validate-rows.js — which STORED rows the schema would now refuse
  export.js — @@export, the governed extract (FJS-D228)
  tenant.js — createTenantRegistry
  jsonschema.js — generateJsonSchema
  testing.js · testing.d.ts — the ./testing subpath
  testdb.js — the migrated template every test copies
  seeder.js · fake.js — Factory/Seeder · the seeded value catalog
  tmp-dirs.js — temp directories a run cannot remove itself
references/ — one .lite per common model, never shipped or imported
test/ — one file per concern; fixtures/scale/openmrp.lite is the 188-model scale fixture
bench/ — scale-schema.mjs · ablation.mjs, timed and asserting nothing
-->
