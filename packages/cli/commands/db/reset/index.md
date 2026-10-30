---
title: db:reset
description: Wipe the database file and rebuild it from its migration history (schema push when there is none)
alias: db-reset
examples:
  - fli db:reset
  - fli db:reset --test
  - fli db:reset --seed
  - fli db:reset --dry
flags:
  test:
    char: t
    type: boolean
    description: Reset the test database
    defaultValue: false
  seed:
    char: s
    type: boolean
    description: Run the app's seeder after the rebuild (skipped when none is found)
    defaultValue: false
---

```js
$.config.env  = flag.test ? ':test' : ''
$.config.root = $.paths.root

log.warn('Resetting the database — this is destructive')
```
