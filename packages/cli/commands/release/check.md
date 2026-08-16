---
title: release:check
description: Classify this deploy against the release before it — expand, contract or unknown
alias: release-check
examples:
  - fli release:check
  - fli release:check --from v1.4.0
  - fli release:check --strict
  - fli release:check --check
flags:
  from:
    char: f
    type: string
    description: The release to compare against — a git ref, or a path to a schema file
    defaultValue: ''
  strict:
    char: s
    type: boolean
    description: Exit 1 unless the verdict is expand or unchanged
    defaultValue: false
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches the schema
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Emit the verdict as JSON and write nothing
    defaultValue: false
  stdout:
    type: boolean
    description: Print the snapshot instead of writing a file
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is release.snapshot.md beside the schema)
    defaultValue: ''
---

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const opts = [
  flag.from   ? `--from ${flag.from}` : '',
  flag.strict ? '--strict' : '',
  flag.check  ? '--check'  : '',
  flag.json   ? '--json'   : '',
  flag.stdout ? '--stdout' : '',
  flag.out    ? `--out ${flag.out}` : '',
].filter(Boolean).join(' ')

context.exec({
  command: `${litestone(context)} release --schema ${schemaPath(context)} ${opts}`,
})
```

## The question

A deploy is not one unit. Code is replaced; the rows already written are not,
and the release currently serving keeps answering requests while the new one
starts. So the honest question is whether the two can share one database:

- **expand** — N-1 keeps working. The deploy can be taken back.
- **contract** — N-1 breaks. This deploy is the pivot: after it, only forward.
- **unknown** — something moved and nothing here can say which way. Counts as a
  contract, because a wrong *reversible* is the only answer that costs anything.

## What it reads

`db/schema.lite`, twice: as it is now, and as it was at the release you name.
The default baseline is `HEAD`, so an uncommitted schema change is classified
before it is committed; `--from v1.4.0` asks the question a deploy asks, which
is *what is between what is serving and what I am about to ship*.

## What counts

| Change | Verdict | Why |
| --- | --- | --- |
| a model, an optional column, a defaulted column | expand | N-1 writes without it |
| an index, an eased gate, a removed `@unique` | expand | nothing N-1 does starts failing |
| an added enum member | expand | the CHECK widens — though N-1 will read a value it has no branch for |
| a required column with no default | **contract** | every N-1 write omits it and is refused |
| a dropped column, a renamed table, a changed type | **contract** | N-1 binds to what was there |
| an added `@unique` or `@@unique` | **contract** | an N-1 write that duplicates is now refused |
| a raised `@@gate`, an added `@@allow` | **contract** | N-1 callers are refused, or quietly filtered |
| a changed policy predicate | unknown | whether it widens or narrows is not decidable from the text |

The access rows are the half no generic deployer can see. Raising a gate takes
reads away from a release that is still serving them, and adding a row policy
empties a screen with a 200 and no error — both are compatibility changes, and
both are visible here only because the rule is declared in the schema rather
than written in a handler.

## The split

A required column with no default is not refused and left there. It is the one
contract with a supported alternative, and the command prints it:

```
expand:   declare it optional and deploy — N-1 keeps serving
backfill: fill it for the rows that predate it
contract: declare it required and deploy again — this deploy is the pivot
```

## The snapshot

`db/release.snapshot.md` — the surface a release binds to: every model, its
table, its gate, every field with its type, nullability and default, the
constraints, the policies and the state transitions. Commit it, and the diff
between two releases is the classified change.

It holds the surface and **never the verdict**. A verdict is a fact about two
schemas and the file describes one, so writing it in would make the file depend
on its own previous contents — and a file that cannot be regenerated twice to
the same bytes cannot be rechecked.

## In CI

```
fli release:check --check     # exits 1 when the committed snapshot is stale
fli release:check --strict    # exits 1 unless the verdict is expand or unchanged
```

`--check` is a staleness check and nothing else — it is what `fli
test:snapshots` reruns out of the file's own header, and a check that also
needed git would fail in a tarball rather than in a repository. `--strict` is
the gate: put it on the branch that deploys, and a contract has to be a decision
somebody made rather than one nobody noticed.

`--strict` also fails when there is **no** baseline — an uncommitted schema, a
ref that predates the file, a baseline that does not parse. It asks for a
reversible deploy, and *I could not tell* is not one.
