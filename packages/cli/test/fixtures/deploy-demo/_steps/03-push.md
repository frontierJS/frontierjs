---
title: 03-push
skip: "flag.dry"
---

```js
const { env, branch, buildOutput } = $.config
log.info(`Pushing ${buildOutput} → ${env}`)
$.exec({
  command: `echo "PUSH: ${buildOutput} to ${env}"`,
  dry: flag.dry
})
log.success(`Deployed ${branch} to ${env}`)
```
