---
title: 01-remove
description: Remove the database file
---

```js
context.exec({
  command: `rm -f ${context.config.dbPath}/${context.config.dbFile}`,
  dry: flag.dry
})
log.info(`Removed ${context.config.dbFile}`)
```
