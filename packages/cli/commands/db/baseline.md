---
title: db:baseline
description: Record the migration files as applied without running them, for a database that already holds what they build
alias: db-baseline
examples:
  - fli db:baseline
---

```js
// The way out for a database that is already correct and has no history to say
// so. Two populations need it and both are ordinary: an app developed entirely
// through `fli db:push`, and your own development database the moment
// `fli db:migrate` writes a delta you had already pushed — `ALTER TABLE ADD
// COLUMN` is not idempotent, so replaying it there fails with `duplicate column
// name` (FJS-D123).
//
// It refuses to record a lie: anything the migrations build and this database
// lacks is named, and nothing is written.
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

log.info('Recording migrations as applied...')
context.exec({ command: `${litestone(context)} migrate baseline --schema ${schema}` })
log.success('Baselined — nothing was run')
```
