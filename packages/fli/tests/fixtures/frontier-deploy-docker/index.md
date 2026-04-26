---
title: fixture:frontier-deploy
description: Deploy fixture — simulates a project with frontier.config.js
flags:
  production:
    type: boolean
    defaultValue: false
  stage:
    type: boolean
    defaultValue: false
---

```js
import { loadFrontierConfig } from '../../../core/utils.js'

const target      = resolveTarget(flag, context.git)
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf  = frontierConfig?.deploy

if (deployConf?.server) {
  const resolved = resolveDeployConf(deployConf, target)
  if (!resolved) {
    log.error('Missing server or path')
    context.config.abort = true
    return
  }
  context.config.stepsDir = '_steps-docker'
  context.config.mode     = 'docker'
  context.config.target   = target
  context.config.server   = resolved.server
  context.config.user     = resolved.user
  context.config.path     = resolved.path
} else {
  context.config.stepsDir = '_steps'
  context.config.mode     = 'legacy'
  context.config.target   = target
}
```
