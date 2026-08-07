# Litestone Project State

**Body written:** 2026-04-25 · **header re-verified:** 2026-08-05
**Tests:** 1416 pass / 0 fail across 6 files (`bun run test`)
**Status:** shipped — workspace is **v1.1.0**. npm `latest` is still 1.0.3, so anything
installed from the registry outside this workspace gets the pre-rename dialect.

> The body below is the April pre-publish snapshot. Its narrative of *what was
> built and why* still reads true; its numbers, "outstanding work" and backlog
> are from before the 1.0/1.1 releases. Re-verify before citing — see
> `../../VERIFYING.md`.

---

## Snapshot

- Public API: 70+ symbols exported from `src/index.js`
- Source: ~18K LOC across `src/` (core, plugins, tools, transform, jsonschema, tenant, testing, seeder)
- Tests: ~13.1K LOC across `test/litestone.test.ts` + `test/cli-smoke.test.ts`
- Runtime: Bun ≥ 1.0
- Bin: `litestone` → `src/tools/cli.js`
- Subpath exports: `/migrate`, `/migrations`, `/parser`, `/ddl`, `/testing`, `/types`, `/storage`, `/external-ref`

---

## What's been done

A long sequence of work across multiple sessions, organized roughly chronologically:

### Phase 1 — Bug fixes (publish-blockers)

**1. `$rotateKey` rowid alias.** `SELECT rowid, id, ...` collapses when the table has `INTEGER PRIMARY KEY id` because Bun's SQLite driver aliases `id` to `rowid`. Fixed by aliasing as `__litestone_rowid`.

**2. PascalCase model convention completed.** Migration to PascalCase model names was incomplete — ~65 lookup sites in `client.js`, `query.js`, `migrate.js` keyed model-indexed maps using `tableName` (snake_case) instead of `model.name`. All maps affected (`policyMap`, `validationMap`, `transitionMap`, `relationMap`, `computedSets`, etc.). Effects ranged from silent auth bypass to no-op validators to false "in sync" migrations. All fixed; SQL identifiers derive via `modelToTableName(model, pluralize)` at the emission site, never reused as map keys.

**3. Plugin invocation sites.** 30 sites in client.js passed `tableName` to plugin lifecycle hooks where `GatePlugin._accessMap` was keyed by model name. Caused **silent auth bypass under PascalCase**. Fixed.

**4. CLI bugs.** `cmdJsonSchema` import path, `openDb` mkdir, REPL banner, Studio endpoints, `diffSchemas`/`generateMigrationSQL` table name comparisons.

**5. Migration command bugs.** Threading `{ pluralize }` through `create()`, `verify()`, `autoMigrate()`, etc.

**6. Misc query bugs.** `GROUP_CONCAT` separator order, `buildOrderBy` table-alias qualification, `{ dir, nulls }` config detected as relation specs.

### Phase 2 — Test fixtures flipped to PascalCase

All high-priority describe blocks flipped to PascalCase fixtures: `@@allow/@@deny`, `@allow field-level`, `policyDebug`, `GatePlugin`, `FrontierGateGetLevel`, `@sequence`, `computed inline`, `soft delete cascade`, `@hardDelete`, `relation orderBy`, `relation aggregate orderBy`, `@from`, `@@softDelete footgun`, `@omit/@guarded`, `@guarded(all)+WHERE`, `@encrypted`, `@secret`, `generateGateMatrix`, `generateFactory`/`autoFactories`, plus the foundational migration/CRUD/transaction/metadata blocks.

This pass caught and fixed two more source bugs that lowercase-plural fixtures hid (plugin invocation sites + `buildRelationMap` keying).

### Phase 3 — `db.query(spec)` multi-model batch dispatcher

Top-level helper that runs many per-table `query()` calls in one snapshot transaction. Spec values are JSON-shaped args, not promises — enables a single HTTP endpoint pattern. Implemented on all three proxies (main, `$setAuth()`, `asSystem()`), each with its own scoped tables. Optional aliasing via `model:` key.

### Phase 4 — Scopes feature

