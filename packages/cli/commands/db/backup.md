---
title: db:backup
description: Hot backup of every database the schema declares, into a new db/backups/<stamp>/
alias: db-backup
examples:
  - fli db:backup
  - fli db:backup db/backups/before-import
  - fli db:backup --vacuum
  - fli db:backup --zip
  - fli db:backup --db main
  - fli db:backup --dry
args:
  -
    name: dest
    description: The directory to write — by default a new timestamped one under db/backups/
    required: false
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
beside them. The destination is a directory, not a file, because a schema
declares as many databases as it likes, and each run writes a new one, so a
second backup never replaces the first. `fli db:restore <dir>` puts one back.

```js
if (!requireSchema($)) return

const { schema } = resolveDb($, flag)

// This command used to run `sqlite3 {dbPath}/development.db '.backup …'`, which
// was wrong in both halves: `development.db` is a name the CLI invented — a
// litestone app's paths come from `database` blocks in the schema — and one
// file is never the whole database anyway. `main` plus an `audit` logger is the
// ordinary shape, so the trail was the part not being copied.
//
// No destination is litestone's own: a timestamped directory under
// db/backups/, beside the schema. A fixed db/backups/ here made every backup
// overwrite the one before it (FJS-1786).
const argv = ['backup']
if (arg.dest)    argv.push(JSON.stringify(resolve(arg.dest)))
argv.push('--schema', JSON.stringify(schema))
if (flag.vacuum) argv.push('--vacuum')
if (flag.zip)    argv.push('--zip')
if (flag.db)     argv.push('--db', flag.db)

$.exec({ command: `${litestone($)} ${argv.join(' ')}`, dry: flag.dry })
```
