---
title: test:access
description: Derive the access snapshot from schema.lite — gates, row policies, protected fields, transition gates
alias: test-access
examples:
  - fli test:access
  - fli test:access --check
  - fli test:access --from origin/main
  - fli test:access --from origin/main --strict
flags:
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches the schema
    defaultValue: false
  from:
    char: f
    type: string
    description: Diff the access surface against that release instead of writing a file — a git ref or a schema path
    defaultValue: ''
  strict:
    char: s
    type: boolean
    description: With --from, exit 1 unless the verdict is narrows or unchanged
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
  flag.from   ? `--from ${flag.from}` : '',
  flag.strict ? '--strict' : '',
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

## What moved — `--from`

The snapshot says what **is**. A reviewer needs what **moved**, and the two are
not the same reading: a removed `@allow` line is the absence of a rule, so in a
diff of the schema it looks like tidying.

```
fli test:access --from origin/main
```

```
✗  WIDENS — this change hands callers access they did not have

Against `origin/main` — 2 widen · 0 undecidable · 1 narrow

  widens   User.role
           @allow('write') removed — nothing at the field refuses this column now
  widens   model User
           gate "4.4.5.6" → "2.4.5.6" — read drops to READER
  narrows  model Order
           @@allow('read') added — rows N-1 reads are filtered out, with a 200 and no error
```

Nothing is written. It reads gates, row policies, field `@allow`, `@guarded` /
`@encrypted` / `@secret`, and transition gates.

**This is not `release:check` with a different word.** It is the same comparison
graded on the other axis, and the two disagree by construction: removing a
`@@gate` is an *expand* for the deploy — nothing the previous release does starts
failing — and it is the widest thing a schema change can do. On a real five-part
widening every single finding was an expand. Whoever reviews permissions has to
be shown the permission answer.

What it cannot answer is a predicate whose text changed. Two expressions are not
comparable by reading them, so that is reported as undecidable rather than
guessed — the guess is the one that ships.

## In CI

```
fli test:access --check                      # the snapshot is stale
fli test:access --from origin/main           # print the permission diff
fli test:access --from origin/main --strict  # exit 1 on a widening
```

`--check` exits 1 with the differing lines when the snapshot is stale. `--strict`
is the gate, and it also fails when there is **no** baseline — it asks whether
this branch widens access, and *I could not tell* is not an answer to that.
