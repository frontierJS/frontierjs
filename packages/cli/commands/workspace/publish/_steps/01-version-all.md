---
title: 01-version-all
description: Bump versions across all target packages
---

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

const getVer = (dir) => {
  try { return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).version }
  catch { return '?' }
}
</script>

```js
if (!context.config.packages?.length) { log.info("No packages to version"); return }
for (const { dir, pkg } of context.config.packages) {
  const before = getVer(dir)
  const cmd    = `npm version ${context.config.bump} --prefix ${dir}`

  log.info(`  ${pkg.name}: ${before} → (${context.config.bump})`)

  if (flag.dry) {
    context.config.results.push({ ...pkg, dir, newVersion: `${before}-preview` })
    continue
  }

  execSync(cmd, { cwd: dir, stdio: 'inherit' })
  const after = getVer(dir)
  context.config.results.push({ ...pkg, dir, newVersion: after })
  log.success(`  ${pkg.name}: ${before} → ${after}`)
}
```
