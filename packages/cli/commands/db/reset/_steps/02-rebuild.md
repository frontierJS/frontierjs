---
title: 02-rebuild
description: Rebuild the database from its migration history, or push the schema when there is none
---

```js
const { schema, dbPath } = resolveDb($, flag)
const ls = litestone($)

// `db push` writes tables and no migration file, so pushing over an app that
// has a history builds a database the next `migrate dev` refuses as drifted.
const migrations = resolve(dbPath, 'migrations')
const hasHistory = existsSync(migrations) && readdirSync(migrations).length > 0

$.exec({
  command: hasHistory ? `${ls} migrate dev --schema ${schema}` : `${ls} db push --schema ${schema}`,
  cwd: $.config.root,
  dry: flag.dry
})
log.success('Database reset complete')
```
