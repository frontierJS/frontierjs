---
title: db:columns
description: List columns for a sqlite table
alias: db-columns
examples:
  - fli db:columns users
  - fli db:columns accounts --test
args:
  -
    name: table
    description: Table name to inspect
    required: true
flags:
  test:
    char: t
    type: boolean
    description: Query the test database
    defaultValue: false
---

```js
const db  = flag.test ? 'test' : 'development'
const sql = `"SELECT GROUP_CONCAT(name) AS fields FROM PRAGMA_TABLE_INFO('${arg.table}');"`
context.exec({ command: `sqlite3 ${context.paths.db}/${db}.db ${sql}`, dry: flag.dry })
```
