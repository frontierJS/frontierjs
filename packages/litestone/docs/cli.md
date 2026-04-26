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
litestone introspect <db> [--out schema.lite] [--no-camel]
```
Reverse-engineer a live SQLite database into a `.lite` schema. Reconstructs column types, FK relations, indexes, `@@softDelete`, enum CHECK constraints.

```bash
litestone jsonschema [--out=./schemas/] [--format=flat]
```
Generate JSON Schema from your `.lite` schema. `--format=flat` emits one file per model instead of a definitions object.

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
litestone tenant delete <id>
litestone tenant migrate [--only=id1,id2]
```

## Global flags

| Flag | Description |
|---|---|
| `--config=<path>` | Path to `litestone.config.js` |
| `--schema=<path>` | Path to `.lite` schema file |
| `--db=<path>` | Path to SQLite database file |
| `--migrations=<dir>` | Path to migrations directory |
| `--port=<n>` | Studio port (default: 5001) |
