---
title: 01-prepare
description: Ensure local backups directory exists
---

<script>
import { mkdirSync } from 'fs'
</script>

```js
const backups = `${context.config.dbPath}/backups`
if (flag.dry) { log.dry(`Would create ${backups}`); return }
mkdirSync(backups, { recursive: true })
log.success(`Backups dir ready: ${backups}`)
```
