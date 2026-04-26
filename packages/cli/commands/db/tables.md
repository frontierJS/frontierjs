---
title: db:tables
description: List all sqlite tables (or show table sizes)
alias: db-tables
examples:
  - fli db:tables
  - fli db:tables --size
  - fli db:tables --test
flags:
  test:
    char: t
    type: boolean
    description: Query the test database
    defaultValue: false
  size:
    char: s
    type: boolean
    description: Show table sizes in KB instead of schemas
    defaultValue: false
---

```js
const { full } = resolveDb(context, flag)

if (flag.size) {
  const sql = `"SELECT name, (SUM(pgsize)/1024) AS size_KB FROM dbstat WHERE name NOT LIKE '\\_%' ESCAPE '\\' GROUP BY name ORDER BY (SUM(pgsize)/1024) DESC;"`
  context.exec({ command: `sqlite3 ${full} ${sql}`, dry: flag.dry })
} else {
  context.exec({ command: `sqlite3 ${full} '.schema'`, dry: flag.dry })
}
```
