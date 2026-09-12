---
title: 02b-unpause
description: Remove the guard file — the edge serves again from the next request
skip: "context.config.pauseKind !== 'unpause'"
---

```js
if (context.config.abort) return

const { host, serverPath } = context.config
const { pausedFile } = await import(new URL('file://' + global.fliRoot + '/core/pause.js'))

// `rm -f`, because an unpause run against a target somebody already cleared by
// hand must still record that the app is serving — that row is the whole of how
// `paused by hand` stops being the answer.
machineFor(context, host, serverPath).run(`rm -f ${pausedFile(serverPath)}`)
log.success('Unpaused — the edge is serving again')
```
