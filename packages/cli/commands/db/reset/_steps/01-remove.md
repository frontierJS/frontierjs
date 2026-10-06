---
title: 01-remove
description: Remove the database file
---

```js
$.exec({
  command: `rm -f ${$.config.dbPath}/${$.config.dbFile}`,
  dry: flag.dry
})
log.info(`Removed ${$.config.dbFile}`)
```