`trait`-like reusable named query fragments, registered per model via the `scopes:` config. Static `where: {...}` or `(ctx) => {...}` for auth-aware filtering. Builds a function-with-properties: default-call → findMany; `.count`, `.findFirst`, `.aggregate`, `.groupBy`, `.query`, `.search` attached. Chaining via getter properties. No writes through scopes. Conflict guard via prototype + reserved-prefix + relation-name collision blocks.

### Phase 5 — Performance audit

- **`needsTiming()` guard** — skips `perf.now()` + fireQuery on the hot path when no listener.
- **`findUnique` PK fast path** — precomputed prepared statement at table-build time, skips buildSQL/parseArgs entirely. **2.2x faster** (5.5µs → 2.5µs). Conditions: no encryption, no `@@allow`/`@@deny`, no global filter, no plugins, no `@from` fields. With `@@external` tables, the prepare is try-guarded since the table may not exist at createClient time.
- **`findMany({})` fast path** — same pattern for the no-args-on-soft-delete-table case.
- **Auto-`ANALYZE` after migrations** — `migrate apply` and `autoMigrate` run `ANALYZE` after success. SQLite-specific edge that Postgres handles via autovacuum.
- **Stmt cache LRU bound** — default 500, evicts oldest on overflow with `finalize()` to release native handles. Bounded memory in long-lived processes.

### Phase 6 — `litestone doctor` PERF checks

Four advisory checks running against the live DB after migration/drift checks:

1. Unindexed FK columns (`@relation(fields:[X])` with no index on `X`)
2. Tables ≥10k rows with no user-defined indexes
3. Stale ANALYZE stats (sqlite_stat1 missing + ≥1k rows)
4. WAL pressure (>5000 frames)

End-to-end smoke verified all checks fire correctly and clear when fixed.

### Phase 7 — Comparison-table audit + rewrite

The README's "How it compares" table got a full pass for honesty:

- **Three factual corrections.** Drizzle correctly gets ✓ for "Zero npm dependencies" (verified). ZenStack correctly gets ✓ for "Studio browser UI" (they ship ZenStack Studio). All four correctly get ✓ for "Cursor pagination" (Prisma's `cursor: { id }`, Drizzle's, etc.).
- **Constraint-as-feature reframes.** "Bun-native" + "SQLite-native" consolidated into a "Platform" group with literal text columns showing actual database/runtime support. Honest tradeoff instead of misleading checkmarks.
- **Renames for clarity.** "Encryption at rest" → "Schema-level field encryption". "File storage" → "File storage primitives in schema". "JSONL/logger" → "Per-model storage backend". "Multi-tenant registry" → "First-class multi-tenant client cache". "Pristine migrations (no shadow db)" → "Migrations without an external dev database" (and Drizzle correctly ✓).
- **Dropped redundancies.** "No TypeScript required" — implied by "Schema file (not code)".
- **Reorganized into 6 grouped tables**, parity rows first within each group: Access control → Querying → Data modeling → Operations → Schema & migrations → Platform.

### Phase 8 — `trait` feature (model fragments)

`trait T { ... }` declarations + `@@trait(T)` model attribute. Reusable model fragments — fields and model-level attributes that get spliced into a model at parse time.

```
trait Dates {
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([createdAt])
}

trait SoftDelete {
  deletedAt DateTime?
  @@softDelete
}

model Post {
  id    Int @id
  title String
  @@trait(Dates)
  @@trait(SoftDelete)
}
```

Implementation: parser-stage transformation. `resolveTraits()` validates trait declarations (forbidden: `@id`, `@@id`, `@@map`, `@@db`, `@@fts`), splices fields + non-restricted attributes, drops `@@trait` references. Host wins on field collisions; two-trait collision is a parse error; nested traits with cycle detection. Trait attributes splice first, host attributes after — so host's `@@deny` evaluates after trait's `@@allow`.

20 tests. End-to-end runtime verified (`@@softDelete` from a trait activates soft-delete behavior on the host model).

### Phase 9 — `type` feature (typed JSON columns)

