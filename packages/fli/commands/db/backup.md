---
title: db:backup
description: Create a timestamped sqlite backup in db/backups/
alias: db-backup
examples:
  - fli db:backup
  - fli db:backup --test
  - fli db:backup --dry
flags:
  test:
    char: t
    type: boolean
    description: Back up the test database instead
    defaultValue: false
---

<script>
import { mkdirSync, existsSync } from 'fs'
</script>

```js
const dbPath  = context.paths.db
if (!dbPath) { log.error('DB path not configured'); return }

const dbFile  = flag.test ? 'test.db' : 'development.db'
const date    = new Date().toJSON().replace(/:/g, '').split('.')[0]
const newFile = `${dbFile}-bak-${date}`
const backups = `${dbPath}/backups`

if (!existsSync(backups)) {
  if (flag.dry) { log.dry(`Would create ${backups}`) }
  else mkdirSync(backups, { recursive: true })
}

context.exec({ command: `sqlite3 ${dbPath}/${dbFile} '.backup ${backups}/${newFile}'`, dry: flag.dry })
context.exec({ command: `du -sh ${backups}/`, dry: flag.dry })

if (!flag.dry) log.success(`Backed up to ${backups}/${newFile}`)
```
