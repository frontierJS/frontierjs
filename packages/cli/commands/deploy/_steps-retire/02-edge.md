---
title: 02-edge
description: Drop this app's routes from Caddy on every machine a side lives on
---

```js
if ($.config.abort) return

const { appId, sides } = $.config

// First, so nothing is routed into a container about to stop. An empty route
// list is `applyEdge` removing this app's routes and access logs and nothing
// else's; `ifPresent` answers `absent` for a machine whose routes setup never
// wrote, a Caddy that does not answer included.
for (const host of new Set(sides.map(s => s.host))) {
  const machine = machineFor($, host, sides.find(s => s.host === host).path)
  const written = await writeEdge(machine, { appId, routes: [], ifPresent: true })
  if (written.error) {
    log.error(`Caddy on ${host}: ${written.error}`)
    $.config.abort = true
    return
  }
  if (written === 'absent') log.info(`  Caddy on ${host} holds no route for ${appId}`)
  else                      log.success(`  Routes dropped → ${host}`)
}
```
