---
title: 04-restore
description: Replace local dev DB with the downloaded backup
---

```js
const { dbPath, backupFile } = context.config
context.exec({ command: `rm -f ${dbPath}/development.db*`, dry: flag.dry })
context.exec({
  command: `sqlite3 ${dbPath}/development.db '.restore ${dbPath}/backups/${backupFile}'`,
  dry: flag.dry
})
// Fix paused actions after restore
context.exec({
  command: `sqlite3 ${dbPath}/development.db 'UPDATE actions SET pausedAt = createdAt'`,
  dry: flag.dry
})
log.success('Local DB restored from backup')
```
