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
const target      = resolveTarget(flag, $.git)
const frontierConfig = await loadFrontierConfig($.paths.root)
const deployConf  = frontierConfig?.deploy

if (deployConf) {
  // Deploy block present → docker mode. Validate via resolveDeployConf.
  const resolved = resolveDeployConf(deployConf, target)
  if (!resolved) {
    log.error('Missing server or path')
    $.config.abort = true
    return
  }
  $.config.stepsDir = '_steps-docker'
  $.config.mode     = 'docker'
  $.config.target   = target
  $.config.server   = resolved.server
  $.config.user     = resolved.user
  $.config.path     = resolved.path
} else {
  // No deploy block → legacy mode (no frontier.config.js or empty config)
  $.config.stepsDir = '_steps'
  $.config.mode     = 'legacy'
  $.config.target   = target
}
```
