---
title: project:install
description: Install the app's dependencies; --force deletes node_modules and the lockfiles first
alias: install
examples:
  - fli install
  - fli install --force
  - fli install --force --dry
flags:
  force:
    type: boolean
    description: Delete node_modules, bun.lock and any stray lockfile, then install from scratch
    defaultValue: false
---

<script>
import { rmSync } from 'fs'

// A lockfile pins each tarball's sha512. When a release is re-cut under the
// same version, a machine with the old tarball cached keeps installing it and
// a clean one fails `Integrity check failed`, so --force drops the lock and
// lets bun record what the URL serves now. package-lock.json is npm's — bun
// never reads it, it only goes stale beside bun.lock.
const FORCE_TARGETS = ['node_modules', 'bun.lock', 'bun.lockb', 'package-lock.json']

const present = (root) => FORCE_TARGETS.filter(t => existsSync(resolve(root, t)))

const remove = (root, targets, { echo, chalk, log, dry }) => {
  for (const t of targets) {
    if (dry) { log.dry(`rm -rf ${resolve(root, t)}`); continue }
    rmSync(resolve(root, t), { recursive: true, force: true })
    echo(chalk`  {red −}  ${t}`)
  }
}
</script>

`bun install` at the app root. **`--force` starts clean**: it deletes
`node_modules` and every lockfile, so the install resolves each dependency
again and records the hash its tarball has now. Use it when an install fails
with `Integrity check failed` on a machine that has not cached the package
before. Commit the new `bun.lock` it writes.

```js
const root = $.paths.root
if (!existsSync(resolve(root, 'package.json'))) {
  log.error(`No package.json at ${root} — run this inside an app`)
  return
}

if (flag.force) {
  const targets = present(root)
  echo(targets.length ? chalk`\n  {bold Removing}` : chalk.dim('\n  Nothing to remove'))
  remove(root, targets, { echo, chalk, log, dry: flag.dry })
  echo('')
}

$.exec({ command: 'bun install', cwd: root, dry: flag.dry })
```
