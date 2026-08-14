---
title: workspace:publish
description: Bump and publish changed workspace packages to npm
alias: ws:pub
examples:
  - fli ws-pub patch
  - fli ws-pub minor --filter fli --filter frontier-core
  - fli ws-pub patch --tag beta
  - fli ws-pub patch --affected
  - fli ws-pub patch --dry
args:
  -
    name: bump
    description: "Version bump: patch | minor | major | prerelease"
    defaultValue: patch
flags:
  filter:
    char: f
    type: string
    multiple: true
    description: Only publish packages matching this name
    defaultValue: ''
  tag:
    char: t
    type: string
    description: npm dist-tag
    defaultValue: latest
  otp:
    char: o
    type: string
    description: npm 2FA one-time password
    defaultValue: ''
  private:
    type: boolean
    description: Include packages marked private in package.json
    defaultValue: false
  changed-only:
    type: boolean
    description: Only publish packages with uncommitted changes of their own
    defaultValue: false
  affected:
    char: a
    type: boolean
    description: Only publish packages changed since their own release tag
    defaultValue: false
---

Bump versions, publish to npm, then push.

In a single-repo monorepo the bump is ONE commit with one `<name>@<version>` tag
per released package, and one push at the end. In a multi-repo workspace each
package is committed, tagged and pushed in its own repo. `ws:pub` detects which
shape it is in rather than being told.

A package marked `private` in its `package.json` is skipped — npm refuses it,
and a failed publish aborts the run before anything is pushed.

```js
const { wsRoot, packages: all } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }

if (!all.length) {
  log.error(`No packages found in ${wsRoot}/packages/`)
  return
}

let packages = all

if (flag.filter) {
  const filters = Array.isArray(flag.filter) ? flag.filter : [flag.filter]
  packages = packages.filter(({ pkg, folder }) =>
    filters.some(f => pkg.name.includes(f) || folder.includes(f))
  )
}

// npm refuses a private package, and step 02 aborts the run on any failure —
// so an unfiltered private member would stop every later package publishing.
if (!flag.private) {
  const skipped = packages.filter(({ pkg }) => pkg.private)
  packages = packages.filter(({ pkg }) => !pkg.private)
  for (const { pkg } of skipped) log.info(`  skipping ${pkg.name} (private)`)
}

if (flag['changed-only']) {
  packages = packages.filter(({ dir, pkg }) => context.git.pkgState(pkg.name, dir).dirty)
  if (!packages.length) {
    log.info('No packages with uncommitted changes — nothing to publish')
    return
  }
}

if (flag.affected) {
  const before = packages.length
  packages = packages.filter(({ dir, pkg }) => context.git.pkgState(pkg.name, dir).affected)
  log.info(`--affected: ${packages.length} of ${before} package(s) have changes since their own tag`)
}

if (!packages.length) {
  log.info('Nothing to publish')
  return
}

// Target versions are resolved here rather than in the version step, so the
// preview below states the numbers a user is approving.
const planned = packages.map(p => ({ ...p, newVersion: bumpVersion(p.pkg.version, arg.bump) }))
const repo    = context.wsRepo(all)

log.info(`Publishing ${planned.length} package(s)`)
log.info(`Bump:   ${arg.bump}`)
log.info(`Tag:    ${flag.tag}`)
log.info(`Repo:   ${repo ? `one repo at ${repo}` : 'one per package'}`)
echo('')
for (const { pkg, newVersion } of planned) log.info(`  ${pkg.name}  ${pkg.version} → ${newVersion}`)
echo('')

context.config.wsRoot     = wsRoot
context.config.repo       = repo
context.config.planned    = planned
context.config.bump       = arg.bump
context.config.tag        = flag.tag
context.config.otp        = flag.otp
context.config.released   = []
context.config.startTime  = Date.now()

// Steps are compiled without the namespace module, so the helpers travel here.
context.config.releaseTag     = releaseTag
context.config.releaseSubject = releaseSubject
```
