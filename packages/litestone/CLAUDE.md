# Litestone — Project Context

`@frontierjs/litestone` is the Data realm: a schema-first SQLite ORM for Bun and
for a browser worker over OPFS. Plain ESM JavaScript; the one runtime dependency
is `@frontierjs/toolbelt`, which depends on nothing (`FJS-D26`). One `.lite`
schema drives DDL, the client, policy, JSON Schema, migrations, introspection and
tests, and **a feature is incomplete while only one of those paths knows about it.**

## Rules a change must keep

Each names its pin; the full form, with the failure behind each, is
`docs/hazards.md` § Rules, and the reasoning `docs/internals.md`.

- **Litestone's edge is what is true about a row** (`FJS-D635`); storage, replication, transform and Studio are batteries behind a subpath, and `test/edge.test.ts` classifies every `src/` directory.
- **Every path that reaches a row applies every rule that guards it**, in `READ_RULES`'s order (`src/core/client.js`, `makeTable`) — positional binds make the order the correctness (`FJS-262`, `FJS-216`). A verb the registry does not place is refused at build; `test/verbs-rules.test.ts` is the oracle.
- **An aggregate strips what `read()` strips**, and a non-column name is refused (`FJS-202`, `FJS-273`).
- **A row is shaped only by `read()`** (`FJS-223`); a write path re-reads `@from` with `read(row, { hydrateFrom: true })`.
- **A relation joins on every column of its key** — `foreignKeys`/`referencedKeys` index-aligned, `pairsOn`/`keyIn`/`tupleOf` in `query.js` (`FJS-377`, `FJS-2790`).
- **A protected column cannot be named in a `where` or `orderBy`** by a non-system caller (`FJS-393`).
- **A row policy compiles twice and both halves agree** — SQL and JS; the JS half compares with SQLite's affinity (`FJS-713`, `FJS-719`). A new form gets a row in `test/policy-interpreters.test.ts`.
- **`upsertMany` is a create and an update at once** (`FJS-720`); a transitions field is refused in a bulk update by name (`FJS-D182`).
- **A write event states `row` or `collection` in `scope`** (`FJS-307`); a zero-row write announces nothing; cross-process stores ids, never the row (`FJS-D173`).
- **`$transaction` decides nesting by async context**, not depth (`FJS-244`). One client per database file per process (`FJS-569`).
- **A value bound into `bun:sqlite` is a primitive** — a plain object voids every positional binding, silently (`FJS-199`).
- **Anything that writes `.lite` reads back to a fixed point** through `parse()`.
- **A migration drops only what litestone named** (`FJS-183`); a generated column is read with `table_xinfo`.
- **`@@unique(where:)` never gets `@@softDelete`'s clause and `@@index(where:)` always does**; `uniq_`/`idx_` is the ownership test (`FJS-614`).
- **`@values` is checked through the caller's accessor**, never `asSystem()`.
- **An expected verdict is never derived from the code it grades** (`FJS-597`).
- **An unsupported combination is refused by name** — SQLite reads an unknown identifier as a string literal and matches nothing (`test/matrix.test.ts`).

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `src/core/parser.js` `.lite` to AST · `catalog.js` every word a `.lite` file can hold · `schema-maps.js` the schema read once into the maps the client runs on · `ddl.js` AST to CREATE.
- `src/core/client.js` is `createClient`, `makeTable` and the flavors; the verbs sit beside it — `aggregate.js`, `search.js`, `group-by.js`, `find-many-cursor.js` — and a write's halves in `write-data.js`, `where-rewrite.js`, `state-guards.js`, `nested-writes.js`, `write-events.js`, `trail-entries.js`, `ledger-notes.js`, `extensible.js`.
- `src/core/query.js` buildWhere/buildOrderBy · `policy.js` `@@allow`/`@@deny` to SQL and JS · `args.js` what a verb may be passed · `errors.js` every error the client throws (junction builds them by name).
- `src/core/migrate.js` + `migrations.js` + `operations.js` are the three-schema migration story · `introspect.js` the `$`-introspection surface · `transaction.js`, `locks.js`, `pragmas.js`, `databases.js` the connection story.
- `src/core/engine.js` is `#sql-engine`; `engines/bun-sqlite.js` alone names `bun:sqlite`; `host/`, `browser/`, `drivers/` are the other side of the seams.
- `src/plugins/gate.js`, `capability.js`, `reach.js` · `src/tools/cli.js` + `cli-helpers.js` (`KNOWN_FLAGS`) · `src/testing.js`, `testdb.js`, `seeder.js`, `fake.js` the `./testing` subpath.

