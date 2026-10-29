---
title: workspace:publish
description: Bump changed workspace packages and ship each to its GitHub Release — and to npm when asked
alias: ws:pub
examples:
  - fli ws:pub patch
  - fli ws:pub minor --filter fli --filter frontier-core
  - fli ws:pub patch --tag beta
  - fli ws:pub patch --to npm --to tarballs
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
  to:
    type: string
    multiple: true
    choices: [npm, tarballs]
    description: "Where the tarball goes: tarballs (a GitHub Release per tag, the package host's bytes — the default) or npm, the public registry. Repeat for both"
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
    description: Publish even though a sibling range (peer or dependency) would no longer resolve, or could not be decided
    defaultValue: false
  changed-only:
    type: boolean
    description: Only publish packages with uncommitted changes of their own
    defaultValue: false
  push:
    type: boolean
    description: Version, tag and publish, but leave the commit and tags local
    defaultValue: true
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

Bump versions, ship each package to a GitHub Release named for its tag — and to
npm when `--to npm` says so — then push.

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
no commits since any tag, which the rule above reads as done. So every
destination in the run is asked first: a package whose `<name>@<version>` tag
exists and which a destination does not hold is shipped THERE as it stands, the
bump argument ignored, and the run says so — which is also how a version that
reached npm and not the release, or the other way round, is completed. A
destination that cannot answer refuses the run, because a guess either bumps
over a version nobody installed or republishes one. This is what `lerna publish
from-package` and `changeset publish` do — the destination, not a state file,
says what is left.

A package marked `private` in its `package.json` is skipped — npm refuses it,
and a failed publish aborts the run before anything is pushed.

**One pack, each destination asked for.** Each package is packed ONCE and that
file goes wherever `--to` names: `tarballs` is a GitHub Release named for the
package's tag (`gh release create <name>@<version> <tgz>`), the bytes
`packages.frontierjs.com/<stem>/<version>.tgz` redirects to (`FJS-D1568`); `npm`
is `bun publish <tgz>`. **Unset is the release alone** (`FJS-D1613`): a release
is what a build box installs from, and an npm publish is a browser 2FA round trip
per package and a version promised to the public — so going public is said, `--to
npm`, and `--to npm --to tarballs` ships both from one pack so the two hold the
same bytes by construction. A destination left out today can be added tomorrow:
the resume rule above asks each one. GitHub refuses a second asset under the same
name, so a tag already released is refused the way npm refuses a spent version.

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
ready before eighteen OTP prompts arrive. When npm is in the run, preflight runs
`npm login --auth-type=web` first, on a terminal: an npm login session lasts two
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

// Where each tarball goes. Unset is the release host alone (`FJS-D1613`): a
// public release is `--to npm`, said on purpose, because every npm publish is a
// browser 2FA round trip and a version promised to the world.
const { hosts, DEFAULT_TO } = await import(new URL('file://' + global.fliRoot + '/core/publish-hosts.js'))
const to   = flag.to ? [...new Set([flag.to].flat())] : DEFAULT_TO
const repo = $.wsRepo(all)

// A release that versioned and tagged and then shipped nothing — an npm session
// that lapsed mid-run — has no commits since any of its tags, so the filter
// below would call it done. Every destination in the run is asked first, and a
// release in flight is FINISHED rather than bumped: a bump over an unshipped
// version skips it for good. Per destination, so a version that reached one
// and not the other is completed, not bumped and not republished.
const { unpublished } = await import(new URL('file://' + global.fliRoot + '/core/publish-preflight.js'))

const onHosts = await Promise.all(packages.map(async ({ dir, pkg }) => {
  const state  = $.git.pkgState(pkg.name, dir)
  const tagged = state.lastTag === releaseTag(pkg.name, pkg.version)
  const holds  = hosts(repo ?? dir)
  const held   = tagged ? await Promise.all(to.map(d => holds[d](pkg.name, pkg.version))) : []
  const missing   = to.filter((d, i) => held[i] === false)
  const published = !tagged ? false : held.some(h => h === null) ? null : missing.length === 0
  return { name: pkg.name, version: pkg.version, tagged, moved: state.affected, published, missing }
}))
const { pending, unknown, moved } = unpublished(onHosts)

if (moved.length) {
  log.error(`  ✗  in-flight-moved: tagged, not shipped to ${to.join(' + ')}, and committed to since: ${moved.join(', ')}`)
  log.error('      npm packs the working directory, so publishing now ships commits the tag does not hold')
  log.error('      fix: publish each from its tag — git worktree add <dir> <name>@<version>, then bun publish in that package')
  $.config.abort = true
  return
}

if (unknown.length) {
  log.error(`  ✗  a destination could not say whether it holds these versions: ${unknown.join(', ')}`)
  log.error('      A guess either bumps over a version nobody installed or republishes one')
  log.error('      Check the network, `npm view <name>@<version>` and `gh release view <name>@<version>`, then run again')
  // gh takes a token from the environment over its own login, and fli loads
  // `~/.config/fli/env` into that environment — so a token set there months
  // ago for `github:*` answers 401 here while `gh auth status` on a bare shell
  // is green. Named, because nothing in gh's own output says where it came from.
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
    log.error('      `GH_TOKEN`/`GITHUB_TOKEN` is set — fli loads `~/.config/fli/env` — and gh uses it over `gh auth login`; a stale one answers 401. Refresh it (`fli eset GITHUB_TOKEN <token> --global`) or remove the line')
  $.config.abort = true
  return
}

const resume = pending.length > 0
if (resume) {
  packages = packages.filter(({ pkg }) => pending.includes(pkg.name))
  // What each one still lacks, read by step 02 so a half-shipped version goes
  // only where it is missing.
  $.config.missing = Object.fromEntries(onHosts.filter(m => pending.includes(m.name)).map(m => [m.name, m.missing]))
  for (const m of onHosts) if (pending.includes(m.name)) log.info(`  ${m.name}@${m.version} is tagged and missing from ${m.missing.join(' + ')}`)
  log.info(`${pending.length} package(s) are versioned and tagged but not shipped everywhere — finishing that release, not bumping`)
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
log.info(`To:     ${to.join(' + ')}`)
if (to.includes('npm')) log.info(`Tag:    ${flag.tag}`)
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
$.config.to         = to
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
