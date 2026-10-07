---
title: db:restore
description: Put a backup from fli db:backup back over the app's databases
alias: db-restore
examples:
  - fli db:restore db/backups/2026-10-06_142233
  - fli db:restore db/backups/before-import --force
  - fli db:restore db/backups/before-import --db main --force
args:
  -
    name: dir
    description: A directory fli db:backup (or litestone backup) wrote
    required: true
flags:
  force:
    type: boolean
    description: Replace the databases that exist — stop the app first
    defaultValue: false
  db:
    type: string
    description: Restore only this database by name
    defaultValue: ''
---

Delegates to `litestone restore --from-backup`, which puts back every database
the backup holds, all or nothing, and removes each SQLite file's `-wal` and
`-shm` so the old log is not replayed onto the copy. A database the backup does
not hold is left as it is and named. The schema and migrations under `db/` are
not restored; they are the repo's, and a database whose history is behind them
applies the rest at the next `fli db:migrate`.

```js
if (!requireSchema($)) return

const { schema } = resolveDb($, flag)

const argv = ['restore', '--from-backup', JSON.stringify(resolve(arg.dir)), '--schema', JSON.stringify(schema)]
if (flag.force) argv.push('--force')
if (flag.db)    argv.push('--db', flag.db)

$.exec({ command: `${litestone($)} ${argv.join(' ')}`, dry: flag.dry })
```