`type T { ... }` declarations + `Json @type(T)` field attribute. Declares the shape of a JSON value; writes are validated against the type, reads get a real TypeScript interface.

```
type Address {
  street     String
  city       String
  state      String?
  postalCode String
  country    String @default("US")
}

model User {
  id      Int @id
  name    String
  address Json @type(Address)
}
```

Three subsystems:

**Validation (parse time).** Declaration-level: forbidden constructs caught where they appear (relations, model-level attrs, `@id`, `@unique`, `@map`, `@encrypted`, `@guarded`, `@secret`, `@updatedAt`, runtime defaults like `now()`/`cuid()`, File/Blob types). Use-site: `@type` requires Json field, unknown type names rejected, cycles in nested types detected with de-duplication.

**Validation (write time).** `validateTypedJson()` walks the JSON value against the type declaration. Required-key check, type check (String → string, Int → integer, Float → number, Boolean → boolean, DateTime → ISO 8601 string, arrays validated). Strict mode (default) rejects unknown keys with helpful message; loose mode keeps them. Nested types validate recursively with full error path (`address.coords.lat`). Validators (`@email`, `@regex`, `@length`, etc.) and transforms (`@trim`, `@lower`) work inside types same as on columns.

**TypeScript generation.** Each `type` becomes a top-level `export interface T` in the generated `.d.ts`. Json fields with `@type(T)` reference the interface name (`address: Address` instead of `address: unknown`). Optional + nullable handling correct.

50 tests (27 declaration/validation + 3 typegen + 23 path pushdown — see Phase 10).

### Phase 10 — Typed JSON path filter pushdown

`where: { address: { city: 'NYC' } }` compiles to `WHERE json_extract("address", '$.city') = ?`. Filter inside typed JSON columns using the same query shape as the type itself.

```js
// All standard operators work
await db.user.findMany({ where: { address: { city: { contains: 'York' } } } })
await db.place.findMany({ where: { coords: { lat: { gte: 40, lt: 50 } } } })
await db.user.findMany({ where: { address: { state: { in: ['NY', 'CA'] } } } })

// Nested types — dotted JSON paths
await db.place.findMany({ where: { address: { coords: { lat: { gte: 42 } } } } })
// → WHERE json_extract("address", '$.coords.lat') >= ?

// Composes with AND/OR/NOT
// Unknown sub-keys throw at query-build time with a precise error
```

Implementation in `query.js`: `buildWhere` accepts a `typedJsonMap` parameter; when a top-level key matches a registered `Json @type(T)` field AND the value is a path traversal (any non-operator key), `buildTypedJsonClauses()` walks both the value and the type recursively, emitting `json_extract` paths with proper coercion (booleans → 0/1) and explicit `CAST AS TEXT` for LIKE predicates.

Operator-vs-path disambiguation is precise: `{ not: null }` is a leaf operator block (works on the whole column); `{ city: null }` is a path traversal because `city` isn't a known operator. No surprises for non-typed JSON — pushdown only activates when the column is registered in `_typedJsonMap`.

23 tests covering equality, all comparison ops, text ops with CAST, IN/notIn, not/IS NOT NULL, boolean coercion, integer/real comparison, nested type traversal, sibling sub-keys, AND/OR/NOT composition, error reporting, `count`/`findFirst`/`updateMany` with typed-JSON filters.

Performance: ~1.5x slower than a plain column scan (0.6 ms/op vs 0.4 ms/op on a 1k-row scan). Documented mitigations: promote frequently-filtered keys to real columns, or create an expression index manually.

---

## Current state

### Tests

```
bun test
→ 1045 pass, 0 fail, 1817 expect calls, ~22s
```

- 1036 unit tests in `test/litestone.test.ts`
- 9 CLI smoke tests in `test/cli-smoke.test.ts`

### Public API surface

70+ symbols from `@frontierjs/litestone`. Notable additions through this work:

