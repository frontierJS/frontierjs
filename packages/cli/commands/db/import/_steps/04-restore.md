---
title: 04-restore
description: Replace local dev DB with the downloaded backup
skip: "$.config.viaBasecamp"
---

```js
const { dbPath, backupFile } = $.config
$.exec({ command: `rm -f ${dbPath}/development.db*`, dry: flag.dry })
$.exec({
  command: `sqlite3 ${dbPath}/development.db '.restore ${dbPath}/backups/${backupFile}'`,
  dry: flag.dry
})
// Fix paused actions after restore
$.exec({
  command: `sqlite3 ${dbPath}/development.db 'UPDATE actions SET pausedAt = createdAt'`,
  dry: flag.dry
})
if (!flag.dry) echo(chalk`  {green ✓} {dim development.db restored from} ${backupFile}`)
```
