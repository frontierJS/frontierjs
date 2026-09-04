---
title: tutor:live
description: A write reaching a second client, and who it does not reach
steps: _steps-live
examples:
  - fli tutor:live --workspace ~/frontier-tutorial
  - fli tutor:live --tmp --yes
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
openTutor(context, 'tutor:live', { ephemeral: ['02-run', '08-finish'] })

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.vars.apiPort   = context.config.apiPort
```

## Lesson 3 — a change reaching somebody else

Everything so far has been one caller asking one question and getting one
answer. This lesson is the other direction: a row is written **here**, and a
client that asked for nothing finds out about it.

That much is ordinary — a socket and a broadcast is not a new idea. The part
worth a lesson is the second question, which most frameworks never ask:

**who is on the other end?**

A channel is a named set of connections. If joining one is a grant, every
subscriber gets every row — and the gate you spent lesson 2 declaring is
enforced on the request and not on the wire. So the same publish is graded per
recipient, against the same `@@gate` and the same `@@allow`, and this lesson
makes you watch it happen: two sockets, one publish, one of them refused.

There is no browser. A raw socket is the only client that can be genuinely
signed **out**, which is why this hole survived a year in this repository's own
example app before a drive was written that could see it.
