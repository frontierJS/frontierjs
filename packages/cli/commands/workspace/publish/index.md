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
  allow-peer-drift:
    type: boolean
    description: Publish even though a sibling range (peer or dependency) would no longer resolve, or could not be decided
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
  yes:
    char: y
    type: boolean
    description: Answer every confirmation with its default — npm's own 2FA still asks
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
reached npm and not the release, or the other way round, is completed. Commits that
landed since the tag change nothing when the remote holds the tag: the pack is of
the tag's checkout, and the run says so (`FJS-D1722`). A tag only this clone
holds was never public, so it is refused (`in-flight-moved`), not shipped
(`FJS-D1725`). A
destination that cannot answer refuses the run, because a guess either bumps
over a version nobody installed or republishes one. This is what `lerna publish
from-package` and `changeset publish` do — the destination, not a state file,
says what is left.

A package marked `private` in its `package.json` is skipped — npm refuses it.

**One pack, each destination asked for.** Each package is packed ONCE, from a
checkout of the commit its tag names rather than the working tree, and that file
goes wherever `--to` names: `tarballs` is a GitHub Release named for the
package's tag (`gh release create <name>@<version> <tgz>`), the bytes
`packages.frontierjs.com/<tag>/<stem>-<version>.tgz` redirects to (`FJS-D1620`); `npm`
is `bun publish <tgz>`. **Unset is the release alone** (`FJS-D1613`): a release
is what a build box installs from, and an npm publish is a browser 2FA round trip
per package and a version promised to the public — so going public is said, `--to
npm`, and `--to npm --to tarballs` ships both from one pack so the two hold the
same bytes by construction. A destination left out today can be added tomorrow:
the resume rule above asks each one. GitHub refuses a second asset under the same
name, so a tag already released is refused the way npm refuses a spent version.

**The tag comes last, after a green CI run.** The bump is committed and nothing
is tagged. The full `ci` then runs in a checkout of that commit, and only a green
run tags it (`FJS-D1720`, `FJS-D1721`). A red run leaves a commit and no tag, so
fixes land and the next run keeps the commit rather than moving a tag. The
`deploy --source npm` branch is skipped by name: the bump raised the scaffold's
pins to versions no host holds yet, and `04-verify-assets` grades the published
framework afterwards (`FJS-D1726`).

**The push goes out before the first publish, for the graded sha.** A GitHub
Release can only be made on a commit GitHub has (`FJS-3616`). The push names the
sha CI graded and the release tags, never `HEAD`, and skips the pre-push hook
because CI already passed on exactly that sha. A version pushed and not yet
shipped is the in-flight case above.

`--no-push` tags the graded commit and keeps it and its tags local, shipping to
npm alone; beside `tarballs` it is refused, since the release has no commit to
sit on. The push command is printed for you to run when you mean to.

**One bump for the whole run, always.** `bun pm pack` rewrites a `workspace:*`
dependency from the sibling's manifest in the tree it packs, so every version is
written and committed BEFORE anything is packed — a per-package bump would pin
every sibling to a version this run has not published yet. A package that should go out on its own bump is its own run,
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
prompt is a browser round trip rather than a code you can type. `--yes` answers
every one of these with its default and never reads stdin; npm's own 2FA is
bun's prompt, not this command's, and still asks.

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

// Where each tarball goes. Unset is the release host alone (`FJS-D1613`): a
// public release is `--to npm`, said on purpose, because every npm publish is a
// browser 2FA round trip and a version promised to the world.
const { hosts, remoteHasTag, DEFAULT_TO, packageHostUrl } = await import(new URL('file://' + global.fliRoot + '/core/publish-hosts.js'))
const to   = flag.to ? [...new Set([flag.to].flat())] : DEFAULT_TO
const repo = $.wsRepo(all)

// A release that versioned and tagged and then shipped nothing — an npm session
// that lapsed mid-run — has no commits since any of its tags, so the filter
// below would call it done. Every destination in the run is asked first, and a
// release in flight is FINISHED rather than bumped: a bump over an unshipped
// version skips it for good. Per destination, so a version that reached one
// and not the other is completed, not bumped and not republished.
const { unpublished, untaggedBumps } = await import(new URL('file://' + global.fliRoot + '/core/publish-preflight.js'))

const onHosts = await Promise.all(packages.map(async ({ dir, pkg }) => {
  const state  = $.git.pkgState(pkg.name, dir)
  const tagged = state.lastTag === releaseTag(pkg.name, pkg.version)
  const lastTagVersion = state.lastTag ? state.lastTag.slice(pkg.name.length + 1) : ''
  const holds  = hosts(repo ?? dir)
  // An untagged version ahead of the last tag may be a bump whose CI gate failed
  // before the tag was written, so the hosts are asked about it too.
  const held   = tagged || (lastTagVersion && lastTagVersion !== pkg.version)
    ? await Promise.all(to.map(d => holds[d](pkg.name, pkg.version))) : []
  const missing   = to.filter((d, i) => held[i] === false)
  const published = !tagged ? false : held.some(h => h === null) ? null : missing.length === 0
  // Asked only where the answer matters: a tag with commits since it that a
  // destination lacks. The remote, not the local tag list, says what is public.
  const needsRemote = tagged && state.affected && published === false
  const pushed = needsRemote ? await remoteHasTag(repo ?? dir, releaseTag(pkg.name, pkg.version)) : undefined
  return { name: pkg.name, version: pkg.version, tagged, lastTagVersion, moved: state.affected, published, missing, pushed,
           none: held.length > 0 && held.every(h => h === false) }
}))
const { pending, unknown, moved: movedAll, fromTag } = unpublished(onHosts)

