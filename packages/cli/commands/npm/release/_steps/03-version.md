---
title: 03-version
description: Bump version in package.json and create git commit + tag
---

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'
const getVer = (root) => {
  try { return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version }
  catch { return '?' }
}
</script>

```js
const { root, bump, preid } = context.config
const before  = getVer(root)
const preidFlag = preid ? `--preid=${preid}` : ''
const cmd     = `npm version ${bump} ${preidFlag} --prefix ${root}`.trim().replace(/\s+/g, ' ')

if (flag.dry) {
  log.dry(`Would bump: ${before} → (${bump})`)
  context.config.newVersion = `${before}-${bump}-preview`
  return
}

context.exec({ command: cmd })
const after = getVer(root)
context.config.newVersion = after
log.success(`${before} → ${after}`)
```