- `db.query(spec)` — multi-model batch dispatcher
- Scopes — reusable named query fragments via `scopes:` config
- `trait T { ... }` + `@@trait(T)` — model fragments
- `type T { ... }` + `Json @type(T)` + path pushdown — typed JSON columns
- `ExternalRefPlugin` — already present, was undocumented in earlier state docs

### Performance characteristics

| Operation | Time/op | vs raw `bun:sqlite` |
|---|---:|---:|
| `findUnique` by PK | 2.5 µs | 2.1x overhead |
| `findMany({})` (10k rows) | 6.1 ms | 1.1x overhead |
| `count({ where })` (no index) | 567 µs | 1.1x overhead |
| `create({ data })` | 30 µs | — |
| Typed JSON pushdown filter (1k scan) | 0.6 ms | 1.5x slower than plain column |
| Plain column filter (1k scan) | 0.4 ms | — |

### Documentation

`docs/` covers: getting-started, schema, querying, filtering, sorting, aggregation, relations, multi-database, multi-tenancy, soft-delete, encryption, file-storage, full-text-search, sequences, window-functions, audit-logging, replication, migrations, performance, testing, typescript, studio, cli, gotchas, traits, json-types, why-litestone, publishing, roadmap.

---

## Outstanding work before publish

In recommended order:

1. ✅ All publish-blockers cleared
2. ✅ Comparison table audited and rewritten for honesty
3. ✅ Performance audit + fast paths + doctor PERF checks
4. ✅ `trait` feature (v1.1)
5. ✅ `type` feature + typed JSON path pushdown (v1.2)
6. **`npm publish --access public`** under `@frontierjs`

The unscoped `litestone` name is still blocked by npm's similarity check (support ticket filed, not chased recently). `@frontierjs/litestone` is publishable now.

---

## Backlog (post-publish, ranked)

1. **`Money` type** — JSON-stored `{ amount, currency, scale }`. The `type` feature now in place is the right primitive to build this on (`type Money { amount Int; currency String; scale Int }` plus runtime helpers).
2. **`LatLng` + `findNear()`** — Haversine in JS. Self-contained.
3. **`Embedding(n)` + `findSimilar()`** — needs `sqlite-vec` extension as soft dependency. Bigger distribution story.
4. **`@slug(source: title)`** — common pattern, small change.
5. **`@@transitions` full DSL** — already partially in place via `transitionMap`; promote to first-class.
6. **Expression index emission from schema** — `@@index([col], where: "...")` partial index syntax; SQLite supports it natively.
7. **`litestone validate` CLI** — walk rows and report typed-JSON shape mismatches after a type's shape changes.
8. **JSON path index hint in `@@index`** — `@@index([address->'$.city'])` to emit `CREATE INDEX ... ON t (json_extract(address, '$.city'))`.
9. **`CREATOR` role doc** — flagged repeatedly; just write the doc paragraph scoping the "submit but can't manage" pattern.
10. **HTTP endpoint helper** — `@frontierjs/litestone-http` package or doc-only example. The `db.query()` work makes this a one-liner.
11. **`resolveMany()`** — polymorphic batch resolver.

---

## Architecture notes (still current)

### Naming

- Model name: `PascalCase` singular (`User`, `ServiceAgreement`)
- Accessor: `camelCase` singular (`db.user`, `db.serviceAgreement`)
- SQL table name: `snake_case` of model name by default (`user`, `service_agreement`)
- `pluralize: true` in createClient/config → table names pluralized
- `@@map("custom")` always wins
- Type name: `PascalCase` (matches models). `interface T` in TS output.
- Trait name: `PascalCase`. Erased at parse time.

### Per-model maps (post-fix)

All maps in `ctx.*` (policyMap, transitionMap, validationMap, relationMap, computedSets, autoIdMap, authDefaultMap, fieldRefDefaultMap, updatedByMap, selfRelationMap, modelDbMap, sequenceMap, computedFns, models, **typeMap**) are keyed by PascalCase model/type name. SQL identifiers are derived via `modelToTableName(model, pluralize)` at the emission site.

### Three-proxy client

