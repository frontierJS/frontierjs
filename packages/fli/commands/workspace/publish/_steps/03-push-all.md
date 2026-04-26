---
title: 03-push-all
description: Push git commits and tags for all published packages
skip: "flag.dry"
---

<script>
import { execSync } from 'child_process'
</script>

```js
if (!context.config.results?.length) { return }
for (const { name, dir } of context.config.results) {
  log.info(`  Pushing ${name}...`)
  try {
    execSync('git push', { cwd: dir, stdio: 'inherit' })
    execSync('git push --tags', { cwd: dir, stdio: 'inherit' })
    log.success(`  ✓ ${name}`)
  } catch (err) {
    log.warn(`  ✗ ${name} push failed: ${err.message}`)
  }
}

const elapsed = ((Date.now() - context.config.startTime) / 1000).toFixed(1)
log.success(`Published ${context.config.results.length} package(s) in ${elapsed}s`)
```
