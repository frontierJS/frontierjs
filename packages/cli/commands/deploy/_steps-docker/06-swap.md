---
title: 06-swap
description: Stop old container, start new one — migrations run in entrypoint
skip: "!$.config.doApi"
---

```js
if ($.config.abort) return

const { imageTag, appId, apiPort, deployConf } = $.config
const { host, path: serverPath } = $.config.api

// The DIGEST where step 04 could read one, and the tag only as a fallback.
// Running the tag means running whatever currently answers to that name, and the
// name is not unique across servers or across rebuilds — which is the whole of
// what 2.3f is about. `imageAddress` is the tag when nothing could be read, and
// step 04 has already said so out loud.
const { container, replaced } = swapContainer($, {
  host,
  container: apiContainer(appId, deployConf),
  image:     $.config.imageAddress ?? imageTag,
  apiPort,
  dbPath:  deployConf.db?.path ?? `${serverPath}/db`,
  envFile: deployConf.api?.env ?? `${serverPath}/.env.production`,
  // The same value `03-build-web` stamped into the bundle, so one deploy is one
  // build on both sides of the wire — the server states it, the browser compares.
  build:   $.config.commit,
  deployConf,
  log,
})

$.config.container = container
$.config.replaced  = replaced
log.success(`Container started → ${container}`)
log.info('  Running migrations in entrypoint...')
```
