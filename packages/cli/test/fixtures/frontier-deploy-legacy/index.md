---
title: deploy:fixture-legacy
description: Deploy fixture — simulates a project without frontier.config.js
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

if (deployConf?.server) {
  context.config.stepsDir = '_steps-docker'
  context.config.mode     = 'docker'
} else {
  context.config.stepsDir = '_steps'
  context.config.mode     = 'legacy'
}
context.config.target = target
```
