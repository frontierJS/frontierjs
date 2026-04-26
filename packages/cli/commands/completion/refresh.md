---
title: completion:refresh
description: Clear and rebuild the completion cache
alias: cr
examples:
  - fli completion:refresh
---

<script>
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
</script>

```js

const cacheFile = join(homedir(), '.fli', 'completion-cache.json')

if (!existsSync(cacheFile)) {
  log.info('No completion cache found — nothing to clear.')
  log.info('Cache is built automatically on your next Tab press.')
  return
}

if (flag.dry) {
  log.dry(`Would delete: ${cacheFile}`)
  return
}

unlinkSync(cacheFile)
log.success('Completion cache cleared.')

// Rebuild immediately so the next Tab press is instant
log.info('Rebuilding...')
const commands = await loadCompletions()
log.success(`Rebuilt — ${commands.length} command(s) cached.`)
```
