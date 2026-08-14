---
title: test:mutate
description: Mutate schema.lite and report which changes the derived checks cannot see
alias: test-mutate
examples:
  - fli test:mutate
  - fli test:mutate --kinds gate-drop,allow-drop
flags:
  kinds:
    char: k
    type: string
    description: Only these mutation kinds (comma-separated)
    defaultValue: ''
---

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const opts = flag.kinds ? `--kinds ${flag.kinds}` : ''

context.exec({
  command: `${litestone(context)} mutate --schema ${schemaPath(context)} ${opts}`,
})
```

## What it does

Drops a `@@gate`, grades one down, removes a `@guarded`, widens a `@length`,
deletes an `@@allow` — one mutant per attribute occurrence — then builds a
database from each mutant and runs the checks derived from the **original**
schema against it.

A mutant nothing notices is a hole in the checks, and it names itself:

```
1 SURVIVED — nothing in the checks can see these changes

  unique-drop  (1)
    schema.lite:58  Product: a @unique column allowed to repeat
```

## The direction is the point

Expectations come from the original schema; the database comes from the mutant.
Deriving both from the mutant is the failure this exists to prevent — drop a
`@@gate` and the ladder loses the rows that would have caught it, so every
mutant survives and the score reads 100%.

## A survivor is a fact about the checks

Not about the schema. Two are expected and mean nothing is wrong:

- **a nullable `@unique`** — SQLite accepts any number of NULLs in a UNIQUE
  column, so there is no duplicate to try.
- **a create-only `@@allow`** — a create policy is checked by `evalJs` and
  nothing else, so there is no second implementation to grade it against.
  Read, update and delete policies compile into a WHERE and are graded.

Anything else is a check that stopped covering what it claims to.

## Not in CI

Run it by hand. `basecamp` is 232 mutants at several seconds each; it answers
*did my last change to a check make it weaker*, which is a question asked when
something changes rather than on every push. `fli test:access --check` is the
cheap thing that belongs in CI, and it covers the other half — a gate that moved
without review.
