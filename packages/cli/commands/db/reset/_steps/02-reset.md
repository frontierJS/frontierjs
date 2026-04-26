---
title: 02-reset
description: Run Litestone migrate reset
---

```js
const { schema } = resolveDb(context, flag)
context.exec({
  command: `cd ${context.config.root} && bunx litestone migrate reset --schema ${schema} --force`,
  dry: flag.dry
})
```
