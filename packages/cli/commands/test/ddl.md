---
title: test:ddl
description: Derive the DDL snapshot from schema.lite — the tables, indexes, triggers and views SQLite is given
alias: test-ddl
examples:
  - fli test:ddl
  - fli test:ddl --check
  - fli test:ddl --stdout
flags:
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches the schema
    defaultValue: false
  stdout:
    type: boolean
    description: Print instead of writing a file
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is ddl.snapshot.sql beside the schema)
    defaultValue: ''
---

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const opts = [
  flag.check  ? '--check'  : '',
  flag.stdout ? '--stdout' : '',
  flag.out    ? `--out ${flag.out}` : '',
].filter(Boolean).join(' ')

context.exec({
  command: `${litestone(context)} ddl --schema ${schemaPath(context)} ${opts}`,
})
```

## What it writes

`db/ddl.snapshot.sql` — one section per declared database, in declaration order:
every `CREATE TABLE`, index, FTS table, `updatedAt` trigger, join table and view
the schema emits. A `jsonl` or `logger` database is named and skipped, because
absent DDL and an absent database have to read differently.

## Why it is committed

The access snapshot covers a rule nothing below the API can show you. This
covers the opposite problem: a name every hand-written statement binds to.
Columns are emitted verbatim camelCase and `DateTime` as ISO-8601 TEXT, so a
change in litestone's emitter renames a column in an app that never touched its
schema — and the app's own tests go through the client that changed with it, so
none of them can see it.

Fragments an app merges at runtime (auth's models, for one) are not in the file.
It is what the schema declares, not what the running database happens to hold.

## In CI

```
fli test:ddl --check
```

Exits 1 with the differing lines when the snapshot is stale. In this repo
`scripts/ci.mjs`'s `snapshots` phase finds it without being told: the file's
header names the command that regenerates it.
