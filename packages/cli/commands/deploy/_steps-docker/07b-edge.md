---
title: 07b-edge
description: Rewrite this app's Caddy routes when the API's paths have moved
---

```js
if ($.config.abort) return

const { host, serverPath, appId, apiPort, deployConf } = $.config

// After health, so a path the new API mounts reaches it only once it answers.
// A failure warns rather than aborts: the release is serving by now, and the
// routes that were there keep working for every path that has not moved.
const { edgeNames, EdgeError } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
let edge
try { edge = edgeNames(deployConf) }
catch (e) {
  if (!(e instanceof EdgeError)) throw e
  log.warn(`Routes not checked: ${e.message}`)
  return
}

const { routes, error } = await edgeRoutesFor({ root: $.paths.root, appId, serverPath, apiPort, edge })
const written = error ? { error } : await writeEdge(machineFor($, host, serverPath), { appId, routes, ifPresent: true })

if (written === 'written') log.success('Routes rewritten — the API mounts paths it did not at the last write')
else if (written === 'unchanged') log.info('Routes unchanged')
else if (written === 'absent') log.info('No routes for this app in Caddy — fli deploy:setup writes them')
else log.warn(`Routes not rewritten: ${written.error}`)
```
