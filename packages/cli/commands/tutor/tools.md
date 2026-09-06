---
title: tutor:tools
description: The four tools that show you what your app is actually doing, and when to open which
steps: _steps-tools
examples:
  - fli tutor:tools --workspace ~/frontier-tutorial
  - fli tutor:tools --tmp --yes
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
  gui-port:
    type: number
    description: Port for fli gui
    defaultValue: 8500
  view-port:
    type: number
    description: Port for fli project:view
    defaultValue: 8501
  studio-port:
    type: number
    description: Port for the database studio
    defaultValue: 8502
  devtools-port:
    type: number
    description: Port for junction's API console
    defaultValue: 8503
---

```js
// Every step here starts something and `07-finish` stops it, and a running
// process is the one thing a journal cannot hold: replayed into a no-op, the
// tools are recorded as started and nothing is listening.
openTutor(context, 'tutor:tools', {
  ephemeral: ['02-gui', '03-studio', '04-devtools', '05-view', '06-finish'],
})

context.config.source       = flag.source || defaultSource()
context.config.apiPort      = flag['api-port']
context.config.guiPort      = flag['gui-port']
context.config.viewPort     = flag['view-port']
context.config.studioPort   = flag['studio-port']
context.config.devtoolsPort = flag['devtools-port']

// Every URL this lesson prints comes from these, so a port that moved cannot
// make a printed URL a lie.
context.vars.apiPort      = context.config.apiPort
context.vars.guiPort      = context.config.guiPort
context.vars.viewPort     = context.config.viewPort
context.vars.studioPort   = context.config.studioPort
context.vars.devtoolsPort = context.config.devtoolsPort
```

## Lesson 2 — the workbench

Lesson 1 built an app and proved it worked by asking the running world. That is
what a lesson can do. What YOU need, every day, is a way to ask the running
world yourself — because the failures that cost time are the quiet ones. A
screen with no rows on it looks the same whether the query is wrong, the policy
filtered them out, or the table is genuinely empty. A button that does nothing
looks the same whether the request was refused, never sent, or answered fine and
the render is broken.

Four tools answer those, and each answers a different question. They live on
fixed ports — **8500 to 8509 is reserved for tooling, for every app** — because
these are things you run *beside* whatever you are working on and type from
memory. They never move with the app.

| | Port | The question it answers |
| --- | --- | --- |
| `fli gui` | 8500 | what is there, what is running, and does anything fail a check |
| `fli db:studio` | 8502 | what is actually in the database |
| junction's console | 8503 | what happened to that call |
| `fli project:view` | 8501 | what handles a request, and in what order |

**Start at the GUI.** It is the only one that knows about the other three — it
lists everything startable in this project, shows which of them is up right
now, and runs `fli check` for you without you remembering the command. The
other three are what you open once it has told you where to look.

**Each tool is shown reporting a fault, not only a clean state.** A dashboard
that says *nothing wrong* is indistinguishable from one that cannot say
anything, so this lesson breaks something on purpose in front of each of them
and then puts it back: a file that breaks two named rules, a schema edited under
a running process, a call refused with its status. That pairing is the only
thing that separates a tool from a green light.

Nothing in this lesson changes your app except one line, in one file — and that
line is left in place, because the console it turns on binds to loopback and
refuses to bind anywhere else without an auth gate.
