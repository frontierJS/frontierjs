---
title: 03-push
description: Push schema to fresh database
---

```js
const { schema } = resolveDb(context, flag)
context.exec({
  command: `cd ${context.config.root} && bunx litestone push --schema ${schema}`,
  dry: flag.dry
})
log.success('Database reset complete')
```
