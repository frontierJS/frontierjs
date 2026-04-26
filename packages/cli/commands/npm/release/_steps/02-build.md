---
title: 02-build
description: Build the package
skip: "context.config.noBuild"
optional: true
---

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'
const hasScript = (root, name) => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    return !!pkg.scripts?.[name]
  } catch { return false }
}
</script>

```js
if (!hasScript(context.config.root, 'build')) {
  log.info('No build script found — skipping')
  return
}

log.info('Building...')
context.exec({ command: `npm run build --prefix ${context.config.root}`, dry: flag.dry })
log.success('Build complete')
```
