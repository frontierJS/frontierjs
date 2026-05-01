---
title: deploy:fixture-docker
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
const target      = resolveTarget(flag, context.git)
const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf  = frontierConfig?.deploy

if (deployConf) {
  // Deploy block present → docker mode. Validate via resolveDeployConf.
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
  // No deploy block → legacy mode (no frontier.config.js or empty config)
  context.config.stepsDir = '_steps'
  context.config.mode     = 'legacy'
  context.config.target   = target
}
```
