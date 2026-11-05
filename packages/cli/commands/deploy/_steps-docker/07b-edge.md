---
title: 07b-edge
description: Rewrite this app's Caddy routes when the API's paths have moved, then check the OAuth discovery document answers
skip: "$.config.siteOnly"
---

```js
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

// The release this deploy built, which 08-release-web is about to make current;
// an API-only deploy keeps the page already serving.
const machine = machineFor($, host, serverPath)
const docRoot = $.config.releaseDir ?? `${serverPath}/current`
const html    = machine.capture(`find ${docRoot}/ -name '*.html' -type f -exec cat {} + 2>/dev/null || true`)

// Where the container answers, which after a start-first is not `apiPort`.
const port = $.config.livePort ?? await livePort(machine, apiContainer(appId, deployConf), apiPort)
const { routes, plain, error } = await edgeRoutesFor({ root: $.paths.root, appId, serverPath, apiPort: port, edge, html })
const written = error ? { error } : await writeEdge(machine, { appId, routes, plain, ifPresent: true })

if (written === 'written') log.done('Routes rewritten — the API mounts paths it did not at the last write')
else if (written === 'unchanged') log.info('Routes unchanged')
else if (written === 'absent') log.info('No routes for this app in Caddy — fli deploy:setup writes them')
else log.warn(`Routes not rewritten: ${written.error}`)

// The routes above are Caddy's own; a front door nobody wrote here (a hand-made
// Caddyfile) answers the root .well-known path with the page. Only a warning:
// the release is serving, and the fix is in a file this deploy does not own.
const { checkDiscovery } = await import(new URL('file://' + global.fliRoot + '/core/discovery-probe.js'))
const { readAppSnapshot } = await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))
const discovery = await checkDiscovery({ snapshot: readAppSnapshot($.paths.root), names: edge })
if (discovery.warning) log.warn(`OAuth discovery: ${discovery.warning}`)
else if (discovery.probed) log.info(`OAuth discovery answers at ${discovery.url}`)
```
