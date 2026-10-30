# CLI Reference

```bash
bunx litestone <command> [flags]
```

All commands read `litestone.config.js` by default. Override with `--config`.

## Every command

```bash
litestone init [--force]
litestone migrate create [label] [--rename Model.old=new]... [--operations ops.json]
litestone migrate dry-run [label]
litestone migrate dev [label]                            # create, then apply — the everyday verb
litestone migrate apply [--backup[=dir]]
litestone migrate status
litestone migrate verify
litestone migrate check                                  # does the history build the schema? no database opened
litestone migrate lock [--check]                         # freeze applied files: an edit fails, an append passes
litestone migrate baseline                               # record the files as applied, running none
litestone db push [--accept-data-loss]                   # apply the schema directly, no file written (dev)
litestone studio [--port=5502] [--no-open] [--gate <path[#export]>] [--host <addr> --token <secret>] [--readonly]
litestone repl [--as <who|Model:who>] [--level <0-9>] [--gate <path[#export]>] [--tenant <id>] [--eval '<expr>']
litestone doctor
litestone types [out.d.ts] [--only=User,Post] [--audience=client|system] [--augment=junction] [--out=<path>] [--stdout]
litestone seed [SeederClass]
litestone seed run [name] [--db=<path>] [--force]
litestone introspect <db> [--out=schema.lite] [--report=<path>] [--strict] [--no-camel]
litestone import <path> [--from=prisma|rails|sql|frappe] [--out=<path>] [--report=<path>] [--strict]
litestone export <dataset> --as <who> | --system [--since=<cursor>] [--format=ndjson|csv] [--out=<dir>] [--stdout]
                 [--include-protected] [--with-deleted] [--gate <path[#export]>] [--tenant <id>]
litestone edge eject <Model>.<field> [--apply]           # promote an @edge/@scoped field to a model
litestone transform [config.js] [--preview] [--dry-run] [--out=<path>] [--only=A,B] [--concurrency=8]
litestone explain [@word] [--visibility] [--json]        # the language, no schema needed
litestone catalog --snapshot [--check] [--stdout] [--out=<path>]   # the language surface, committed
litestone catalog --reference [--check] [--stdout] [--out=<path>]  # docs/reference.snapshot.md, the A-Z page
litestone advise [--json] [--strict]                     # legal-and-wrong, plus legal-and-MISSING
litestone validate [--only=A,B] [--json]                 # which STORED rows the schema would now refuse; exits 1
litestone assistant [--bare] [--out=<path>] [--purpose=<path>]  # a chat-model schema assistant + this schema + PURPOSE.md, to paste
litestone assistant --snapshot [--check]                 # assistant.snapshot.md — the URL form, no schema
litestone jsonschema [--out=<path>] [--stdout] [--mode=create|update|full] [--all-modes] [--format=definitions|flat]
litestone jsonschema --snapshot [--check] [--stdout] [--out=<path>]
litestone access [--check] [--json] [--stdout] [--out=<path>]
litestone access --for <who> [--json]                    # what this person can do, live
litestone access --from=<ref|path> [--strict] [--json]   # the permission diff
litestone ddl [--check] [--stdout] [--pluralize] [--out=<path>]
litestone release [--from=<ref|path>] [--strict] [--check] [--json] [--out=<path>]
litestone mirror exit                                    # write each @@mirror out as what it derived, in place
litestone mutate                                         # mutate the schema, report what the checks miss
litestone mutate --suite "bun test api/test"           # ...and run the app's own tests on each survivor
litestone replicate [config.js] [--url=<url>] [--interval=<s>] [--retention=<d>] [--db=<name>]
litestone restore [config.js] [--at=<instant>] [--from-backup=<dir>] [--force | --verify=<dir> [--without-key]]
litestone rekey [--orphan=Model.field,…]                 # every encrypted column from ENCRYPTION_KEY to NEW_ENCRYPTION_KEY
litestone rsync <dest>                                   # every SQLite db to a destination via sqlite3_rsync
litestone backup [dest] [--vacuum] [--zip] [--db=<name>]
litestone optimize [table]
litestone tenant list|create|info|delete|migrate
```

## Migration commands

