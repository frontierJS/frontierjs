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
const target      = resolveTarget(flag, $.git)
const frontierConfig = await loadFrontierConfig($.paths.root)
const deployConf  = frontierConfig?.deploy

if (deployConf?.server) {
  $.config.stepsDir = '_steps-docker'
  $.config.mode     = 'docker'
} else {
  $.config.stepsDir = '_steps'
  $.config.mode     = 'legacy'
}
$.config.target = target
```
