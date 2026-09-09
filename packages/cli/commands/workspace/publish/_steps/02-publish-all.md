---
title: 02-publish-all
description: Publish each package to npm
---

<script>
import { execSync } from 'child_process'
</script>

```js
const { released, tag, otp, tolerate } = context.config
if (!released?.length) { log.info('Nothing to publish'); return }

const published = []
const failures  = []

for (const { name, dir, newVersion } of released) {
  // bun, not npm: npm ships a `workspace:*` dependency spec verbatim, and no
  // registry can resolve one — the package installs nowhere. bun's packer
  // rewrites it to the sibling's version and drops devDependencies entirely.
  // Same --tag/--otp/--access flags.
  const parts = ['bun publish']
  if (tag !== 'latest') parts.push(`--tag ${tag}`)
  if (otp) parts.push(`--otp ${otp}`)
  // Off by default: a version the registry already holds means the bump did not
  // happen, and a release that published nothing reads the same as one that
  // worked. On, it is the only way to finish a run that published some of its
  // packages and not others — the state this loop can leave, since it collects
  // failures rather than stopping at the first.
  if (tolerate) parts.push('--tolerate-republish')

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
  if (published.length) {
    log.warn(`  ${published.length} package(s) DID publish: ${published.join(', ')}`)
    log.warn('  Those versions are on the registry for good. Re-running the same command bumps')
    log.warn('  again and skips a version; resetting and re-running needs --tolerate-republish,')
    log.warn('  or bun exits 1 on the ones that already went out.')
  }
  throw new Error(`${failures.length} package(s) failed to publish: ${failures.join(', ')} — nothing pushed`)
}
```