```bash
litestone migrate create [label]
```
Generate a new SQL migration file from the diff between your schema and the migration history replayed into a shadow database — the live database is not consulted. Creates `migrations/<timestamp>_<label>.sql`.

A renamed column is a drop plus an add to a diff, so say it was a rename and its values stay (`ALTER TABLE … RENAME COLUMN`, written into the file and named in its header):

```bash
litestone migrate create rename --rename Issue.description=brief     # Model.oldColumn=newField, repeatable
litestone migrate create rename --operations ops.json                # the same, as a document
```

On a terminal with neither, `create` asks about each column that left beside one of the same type that arrived. `migrate dev` takes the same flags. The document is `{ "operations": [{ "op": "rename", "model": "Issue", "from": "description", "to": "brief" }] }`; `@frontierjs/oracle`'s `emit()` returns it as `document`.

```bash
litestone migrate dev [label]
```
Create, then apply, in one verb — the one a developer runs constantly. It refuses when the live database is ahead of its history (a column pushed and never written down) and says the way out, rather than failing on `duplicate column name` from the middle of a file.

```bash
litestone migrate apply [--backup[=dir]]
```
Apply all pending migration files in chronological order. Records applied migrations in `_litestone_migrations`. Before applying, it asks the same question `migrate check` asks and refuses when the history does not build the declared schema, so a container does not start over a database holding litestone's bookkeeping table and nothing else. `--backup` copies every database first — there is no down. A file whose DESTRUCTIVE box still says `Accept data loss: no` is refused.

```bash
litestone migrate check
```
Does the migration history build the schema this app declares? Asked of the repo alone — the files are replayed into a shadow database and diffed against the schema, no database of yours is opened — which is what lets CI and `fli deploy:doctor` ask it before an image exists. Exits 1 when the history falls short.

```bash
litestone migrate lock [--check]
```
Freeze the history once a real database has applied it. Writes `migrations.snapshot.md` beside the migrations directory: each file with the checksum `migrate apply` records for it. `--check` exits 1 when a listed file was edited or removed, and passes a newer file that is not listed yet. A write only appends — it refuses a changed or missing listed file rather than rehashing it, so `fli check --fix` cannot bless the edit. The header names the command, so `fli test:snapshots` and the CI `snapshots` phase run it.

```bash
litestone migrate baseline
```
Record the migration files as applied without running them, for a database that already holds what they build: an app developed through `db push`, or your own database the moment `migrate create` writes a delta you had already pushed.

```bash
litestone migrate status
```
Show migration state per file: `applied`, `pending`, `modified` (applied file changed on disk — checksum mismatch), `orphaned` or `skipped`.

```bash
litestone migrate verify
```
Confirm the live database matches the DECLARED schema — the schema is built into a pristine database and the two are diffed. Exits non-zero on drift, and prints the corrective diff; `migrate check` is the other comparison, history against schema.

```bash
litestone migrate dry-run [label]
```
Preview the SQL that would be generated, without writing a file.

```bash
litestone db push [--accept-data-loss]
```
Apply the schema to the database directly, writing no migration file — prototyping only, because a history that falls behind is what `migrate apply` refuses at deploy. A change that drops a column and its values asks `y/N` at a terminal and refuses anywhere else unless `--accept-data-loss` is passed.

## Development commands

```bash
litestone studio [--port=5502] [--no-open] [--gate <path[#export]>] [--host <addr> --token <secret>] [--readonly]
```
Launch the browser UI at `http://localhost:5502` and open it (`--no-open` to not). `--gate` grades access previews with the app's own `getLevel`; `--host` beyond loopback is refused without `--token`; `--readonly` blocks every mutating endpoint. [studio.md](studio.md) is the full reference.

```bash
litestone repl [--as <who|Model:who>] [--level <0-9>] [--gate <path[#export]>] [--tenant <id>] [--eval '<expr>']
```
A console that boots at a gate level, with `db`, the model accessors and tab completion. `--as` resolves an account the way `export --as` does; `--level` fixes the standing with no user; `--eval` runs one expression, prints it as JSON and exits 1 on a throw. A `repl.js` beside the schema adds commands.

```bash
litestone doctor
```
Check setup and database health: Bun version, config, schema validity, database reachability and stale `-wal`/`-shm` files, migration state, and performance — FK columns with no index, large tables with no index at all, stale `ANALYZE` statistics, WAL checkpoint pressure.

