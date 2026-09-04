---
title: 01-machine
description: Is there a control plane on this machine to run
---

## First, the parts

Two of the four things this lesson needs are processes, and both of them live in
a **checkout** of the framework rather than on npm. Basecamp is `private: true`
— it is an application built on FrontierJS, not a piece of it — and it is the
control plane, so without it there is nothing here to run.

The Outpost is published, but the copy beside the CLI is the one that matches
this control plane's protocol, so the lesson uses that.

Neither being here is a reason to think something is wrong: if you installed
`fli` from npm this lesson has nothing to stand on, and it says so and stops.

```js
if (!await narrate(context)) return

context.config.__step = 1

for (const bin of ['bun', 'git']) {
  if (!await must(context, probe.commandExists({ bin }), {
    likely: `${bin} is not installed, or not on the PATH this shell has`,
  })) return
}

// The anchor is the CLI's own directory, which is `packages/cli` in a checkout
// and somewhere under `node_modules` in an install. Deriving the two siblings
// from it rather than from the working directory is what makes the answer the
// same wherever the lesson is typed.
const packages  = resolve(global.fliRoot, '..')
const basecamp  = join(packages, 'basecamp')
const outpost   = join(packages, 'outpost')

for (const [dir, what] of [[basecamp, 'basecamp'], [outpost, 'outpost']]) {
  if (!existsSync(join(dir, 'package.json'))) {
    // `stop`, not `abort`: a deliberate early exit that SUCCEEDED. The lesson
    // is not broken — this installation has no control plane in it, which is a
    // legitimate answer and the ordinary one for anybody who installed from npm.
    log.warn(`there is no ${what} beside this CLI, so there is no control plane to run — stopping here.`)
    log.info(`  looked in  ${dir}`)
    log.info('  Lessons 1 to 3 need none of this. Clone the framework to run this one:')
    log.info('    git clone https://github.com/frontierJS/frontierjs && cd frontierjs && bun install')
    context.config.stop = true
    return
  }
  log.success(`${what} — ${dir}`)
}

for (const [port, what] of [
  [context.config.apiPort,     'the control plane'],
  [context.config.outpostPort, 'the outpost'],
]) {
  if (!await must(context, probe.portFree({ port, name: `port ${port} is free for ${what}` }), {
    likely:    `something is already listening on ${port} — a dev server, or an earlier run of this lesson`,
    reproduce: `fli ports:status`,
  })) return
}

remember(context, '01-machine', { basecamp, outpost })
```
