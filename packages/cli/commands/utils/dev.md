---
title: utils:dev
description: Start dev server — uses bun if bun.lockb exists, otherwise npm
alias: dev
examples:
  - fli dev
  - fli dev --dry
---

<script>
import { existsSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const root    = context.paths.root
const usesBun = existsSync(resolve(root, 'bun.lockb')) || existsSync(resolve(root, 'bun.lock'))
const runner  = usesBun ? 'bun run dev' : 'npm run dev'

log.info(`${usesBun ? 'bun' : 'npm'} detected — running: ${runner}`)
context.exec({ command: `cd ${root} && ${runner}`, dry: flag.dry })
```
