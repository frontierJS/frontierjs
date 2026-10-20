---
title: workspace:publish
description: Bump and publish changed workspace packages to npm
alias: ws:pub
examples:
  - fli ws:pub patch
  - fli ws:pub minor --filter fli --filter frontier-core
  - fli ws:pub patch --tag beta
  - fli ws:pub patch --all
  - fli ws:pub patch --dry
  - fli ws:pub patch --no-push
  - fli ws:pub --interactive
args:
  -
    name: bump
    choices: [patch, minor, major, prerelease]
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

**A release in flight is finished, never bumped.** A run that versioned and
tagged and then published nothing — an npm session that lapsed mid-run — leaves
no commits since any tag, which the rule above reads as done. So the registry is
asked first: a package whose `<name>@<version>` tag exists and whose version npm
does not hold is published as it stands, the bump argument ignored, and the run
says so. A registry that cannot answer refuses the run, because a guess either
bumps over a version nobody installed or republishes one. This is what `lerna
publish from-package` and `changeset publish` do — the registry, not a state
file, says what is left.

A package marked `private` in its `package.json` is skipped — npm refuses it,
and a failed publish aborts the run before anything is pushed.

`--tolerate-republish` passes bun's flag of the same name through: a version the
registry already holds is not a failure. Finishing a release in flight does not
need it — that run selects only the versions npm lacks. It is off by default
because the error it silences is worth hearing on an ordinary run: a version
already on the registry means the bump did not happen.

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
ready before eighteen OTP prompts arrive. Preflight runs `npm login
--auth-type=web` first, on a terminal, every run: an npm login session lasts two
hours, so a session that merely answers `npm whoami` can lapse between the first
publish and the last. A lapse mid-run stops the loop at the first package it
fails rather than failing every one after it, and the next `ws:pub` finishes the
release.
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

// A release that versioned and tagged and then published nothing — an npm
// session that lapsed mid-run — has no commits since any of its tags, so the
// filter below would call it done. The registry is asked first, and a release
// in flight is FINISHED rather than bumped: a bump over an unpublished version
// skips it for good.
const { unpublished } = await import(new URL('file://' + global.fliRoot + '/core/publish-preflight.js'))
const { execFile } = await import('child_process')
const onRegistry = (name, version) => new Promise(done =>
  execFile('npm', ['view', `${name}@${version}`, 'version'], (err, stdout, stderr) =>
    done(err ? (/\bE404\b/.test(String(stderr)) ? false : null) : Boolean(String(stdout).trim()))))

const onNpm = await Promise.all(packages.map(async ({ dir, pkg }) => {
  const state  = $.git.pkgState(pkg.name, dir)
  const tagged = state.lastTag === releaseTag(pkg.name, pkg.version)
  return { name: pkg.name, version: pkg.version, tagged, moved: state.affected,
           published: tagged ? await onRegistry(pkg.name, pkg.version) : false }
}))
const { pending, unknown, moved } = unpublished(onNpm)

if (moved.length) {
  log.error(`  ✗  in-flight-moved: tagged, not on npm, and committed to since: ${moved.join(', ')}`)
  log.error('      npm packs the working directory, so publishing now ships commits the tag does not hold')
  log.error('      fix: publish each from its tag — git worktree add <dir> <name>@<version>, then bun publish in that package')
  $.config.abort = true
  return
}

if (unknown.length) {
  log.error(`  ✗  npm could not say whether these versions are published: ${unknown.join(', ')}`)
  log.error('      A guess either bumps over a version nobody installed or republishes one')
  log.error('      Check the network and `npm view <name>@<version>`, then run again')
  $.config.abort = true
  return
}

const resume = pending.length > 0
if (resume) {
  packages = packages.filter(({ pkg }) => pending.includes(pkg.name))
  log.info(`${pending.length} package(s) are versioned and tagged but not on npm — finishing that release, not bumping`)
  log.info(`  '${arg.bump}' is ignored: a bump over an unpublished version skips it for good`)
}

// A package with no commits since its own tag is held back by DEFAULT, because
// the version it would spend buys nothing and the republish is not reversible.
// The sibling `ws:*` commands ask for that filter with `--affected`; here the
// cost of the wrong answer is a burned version rather than a wasted test run,
// so the filter is the default and `--all` is what turns it off.
else if (!flag.all) {
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
let planned = packages.map(p => ({ ...p, newVersion: resume ? p.pkg.version : bumpVersion(p.pkg.version, arg.bump) }))
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
log.info(`Bump:   ${resume ? 'none — finishing a release in flight' : arg.bump}`)
log.info(`Tag:    ${flag.tag}`)
log.info(`Repo:   ${repo ? `one repo at ${repo}` : 'one per package'}`)
echo('')
for (const { pkg, newVersion } of planned) log.info(resume ? `  ${pkg.name}  ${newVersion}` : `  ${pkg.name}  ${pkg.version} → ${newVersion}`)
echo('')

$.config.wsRoot     = wsRoot
$.config.repo       = repo
// Every member, not the release set: the package a peer range breaks is the one
// DECLARING it, and that is usually not one of the packages being bumped.
$.config.members    = all
$.config.planned    = planned
$.config.bump       = arg.bump
$.config.resume     = resume
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
