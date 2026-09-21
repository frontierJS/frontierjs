---
title: 02-build
optional: true
---

```js
log.info(`Building for ${context.config.env}...`)
context.exec({
  command: `echo "BUILD: ${context.config.env} @ ${context.config.branch}"`,
  dry: flag.dry
})
context.config.buildOutput = `/dist/${context.config.env}`
log.success(`Build output: ${context.config.buildOutput}`)
```
