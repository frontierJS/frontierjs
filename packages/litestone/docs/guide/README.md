# Litestone Guide

What a schema and its client can do, one quick page per idea. The guide shows
what is possible; the topic docs beside this folder explain it. Every word, A–Z,
is [`../reference.snapshot.md`](../reference.snapshot.md).

A page is a skim, not a lesson:

- one or two sentences on what the feature is for
- one example, the smallest that shows it working
- a short list of what else it can do, a line each, with no explanation
- a closing **In depth** link to the doc its `from` note names

Edge cases, refusals, rulings and `FJS-` ids belong in the full doc. If a page
needs a second example to make sense, that material belongs in the full doc and
the page links to it.

This list is the page order. The website builds `/docs/litestone/` from it, so a
page that is not listed here is not published.

## Introduction

- [Overview](introduction/overview.md)
<!-- from: why-litestone.md, README.md -->
- [Getting started](introduction/getting-started.md)
<!-- from: getting-started.md § Install, Scaffold, Quick start -->
- [`.lite` files](introduction/lite-files.md)
<!-- from: schema.md § Naming conventions, Multi-file schemas, Doc comments, Schema functions -->
- [The client](introduction/the-client.md)
<!-- from: getting-started.md § createClient options, Auth scoping -->

## Schema

- [Models and fields](schema/models-and-fields.md)
<!-- from: schema.md § Types, Field attributes, Table structure -->
- [Ids and keys](schema/ids-and-keys.md)
<!-- from: schema.md § Identity & constraints, @@id, @@unique(where:); modeling.md § uuid or Int, natural key -->
- [Defaults](schema/defaults.md)
<!-- from: schema.md § Default values, Lifecycle; access-control.md § @default(auth().id) -->
- [Relations](schema/relations.md)
<!-- from: relations.md § Defining relations, One-to-one, The implicit join table -->
- [Enums](schema/enums.md)
<!-- from: schema.md § Enums, Labeling a member, A set of enum values -->
- [Numbers and money](schema/numbers-and-money.md)
<!-- from: exact-numbers.md -->
- [Json with a shape](schema/json.md)
<!-- from: json-types.md; modeling.md § Json array or join table -->
- [Computed fields](schema/computed-fields.md)
<!-- from: schema.md § Derived & generated, @generated, @derived -->
- [Choosing a field](schema/choosing-a-field.md)
<!-- from: modeling.md § Which feature makes this field -->

## Validation

- [Validators](validation/validators.md)
<!-- from: schema.md § Validators, Transforms -->
- [Checks](validation/checks.md)
<!-- from: schema.md § @check/@@check, What a @@check cannot say, @validate -->
- [State machines](validation/state-machines.md)
<!-- from: schema.md § State machines -->
- [Optimistic concurrency](validation/version.md)
<!-- from: schema.md § @version -->

## Querying

- [Reading rows](querying/reading.md)
<!-- from: querying.md § Read operations -->
- [Filtering](querying/filtering.md)
<!-- from: filtering.md -->
- [Sorting](querying/sorting.md)
<!-- from: sorting.md -->
- [Paging](querying/paging.md)
<!-- from: querying.md § Cursor pagination -->
- [`select` and `include`](querying/select-and-include.md)
<!-- from: querying.md § Select, Include; relations.md § Include, Relation counts -->
- [Writing rows](querying/writing.md)
<!-- from: querying.md § Write operations (an explicit null clears, invariant 9) -->
- [Nested writes](querying/nested-writes.md)
<!-- from: relations.md § Nested writes -->
- [Transactions](querying/transactions.md)
<!-- from: querying.md § Transactions -->
- [Aggregates and group-by](querying/aggregates.md)
<!-- from: aggregation.md -->
- [Scopes](querying/scopes.md)
<!-- from: querying.md § Scopes -->

## Access

- [The Warden](access/warden.md)
<!-- from: warden.md -->
- [Gates](access/gates.md)
<!-- from: access-control.md § Gates, Levels, @@gate syntax -->
- [Row policies](access/row-policies.md)
<!-- from: access-control.md § Row-level policies, Policy expressions, Applying policies -->
- [`auth()` and claims](access/auth-and-claims.md)
<!-- from: access-control.md § What auth().x may name, A claim on another row, An absent claim is UNKNOWN -->
- [Field policies](access/field-policies.md)
<!-- from: access-control.md § Field-level policies; schema.md § Visibility & security -->
- [Capabilities](access/capabilities.md)
<!-- from: access-control.md § Capabilities, The identity models -->
- [Refusals](access/refusals.md)
<!-- from: access-control.md § Combining them, Rule one, Rule two -->
- [Running as the system](access/as-system.md)
<!-- from: warden.md § asSystem -->

