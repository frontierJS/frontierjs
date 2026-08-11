---
title: completion:refresh
description: Drop the registry cache and rebuild it
alias: cr
examples:
  - fli completion:refresh
---

```js

const { clearRegistryCache } = await import(
  new URL('file://' + global.fliRoot + '/core/registry.js')
)

if (flag.dry) {
  log.dry('Would drop the registry cache and rebuild it')
  return
}

const { path, held } = clearRegistryCache()
log.info(held ? `Dropped ${held} cached command(s) — ${path}` : 'No cache was present.')

// Rebuild now so the next Tab press pays nothing
const commands = await loadCompletions()
log.success(`Rebuilt — ${commands.length} command(s) cached.`)
```