- Main proxy — unscoped, default identity
- `$setAuth(user)` proxy — sets `ctx.auth`, runs through scoped tables
- `asSystem()` proxy — sets `ctx.isSystem = true`, bypasses policies/gate/guarded

Each proxy has its own `query` closure that resolves spec accessors against its own tables. Without this, a batched `query()` from the auth proxy would silently strip auth context when nested through `$transaction`.

### Trait & type pipeline

Both are parser-stage transformations, erased before validation runs. `resolveTraits(schema)` mutates `schema.models` with spliced fields/attributes. `validateTypes(schema)` walks `schema.types` and every `Json @type(T)` reference for shape errors. The `typeMap` (Map<typeName, typeDecl>) is built once in `createClient()`, threaded through `ctx`, used by both `validate()` (for write-time typed-JSON validation) and `buildWhere()` (for path filter pushdown).

### Fast paths

- `findUnique({ where: { <pk>: v }})` — precomputed prepared statement at table-build time. ~2.5 µs/op. Conditions: no encryption, no policies, no global filter, no plugins, no `@from` fields. Try-guarded for `@@external` tables.
- `findMany({})` on soft-delete tables with no policies/filters/plugins — same pattern.

### Statement cache

LRU-bounded (default 500 entries). Move-to-end on hit (cheap O(1) Map.delete + Map.set), evict oldest on overflow with `finalize()` to release native handles. Bounded memory in long-lived processes building many distinct WHERE shapes.

### Auto-ANALYZE

`migrate apply` + `autoMigrate` run `ANALYZE` after success. SQLite-specific edge that Postgres handles via autovacuum.

---

## File locations (session)

- Working copy: `/home/claude/litestone/`
- Latest zip: `/mnt/user-data/outputs/litestone_fixed.zip`
- This doc: `PROJECT_STATE.md` at repo root
- Transcript catalog: `/mnt/transcripts/journal.txt`

---

## Recent additions

### CLI: `getEncKey()` helper + auto `.env` loader

All CLI commands that open `createClient` (`db push`, `migrate apply`, `studio`,
`seed`, `seed run`, `optimize`, `backup`) now resolve `encryptionKey` from
`process.env.ENCRYPTION_KEY` (or `LITESTONE_KEY`). New `--env-file=<path>` and
`--no-env` flags. Default search order: `.env.local` then `.env` in cwd.

### Parser: hardened tokenizer

- Strips leading UTF-8 BOM
- Treats common Unicode invisibles as whitespace (NBSP, ZWSP, ZWNJ, ZWJ, FIGURE
  SPACE, NARROW NBSP, mid-stream BOM)
- `Unexpected character` error now shows codepoint (`U+201C`) + line context +
  caret + actionable hint for smart quotes, em-dashes, NBSP, etc.
- `parseFile` sniffs binary input: SQLite databases and other binary files get
  a clear `Schema file is a SQLite database, not a .lite schema` error
  (catches the `schema:` / `db:` swap) instead of crashing the tokenizer at
  some arbitrary `U+0000`. Error includes the file path so import chains are
  navigable.

### `createClient`: env-aware encryption-key error

When `@encrypted`/`@secret` fields exist but no key was passed, the error now:
- Names the affected fields (`User.ssn, User.token`)
- Detects `process.env.ENCRYPTION_KEY` (or conventional names) and points at
  the forgot-to-forward case explicitly
- Heuristic-suggests env vars whose values look like 32-byte hex
- Falls back to `openssl rand -hex 32` instructions if nothing matches

### `@@hasTemplates` directive

Categorical "definition vs instance" distinction. Templates and instances cohabit
the same table; default reads exclude templates.

```
model Quote {
  id     Int @id
  number String
  total  Float
  @@hasTemplates                       // → adds isTemplate Boolean @default(false)
}

model Preset {
  id    Int @id
  @@hasTemplates(field: "isPreset")    // → custom column name
}
```

**Query API** (parallel to soft-delete):
```js
db.quote.findMany()                         // instances only
db.quote.findMany({ withTemplates: true })  // instances + templates
db.quote.findMany({ onlyTemplates: true })  // templates only

// Same flags work on findFirst, findUnique, findManyAndCount, count, exists, search
// Nested in includes:
db.account.findMany({ include: { quotes: { withTemplates: true } } })
```

