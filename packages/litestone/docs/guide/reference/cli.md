# CLI

`litestone <command>` reads `litestone.config.js` and the schema beside it. Every command and flag is in the CLI doc; this is the list of what exists.

```sh
bunx litestone migrate dev add-notes   # create the migration from the schema diff, then apply it
bunx litestone explain @gate           # look a word up, no schema needed
```

## What else it can do

- `init` scaffolds a project, and `doctor` checks setup and database health
- `migrate create`, `dry-run`, `dev`, `apply`, `status`, `verify`, `check`, `lock`, `baseline` and `accept` are the migration verbs
- `db push` applies the schema with no file written, for prototyping
- `studio` opens the browser UI, and `repl` a console at a chosen user or level
- `types` writes the `.d.ts`, and `jsonschema` the JSON Schema document
- `explain` looks up a word, and `catalog` and `spec` write the generated reference pages
- `advise` reads the schema for what is legal and wrong, or legal and missing
- `validate` lists the stored rows the schema would now refuse
- `access` writes or diffs the permission surface, and `release` grades a change for deploy
- `ddl` writes the DDL snapshot, and `mutate` reports what the checks miss when the schema is mutated
- `import` reads a Prisma, Rails, SQL or Frappe schema, and `introspect` reads a live SQLite file
- `seed` and `seed run` run seeders, and `export` takes a graded bulk extract
- `edge eject` promotes an edge field to a model, and `mirror exit` writes each mirror out as what it derived
- `backup`, `rsync`, `replicate` and `restore` copy and recover databases, and `optimize` merges FTS5 segments
- `rekey` and `key-check` rotate and inspect encryption keys
- `transform` runs the anonymize and shard pipeline
- `tenant` lists, creates, inspects, deletes and migrates tenants
- `assistant` builds a chat-model schema assistant to paste
- Global flags are `--config`, `--schema`, `--db`, `--migrations`, `--env-file`, `--no-env`, `--debug` and `--version`

**In depth:** [CLI § Every command](../../cli.md#every-command), [§ Migration commands](../../cli.md#migration-commands), [§ Development commands](../../cli.md#development-commands), [§ Global flags](../../cli.md#global-flags)
