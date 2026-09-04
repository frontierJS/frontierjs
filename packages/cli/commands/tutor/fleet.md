---
title: tutor:fleet
description: A machine that reports in, and a command that really runs on it
steps: _steps-fleet
examples:
  - fli tutor:fleet --workspace ~/frontier-tutorial
  - fli tutor:fleet --tmp --yes
flags:
  workspace:
    char: w
    type: string
    description: Directory to keep the control plane's database in
    defaultValue: ''
  tmp:
    type: boolean
    description: Use a throwaway directory instead (the default with no --workspace)
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
  api-port:
    type: number
    description: Port for the control plane — refused rather than moved if something holds it
    defaultValue: 8120
  outpost-port:
    type: number
    description: Port for the outpost on this machine
    defaultValue: 8180
---

```js
// Both processes are started by this lesson and stopped by its last step, and
// neither is a fact a journal can hold: replayed into a no-op, the first leaves
// every step after it talking to a dead port.
openTutor(context, 'tutor:fleet', { ephemeral: ['02-basecamp', '05-outpost', '07-finish'] })

context.config.apiPort     = flag['api-port']
context.config.outpostPort = flag['outpost-port']

context.vars.apiPort     = context.config.apiPort
context.vars.outpostPort = context.config.outpostPort
```

## Lesson 4 — one control plane, one machine

Lesson 3 deployed from your laptop with `fli deploy`: you hold the ssh key, you
type the command, and the machine is a target. That is one release story and it
is the right one for one app on one box.

This is the other one. **Basecamp** is a control plane — an app that holds the
fleet as rows — and **Outpost** is the process a machine runs so the control
plane has hands on it. Nobody types a deploy; somebody clicks one, and a job
sends a signed command to a machine that agreed to take orders.

Four things get built, in this order:

- a control plane, on its own database, with nothing in it
- a **Server** row — the machine as a noun, before anything is on it
- a real Outpost, on this machine, reporting in
- a command, sent from the control plane, that really runs here

The last one is the whole lesson. Everything before it is arranging for a
machine to be reachable, and *reachable* turns out to have a precise meaning
that a row cannot express.

**This lesson needs a checkout.** Basecamp is not published — it is an
application built on the framework rather than a part of it — so the first step
looks for it beside the CLI and stops with a sentence if it is not there.
