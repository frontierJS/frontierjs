---
title: db:explain
description: What a .lite word is, what it accepts, where it is legal
alias: explain
examples:
  - fli explain
  - fli explain @guarded
  - fli explain --visibility
  - fli explain @@gate --json
args:
  -
    name: word
    description: The word to look up, as you would type it — @guarded, @@gate, tenancy
    required: false
flags:
  visibility:
    type: boolean
    description: Which of @computed/@transient/@system/@guarded/@encrypted, as a table
    defaultValue: false
  json:
    type: boolean
    description: The catalog as data
    defaultValue: false
---

```js
// No requireSchema, and that is the point rather than an omission: this reads
// the LANGUAGE's own catalog, not the app's seed, so it answers before there is
// a schema to answer about — which is exactly when someone is looking a word up.
// Every other db: command asks the app about itself and needs one first.
const word = arg.word ? ` ${arg.word}` : ''
const opts = [flag.visibility && '--visibility', flag.json && '--json'].filter(Boolean).join(' ')

// An unknown word is an ANSWER here, not a crash: litestone names it, suggests
// the near ones and exits 1. Letting stream() reject prints `Command failed
// (exit 1): cd … && bunx litestone explain @nosuch` underneath that, which is a
// second report saying less than the first. Keep the status, drop the noise.
try {
  await context.stream({
    command: `${litestone(context)} explain${word}${opts ? ' ' + opts : ''}`,
  })
} catch {
  process.exitCode = 1
}
```

## Why this is here

The catalog is a module rather than a Studio panel so that a terminal can ask
it, and this is the door an app developer actually stands in front of: `fli` is
what a scaffolded app installs, and `litestone` is a dependency of it. A reader
nobody can reach is not a reader.

It needs no `schema.lite` and no database, unlike every other `db:` command. The
question it answers is about the language, and the moment you most want to ask it
is before the thing you are asking about exists.

A bare word that exists at two levels answers with both, because the prefix
picks the level — `@unique` constrains a column and `@@unique` constrains a
tuple, and answering the wrong one is worse than answering neither. An unknown
word suggests the near ones and exits 1.

`--visibility` is the question that runs the other way: not *what is
`@guarded`* but *I need a column the caller may not read — which word is that?*
Three yes/no answers, one word out.

## The rest of the surface

```
fli explain                  every word, grouped
fli explain @guarded         one word
fli explain --visibility     the five that get confused, as a table
fli explain --json           the whole table, for a machine
```

The same rows are a page:
`packages/litestone/docs/reference.snapshot.md`, every word with a worked
example. Studio's **Explore** panel (`fli db:studio`) is the third reader, and
it is the only one that writes back — it places a word into your schema and
shows you the diff first.