**Default behaviour:**
- All read paths exclude templates by default
- `update`/`updateMany`/`remove`/`removeMany` target instances only
- `aggregate` and `groupBy` are hardcoded to instances (parallel to hardcoded
  `'live'` for soft-delete) — protects reporting from accidental template inclusion
- `count` excludes templates
- `_count` aggregation in includes excludes templates
- DDL emits `<field> INTEGER NOT NULL DEFAULT 0` so existing `create()` calls
  that don't pass the marker still produce instances

**Composes with `@@softDelete`:** filters AND together. `findMany()` on a model
with both directives → `WHERE deletedAt IS NULL AND isTemplate = 0`.

**Validation:**
- User-declared marker field must be `Boolean`, non-optional. Errors otherwise.
- If user doesn't declare it, parser auto-injects `<field> Boolean @default(false)`.

**Test count:** 1109 (was 1067 baseline before this work). 31 new tests for
@@hasTemplates parser, runtime, soft-delete composition, nested includes, and
custom field name.

### Write payload — unknown-field rejection

Writes (`create`, `createMany`, `update`, `updateMany`, `upsert`, etc.) now
validate keys against a per-model allowlist of writable fields:

- All scalar fields (excluding computed/generated)
- All relation names
- belongsTo FK columns (e.g. `accountId` from `account` belongsTo)

Unknown keys throw `ValidationError` with model context and a Levenshtein-based
"Did you mean" hint:

```
ValidationError: Unknown field 'emial' on model 'users'.
Did you mean: email?
```

Replaces SQLite's cryptic `table users has no column named emial`. The check
runs in `writeData` *before* SQL emission, so nested writes surface the typo
on the correct child model.

**Test count:** 1117 (was 1108). 9 new tests for unknown-field validation.

### Co-FK propagation on nested writes

When a nested `create` (`accounts.create({ data: { orders: { create: ... } } })`)
runs, any FK column that exists on **both** the parent and the child and points
at the same target table is automatically propagated parent→child.

**Strict by default:** parent's value silently overwrites whatever the child
provided. Prevents referential drift (a line item with a different `tenantId`
than its parent order is a bug, not a feature).

**Detection:**
- Both parent and child have a `belongsTo` relation
- Same FK column name (`tenantId` on both)
- Same target model (`tenants`)
- Same referenced column (`id`)

**Direct FKs unchanged.** The direct hasMany FK (e.g. `accountId` from `account`
→ `account.orders`) is always injected from the parent's PK — that's pre-
existing behaviour, not co-FK propagation. Co-FK only applies to *additional*
overlapping FK columns.

**Opt-out:**

```js
createClient({
  schema: '...',
  allowChildFkOverride: true,   // explicit child value wins; missing still filled
})
```

**Example:**

```
model Account { id Int @id; tenantId Int; orders Order[] }
model Order   { id Int @id; tenantId Int; accountId Int }

await db.account.create({
  data: {
    id: 10, tenantId: 5,
    orders: { create: [{ id: 100 }] },   // → tenantId: 5 auto-injected
  }
})
```

**Test count:** 1125 (was 1117). 8 new co-FK tests covering strict overwrite,
permissive opt-out, multi-level nesting, and null-parent guard.

### Type rename — hard cut

Schema DSL renamed for alignment with TypeScript / Prisma / GraphQL conventions.
Pre-publish, no aliases.

| Old        | New      |
| ---------- | -------- |
| `Text`     | `String` |
| `Integer`  | `Int`    |
| `Real`     | `Float`  |
| `Blob`     | `Bytes`  |

Old names produce a parse error pointing at the new spelling and mentioning
the codemod. Works end-to-end across parser, DDL, validator, JSON-schema
generator, type-gen, introspect, and tests.