## Type generation

```bash
litestone types [out.d.ts] [--only=User,Post] [--audience=client|system] [--augment=junction] [--stdout]
```
Generate TypeScript declarations from your schema, to `<schema>.d.ts` beside it by default. Outputs `<Model>` (the row), `<Model>Create`, `<Model>Update`, `<Model>Where` and `<Model>OrderBy` for every model — `User`, `UserCreate`, … `--only` takes model names and refuses one that names no model. `--audience=system` includes the fields a client never sees and registers the generated client as what `createClient()` answers; `--augment=junction` adds the module augmentation Junction's `ServiceTypes` reads. [typescript.md](typescript.md) shows what is generated.

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
litestone advise [--json] [--strict]
```
The one command that reads YOUR schema and says something no generated artifact
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
because every other artifact is derived from the schema and a word absent from the
seed is absent from all of them.

**Three of them are about a decision that cannot be taken back**, which is why
they are here rather than in a rule: a second open validity window, a document
reading its price through a relation so the catalog reprices what is already
written, and a standing spelled on a model that spans tenants. Each is legal,
each works, and each loses information nothing can recover once it is wrong —
so the confidence is about whether you meant it, never about whether it broke.

Each suggestion names the word it is about and prints the next thing to type —
`litestone explain @@fts`, and the docs page beside it. A rule carries a
`severity` because it is a defect; a suggestion carries a `confidence` because
the schema is not wrong and you may have meant it. **Neither list is a gate**:
`litestone access --strict` and `litestone release --strict` are the two that
fail a branch, and `advise --strict` exits 1 on an error or warn RULE alone.

One refusal is not a rule and always exits 1: a schema that parses and that
`createClient` then rejects (a `@@gate` ladder out of order, a `@@unique` over
an optional column). `advise` builds the client over memory first, so it answers
*will this schema run* with no database, and `fli check`'s `schema-runs` rule is
that call.

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
litestone introspect <db> [--out=schema.lite] [--report=<path>] [--strict] [--no-camel]
```
Reverse-engineer a live SQLite database into a `.lite` schema. Reconstructs column
types, FK relations, indexes, `@@softDelete` and enum CHECK constraints.

**Graded the same way `import` is**, and for the same reason: a database says less
than the schema that built it, and a converter that prints only its output has
quietly decided what to lose. `--report` writes the list as JSON, `--strict` exits
1 on `changed`. What it reports here is partial and expression indexes, a second
index over one column list, a generated column or a default `.lite` has no
spelling for, a referential action it has no word for — and, where the DEFAULT is
evidence, the two types SQLite cannot hold: `DateTime` is stored as TEXT and
`Boolean` as INTEGER, so both come back as something else and only you know which.
No `@@gate`, `@@allow`, `@secret` or `@@fts` is in a SQLite file at all; that is
said once, in the report and at the top of the generated schema.

Given no path it uses the database the SCHEMA declares — which is what
`fli db:pull` passes, and for its whole life it fell back to `./development.db`
instead and named a file the app never mentioned. A schema declaring several is
asked which with `--db=<name>`: one database in is one schema out, and each of
its models carries `@@db(<name>)` so it lands in the right file when pasted into
the multi-database schema.

**The output parses, and reading it back is a fixed point** —
`test/introspect-roundtrip.test.ts` asserts it over the corpus. That is the
property rather than a nicety: for its whole life this emitted a `.lite` litestone
could not read, behind six tests that only ever matched substrings of it
(`FJS-594`). The output is order-stable, so re-running it produces a diff you can
read.

```bash
litestone import <path> [--from=prisma|rails|sql|frappe] [--out=<path>] [--report=<path>] [--strict]
```
Read a schema you already have — a Prisma schema, a Rails `db/schema.rb`, a PostgreSQL dump, or a Frappe app — into `.lite`. The format is detected from the path; `--from` always wins.

**The output is not the whole answer.** Every construct the reading could not express is recorded and graded: **changed** (the schema says something the source does not), **lost** (the source says something the schema does not), **noted** (a decision for you). `--strict` fails on `changed` alone. Each `changed` one is marked on its own line in the written file with `// ⚠ imported:`.

