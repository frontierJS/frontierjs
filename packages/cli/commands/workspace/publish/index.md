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
  - fli ws-pub patch --no-push
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
  except:
    char: e
    type: string
    multiple: true
    description: Publish everything but this package — the counterpart to --filter, for a package that needs its own run
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
  allow-dirty:
    type: boolean
    description: Publish even though a package has uncommitted files — npm packs the working directory, not the commit
    defaultValue: false
  allow-peer-drift:
    type: boolean
    description: Publish even though a peer range would no longer resolve, or could not be decided
    defaultValue: false
  changed-only:
    type: boolean
    description: Only publish packages with uncommitted changes of their own
    defaultValue: false
  no-push:
    type: boolean
    description: Version, tag and publish, but leave the commit and tags local
    defaultValue: false
  tolerate-republish:
    type: boolean
    description: Do not fail on a version the registry already holds — the recovery flag, for finishing a run that published some of its packages and not others
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

`--tolerate-republish` is the recovery flag. A run that publishes some of its
packages and not others leaves versions the registry already holds, and
`bun publish` exits 1 on those — so the obvious *fix the failure and re-run*
fails on exactly the packages that succeeded. It is a flag rather than the
default because the error it silences is worth hearing on an ordinary run: a
version already on the registry means the bump did not happen, and a release
that quietly published nothing looks identical to one that worked.

`--no-push` stops after publishing: the release commit and its tags stay local.
Worth reaching for when this repo's `pre-push` hook is a CI tier — a release
commit carries version bumps and nothing else, so re-running the checks that
already passed on its parent costs about a minute and proves nothing new. The
push command is printed for you to run when you mean to.

```js
const { wsRoot, packages: all } = await context.wsPackages()
if (!wsRoot) { log.error('No workspace path provided'); return }

if (!all.length) {
  log.error(`No packages found in ${wsRoot}/packages/`)
  return
}

let packages = all

const { matchesSelector } = await import(new URL('file://' + global.fliRoot + '/core/publish-preflight.js'))

if (flag.filter)
  packages = packages.filter(({ pkg, folder }) => matchesSelector(pkg, folder, flag.filter))

// `--except` is the counterpart to `--filter` and exists for a package that
// needs its OWN run: one `ws:pub` applies one dist-tag to everything it
// publishes, so a package going out under a different tag has to be held back
// from this one rather than tagged differently inside it.
//
// Matched the way `--filter` matches, so the two are learned once.
if (flag.except) {
  const excepts = Array.isArray(flag.except) ? flag.except : [flag.except]
  const before  = packages.length
  packages = packages.filter(({ pkg, folder }) => !matchesSelector(pkg, folder, flag.except))
  // Named rather than counted. An `--except` that matched nothing is a typo,
  // and silently publishing the package it was meant to hold back is the one
  // outcome the flag exists to prevent.
  if (packages.length === before)
    log.warn(`--except matched no package: ${excepts.join(', ')}`)
  else
    log.info(`--except: holding back ${before - packages.length} package(s)`)
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
// Every member, not the release set: the package a peer range breaks is the one
// DECLARING it, and that is usually not one of the packages being bumped.
context.config.members    = all
context.config.planned    = planned
context.config.bump       = arg.bump
context.config.tag        = flag.tag
context.config.otp        = flag.otp
context.config.tolerate   = flag['tolerate-republish']
context.config.released   = []
context.config.startTime  = Date.now()

// Steps are compiled without the namespace module, so the helpers travel here.
context.config.releaseTag     = releaseTag
context.config.releaseSubject = releaseSubject
```
