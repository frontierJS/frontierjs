---
title: 02-reset
description: Run Litestone migrate reset
---

```js
const { schema } = resolveDb($, flag)
$.exec({
  command: `${$.bin('litestone', $.config.root)} migrate reset --schema ${schema} --force`,
  cwd: $.config.root,
  dry: flag.dry
})
```
