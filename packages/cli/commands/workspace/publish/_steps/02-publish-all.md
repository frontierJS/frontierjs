---
title: 02-publish-all
description: Publish each package to npm
---

<script>
import { execSync } from 'child_process'
</script>

```js
if (!context.config.results?.length) { log.info("Nothing to publish"); return }
let failed = 0

for (const { name, dir, newVersion } of context.config.results) {
  const parts = [`npm publish`, `--prefix ${dir}`]
  if (context.config.tag !== 'latest') parts.push(`--tag ${context.config.tag}`)
  if (context.config.otp) parts.push(`--otp ${context.config.otp}`)

  log.info(`  Publishing ${name}@${newVersion}...`)

  if (flag.dry) { log.dry(`  Would run: ${parts.join(' ')}`); continue }

  try {
    execSync(parts.join(' '), { cwd: dir, stdio: 'inherit' })
    log.success(`  ✓ ${name}@${newVersion}`)
  } catch (err) {
    log.error(`  ✗ ${name}: ${err.message}`)
    failed++
  }
}

if (failed) throw new Error(`${failed} package(s) failed to publish`)
```
