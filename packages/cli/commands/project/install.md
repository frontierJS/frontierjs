---
title: project:install
description: Install the app's dependencies; --force deletes node_modules and the lockfiles first and offers newer releases
alias: install
examples:
  - fli install
  - fli install --force
  - fli install --bump
  - fli install --force --dry
flags:
  force:
    type: boolean
    description: Delete node_modules, bun.lock and any stray lockfile, then install from scratch; asks to bump a hosted pin with a newer release
    defaultValue: false
  bump:
    type: boolean
    description: Raise every hosted @frontierjs pin to its newest served release without asking
    defaultValue: false
---

<script>
import { rmSync } from 'fs'

const { hostedPins, releasedVersions, bumpsOwed, rewritePins, listReleaseTags } =
  await import(resolve(global.fliRoot, 'core/pin-bump.js'))

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

// A pin hosted at packages.frontierjs.com names one version and has no
// `latest` to float to, so a newer release is found from the repo's tags.
const newerReleases = async (root, { log }) => {
  const pins = hostedPins(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')))
  if (!Object.keys(pins).length) return []
  try { return await bumpsOwed(pins, releasedVersions(await listReleaseTags())) }
  catch (err) { log.warn(`Could not read the releases, pins left as they are: ${err.message}`); return [] }
}

const showBumps = (bumps, { echo, chalk }) => {
  echo(chalk`\n  {bold Newer releases}`)
  for (const b of bumps) echo(chalk`  {cyan ↑}  ${b.name}  {dim ${b.from}} → ${b.to}`)
}

// --bump takes them; a person at a terminal is asked; anyone else is told.
const bumpWanted = async ({ flag, tty, echo, chalk }) => {
  if (flag.bump) return true
  if (!tty.interactive) { echo(chalk.dim('  fli install --bump raises them')); return false }
  return (await tty.keys('  Bump to latest?', { y: 'yes', n: 'no' })) === 'y'
}

const writeBumps = (root, bumps, { echo, log, dry }) => {
  const file = resolve(root, 'package.json')
  if (dry) { log.dry(`rewrite ${bumps.length} pin(s) in ${file}`); return }
  writeFileSync(file, rewritePins(readFileSync(file, 'utf8'), bumps))
  echo(`  Bumped ${bumps.length} pin(s) in package.json`)
}
</script>

`bun install` at the app root. **`--force` starts clean**: it deletes
`node_modules` and every lockfile, so the install resolves each dependency
again and records the hash its tarball has now. Use it when an install fails
with `Integrity check failed` on a machine that has not cached the package
before. Commit the new `bun.lock` it writes.

**A hosted pin is checked for a newer release** on `--force`. A pin on
`packages.frontierjs.com` names one version, with no `latest` to float to, so
the run reads the repo's release tags, keeps a version only when its tarball is
served, and asks before rewriting the URLs in `package.json`. `--bump` rewrites
them without asking, and works without `--force`. An app on `link:` or npm
specs has no hosted pin and is not asked.

```js
const root = $.paths.root
if (!existsSync(resolve(root, 'package.json'))) {
  log.error(`No package.json at ${root} — run this inside an app`)
  return
}

if (flag.force || flag.bump) {
  const bumps = await newerReleases(root, { log })
  if (bumps.length) {
    showBumps(bumps, { echo, chalk })
    if (await bumpWanted({ flag, tty, echo, chalk })) writeBumps(root, bumps, { echo, log, dry: flag.dry })
  }
}

if (flag.force) {
  const targets = present(root)
  echo(targets.length ? chalk`\n  {bold Removing}` : chalk.dim('\n  Nothing to remove'))
  remove(root, targets, { echo, chalk, log, dry: flag.dry })
  echo('')
}

$.exec({ command: 'bun install', cwd: root, dry: flag.dry })
```
