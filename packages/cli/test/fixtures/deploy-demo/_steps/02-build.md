---
title: 02-build
optional: true
---

```js
log.info(`Building for ${$.config.env}...`)
$.exec({
  command: `echo "BUILD: ${$.config.env} @ ${$.config.branch}"`,
  dry: flag.dry
})
$.config.buildOutput = `/dist/${$.config.env}`
log.success(`Build output: ${$.config.buildOutput}`)
```
