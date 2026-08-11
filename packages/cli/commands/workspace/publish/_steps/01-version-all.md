---
title: 01-version-all
description: Write the new versions, then commit and tag them
---

<script>
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'
</script>

```js
const { planned, repo, releaseTag, releaseSubject } = context.config
if (!planned?.length) { log.info('No packages to version'); return }

for (const { dir, pkg, newVersion } of planned) {
  log.info(`  ${pkg.name}: ${pkg.version} → ${newVersion}`)
  if (flag.dry) continue
  const pkgPath = resolve(dir, 'package.json')
  const raw = JSON.parse(readFileSync(pkgPath, 'utf8'))
  raw.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
}

context.config.released = planned.map(({ dir, path, pkg, newVersion }) =>
  ({ dir, path, name: pkg.name, newVersion }))

if (flag.dry) {
  log.dry(`  Would commit ${planned.length} manifest(s) and tag each package`)
  return
}

const released = context.config.released

if (repo) {
  // One repo, one commit. Staging is per manifest — an unrelated edit sitting
  // in the working tree is not part of this release.
  for (const { path } of released) execSync(`git add ${path}/package.json`, { cwd: repo })
  execSync(`git commit -m ${JSON.stringify(releaseSubject(released))}`, { cwd: repo, stdio: 'inherit' })
  for (const { name, newVersion } of released) {
    execSync(`git tag ${releaseTag(name, newVersion)}`, { cwd: repo })
    log.success(`  tagged ${releaseTag(name, newVersion)}`)
  }
} else {
  for (const { dir, name, newVersion } of released) {
    const tag = releaseTag(name, newVersion)
    execSync('git add package.json', { cwd: dir })
    execSync(`git commit -m ${JSON.stringify(`chore(release): ${tag}`)}`, { cwd: dir })
    execSync(`git tag ${tag}`, { cwd: dir })
    log.success(`  tagged ${tag}`)
  }
}
```
