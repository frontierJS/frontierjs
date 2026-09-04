---
title: tutor:jobs
description: Work that outlives the request, and the file it is queued in
steps: _steps-jobs
examples:
  - fli tutor:jobs --workspace ~/frontier-tutorial
  - fli tutor:jobs --tmp --yes
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
openTutor(context, 'tutor:jobs', { ephemeral: ['02-run', '06-finish'] })

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.vars.apiPort   = context.config.apiPort
```

## Lesson 4 — work that outlives the request

Some work should not happen while somebody is waiting. Sending mail, calling a
payment provider, rebuilding a thumbnail, anything that can fail and should be
tried again — none of it belongs on the path between a request and its response.

The queue here is `@frontierjs/caravan`, and it is **SQLite**. That is the whole
of its infrastructure: no Redis, no broker, no second process to keep alive. A
job is a row in a file you can open, which is what makes the last step of this
lesson possible at all — you look at the row.

Three things are asserted, and the first is the one that matters:

- the response comes back **before** the work is done,
- the work then happens, and is written back through the app's own service,
- and the row that recorded it is still there afterwards.

There is no browser and no clock to wait on.
