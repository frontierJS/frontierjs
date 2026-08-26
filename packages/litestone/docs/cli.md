# CLI Reference

```bash
bunx litestone <command> [flags]
```

All commands read `litestone.config.js` by default. Override with `--config`.

## Migration commands

```bash
litestone migrate create [label]
```
Generate a new SQL migration file from the diff between your schema and the live database. Creates `migrations/<timestamp>_<label>.sql`.

```bash
litestone migrate apply
```
Apply all pending migration files in chronological order. Records applied migrations in `_litestone_migrations`.

```bash
litestone migrate status
```
Show migration state: `applied`, `pending`, or `modified` (applied file changed on disk).

```bash
litestone migrate verify
```
Confirm the live database schema matches what the migration files would produce. Exits non-zero if drift detected — useful in CI.

```bash
litestone migrate dry-run [label]
```
Preview the SQL that would be generated, without writing a file.

## Development commands

```bash
litestone studio [--port=5001]
```
Launch the browser UI at `http://localhost:5001`. Includes table browser, SQL editor, schema viewer, migration status, REPL, and performance advisor.

```bash
litestone repl
```
Interactive Litestone query REPL with autocomplete and history.

```bash
litestone doctor
```
Analyze schema and database health: missing FK indexes, large tables without covering indexes, fragmented FTS5 segments, WAL growth.

## Type generation

```bash
litestone types [out.d.ts]
litestone types --only=users,posts
```
Generate TypeScript declarations from your schema. Outputs `<model>Where`, `<model>Create`, `<model>Update`, `<model>OrderBy` types for every model. `--only` limits output to specified models.

## Schema tools

```bash
litestone explain [@word] [--visibility] [--json]
```
What a `.lite` word is, what it accepts, where it is legal. No schema, no
database, no server — it reads the language's own catalog, so it answers in a
directory with nothing in it.

A bare word that exists at two levels shows both: `@unique` constrains a column
and `@@unique` constrains a tuple, and answering the wrong one is worse than
answering neither. `--visibility` asks the question that runs the other way —
*I need a column the caller may not read, which word is that?* — as three yes/no
answers. An unknown word suggests the near ones and exits 1.

```bash
litestone advise [--json]
```
The one command that reads YOUR schema and says something no generated artefact
can. Two lists, and they are two questions.

**Legal and worth a look** — the schema says something and a layer above the
parser refuses it: a required `@guarded` column nothing below level 8 can
create, an `@@fts` over an `@encrypted` column where the search can never match,
a foreign key with no index. `parse()` is more permissive than everything above
it, so these stay green through every migration and every test.

**Declared by nobody** — the schema says nothing, everything works, and a word
would have said it better: a `deletedAt` with no `@@softDelete` behind it, a
token column stored as text, an enum lifecycle any write may set to any value,
the same columns written out in five models. Nothing else can produce this list,
because every other artefact is derived from the seed and a word absent from the
seed is absent from all of them.

Each suggestion names the word it is about and prints the next thing to type —
`litestone explain @@fts`, and the docs page beside it. A rule carries a
`severity` because it is a defect; a suggestion carries a `confidence` because
the schema is not wrong and you may have meant it. **Neither list is a gate**:
`litestone access --strict` and `litestone release --strict` are the two that
fail a branch.

```bash
litestone catalog --snapshot  [--check] [--stdout] [--out=<path>]
litestone catalog --reference [--check] [--stdout] [--out=<path>]
```
Two renderings of the same table, and the difference is who reads them.

`--snapshot` writes `catalog.snapshot.md` at the package root: facts in columns,
no prose, so a diff is *what changed about the language* rather than a reshuffle
on an edited sentence. `--reference` writes `docs/reference.snapshot.md`: every
word with its blurb, a worked example and cross-links — the page you read when
you do not already know the word to look up.

Both are gated by CI, and every example on the reference page is the same text
`test/catalog.test.ts` parses. Neither takes a `--schema`: the language is a
property of this package, not of your seed.

```bash
litestone introspect <db> [--out schema.lite] [--no-camel]
```
Reverse-engineer a live SQLite database into a `.lite` schema. Reconstructs column types, FK relations, indexes, `@@softDelete`, enum CHECK constraints.

```bash
litestone jsonschema [--out=<path>] [--stdout] [--mode=create|update|full] [--all-modes]
                     [--format=definitions|flat] [--include-timestamps] [--include-deleted-at]
```
Generate JSON Schema from your `.lite` schema. Writes `./schema.json` beside the schema by default; `--out` pointed at a directory writes `schema.json` into it, and `--all-modes` writes `schema.create.json` / `.update.json` / `.full.json`.

`--format=flat` puts every definition at the document root instead of under `$defs` — still one file, not one per model. `--mode` decides which fields exist: `create` omits `@id`, `update` drops `required[]`, `full` adds ids plus the read-only computed/generated/`@from`/`@version` fields.

`--stdout` prints the document with no banner, so `litestone jsonschema --stdout > schema.json` parses.

[jsonschema.md](jsonschema.md) is the full key reference.

## Data commands

```bash
litestone seed [SeederClass]
```
Run the default seeder or a named seeder class.

```bash
litestone seed run [name] [--db=main] [--force]
```
Run a named data seed (e.g. calendar table). `--force` re-runs even if already applied.

```bash
litestone backup [dest] [--vacuum]
```
Create a hot backup. `--vacuum` runs `VACUUM INTO` for a compacted copy.

```bash
litestone optimize [table]
```
Merge FTS5 index segments for optimal search performance. Omit `table` to optimize all FTS models.

## Infrastructure

```bash
litestone replicate [config.js]
```
Start Litestream WAL replication. Runs as a managed subprocess — signal-forwarded, YAML config auto-generated.

```bash
litestone transform [config.js] [--preview] [--dry-run]
```
Run the anonymize/shard pipeline (dev tool). `--preview` shows output without writing.

## Tenant management

```bash
litestone tenant list
litestone tenant create <id>
litestone tenant info <id>
litestone tenant delete <id>
litestone tenant migrate [--only=id1,id2] [--concurrency=8]
```

Reads the schema's own `tenancy { }` block for the tenant directory, the
registry file, the pool size and the key. `--dir` / `--registry` and a
`tenants:` key in `litestone.config.js` override it, in that order — **flag,
config, schema, default**. A schema declaring `tenancy { strategy row }` has one
database and a tenant column, so these commands refuse by name rather than
writing files nothing will read. See `docs/multi-tenancy.md`.

## Global flags

| Flag | Description |
|---|---|
| `--config=<path>` | Path to `litestone.config.js` |
| `--schema=<path>` | Path to `.lite` schema file |
| `--db=<path>` | Path to SQLite database file |
| `--migrations=<dir>` | Path to migrations directory |
| `--port=<n>` | Studio port (default: 5001) |
