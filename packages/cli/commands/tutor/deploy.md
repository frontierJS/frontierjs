---
title: tutor:deploy
description: A real deploy to this machine, and a revert that really reverts
steps: _steps-deploy
examples:
  - fli tutor:deploy --workspace ~/frontier-tutorial
  - fli tutor:deploy --tmp --yes
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
    description: Keep a throwaway workspace, and the container, when the lesson ends
    defaultValue: false
  source:
    type: string
    description: Where @frontierjs packages come from — local (this tree) or npm
    defaultValue: ''
  port:
    type: number
    description: Host port the deployed container answers on
    defaultValue: 8100
---

```js
// The throwaway workspace is a Docker BUILD CONTEXT here, which no other
// lesson's is, and that rules out two directories the others are happy in.
//
// Not /tmp: a shell whose /tmp is private to it hands the daemon a path it
// cannot see, and the build fails with `lstat deploy: no such file or
// directory` about a directory that is plainly there.
//
// And not a HIDDEN one. `docker build` cannot read a Dockerfile whose context
// path has a dot-prefixed component anywhere in it — measured, with the same
// tree in two places: `~/probe/server` builds and `~/.probe/server` answers
// `open Dockerfile: no such file or directory`, with an absolute `-f` and an
// absolute context making no difference. So this is `fjs-tutor` and not
// `.fli/tutor`, which is where it was first put.
openTutor(context, 'tutor:deploy', {
  ephemeral: ['10-finish'],
  base:      join(homedir(), 'fjs-tutor'),
})

context.config.source = flag.source || defaultSource()
context.config.port   = flag.port
context.vars.port     = context.config.port

// The container and the images are named for the app, so the teardown can find
// everything this lesson built without a list.
context.config.container = `${context.config.app}-api`
context.vars.container   = context.config.container
```

## Lesson 9 — deploying it, and taking it back

This is the lesson almost no framework tutorial has, and the reason is always
the same: they cannot give you a server.

FrontierJS can, because **a deploy target may be `localhost`**. One module owns
*(host, script) → the argv that runs it there*, and the script travels on stdin
to `sh -s` whether or not there is an `ssh` in front of it. So everything below
is the real pipeline — a real journal on disk, a real image, a real swap, a real
health poll and a real revert. The only thing not exercised is ssh itself.

You need **Docker** and **git**. Nothing is sent anywhere.

What you will end up having done:

- pointed the app at a machine, and written down what a release IS
- deployed it, and watched the container answer
- changed a line, deployed again, and seen different bytes running
- **reverted**, and seen the previous release serving again

The last one is the point of the whole design. A deploy you cannot take back is
a deploy you make slowly and at night.
