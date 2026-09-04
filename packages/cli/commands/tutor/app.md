---
title: tutor:app
description: An empty directory to a running app with a model of your own in it
steps: _steps-app
examples:
  - fli tutor:app --workspace ~/frontier-tutorial
  - fli tutor:app --tmp --yes
  - fli tutor:app --workspace ~/frontier-tutorial --step 3
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
  web-port:
    type: number
    description: Port for the web app — refused rather than moved if something holds it
    defaultValue: 8000
---

```js
// `04-run` starts processes and `10-finish` stops them, and neither is a fact a
// journal can hold: replayed into a no-op, the first leaves every step after it
// talking to a dead port and the second leaves a dev server running.
openTutor(context, 'tutor:app', { ephemeral: ['04-run', '10-finish'] })

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.config.webPort = flag['web-port']

// Every URL this lesson prints comes from these two, so a port that moved
// cannot make a printed URL a lie.
context.vars.apiPort = context.config.apiPort
context.vars.webPort = context.config.webPort
```

## Lesson 1 — an app that runs

You are going to scaffold a FrontierJS app, start it, add a model of your own,
and read a row back out of the database it wrote.

Nothing here is a demonstration. Every step runs the command you would run, and
then asks the running world whether it worked — a port that answers, a table
that exists, a row that is really there. A step that cannot prove itself stops
the lesson and tells you what it asked for and what it got instead.

You can stop at any point. Running the lesson again picks up where you left off.
