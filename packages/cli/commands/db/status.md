---
title: db:status
description: Show pending migrations and verify the database matches schema.lite
alias: db-status
examples:
  - fli db:status
---

```js
if (!requireSchema($)) return

const { schema } = resolveDb($, flag)
const ls = litestone($)

$.exec({ command: `${ls} migrate status --schema ${schema}` })
```
