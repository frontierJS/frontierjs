---
title: tutor:adopt
description: A database you already have, read into a schema — and what the reading could not carry
steps: _steps-adopt
examples:
  - fli tutor:adopt --workspace ~/frontier-tutorial
  - fli tutor:adopt --tmp --yes
flags:
  workspace:
    char: w
    type: string
    description: Directory to build the app in — kept when the lesson ends
    defaultValue: ''
  tmp:
    type: boolean
    description: Build in a throwaway directory instead (the default with no --workspace)
    defaultValue: false
  restart:
    type: boolean
    description: Begin this lesson again, forgetting what an earlier run finished
    defaultValue: false
  yes:
    char: y
    type: boolean
    description: Run the whole lesson without stopping — no confirmation between steps
    defaultValue: false
  keep:
    type: boolean
    description: Keep a throwaway workspace when the lesson ends
    defaultValue: false
  source:
    type: string
    description: Where @frontierjs packages come from — local (this tree) or npm
    defaultValue: ''
  api-port:
    type: number
    description: Port for the API — refused rather than moved if something holds it
    defaultValue: 8100
---


```js
openTutor(context, 'tutor:adopt', { ephemeral: ['06-finish'] })

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.vars.apiPort   = context.config.apiPort
```

## Lesson 13 — the database you already have

Every lesson so far started with `fli new`. This one starts with a database that
has been in production for years, made by somebody else, with rows in it — the
door almost nobody writes a tutorial for.

Two commands read a schema you already have:

| | |
| --- | --- |
| `litestone introspect <db>` | a live SQLite database → `.lite` |
| `litestone import <file>` | a Prisma schema, a Rails `schema.rb`, a `pg_dump` |

The half worth the lesson is the **second output**. A converter that prints only
its result has quietly decided what to lose, so both of these record every
construct they could not express — with the model, the column, what the source
said and what was emitted instead — graded three ways:

- **changed** — the schema says something the source does not. Reading it will
  mislead you.
- **lost** — the source says something the schema does not. Thinner, never wrong.
- **noted** — a decision only you can make.

`--strict` fails on **changed** alone, because a gate that also failed on *lost*
would fire on every real import, and a check that always fires is one nobody
reads.

Then the app serves a row that was in that database before FrontierJS existed —
and the last step is about the finding that comes with it. An inherited schema
has debt in it by definition, and `check-baseline.json` is how you keep debt
without letting it grow: `--adopt` takes it on, `--update` may only ever lower
it, and the findings print either way.
