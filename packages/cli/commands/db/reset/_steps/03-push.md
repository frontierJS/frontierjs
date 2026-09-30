---
title: 03-push
description: Push schema to fresh database
---

```js
const { schema } = resolveDb(context, flag)
context.exec({
  command: `${context.bin('litestone', context.config.root)} db push --schema ${schema}`,
  cwd: context.config.root,
  dry: flag.dry
})
log.success('Database reset complete')
```
