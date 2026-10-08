# Litestone Docs

## Getting started
- [getting-started.md](getting-started.md) — install, quick start, createClient, first query
- [why-litestone.md](why-litestone.md) — why SQLite, why Bun, why schema-first, when to choose something else
- [gotchas.md](gotchas.md) — production surprises: ILIKE, json_extract types, NULL behavior, WAL contention

## Schema
- [schema.md](schema.md) — .lite DSL: types, field attributes, model attributes, enums, functions
- [reference.snapshot.md](reference.snapshot.md) — **every word, A–Z**: what it does, what it accepts, where it is legal, a worked example. Generated from the catalog and gated, so it cannot drift; `litestone explain @guarded` asks the same rows one at a time
- [modeling.md](modeling.md) — the recurring judgment calls: which feature makes this field (the nine-kind matrix), uuid vs Int id, surrogate vs natural key, Json array vs join table
- [migrations.md](migrations.md) — autoMigrate, file migrations, JS migrations, CLI
- [typescript.md](typescript.md) — litestone types, generated .d.ts, WhereBase, WindowSpec
- [jsonschema.md](jsonschema.md) — generateJsonSchema: every key it emits, modes, audience, who reads each
- [exact-numbers.md](exact-numbers.md) — `Int @scale(n)` and `Int @money(USD)`: an exact quantity and an amount of money, stored as whole minor units. **There is no `Decimal` and that is a ruling, not a gap** ([`FJS-D142`](../../../DECISIONS.md#fjs-d142)). `@unit(ms)` is the fourth and asks the other question — not how exact the number is but what it counts ([`FJS-D348`](../../../DECISIONS.md#fjs-d348))
- [json-types.md](json-types.md) — `type T { }` in the schema and `Json @type(T)`: a declared shape for a Json column, validated on write
- [extensible-columns.md](extensible-columns.md) — `@@extensible`: a field the tenant declares at runtime, stored in a pooled column and still filterable
- [traits.md](traits.md) — `@@trait` and `extend model X { }`: what a package contributes into a seed, and what the installing app says back about a model it did not write

## Querying
- [querying.md](querying.md) — findMany, findFirst, findUnique, count, exists, pagination, writes, multi-model `db.query()` batch
- [filtering.md](filtering.md) — where clause, operators, AND/OR/NOT, $raw + sql tag
- [sorting.md](sorting.md) — orderBy, NULLS FIRST/LAST, relation field, relation aggregate
- [relations.md](relations.md) — belongsTo, hasMany, one-to-one, manyToMany, include, nested writes, recursive tree
- [aggregation.md](aggregation.md) — aggregate(), groupBy(), interval/fillGaps, FILTER, named aggs, query() dispatcher
- [window-functions.md](window-functions.md) — all window fns, partitionBy, frame specs, FILTER

## Security & access control
- [warden.md](warden.md) — **the Warden, the whole access system on one page**: the layers a call passes through, what `asSystem()` lifts and holds, and the rulings behind them. Start here, then follow its links
- [access-control.md](access-control.md) — row policies, field policies, GatePlugin levels, auth()
- [encryption.md](encryption.md) — @encrypted, @secret, $rotateKey, searchable encryption

## Features
- [soft-delete.md](soft-delete.md) — @@softDelete, cascade, @hardDelete, restore
- [export.md](export.md) — `@@export`: a governed bulk extract, a paginated scoped read that cannot contain what the principal could not read a row at a time
- [full-text-search.md](full-text-search.md) — @@fts, search(), highlight/snippet, optimizeFts
- [geo.md](geo.md) — `@point`: a coordinate indexed as two columns and read as one, with bounding-box pruning (`FJS-D316`, `FJS-D317`)
- [vectors.md](vectors.md) — `@vector`: a float32 embedding column, compared by angle — where the comparison runs differs on a server and in a browser
- [file-storage.md](file-storage.md) — FileStorage plugin, S3/R2/local, autoResolve, fileUrl, ExternalRefPlugin
- [audit-logging.md](audit-logging.md) — @trail, @@trail, logger driver, onLog callback
- [multi-database.md](multi-database.md) — database blocks, drivers (sqlite/jsonl/logger), @@db, @@external
- [sequences.md](sequences.md) — @sequence per-scope auto-increment
- [edge-fields.md](edge-fields.md) — @edge / @scoped: per-relationship & per-viewer values, scopedBy binder, eject-to-model

## Infrastructure
- [performance.md](performance.md) — WAL, dual connections, select:false, indexes, fast paths
- [concurrency.md](concurrency.md) — `bun:sqlite` is synchronous: what blocks the event loop, `busyTimeout` (option → env → default), why two clients on one file in one process deadlock, and when to reach for a worker thread
- [multi-tenancy.md](multi-tenancy.md) — the `tenancy { }` block: a database per tenant or a tenant column, and how a request names one
- [replication.md](replication.md) — Litestream wrapper, WAL replication, point-in-time recovery

## Tooling
- [testing.md](testing.md) — makeTestClient, Factory, Seeder, generateGateMatrix, generateValidationCases
- [onquery-logging.md](onquery-logging.md) — onQuery, $tapQuery, event shape, telemetry patterns
- [cli.md](cli.md) — all commands with flags
- [validate.md](validate.md) — `litestone validate`: which STORED rows the schema would now refuse. The half the migration differ cannot see, because a boundary validator leaves no CHECK behind
- [import.md](import.md) — `litestone import`: a Prisma/Rails/Postgres/Frappe schema read into `.lite`, and the graded list of what the reading could not express
- [studio.md](studio.md) — browser UI panels, REPL, acting-as picker
- [publishing.md](publishing.md) — npm scope, pre-publish checklist, version strategy

## Meta
- [internals.md](internals.md) — **for a change to litestone itself**: the rule each path must keep, the failure that established it, and its `FJS-###`. Reads, writes, events, policies, parse, migrations, SQLite, tenancy, client utilities, tooling
- [gotchas.md](gotchas.md) — production surprises and edge cases

## Audits

Point-in-time reviews. Read them for the reasoning; re-verify before citing a number
— see [VERIFYING.md](../../../VERIFYING.md).

- [PERFORMANCE_AUDIT.md](../bench/PERFORMANCE_AUDIT.md) — query and write-path performance review

## Guides

Task-oriented walkthroughs for real scenarios:

- [guides/multi-tenant-saas.md](guides/multi-tenant-saas.md) — per-tenant databases, encryption, audit log, migrations
- [guides/audit-trail.md](guides/audit-trail.md) — @@trail setup, before/after snapshots, onLog enrichment, querying
- [guides/file-uploads.md](guides/file-uploads.md) — FileStorage + presigned URLs end-to-end
- [guides/row-level-security.md](guides/row-level-security.md) — policies + GatePlugin together, layered security