// A tag only this clone holds, with commits since it and on no host, was never
// public and its sha is usually the commit the hook refused: deleted by name
// and sha, and the version resumes as an untagged bump (`FJS-D1725`). The
// remote must have ANSWERED that it lacks the tag, and no destination may hold
// the version; anything else is refused below.
const { execSync } = await import('child_process')
const stale = onHosts.filter(m => movedAll.includes(m.name) && m.pushed === false && m.none)
for (const m of stale) {
  const tagName = releaseTag(m.name, m.version)
  const dir     = repo ?? packages.find(p => p.pkg.name === m.name).dir
  const sha     = execSync(`git rev-parse --short ${JSON.stringify(`refs/tags/${tagName}^{commit}`)}`, { cwd: dir, encoding: 'utf8' }).trim()
  if (flag.dry) { log.dry(`  Would delete the local-only tag ${tagName} ${sha} and resume ${m.version} as an untagged bump`); m.tagged = false; continue }
  execSync(`git tag -d ${JSON.stringify(tagName)}`, { cwd: dir, stdio: 'ignore' })
  m.tagged = false
  log.warn(`  deleted ${tagName} ${sha} -- only this clone held it, and no destination holds ${m.version}`)
}
const moved = movedAll.filter(n => !stale.some(m => m.name === n))

if (moved.length) {
  const asked = onHosts.filter(m => moved.includes(m.name))
  log.error(`  ✗  in-flight-moved: tagged, not shipped to ${to.join(' + ')}, committed to since, and the remote does not hold the tag: ${moved.join(', ')}`)
  if (asked.some(m => m.pushed === null))
    log.error(`      the remote could not say whether it holds: ${asked.filter(m => m.pushed === null).map(m => releaseTag(m.name, m.version)).join(', ')}`)
  log.error('      a tag only this clone holds was never public, and its commit is usually the one the pre-push hook refused')
  log.error('      fix: `git tag -d <name>@<version>` for each, then run again -- the version it spent is skipped and the next bump is cut from HEAD')
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

// An untagged bump on no host: the CI gate failed before the tag was written.
const retag = untaggedBumps(onHosts)
if (retag.length && pending.length) {
  log.error(`  ✗  a shipped-tag release (${pending.join(', ')}) and an untagged bump (${retag.join(', ')}) are both in flight`)
  log.error('      finish the tagged one first, narrowing the run with --filter, then run again')
  $.config.abort = true
  return
}

const resume = pending.length > 0
if (retag.length) {
  packages = packages.filter(({ pkg }) => retag.includes(pkg.name))
  log.info(`${retag.length} package(s) have a bumped version that was never tagged -- tagging it after CI, not bumping again`)
  log.info(`  '${arg.bump}' is ignored: ${retag.join(', ')} already hold the version`)
} else if (resume) {
  packages = packages.filter(({ pkg }) => pending.includes(pkg.name))
  // What each one still lacks, read by step 02 so a half-shipped version goes
  // only where it is missing.
  $.config.missing = Object.fromEntries(onHosts.filter(m => pending.includes(m.name)).map(m => [m.name, m.missing]))
  for (const m of onHosts) if (pending.includes(m.name)) log.info(`  ${m.name}@${m.version} is tagged and missing from ${m.missing.join(' + ')}`)
  log.info(`${pending.length} package(s) are versioned and tagged but not shipped everywhere — finishing that release, not bumping`)
  // The pack is of the tag's checkout (03), so commits since the tag are
  // not in the tarball. Said, because the working tree is not what ships.
  for (const m of onHosts) if (fromTag.includes(m.name)) log.info(`  ${m.name}@${m.version} has commits since its tag, which the remote holds -- shipping from the tag, not from HEAD`)
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
let planned = packages.map(p => ({ ...p, newVersion: resume || retag.length ? p.pkg.version : bumpVersion(p.pkg.version, arg.bump) }))

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
  prompts = createPrompts({ yes: flag.yes })
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
$.config.retag      = retag.length > 0
$.config.tag        = flag.tag
$.config.otp        = flag.otp
$.config.to         = to
$.config.released   = []
$.config.startTime  = Date.now()

// Steps are compiled without the namespace module, so the helpers travel here.
$.config.releaseTag     = releaseTag
$.config.packageHostUrl = packageHostUrl
$.config.releaseSubject = releaseSubject

// The pacing the later steps read. `prompts` is null on a --dry run, which is
// the one shape that must never ask a question.
$.config.interactive = flag.interactive
$.config.prompts     = prompts
```
