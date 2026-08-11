---
title: 03-push-all
description: Push the release commit and tags
skip: "flag.dry"
---

<script>
import { execSync } from 'child_process'
</script>

```js
const { released, repo, startTime } = context.config
if (!released?.length) return

// One repo means one push. The old per-package loop pushed the same branch
// once per member, so a sixteen-package release was fifteen no-ops.
const targets = repo
  ? [{ label: 'workspace', dir: repo }]
  : released.map(({ name, dir }) => ({ label: name, dir }))

for (const { label, dir } of targets) {
  log.info(`  Pushing ${label}...`)
  try {
    execSync('git push', { cwd: dir, stdio: 'inherit' })
    execSync('git push --tags', { cwd: dir, stdio: 'inherit' })
    log.success(`  ✓ ${label}`)
  } catch (err) {
    log.warn(`  ✗ ${label} push failed: ${err.message}`)
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
log.success(`Published ${released.length} package(s) in ${elapsed}s`)
```