## Protected data

- [Encryption](protected/encryption.md)
<!-- from: encryption.md; access-control.md § Encryption keys, Comparing an encrypted column -->
- [Secrets, hashes and personal data](protected/secrets.md)
<!-- from: encryption.md § @secret; schema.md § Visibility & security -->
- [The audit trail](protected/audit-trail.md)
<!-- from: trail.md, guides/audit-trail.md -->
- [Soft delete](protected/soft-delete.md)
<!-- from: soft-delete.md -->
- [Bulk export](protected/export.md)
<!-- from: export.md -->

## Changing a schema

- [In development](migrations/development.md)
<!-- from: migrations.md § autoMigrate, db push is prototyping only -->
- [Migrations](migrations/migrations.md)
<!-- from: migrations.md § File migrations, The three schemas, There is no down -->
- [Data changes](migrations/data-changes.md)
<!-- from: migrations.md § Data changes are not migrations -->
- [Checking stored rows](migrations/validate.md)
<!-- from: validate.md -->
- [Adopting a database](migrations/adopting.md)
<!-- from: migrations.md § Introspect an existing database; import.md -->

## Built in

- [Full-text search](built-in/full-text-search.md)
<!-- from: full-text-search.md -->
- [Vectors](built-in/vectors.md)
<!-- from: vectors.md -->
- [Geo points](built-in/geo.md)
<!-- from: geo.md -->
- [Files](built-in/files.md)
<!-- from: file-storage.md, guides/file-uploads.md -->
- [Sequences](built-in/sequences.md)
<!-- from: sequences.md -->
- [Rank](built-in/rank.md)
<!-- from: rank.md -->

## Advanced

- [Multi-tenancy](advanced/multi-tenancy.md)
<!-- from: multi-tenancy.md, guides/multi-tenant-saas.md -->
- [Policies across relations](advanced/policies-across-relations.md)
<!-- from: access-control.md § include, check(field), relation.column, relation.some, @@require -->
- [Relationship rules](advanced/relationship-rules.md)
<!-- from: relations.md § @@relator, @from; schema.md § @@arc, @minItems -->
- [Trees](advanced/trees.md)
<!-- from: relations.md § Recursive tree queries -->
- [Edge fields](advanced/edge-fields.md)
<!-- from: edge-fields.md -->
- [Window functions](advanced/window-functions.md)
<!-- from: window-functions.md -->
- [Batch queries](advanced/batch-queries.md)
<!-- from: querying.md § Unified dispatcher, Multi-model batch -->
- [Raw SQL](advanced/raw-sql.md)
<!-- from: filtering.md § $raw + sql tag -->
- [Multiple databases](advanced/multiple-databases.md)
<!-- from: multi-database.md; migrations.md § Multi-database schemas -->
- [Extensible columns](advanced/extensible-columns.md)
<!-- from: extensible-columns.md -->
- [Traits](advanced/traits.md)
<!-- from: traits.md -->
- [Concurrency](advanced/concurrency.md)
<!-- from: concurrency.md -->
- [Performance](advanced/performance.md)
<!-- from: performance.md -->
- [Replication](advanced/replication.md)
<!-- from: replication.md -->

## Misc

- [Testing](misc/testing.md)
<!-- from: testing.md -->
- [TypeScript](misc/typescript.md)
<!-- from: typescript.md -->
- [JSON Schema](misc/json-schema.md)
<!-- from: jsonschema.md -->
- [Logging queries](misc/logging-queries.md)
<!-- from: onquery-logging.md -->
- [Studio](misc/studio.md)
<!-- from: studio.md -->
- [Gotchas](misc/gotchas.md)
<!-- from: gotchas.md -->
- [Coming from Prisma](misc/coming-from-prisma.md)
<!-- new: the Prisma-to-.lite mapping import.md already grades, written as prose -->

## Reference

- [Every word, A–Z](reference/words.md)
<!-- from: reference.snapshot.md (generated; this page renders it) -->
- [`createClient` options](reference/create-client.md)
<!-- from: getting-started.md § createClient options -->
- [CLI](reference/cli.md)
<!-- from: cli.md -->
