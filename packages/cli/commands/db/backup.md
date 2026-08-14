---
title: db:backup
description: Hot backup of every database the schema declares, into db/backups/
alias: db-backup
examples:
  - fli db:backup
  - fli db:backup --vacuum
  - fli db:backup --zip
  - fli db:backup --db main
  - fli db:backup --dry
flags:
  vacuum:
    type: boolean
    description: Compact the SQLite files while copying (VACUUM INTO)
    defaultValue: false
  zip:
    type: boolean
    description: Zip the backup directory
    defaultValue: false
  db:
    type: string
    description: Back up only this database by name
    defaultValue: ''
---

Delegates to `litestone backup`, which reads `db/schema.lite` and copies **every**
declared database — SQLite files hot through `$backup`, JSONL/logger directories
beside them. The destination is a timestamped directory, not a file, because a
schema declares as many databases as it likes.

```js
const dbPath = context.paths.db
if (!dbPath) { log.error('DB path not configured'); return }

// This command used to run `sqlite3 {dbPath}/development.db '.backup …'`, which
// was wrong in both halves: `development.db` is a name the CLI invented — a
// litestone app's paths come from `database` blocks in the schema — and one
// file is never the whole database anyway. `main` plus an `audit` logger is the
// ordinary shape, so the trail was the part not being copied.
const dest = `${dbPath}/backups`

// Not `args` — the compiled command already destructures that from context.
const argv = ['backup', dest]
if (flag.vacuum) argv.push('--vacuum')
if (flag.zip)    argv.push('--zip')
if (flag.db)     argv.push('--db', flag.db)

context.exec({ command: `bunx litestone ${argv.join(' ')}`, dry: flag.dry })

if (!flag.dry) log.success(`Backed up every declared database → ${dest}`)
```