## What bites here

The traps that bite most; the full catalog is `docs/hazards.md`, read it before
touching the client, a policy, a migration or a seam.

- **`parseFile` resolves imports and `parse` does not** — a schema from a PATH goes through `parseFile` (`FJS-264`).
- **`createClient({ db })` overrides MAIN and nothing else**; `databases: ':memory:'` > `databases: { main }` > `db` > the declaration.
- **`$setAuth(user)` RETURNS a scoped client.** `asSystem()` bypasses the gate, policies, `@guarded` and a move's `@gate`/`@system`, and lifts nothing else — not soft-delete, templates, checks, `@immutable` or the `@@transitions` machine (`FJS-D502`, `FJS-D470`). Lift the gate alone with `system: ['@@gate']`, never through `ctx.isSystem` (`FJS-D575`).
- **Raw SQL keeps the policies only inside a where**; `db.sql` throws once a schema declares access rules; stored text that may not write goes through `sql.read` (`FJS-2412`).
- **The clock is `now()`** — `datetime('now')` compares wrong against ISO-8601 TEXT and is refused by name (`FJS-226`).
- **A bare array in a `where` is membership**; `{ equals: [...] }` is equality.
- **`undefined` is omitted and only `null` clears.** A single-row write returns the row, a bulk write `{ count }`.
- **`getLevel()` is synchronous and clamped to 0–7.** `@@allow` holds only on TRUE, `@@deny` fires on TRUE or UNKNOWN, an absent claim is UNKNOWN.
- **Protection refuses by name rather than dropping.** `@guarded` is system-only both ways; `@encrypted` hides and stays writable.
- **Three schemas, and a migration question compares two** — declared, shadow, live (`FJS-D123`); a rename is a drop plus an add unless `migrate create` was told (`--rename`, `src/core/operations.js`, `FJS-D603`).
- **A `jsonl` model has no update, delete, migration or FTS**; `findManyCursor` pages it.
- **A bare `@computed` function widens its read to `SELECT *`**; declare `needs` to narrow it, and a computed field cannot be sorted (the fence is `docs/hazards.md` § Computed fields).
- **A cache keyed on the ctx answers the first caller's value to everybody** (`FJS-722`) — key on `ctx._flavor ?? ctx`.
- **A hook that reads another row reads it through `ctx.tables`** (`FJS-1358`), never a client captured at install.
- **An engine answering promises is refused at registration** — `.get()`/`.all()` are called from ~270 sites that do not await.

## Proving a change

```bash
bun run test                    # test:smoke is the CLI alone
bun run test:browser            # a change to a seam — Chrome over OPFS
VERBS_REPORT=1  bun test test/verbs-rules.test.ts   # fill the grid from this,
MATRIX_REPORT=1 bun test test/matrix.test.ts        # never by hand
```

**`test` ends with `bench/statements.mjs`**, a ratchet on the SQL a request
costs over `example`'s schema: distinct statement texts per request kind,
cache evictions, and the texts a second pass with other values adds. A
rise fails. A value written into statement text shows up there first. A
model added to `example` legitimately moves it, and `--adopt` is the
answer then. `--why` and `--all` say what moved.

