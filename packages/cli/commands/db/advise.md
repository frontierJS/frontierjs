---
title: db:advise
description: What this schema says wrong, and what it never said at all
alias: advise
examples:
  - fli advise
  - fli advise --json
flags:
  json:
    type: boolean
    description: Both lists as data
    defaultValue: false
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

// Not a gate and it never exits non-zero on a finding. `fli test:access
// --strict` and `fli release:check` are the two that fail a branch; this one
// reads.
await context.stream({
  command: `${litestone(context)} advise --schema ${schema}${flag.json ? ' --json' : ''}`,
})
```

## Two questions, and they are not the same one

**Legal and worth a look.** The schema says something and a layer above the
parser refuses it: a required `@guarded` column nothing below level 8 can
create, an `@@fts` over an `@encrypted` column where the index holds ciphertext
and the search silently returns nothing, a foreign key with no index. `parse()`
is more permissive than everything above it, so these are green in every
migration and every test.

**Declared by nobody.** The schema says *nothing*, everything works, and a word
would have said it better — a `deletedAt` column with no `@@softDelete` behind
it, a token column stored as text, an enum lifecycle any write can set to any
value, the same six columns written out in five models.

That second list is the one no other command can produce. `fli db:jsonschema`,
`fli test:access` and `fli release:check` all describe what you HAVE, because
every one of them is derived from the seed — so a word absent from the seed is
absent from all of them, and nobody has ever been told about a feature they
never heard of.

## It ends in a command

Every suggestion names the word it is about and prints the next thing to type:

```
possible  Customer
          Customer carries name and notes and no @@fts. search() is a 400
          naming the attribute until one is declared.
          litestone explain @@fts   docs/full-text-search.md
```

`fli explain @@fts` is the same rows in more detail, and the docs page is where
it goes deeper. Studio's **Explore** panel (`fli db:studio`) is the third
reader and the only one that writes back.

## Confidence, not severity

A rule carries a severity because it is a defect. A suggestion carries a
`confidence` because the schema is not wrong and you may have meant it —
`likely` where litestone can SEE the thing it is asserting (a model that carries
the row's owner and declares no `@@allow`), and `possible` where it is asking.
Nothing here distinguishes a catalogue from a possession, so it says so rather
than guessing.
