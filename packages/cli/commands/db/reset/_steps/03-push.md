---
title: 03-push
description: Push schema to fresh database
---

```js
const { schema } = resolveDb($, flag)
$.exec({
  command: `${$.bin('litestone', $.config.root)} db push --schema ${schema}`,
  cwd: $.config.root,
  dry: flag.dry
})
log.success('Database reset complete')
```
