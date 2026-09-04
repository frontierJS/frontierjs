---
title: 03-swap
description: Put the container back onto the release being restored
---

```js
if (context.config.abort) return

const { host, serverPath, deployConf, appId, apiPort, revertImage } = context.config

// The same function `_steps-docker/06-swap` calls. One owner, because the
// going-back path is the one nobody exercises until the day it matters, and a
// copy that had drifted would be discovered mid-incident.
const { container, replaced } = swapContainer(context, {
  host,
  container: `${appId}-api`,
  image:     revertImage,
  apiPort,
  dbPath:  deployConf.db?.path ?? `${serverPath}/db`,
  envFile: deployConf.api?.env ?? `${serverPath}/.env.production`,
  deployConf,
  log,
})

context.config.container = container
context.config.replaced  = replaced

// The bytes this revert put into service, in the same shape `04-build-api`
// writes. Without it a revert transition records no image, so the release it
// restored cannot be reverted TO — the next revert reads `no-image` about a
// release that is plainly running.
noteForJournal(context, '03-swap', {
  image: revertImage,
  tag:   null,
  scope: context.config.revertTo?.id ? 'restored' : null,
})

log.success(`Container started → ${container} on ${revertImage}`)

// The entrypoint runs `db:migrate` before it serves, and on a revert that is
// migrating FORWARD to a schema this code was written before. That is safe
// exactly when the pivot said it was, which is why `--past-pivot` exists and why
// it is a refusal rather than a warning.
log.info('  Running migrations in entrypoint...')
```
