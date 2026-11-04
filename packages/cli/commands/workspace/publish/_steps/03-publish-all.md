---
title: 03-publish-all
description: Pack each package once and ship that tarball to each destination the run names
---

<script>
import { execSync } from 'child_process'
import { join }     from 'path'

// The commit each package ships from, grouped so one checkout serves every
// package tagged on it. The tag, not HEAD: a commit landing after the tag is not
// in the release. A --dry run has written no tag, so it packs HEAD.
function releaseCommits(released, releaseTag, dry) {
  const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const commits = new Map()
  for (const entry of released) {
    const repo = git(entry.dir, 'rev-parse --show-toplevel')
    const tag  = releaseTag(entry.name, entry.newVersion)
    let sha = ''
    try { sha = git(repo, `rev-parse --verify --quiet ${JSON.stringify(`refs/tags/${tag}^{commit}`)}`) } catch {}
    if (!sha && !dry) throw new Error(`${tag} is not tagged, so there is no commit to pack it from — nothing published`)
    sha ||= git(repo, 'rev-parse HEAD')
    const key = `${repo}\0${sha}`
    if (!commits.has(key)) commits.set(key, { repo, sha, entries: [] })
    commits.get(key).entries.push(entry)
  }
  return [...commits.values()]
}
</script>

```js
const { released, tag, otp, to, missing, interactive, prompts, repo, releaseTag, releaseSubject } = $.config
if (!released?.length) { log.info('Nothing to publish'); return }

const { packAtCommit } = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
const { fliTmpRoot }   = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))

// One pack per package, kept for the run: the registry copy and every other
// destination are this file, so they agree by construction. Packed from a
// checkout of the tagged commit, so the file holds what the tag holds whatever
// lands in the working tree meanwhile. Packed before the first prompt, so a
// package that does not pack is named before any 2FA round trip. Under fli's
// own tmp root: a dry run must leave no file behind.
const packDir = join(fliTmpRoot(global.fliRoot), 'publish', String($.config.startTime))
for (const commit of releaseCommits(released, releaseTag, flag.dry)) {
  for (const { name, file, path } of packAtCommit({ ...commit, destination: packDir, scratch: packDir })) {
    released.find(e => e.name === name).tarball = path
    echo`  {dim packed} ${file} {dim at ${commit.sha.slice(0, 12)}${flag.dry ? ', HEAD — the bump is not written on --dry' : ''}}`
  }
}

// A release in flight goes only where it is missing; a fresh one goes everywhere
// the run names.
const shipsFor = (name) => missing?.[name] ?? to
const anyNpm   = released.some(({ name }) => shipsFor(name).includes('npm'))

const ghCwd = repo ?? released[0].dir
const notes = releaseSubject(released)

const published = []
const uploaded  = []
const failures  = []
const skipped   = []
let lapsed      = false

const label = (ships) => ships.map(d => d === 'npm' ? `npm (tag ${tag})` : 'GitHub Release').join(' + ')

for (const { name, dir, newVersion, tarball } of released) {
  const ships      = shipsFor(name)
  const toNpm      = ships.includes('npm')
  const toTarballs = ships.includes('tarballs')

  // npm's browser 2FA is per-publish, so a loop that does not stop opens an OTP
  // prompt for a package nobody is looking at — and the version is already
  // committed by now, so *not this one, not today* has to be answerable without
  // abandoning the run. The FIRST one always stops, which is where a person
  // gets their authenticator up; `--interactive` keeps stopping after that.
  // The first stop needs a terminal: `prompt.js` buffers a piped stdin to
  // `end`, so asking where nobody is typing hangs with no output. The flag
  // does not, because passing it IS somebody saying they are here.
  const first = !published.length && !failures.length && !skipped.length
  if ((interactive || (first && tty.interactive)) && !flag.dry) {
    echo('')
    if (first) log.info(`  ${released.length} publish(es) from here${anyNpm ? ', each npm one with its own 2FA prompt' : ''}.`)
    log.info(`  Ready: ${name}@${newVersion}  →  ${label(ships)}`)
    if (!await prompts.confirm('  Publish it?', { default: true })) {
      // A skip is NOT a failure: the version and tag are already written, so
      // the next `ws:pub` finds it in flight and publishes it.
      skipped.push(`${name}@${newVersion}`)
      log.warn(`  · skipped ${name}@${newVersion}`)
      continue
    }
  }

  // The tarball, not the directory: `bun publish <tgz>` ships the file packed
  // above, which is the one the release gets too.
  const parts = ['bun publish', JSON.stringify(tarball)]
  if (tag !== 'latest') parts.push(`--tag ${tag}`)
  if (otp) parts.push(`--otp ${otp}`)

  // One release per package tag, the asset named as `vendor.js` packs it, which
  // is the name the package host's redirect spells (`FJS-D1568`). No
  // `--clobber`: GitHub refuses a second asset under the same name, so a tag
  // already released is refused here the way a spent version is on npm.
  // `--verify-tag`, never `--target`: step 02 pushed the tag, and a tag GitHub
  // lacks would otherwise be written at the default branch's head.
  const tagName = releaseTag(name, newVersion)
  const release = ['gh release create', JSON.stringify(tagName), JSON.stringify(tarball),
                   '--latest=false', '--verify-tag', '--title', JSON.stringify(tagName), '--notes', JSON.stringify(notes)]

  log.info(`  Publishing ${name}@${newVersion}...`)

  if (flag.dry) {
    if (toNpm)      log.dry(`  Would run in ${dir}: ${parts.join(' ')}`)
    if (toTarballs) log.dry(`  Would run in ${ghCwd}: ${release.join(' ')}`)
    continue
  }

  if (toNpm) {
    try {
      execSync(parts.join(' '), { cwd: dir, stdio: 'inherit' })
      published.push(`${name}@${newVersion}`)
      log.done(`  ✓ ${name}@${newVersion} → npm`)
    } catch (err) {
      failures.push(name)
      log.error(`  ✗ ${name}: ${err.message}`)
      // A lapsed session fails every package after this one too, so collecting
      // them buries the one cause under twenty copies. npm is asked rather than
      // bun's output read: the 2FA prompt needs bun's streams on the terminal.
      let who = ''
      try { who = String(execSync('npm whoami', { stdio: ['ignore', 'pipe', 'ignore'] })).trim() } catch {}
      if (!who) { lapsed = true; break }
      // The release is not made for a version npm does not hold: the next run
      // finds both missing and ships both.
      continue
    }
  }

  if (toTarballs) {
    try {
      execSync(release.join(' '), { cwd: ghCwd, stdio: 'inherit' })
      uploaded.push(`${name}@${newVersion}`)
      log.done(`  ✓ ${name}@${newVersion} → release ${tagName}`)
    } catch (err) {
      failures.push(name)
      log.error(`  ✗ ${name}: release ${tagName} not created: ${err.message}`)
      // Whatever reached npm stays there; the next run asks each destination
      // and ships only this one.
    }
  }
}

$.config.published = published
$.config.uploaded  = uploaded

if (skipped.length) {
  log.warn(`  ${skipped.length} skipped: ${skipped.join(', ')}`)
  log.warn('  Each is versioned and tagged locally; `fli ws:pub` again publishes them')
}

if (failures.length) {
  // Re-running finishes the release: `ws:pub` asks each destination which
  // tagged versions it lacks and ships those, without a second bump.
  if (published.length) log.warn(`  ${published.length} package(s) DID publish to npm: ${published.join(', ')}`)
  if (uploaded.length)  log.warn(`  ${uploaded.length} release(s) DID upload: ${uploaded.join(', ')}`)
  if (lapsed) {
    const left = released.length - published.length - skipped.length
    log.error(`  npm auth lapsed — stopped with ${left} package(s) unpublished`)
    log.error('  Run `fli ws:pub` again: it logs in and finishes this release')
  } else {
    log.warn('  Fix the failure and run `fli ws:pub` again: it finishes this release rather than bumping')
  }
  throw new Error(lapsed ? 'npm auth lapsed' : `${failures.length} package(s) failed to publish: ${failures.join(', ')}`)
}

prompts?.close()
if (!flag.dry) log.done(`Published ${released.length} package(s) in ${((Date.now() - $.config.startTime) / 1000).toFixed(1)}s`)
```
