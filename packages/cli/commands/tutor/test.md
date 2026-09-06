---
title: tutor:test
description: The checks a schema already knows how to run, and what grades them
steps: _steps-test
examples:
  - fli tutor:test --workspace ~/frontier-tutorial
  - fli tutor:test --tmp --yes
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
---


```js
openTutor(context, 'tutor:test', { ephemeral: ['06-finish'] })

context.config.source = flag.source || defaultSource()
```

## Lesson 11 — knowing it is right

Everything so far declared something and then watched it work. This lesson is
the other question: **how do you know it still does?**

The answer here is unusual, and it is the reason this lesson exists. Most of
what you would write tests for has already been *declared* — a gate, a row
policy, a `@guarded` column, a `@length`. A declaration can be executed, so
Litestone ships the executions:

| | Asks |
| --- | --- |
| `verifyGateLadder()` | every declared level of every gated model, for read, create, update and delete |
| `verifyFieldProtection()` | every `@guarded` / `@encrypted` / `@secret` column, actually read back |
| `verifyConstraints()` | every validator, with values on both sides of its boundary |
| `verifyRowPolicies()` | every `@@allow` / `@@deny`, against rows either side of its predicate |

None of those is a test you write. They are the schema, run.

Then the last step asks the question nobody asks: **what grades the checks?** A
suite that passes proves nothing about what it does not look at, so the schema
is *mutated* — a gate dropped, a `@guarded` removed — and the checks derived
from the ORIGINAL are run against the mutant. Anything that survives is a hole,
and it names itself.

There is no server in this lesson and no browser. Every assertion is a real
database.
