---
title: 03-download
description: Download the backup from the remote server
---

```js
const { server, serverPath, dbPath, backupFile } = $.config
$.exec({
  command: `scp ${server}:${serverPath}/db/backups/${backupFile} ${dbPath}/backups/.`,
  dry: flag.dry
})
if (!flag.dry) log.success('Downloaded backup')
```
