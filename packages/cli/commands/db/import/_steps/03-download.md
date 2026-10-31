---
title: 03-download
description: Download the backup from the remote server
skip: "$.config.viaBasecamp"
---

```js
const { server, serverPath, dbPath, backupFile } = $.config
$.exec({
  command: `scp ${server}:${serverPath}/db/backups/${backupFile} ${dbPath}/backups/.`,
  dry: flag.dry
})
if (!flag.dry) echo(chalk`  {green ✓} {dim downloaded} ${backupFile}`)
```
