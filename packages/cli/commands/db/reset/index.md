---
title: db:reset
description: Wipe the database file and rebuild it from its migration history (schema push when there is none)
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
$.config.env    = flag.test ? ':test' : ''
$.config.dbFile = flag.test ? 'test.db' : 'development.db'
$.config.dbPath = $.paths.db
$.config.root   = $.paths.root

log.warn(`Resetting ${$.config.dbFile} — this is destructive`)
```
