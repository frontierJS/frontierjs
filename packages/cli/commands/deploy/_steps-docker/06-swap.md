---
title: 06-swap
description: Stop old container, start new one — migrations run in entrypoint
skip: "!context.config.doApi"
---

```js
if (context.config.abort) return

const { imageTag, appId, apiPort, deployConf } = context.config
const { host, path: serverPath } = context.config.api

// The DIGEST where step 04 could read one, and the tag only as a fallback.
// Running the tag means running whatever currently answers to that name, and the
// name is not unique across servers or across rebuilds — which is the whole of
// what 2.3f is about. `imageAddress` is the tag when nothing could be read, and
// step 04 has already said so out loud.
const { container, replaced } = swapContainer(context, {
  host,
  container: `${appId}-api`,
  image:     context.config.imageAddress ?? imageTag,
  apiPort,
  dbPath:  deployConf.db?.path ?? `${serverPath}/db`,
  envFile: deployConf.api?.env ?? `${serverPath}/.env.production`,
  // The same value `03-build-web` stamped into the bundle, so one deploy is one
  // build on both sides of the wire — the server states it, the browser compares.
  build:   context.config.commit,
  log,
})

context.config.container = container
context.config.replaced  = replaced
log.success(`Container started → ${container}`)
log.info('  Running migrations in entrypoint...')
```
