---
title: 02-backup-remote
description: Create a sqlite backup on the remote server
skip: "$.config.viaBasecamp"
---

```js
const { server, serverPath, file, backupFile } = $.config
$.exec({
  command: `ssh ${server} "sqlite3 ${serverPath}/db/${file} '.backup ${serverPath}/db/backups/${backupFile}'"`,
  dry: flag.dry
})
```
