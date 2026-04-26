---
title: db:reset
description: Wipe and reset the database (remove file, migrate reset, push schema)
alias: db-reset
examples:
  - fli db:reset
  - fli db:reset --test
  - fli db:reset --dry
flags:
  test:
    char: t
    type: boolean
    description: Reset the test database
    defaultValue: false
---

```js
context.config.env    = flag.test ? ':test' : ''
context.config.dbFile = flag.test ? 'test.db' : 'development.db'
context.config.dbPath = context.paths.db
context.config.root   = context.paths.root

log.warn(`Resetting ${context.config.dbFile} — this is destructive`)
```
