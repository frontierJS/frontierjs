---
title: 01-preflight
description: Can this machine build an app at all
---

## First, the machine

A lesson that fails at step 6 because something was missing at step 1 teaches
you about this tutorial rather than about the framework. So before anything is
written: the tools, and the two ports the app will want.

The ports are **refused rather than moved**. Every URL printed from here on says
{{apiPort}} and {{webPort}}, and an app quietly relocated to the next free port
makes every one of them a lie. If something already holds one, pass
`--api-port` or `--web-port` and the lesson will say the numbers you chose.

```js
if (!await narrate(context)) return

context.config.__step = 1

for (const bin of ['bun', 'git']) {
  if (!await must(context, probe.commandExists({ bin }), {
    likely: `${bin} is not installed, or not on the PATH this shell has`,
  })) return
}

for (const [port, what] of [
  [context.config.apiPort, 'the API'],
  [context.config.webPort, 'the web app'],
]) {
  if (!await must(context, probe.portFree({ port, name: `port ${port} is free for ${what}` }), {
    likely:    `something is already listening on ${port} — another app, or an earlier run of this lesson`,
    reproduce: `fli ports:status`,
  })) return
}

// Not `remember`: the ports are the FLAGS' answer, and writing them into the
// journal would make a later `--api-port` silently lose to the first run's.
```
