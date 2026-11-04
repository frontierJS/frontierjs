---
title: 03-swap
description: Put the container back onto the release being restored, and health-check it — puts the current one back if it does not answer
---

```js
const { host, serverPath, deployConf, appId, apiPort, revertImage, healthPath } = $.config

// The same function `_steps-docker/06-swap` calls, so a revert's safety net is
// the deploy's safety net rather than a copy of it.
const { container, replaced, healthy, restored } = await swapContainer($, {
  host,
  appId,
  container: apiContainer(appId, deployConf),
  image:     revertImage,
  apiPort,
  dbPath:     apiFiles(deployConf, serverPath).dbDir,
  envFile:    apiFiles(deployConf, serverPath).envFile,
  secretsDir: apiFiles(deployConf, serverPath).secretsDir,
  deployConf,
  corsOrigins: derivedOrigins($, deployConf),
  configuration: $.config.revertConfiguration,
  healthPath,
  log,
})

$.config.container = container
$.config.replaced  = replaced

if (!healthy) {
  // Worth saying plainly: the release being restored did not come up, so the one
  // that was serving is back. That is a revert which did not happen — not a
  // deploy that failed — and the journal records it as such.
  log.error(`Revert to ${revertImage} did not come up`)
  if (restored) log.warn('  The release that was serving is running again.')
  else          log.error('  Nothing is serving — restore by hand.')
  $.config.abort = true
  throw new Error(`Revert failed health check for ${revertImage}`)
}

// The bytes this revert put into service, in the same shape `04-build-api`
// writes. Without it a revert transition records no image, so the release it
// restored cannot be reverted TO — the next revert reads `no-image` about a
// release that is plainly running.
noteForJournal($, '03-swap', {
  image: revertImage,
  tag:   null,
  scope: $.config.revertTo?.id ? 'restored' : null,
})

log.done(`Container started → ${container} on ${revertImage}`)

// The entrypoint runs `db:migrate` before it serves, and on a revert that is
// migrating FORWARD to a schema this code was written before. That is safe
// exactly when the pivot said it was, which is why `--past-pivot` exists and why
// it is a refusal rather than a warning.
```
