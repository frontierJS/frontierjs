---
title: tutor:notify
description: Telling somebody something, once, across every way you reach them
steps: _steps-notify
examples:
  - fli tutor:notify --workspace ~/frontier-tutorial
  - fli tutor:notify --tmp --yes
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
openTutor(context, 'tutor:notify', { ephemeral: ['02-run', '08-finish'] })

context.config.source  = flag.source || defaultSource()
context.config.apiPort = flag['api-port']
context.vars.apiPort   = context.config.apiPort
```

## Lesson 7 — telling somebody something

An app that has anything to say to a person says it in more than one place: a
row in a bell menu, an email, one day a text message. Written by hand that is
the same sentence in three files, drifting apart from the day it is written.

`@frontierjs/notifications` makes it one declaration. **A notification is a
file**, the file names it, and each way of reaching somebody is a **transport**
the same file formats for. One `app.notify(...)` call, and every transport that
notification declares is formatted, checked, and delivered.

Four things are asserted here, and two of them are about the thing nobody plans
for — what happens when it is wrong:

- one send reaches **two transports**, and the row it wrote carries a type
  nothing in the file states,
- **renaming the file renames the type** and orphans every row already written,
  in silence, which is why `type:` exists,
- a transport declared with no formatter refuses **before anything is
  delivered**, so a two-transport notification cannot half-land,
- and the app can be asked **what it is able to send** with nothing sent.

There is no browser here and no mail server. Mail goes to a file, because a
mailer is one method and the lesson is not about SMTP.