Without `--out` the schema goes to stdout and the report to stderr, so `litestone import x.prisma > db/schema.lite` parses. [import.md](import.md) is the full reference.

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
litestone seed run [name] [--db=<path>] [--force]
```
Run a named infrastructure seed (e.g. a calendar table), from `src/tools/seeds/`. `--force` re-runs one already applied; `--db` names the database file.

```bash
litestone export <dataset> --as <who> | --system [--since=<cursor>] [--format=ndjson|csv] [--out=<dir>] [--stdout]
                 [--include-protected] [--with-deleted] [--gate <path[#export]>] [--tenant <id>]
```
Take a bulk extract of a dataset that declares `@@export`, graded as the account `--as` names — the rows that leave are the rows that account can read. Writes `<dataset>.<format>` and `<dataset>.manifest.json` into `--out` (default: the working directory); `--stdout` streams the rows and prints the manifest to stderr. `--since` resumes from the cursor a previous manifest recorded. [export.md](export.md) is the full reference.

```bash
litestone backup [dest] [--vacuum] [--zip] [--db=<name>]
```
Create a hot backup — with no `dest`, into a new `db/backups/<stamp>/` beside the schema, so a second backup never replaces the first. `--vacuum` runs `VACUUM INTO` for a compacted copy. With the schema in `db/`, every other file under `db/` comes too — [replication.md § The rest of `db/`](replication.md#the-rest-of-db).

```bash
litestone optimize [table]
```
Merge FTS5 index segments for optimal search performance. Omit `table` to optimize all FTS models.

## Infrastructure

```bash
litestone replicate [config.js] [--url=<url>] [--interval=<s>] [--retention=<d>] [--db=<name>]
```
Start Litestream WAL replication. Runs as a managed subprocess — signal-forwarded, YAML config auto-generated. Each flag overrides the same key under `replicate:` in the config.

```bash
litestone restore [config.js] [--url=<url>] [--at=<instant>] [--from-backup=<dir>] [--force | --verify=<dir> [--without-key]] [--json]
```
Bring every database `replicate` streams back from its replica — all or nothing. `--from-backup` with no `--url`, `--at` or `--verify` restores every database from a `litestone backup` directory instead, with no litestream (§ From a local backup). `--verify` restores into `<dir>` instead and grades the copy. See `docs/replication.md` § Restoring and § Proving a copy.

```bash
litestone rekey [--orphan=Model.field,…]
```
Re-encrypt every encrypted column from `ENCRYPTION_KEY` to `NEW_ENCRYPTION_KEY` (or the file `NEW_ENCRYPTION_KEY_FILE` names), through `$rotateKey`: one transaction per database, the app stopped first. The new key is never an argument, because `ps`, shell history and `docker exec` all show one; a positional is refused. `--orphan` is `$rotateKey`'s `{ orphan }`, the `@hashed` and `@secret(rotate: false)` columns it otherwise refuses to leave behind. A run that died between two databases is finished by running it again with the same two keys. Then set `ENCRYPTION_KEY` to the new key; a backup taken before is still under the old one. `strategy database` is refused: the tenants' files are not reached. See `docs/encryption.md` § Key rotation.

```bash
litestone transform [config.js] [--preview] [--dry-run] [--out=<path>] [--only=A,B] [--concurrency=8]
```
Run the anonymize/shard pipeline (dev tool). `--preview` shows output without writing; `--dry-run` runs the pipeline and writes nothing.

```bash
litestone rsync <dest>
```
Sync every SQLite database to a destination with `sqlite3_rsync`.

## Tenant management

```bash
litestone tenant list
litestone tenant create <id>
litestone tenant info <id>
litestone tenant delete <id>
litestone tenant migrate [--only=id1,id2] [--concurrency=8]
```

`tenant create` takes `--meta '<json>'` to store alongside the id.

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
| `--env-file=<path>` | Load env vars from this file (default: `./.env.local`, then `./.env`) |
| `--no-env` | Skip loading `.env` files |
| `--debug` | Print stack traces on error |
| `--version` | Print the version and exit |

A flag no command reads is refused by name before anything runs, so `migrate create --dry` writes no file; the preview is `migrate dry-run`.
