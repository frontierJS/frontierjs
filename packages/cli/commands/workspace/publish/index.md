---
title: workspace:publish
description: Bump and publish changed workspace packages to npm
alias: ws:pub
examples:
  - fli ws-pub patch
  - fli ws-pub minor --filter fli --filter frontier-core
  - fli ws-pub patch --tag beta
  - fli ws-pub patch --all
  - fli ws-pub patch --dry
  - fli ws-pub patch --no-push
  - fli ws-pub --interactive
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
  push:
    type: boolean
    description: Version, tag and publish, but leave the commit and tags local
    defaultValue: true
  tolerate-republish:
    type: boolean
    description: Do not fail on a version the registry already holds — the recovery flag, for finishing a run that published some of its packages and not others
    defaultValue: false
  all:
    char: a
    type: boolean
    description: Publish every selected package, including ones with no commits since their own release tag
    defaultValue: false
  interactive:
    char: i
    type: boolean
    description: Confirm before every publish, not just the first — the pacing a browser 2FA prompt needs
    defaultValue: false
---

Bump versions, publish to npm, then push.

In a single-repo monorepo the bump is ONE commit with one `<name>@<version>` tag
per released package, and one push at the end. In a multi-repo workspace each
package is committed, tagged and pushed in its own repo. `ws:pub` detects which
shape it is in rather than being told.

Only a package with commits since its own `<name>@<version>` tag is released. A
version spent on a package nothing has touched cannot be taken back, and a run
that publishes sixteen identical tarballs looks exactly like one that worked.
`--all` turns that off and publishes everything selected — what to reach for
when a republish is the point, after a failed run or a packaging fix that
changed no source. A package that has never been released has no tag and is
always affected.

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

**One bump for the whole run, always.** `bun publish` rewrites a `workspace:*`
dependency from the LOCKFILE, so every version is written, the lockfile is
refreshed once and the commit is made BEFORE anything is published — a
per-package bump would pin every sibling to a version this run has not
published yet. A package that should go out on its own bump is its own run,
which is what `--filter` and `--except` are for.

**Every run stops once before the first publish**, on a terminal. npm's browser
2FA is per-publish and human-paced, so the pause is where you get logged in and
ready before eighteen OTP prompts arrive; whether you are logged in AT ALL is
asked earlier still, in preflight, where no version has been spent yet.
`--interactive` extends that pause to every package, and adds one before
versioning and one before the push — the pacing to reach for when the 2FA
prompt is a browser round trip rather than a code you can type.

```js
const { wsRoot, packages: all } = await $.wsPackages()
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
  packages = packages.filter(({ dir, pkg }) => $.git.pkgState(pkg.name, dir).dirty)
  if (!packages.length) {
    log.info('No packages with uncommitted changes — nothing to publish')
    return
  }
}

// A package with no commits since its own tag is held back by DEFAULT, because
// the version it would spend buys nothing and the republish is not reversible.
// The sibling `ws:*` commands ask for that filter with `--affected`; here the
// cost of the wrong answer is a burned version rather than a wasted test run,
// so the filter is the default and `--all` is what turns it off.
if (!flag.all) {
  const before = packages.length
  packages = packages.filter(({ dir, pkg }) => $.git.pkgState(pkg.name, dir).affected)
  if (packages.length < before)
    log.info(`${before - packages.length} package(s) have no commits since their own tag — holding back (--all publishes them)`)
}

if (!packages.length) {
  log.info('Nothing to publish')
  return
}

// Target versions are resolved here rather than in the version step, so the
// preview below states the numbers a user is approving.
let planned = packages.map(p => ({ ...p, newVersion: bumpVersion(p.pkg.version, arg.bump) }))
const repo  = $.wsRepo(all)

// ─── prompts ──────────────────────────────────────────────────────────────────
// Constructed ONCE and carried to the steps on `$.config`. A step
// importing its own would put a second readline interface on one TTY, and the
// two then race for every keystroke. Constructing is free — `prompt.js` opens
// stdin lazily, on the first question actually asked — so they are built for
// any run that could ask one, rather than for `--interactive` alone: step 02
// stops before the FIRST publish on every run.
let prompts = null
if (!flag.dry) {
  const { createPrompts } = await import(new URL('file://' + global.fliRoot + '/core/prompt.js'))
  prompts = createPrompts()
}

log.info(`Publishing ${planned.length} package(s)`)
log.info(`Bump:   ${arg.bump}`)
log.info(`Tag:    ${flag.tag}`)
log.info(`Repo:   ${repo ? `one repo at ${repo}` : 'one per package'}`)
echo('')
for (const { pkg, newVersion } of planned) log.info(`  ${pkg.name}  ${pkg.version} → ${newVersion}`)
echo('')

$.config.wsRoot     = wsRoot
$.config.repo       = repo
// Every member, not the release set: the package a peer range breaks is the one
// DECLARING it, and that is usually not one of the packages being bumped.
$.config.members    = all
$.config.planned    = planned
$.config.bump       = arg.bump
$.config.tag        = flag.tag
$.config.otp        = flag.otp
$.config.tolerate   = flag['tolerate-republish']
$.config.released   = []
$.config.startTime  = Date.now()

// Steps are compiled without the namespace module, so the helpers travel here.
$.config.releaseTag     = releaseTag
$.config.releaseSubject = releaseSubject

// The pacing the later steps read. `prompts` is null on a --dry run, which is
// the one shape that must never ask a question.
$.config.interactive = flag.interactive
$.config.prompts     = prompts
```
