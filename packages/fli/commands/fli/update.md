---
title: fli:update
description: Update FLI itself (git pull + bun install)
alias: update
examples:
  - fli update
  - fli update --dry
---

```js
log.info(`Updating FLI at ${global.fliRoot}`)

context.exec({ command: `cd ${global.fliRoot} && git pull`, dry: flag.dry })
context.exec({ command: `cd ${global.fliRoot} && bun install`, dry: flag.dry })

if (!flag.dry) log.success('FLI updated — restart your terminal to use the new version')
```
