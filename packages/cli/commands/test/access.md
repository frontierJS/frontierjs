---
title: test:access
description: Derive the access snapshot from schema.lite — gates, row policies, protected fields, transition gates
alias: test-access
examples:
  - fli test:access
  - fli test:access --check
  - fli test:access --stdout
flags:
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches the schema
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Write the structured table instead of the markdown
    defaultValue: false
  stdout:
    type: boolean
    description: Print instead of writing a file
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is access.snapshot.md beside the schema)
    defaultValue: ''
---

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const opts = [
  flag.check  ? '--check'  : '',
  flag.json   ? '--json'   : '',
  flag.stdout ? '--stdout' : '',
  flag.out    ? `--out ${flag.out}` : '',
].filter(Boolean).join(' ')

context.exec({
  command: `${litestone(context)} access --schema ${schemaPath(context)} ${opts}`,
})
```

## What it writes

`db/access.snapshot.md` — every access rule the Data boundary enforces, in one
file:

- **Unrestricted** — models declaring neither `@@gate` nor `@@allow`. Every
  caller reaches every row, an unauthenticated one included.
- **Gates** — the minimum level per model per operation.
- **Row policies** — each `@@allow`/`@@deny` predicate, in the syntax it was
  written in. A policy compiles into the WHERE clause and never raises, so a
  wrong one is an empty screen with a 200.
- **Protected fields** — `@guarded`, `@encrypted`, `@secret`, field `@allow`.
- **State transitions** — each `@@transitions` move and the level it needs.

Sections are omitted when empty, and models are sorted by name so that adding
one does not shift every row below it.

## In CI

```
fli test:access --check
```

Exits 1 with the differing lines when the snapshot is stale.
