---
title: 01-remove
description: Remove the database file the schema declares
---

```js
// The schema's `database` declaration says which file litestone opens;
// `resolveDb`'s development.db is only the answer for an app that declares none.
const { databaseFilesToReset } = await import(resolve(global.fliRoot, 'core/db-preflight.js'))
const { full } = resolveDb($, flag)
const files = databaseFilesToReset($.paths.root, $.paths.db, { test: flag.test, fallback: full })

for (const file of files) {
  $.exec({ command: `rm -f ${JSON.stringify(file)} ${JSON.stringify(file + '-wal')} ${JSON.stringify(file + '-shm')}`, dry: flag.dry })
  log.info(`Removed ${file}`)
}
```
