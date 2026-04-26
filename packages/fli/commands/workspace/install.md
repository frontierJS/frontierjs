---
title: workspace:install
description: Run bun install at the workspace root
alias: ws:install
examples:
  - fli ws-install
  - fli ws-install --dry
---

<script>
import { resolve } from 'path'
import { homedir } from 'os'
</script>

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
log.info(`Installing all workspace deps at ${wsRoot}`)
context.exec({ command: `bun install --cwd ${wsRoot}`, dry: flag.dry })
if (!flag.dry) log.success('All workspace deps installed')
```
