---
title: db:status
description: Show pending migrations and verify the database matches schema.lite
alias: db-status
examples:
  - fli db:status
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)
const ls = litestone(context)

context.exec({ command: `${ls} migrate status --schema ${schema}` })
```
