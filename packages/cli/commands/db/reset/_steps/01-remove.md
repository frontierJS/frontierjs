---
title: 01-remove
description: Remove the database file
---

```js
$.exec({
  command: `rm -f ${$.config.dbPath}/${$.config.dbFile} ${$.config.dbPath}/${$.config.dbFile}-wal ${$.config.dbPath}/${$.config.dbFile}-shm`,
  dry: flag.dry
})
log.info(`Removed ${$.config.dbFile}`)
```
