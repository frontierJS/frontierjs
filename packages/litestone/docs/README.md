# Litestone Docs

## Getting started
- [getting-started.md](getting-started.md) — install, quick start, createClient, first query
- [why-litestone.md](why-litestone.md) — why SQLite, why Bun, why schema-first, when to choose something else
- [gotchas.md](gotchas.md) — production surprises: ILIKE, json_extract types, NULL behavior, WAL contention

## Schema
- [schema.md](schema.md) — .lite DSL: types, field attributes, model attributes, enums, functions
- [migrations.md](migrations.md) — autoMigrate, file migrations, JS migrations, CLI
- [typescript.md](typescript.md) — litestone types, generated .d.ts, WhereBase, WindowSpec

## Querying
- [querying.md](querying.md) — findMany, findFirst, findUnique, count, exists, pagination, writes, multi-model `db.query()` batch
- [filtering.md](filtering.md) — where clause, operators, AND/OR/NOT, $raw + sql tag
- [sorting.md](sorting.md) — orderBy, NULLS FIRST/LAST, relation field, relation aggregate
- [relations.md](relations.md) — belongsTo, hasMany, manyToMany, include, nested writes, recursive tree
- [aggregation.md](aggregation.md) — aggregate(), groupBy(), interval/fillGaps, FILTER, named aggs, query() dispatcher
- [window-functions.md](window-functions.md) — all window fns, partitionBy, frame specs, FILTER

## Security & access control
- [access-control.md](access-control.md) — row policies, field policies, GatePlugin levels, auth()
- [encryption.md](encryption.md) — @encrypted, @secret, $rotateKey, searchable encryption

## Features
- [soft-delete.md](soft-delete.md) — @@softDelete, cascade, @hardDelete, restore
- [full-text-search.md](full-text-search.md) — @@fts, search(), highlight/snippet, optimizeFts
- [file-storage.md](file-storage.md) — FileStorage plugin, S3/R2/local, autoResolve, fileUrl, ExternalRefPlugin
- [audit-logging.md](audit-logging.md) — @log, @@log, logger driver, onLog callback
- [multi-database.md](multi-database.md) — database blocks, drivers (sqlite/jsonl/logger), @@db, @@external
- [sequences.md](sequences.md) — @sequence per-scope auto-increment

## Infrastructure
- [performance.md](performance.md) — WAL, dual connections, select:false, indexes, fast paths
- [multi-tenancy.md](multi-tenancy.md) — createTenantRegistry, per-tenant DBs, migration, encryptionKey fn
- [replication.md](replication.md) — Litestream wrapper, WAL replication, point-in-time recovery

## Tooling
- [testing.md](testing.md) — makeTestClient, Factory, Seeder, generateGateMatrix, generateValidationCases
- [onquery-logging.md](onquery-logging.md) — onQuery, $tapQuery, event shape, telemetry patterns
- [cli.md](cli.md) — all commands with flags
- [studio.md](studio.md) — browser UI panels, REPL, acting-as picker
- [publishing.md](publishing.md) — npm scope, pre-publish checklist, version strategy

## Meta
- [roadmap.md](roadmap.md) — what's coming: Money, Embedding, LatLng, @slug, ExternalSync
- [gotchas.md](gotchas.md) — production surprises and edge cases

## Guides

Task-oriented walkthroughs for real scenarios:

- [guides/multi-tenant-saas.md](guides/multi-tenant-saas.md) — per-tenant databases, encryption, audit log, migrations
- [guides/audit-trail.md](guides/audit-trail.md) — @@log setup, before/after snapshots, onLog enrichment, querying
- [guides/file-uploads.md](guides/file-uploads.md) — FileStorage + presigned URLs end-to-end
- [guides/row-level-security.md](guides/row-level-security.md) — policies + GatePlugin together, layered security
