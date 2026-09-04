---
title: tutor:change
description: Changing a schema that is already deployed, and the verdict that says whether you can go back
steps: _steps-change
examples:
  - fli tutor:change --workspace ~/frontier-tutorial
  - fli tutor:change --tmp --yes
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
openTutor(context, 'tutor:change', { ephemeral: [] })

context.config.source = flag.source || defaultSource()
```

## Lesson 7 — the schema you already deployed

Every lesson so far changed a schema that nobody was using. This one is about
month two, when there are rows in production and a release already serving them.

The question a deploy actually asks is not *is this migration correct*. It is:

**can the release that is running and the release that is starting share one
database?**

If they can, the deploy is an **expand** and you can take it back — roll the new
release off and the old one keeps working. If they cannot, it is a **contract**,
and that deploy is the **pivot**: after it there is no going back, only forward.
An unknown counts as a contract, because a deploy you are not sure about is one
you cannot safely undo.

`fli release:check` answers it, and the answer is a document rather than a
feeling. Three changes are made here — one that is safe, one that is not, and
one that touches no column at all — and each is classified.

There is no server in this lesson, and no Docker. It is all schema.
