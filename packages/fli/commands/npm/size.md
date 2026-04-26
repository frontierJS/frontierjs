---
title: npm:size
description: Check the install size of a package before adding it
alias: pkgsize
examples:
  - fli pkgsize lodash
  - fli pkgsize react react-dom
  - fli pkgsize zustand --dry
args:
  -
    name: packages
    description: Package name(s) to check
    required: true
    variadic: true
---

<script>
// Uses bundlephobia API — no install needed
const formatBytes = (bytes) => {
  if (bytes < 1024)       return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`
  return `${(bytes/1024/1024).toFixed(2)} MB`
}
</script>

Checks package size on [bundlephobia.com](https://bundlephobia.com) — no install needed.

```js
const names = arg.packages.split(' ').map(p => p.trim()).filter(Boolean)

for (const name of names) {
  if (flag.dry) {
    log.dry(`Would check bundlephobia: ${name}`)
    continue
  }

  log.info(`Checking ${name}...`)
  try {
    const res  = await fetch(`https://bundlephobia.com/api/size?package=${encodeURIComponent(name)}`)
    const data = await res.json()
    if (data.error) { log.error(`${name}: ${data.error.message || 'not found'}`); continue }
    echo(`  ${name}@${data.version}`)
    echo(`    size (minified):  ${formatBytes(data.size)}`)
    echo(`    size (gzipped):   ${formatBytes(data.gzip)}`)
    echo(`    weekly downloads: ${(data.description?.includes('weekly') ? '' : '')}`)
    if (data.dependencyCount !== undefined) echo(`    dependencies:     ${data.dependencyCount}`)
    echo('')
  } catch (err) {
    log.error(`Failed to fetch ${name}: ${err.message}`)
  }
}
```