**`bench/cases.mjs` is the timed tier and is not in `test`.** Each case is
timed beside raw `bun:sqlite` in the same process and declares the ratio it
may not exceed. `node scripts/bench-ab.mjs --only litestone` (from the root)
compares this tree with a base ref, and CI's `perf` phase prints that and
never fails on a time. A case that throws fails it.

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
| a CLI flag | `KNOWN_FLAGS` in `src/tools/cli-helpers.js` — an unlisted flag is refused by name, and `test/cli-smoke.test.ts` fails one the sources read that is not listed (`FJS-2166`) |
| a `.lite` word | `test/catalog.test.ts` fails until the catalog has its row, a tier, and an axis in `AXES` (`FJS-D635`) |
| an example to `docs/`, `README.md` or `AGENTS.md` | nothing — `test/doc-examples.test.ts` runs every fence (`FJS-D860`): a ```lite block is built, a ```js block runs under the nearest ```lite above it; `fragment`, `throws` and `failing` on the info string are the whole contract, and `DOC_EXAMPLES_REPORT=1 DOC_EXAMPLES_ONLY=docs/x.md` lists what a page still fails |
| a `src/` directory, or an axis import of a battery | `test/edge.test.ts` — classified, or a ruling |
| a runtime global in `src/` | `HOST_GLOBALS` in `test/undeclared-names.test.ts` — by name, never all of lib.dom |
| a use of `process`, `Buffer`, `Bun` or `setImmediate` in a module the browser graph reaches | `CEILING` in `test/audit-browser-globals.test.ts` — a new use fails, a beaten ceiling must be lowered (`FJS-2404`) |

## The context in this package

**One, and it is not a request context** (`FJS-D03`). A plugin's `ctx` is the
**client's compiled state** — `shapes` (every per-model fact, one frozen
record per model: `ctx.shapes[model].relations`, `.policy`, `.softDelete`, …),
`typeMap`, `computedFns`, `schema`, `now`, `tx` and the rest — plus `auth` and
`isSystem`. It is built once in `createClient`, and `asSystem()`,
`$setAuth()` and `$scopedBy()` each SPREAD it with `auth`/`isSystem` changed.
There is no `ctx.query`, `ctx.method` or `ctx.locals`; a hook gets `model`,
`args` and `rows` as its own arguments.

**A hook that reads another row reads it through `ctx.tables`** (`FJS-1358`) —
the calling flavor's own accessors, so `$setAuth` reads under that principal's
policies and `asSystem()` past them. Never a client captured at install: the
root reads as nobody and `asSystem()` as everybody, whoever is calling.
`onInit` runs before the tables exist and has none.

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
  proxy that refuses `$transaction` and `$backup` by name and releases the worker on `pagehide`
  (`FJS-1179`). `engines/` runs SQL; `drivers/` is where one model's rows live.

## Where to look

| Question | Answer |
| --- | --- |
| What a `.lite` word means, accepts, and where it is legal | `docs/reference.snapshot.md` · `litestone explain @word` · `catalog.snapshot.md` groups every word and holds the visibility table |
| How a feature is used | `docs/README.md`, one file per feature; `docs/cli.md`; `docs/testing.md` |
| Why the code is shaped this way | `docs/internals.md`, by path |
| Which file owns what | `docs/layout.md` |
| Every trap, verbatim | `docs/hazards.md` |
| Correct-but-surprising behavior at the Data boundary | the `data-hazards` skill |
| Who owns a cross-package seam | the `bridge-index` skill |
| Open defects, rulings, proposals | `ISSUES.md` · `DECISIONS.md` · `IDEAS/` |

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
ablation.mjs access.js advise.js aggregate.js args.js assistant.js audit-log.js backup.js 
browser.js bun-sqlite.js capabilities.js capability.js cardinality.js cases.mjs 
catalog-reference.js catalog-snapshot.js catalog.js cli-helpers.js cli.js client.js 
commitment.js computed.js cross-process.js databases.js db-path.js ddl-snapshot.js ddl.js 
device-schema.js eject.js encryption.js engine.js errors.js export.js extensible.js 
external-ref.js fake.js field-policy.js file-storage.js find-many-cursor.js framework.js 
frappe.js gate.js group-by.js hooks.js ids.js include.js index.d.ts index.js introspect.js 
jsonl-index.js jsonl.js jsonschema-snapshot.js jsonschema.js local.js locks.js migrate.js 
migrations.js mutate.js nested-writes.js node.js none.js operations.js opportunities.js 
parser.js personal.js plugin.js policy.js polymorphic.js pragmas.js principal.js prisma.js 
query.js rails.js reach.js ref-url.js release.js repl.js replicate.js retention.js run.js 
runner.js s3.js scale-schema.mjs schema-maps.js seal.js search.js seeder.js sigv4.js 
split-worker.js split-worker.source.js sql.js sqlite-wasm.js stamps.js state-guards.js 
statements.mjs studio-queries.js studio.html studio.js tenancy.js tenant.js testdb.js 
testing.d.ts testing.js three-way.js tiers.js tmp-dirs.js transaction.js typegen.js 
validate-rows.js validate.js valuesets.js vector.js watch.js where-rewrite.js wide-int.js 
worker.js write-data.js write-events.js 
-->
