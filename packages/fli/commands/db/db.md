---
title: db:db
description: Open an interactive sqlite3 shell or run a query against the project database
alias: db
examples:
  - fli db
  - fli db "select * from users;"
  - fli db "select * from users;" --test
  - fli db "select * from users;" --output users.sql
  - fli db --dry
args:
  -
    name: query
    description: SQL query to run (omit to open interactive shell)
    variadic: true
flags:
  test:
    char: t
    type: boolean
    description: Use the test database
    defaultValue: false
  output:
    char: o
    type: string
    description: Dump results to a file in insert mode
    defaultValue: ''
---

```js
const dbPath  = context.paths.db
const dbName  = flag.test ? 'test' : 'development'
const dbFile  = `${dbPath}/${dbName}.db`

// No query — open interactive shell
if (!arg.query) {
  log.info(`Opening ${dbName}.db`)
  context.exec({ command: `sqlite3 ${dbFile}`, dry: flag.dry })
  return
}

const sql = arg.query

// Output mode — dump results as INSERT statements into a file
if (flag.output) {
  const table = sql.replace(/^.*from\s+/i, '').replace(/[;"'\s]+$/, '').split(/\s/)[0]
  const cmd = `sqlite3 ${dbFile} ".mode insert ${table}" ".out ${flag.output}" "${sql.replace(/"/g, '\\"')}"`
  log.info(`Dumping ${table} → ${flag.output}`)
  context.exec({ command: cmd, dry: flag.dry })
  return
}

// Run query directly
context.exec({ command: `sqlite3 ${dbFile} "${sql.replace(/"/g, '\\"')}"`, dry: flag.dry })
```
