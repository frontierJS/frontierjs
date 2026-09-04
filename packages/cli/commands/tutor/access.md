---
title: tutor:access
description: The gate and the row policy, watched refusing somebody
steps: _steps-access
examples:
  - fli tutor:access --workspace ~/frontier-tutorial
  - fli tutor:access --tmp --yes
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
    description: Answer every question with its default
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
openTutor(context, 'tutor:access', { ephemeral: ['02-run', '09-finish'] })

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.vars.apiPort   = context.config.apiPort
```

## Lesson 2 — who may do what

Authorization in FrontierJS is **declared in the schema**, not written in hooks.
That sentence is easy to nod at and hard to believe, so this lesson does not
explain it. It changes one line of `db/schema.lite` at a time and shows you the
answer to the same HTTP request changing.

Four mechanisms, in the order you meet them:

- **`@@gate`** — a level per operation. It refuses.
- **`@@allow`** on a model — a predicate over the row. It filters.
- **`@allow('write', …)`** on a column — a predicate over one field. It drops.
- **`fli test:access`** — all three of them written down and committed.

Every refusal here is asked **twice**: once by a caller who should be refused,
and once by an otherwise identical caller who should not. A rule that refused
everybody would look exactly the same from the refused side.

There is no browser in this lesson. The gate is enforced at the Data boundary,
so `curl` sees precisely what a page would.