**`litestone codemod [path]`** — walks `.lite` files under cwd (or `path`),
applies word-boundary renames, writes `.bak` alongside (skip with
`--no-backup`). `--dry-run` previews. Skips `node_modules`, `.git`,
`migrations`, `dist`, `build`.

**Caveat:** word-boundary regex can't read English. Comments containing
`Real`/`Text`/`Integer`/`Blob` will get rewritten too. Trivial to fix by hand
post-codemod; not worth the complexity of an actual lexer in the codemod.

**Test count:** 1133 (was 1125). 5 type-rename tests + 3 codemod tests.

### `@time` validator

24-hour clock validation for `String` fields.

```
model BusinessHours {
  id        Int    @id
  openTime  String @time                    // HH:MM, leading zeros required
  closeTime String @time(seconds: true)     // HH:MM or HH:MM:SS
}
```

- Default: `HH:MM` only — rejects `9:30`, `24:00`, `12:60`, `12:34:00`
- `seconds: true`: accepts both `HH:MM` and `HH:MM:SS` — rejects `24:00:00`, `12:34:60`
- Range: `00:00:00` → `23:59:59`
- Strict leading zeros so values sort lexicographically the same as numerically
- Optional `message:` for a custom error string

**Test count:** 1142 (was 1133). 9 new `@time` tests.

### `view` blocks (existed, hardened)

The `view` keyword in the schema produces a read-only schema entity backed by
a SQL query. Two flavors:

**Regular view** — `CREATE VIEW`, recomputed every read:
```
view orderTotals {
  accountId Int
  total     Float
  @@sql("SELECT accountId, SUM(total) AS total FROM orders GROUP BY accountId")
}
```

**Materialized view** — actual table + INSERT/UPDATE/DELETE triggers on source
models that keep it in sync:
```
view orderTotals {
  accountId Int
  total     Float
  @@materialized
  @@sql("SELECT accountId, SUM(total) AS total FROM orders GROUP BY accountId")
  @@refreshOn([orders])
}
```

**Multi-DB:** `@@db(analytics)` routes the view to a specific database.

**Client API:** `db.viewName.findMany()`, `findFirst`, `findUnique`, `count`,
`exists`, `aggregate`, `groupBy`, `findManyCursor`. All write methods throw a
clear "view — write operations are not supported" error.

**Bug fixed:** view-as-model stubs were missing `attributes` arrays and didn't
declare `@@external`, causing DDL emission to crash on any schema with a view
when it tried to call `f.attributes.find(...)`. Stubs now backfill empty
attribute arrays and tag themselves `@@external` so DDL skips them.

**Test count:** 1146 (was 1142). 4 new view tests.

### Stage A: `@@fts(tokenize: ...)`

FTS5 tokenizer selection via schema. Same `search()` and `where { fts }` API
across all tokenizers — the schema picks what kind of matching the FTS index
supports.

```
@@fts([title, body])                   // default: unicode61 (word matching, current behavior)
@@fts([title], tokenize: trigram)      // substring / partial-word / truncation tolerance
@@fts([body], tokenize: porter)        // English stemming (run = running = runs)
@@fts([title], tokenize: ascii)        // ASCII-only fold
```

**Tokenizer characteristics:**
- `unicode61` (default) — word-based, case-folded, no stemming, no substring
- `trigram` — character-overlap; matches substrings and truncations.
  *Not* missing-letter-tolerant (`Aple` does not find `Apple` — that's pg_trgm
  behavior, not FTS5 trigram). It IS truncation-tolerant (`Appl` finds `Apple`).
- `porter` — English Porter stemmer; `run`/`running`/`runs` collapse to one stem
- `ascii` — lowercase ASCII fold

**Back-compat:** schemas without `tokenize:` emit the same DDL as before this
change (no `tokenize=` clause). FTS5 falls back to its built-in unicode61
default, which matches Litestone's prior behavior bit-for-bit.

**Rejected:**
- Unknown tokenizer names → parse error listing allowed values
- Unknown named arguments → parse error pointing at `tokenize`

**Test count:** 1156 (was 1146). 10 new tests covering parser, DDL, and
runtime smoke for trigram + porter + default.
