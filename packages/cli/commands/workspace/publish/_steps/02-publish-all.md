---
title: 02-publish-all
description: Publish each package to npm
---

<script>
import { execSync } from 'child_process'
</script>

```js
const { released, tag, otp } = context.config
if (!released?.length) { log.info('Nothing to publish'); return }

const published = []
const failures  = []

for (const { name, dir, newVersion } of released) {
  const parts = ['npm publish']
  if (tag !== 'latest') parts.push(`--tag ${tag}`)
  if (otp) parts.push(`--otp ${otp}`)

  log.info(`  Publishing ${name}@${newVersion}...`)

  if (flag.dry) { log.dry(`  Would run in ${dir}: ${parts.join(' ')}`); continue }

  try {
    execSync(parts.join(' '), { cwd: dir, stdio: 'inherit' })
    published.push(`${name}@${newVersion}`)
    log.success(`  ✓ ${name}@${newVersion}`)
  } catch (err) {
    failures.push(name)
    log.error(`  ✗ ${name}: ${err.message}`)
  }
}

context.config.published = published

if (failures.length) {
  // The commit and tags from step 01 are still local — nothing is pushed, so
  // the recovery is to fix the failure and re-run, or reset the release commit.
  if (published.length) log.warn(`  ${published.length} package(s) DID publish: ${published.join(', ')}`)
  throw new Error(`${failures.length} package(s) failed to publish: ${failures.join(', ')} — nothing pushed`)
}
```
