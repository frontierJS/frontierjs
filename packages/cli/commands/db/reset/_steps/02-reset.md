---
title: 02-reset
description: Run Litestone migrate reset
---

```js
const { schema } = resolveDb(context, flag)
context.exec({
  command: `${context.bin('litestone', context.config.root)} migrate reset --schema ${schema} --force`,
  cwd: context.config.root,
  dry: flag.dry
})
```
