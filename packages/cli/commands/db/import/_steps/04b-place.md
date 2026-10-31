---
title: 04b-place
description: Put each database the archive holds in place of the local one
skip: "!$.config.viaBasecamp"
---

```js
const { archive, dbPath } = $.config
if (flag.dry) { log.dry(`replace each database in ${dbPath} with the archive's — production.db as development.db`); return }
const placed = placeArchive(archive.dir, archive.files, dbPath)
if (!placed.length) { log.error(`${archive.file} holds no database`); $.config.abort = true; return }
echo.lines(placed.map(p => chalk`  {green ✓} ${p.to}${p.to === p.from ? '' : chalk` {dim from ${p.from}}`}`))
```
