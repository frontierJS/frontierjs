---
title: 01-version-all
description: Write the new versions and commit them -- tagging waits for a green CI run
---

<script>
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'
</script>

```js
const { planned, repo, wsRoot, releaseTag, releaseSubject } = $.config
if (!planned?.length) { log.info('No packages to version'); return }

const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// A release in flight is already written, committed and tagged — the versions
// in the manifests ARE the release, and a second commit would tag nothing new.
// Each tag's own commit is the graded one: that run passed before the tag was
// written, so there is nothing to grade again and nothing at HEAD to push.
if ($.config.resume) {
  $.config.released = planned.map(({ dir, path, pkg, newVersion }) => ({ dir, path, name: pkg.name, newVersion }))
  $.config.graded   = planned.map(({ dir, pkg, newVersion }) => {
    const tag = releaseTag(pkg.name, newVersion)
    return { cwd: repo ?? dir, sha: git(repo ?? dir, `rev-parse ${JSON.stringify(`refs/tags/${tag}^{commit}`)}`), tags: [tag], graded: true }
  })
  log.info('  already versioned and tagged — publishing what is there')
  return
}

for (const { dir, pkg, newVersion } of planned) {
  log.info(`  ${pkg.name}: ${pkg.version} → ${newVersion}`)
  if (flag.dry) continue
  const pkgPath = resolve(dir, 'package.json')
  const raw = JSON.parse(readFileSync(pkgPath, 'utf8'))
  raw.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
}

// ─── the scaffold's pins ──────────────────────────────────────────────────────
//
// `fli new` installs the exact versions in the cli's `core/app-config.js`, so
// they are written HERE, to the set this run publishes, and ride in the release
// commit. Written after the release, a published cli names the release before
// it (`FJS-3356`). A cli outside this run would ship none of the new pins, so
// that is said rather than written.
const cliMember = ($.config.members ?? []).find(m => m.pkg?.name === '@frontierjs/cli')
const pinFile   = cliMember && resolve(cliMember.dir, 'core/app-config.js')
if (pinFile && existsSync(pinFile)) {
  const { writePins } = await import(new URL('file://' + global.fliRoot + '/core/publish-preflight.js'))
  const versions = new Map((($.config.members) ?? []).map(m => [m.pkg.name, m.pkg.version]))
  for (const { pkg, newVersion } of planned) versions.set(pkg.name, newVersion)
  const { text, moved } = writePins(readFileSync(pinFile, 'utf8'), versions)
  const pins = moved.map(m => `${m.name} ${m.from} → ${m.to}`).join(', ')
  const cliReleased = planned.some(p => p.pkg.name === '@frontierjs/cli')
  if (moved.length && !cliReleased)
    log.warn(`  @frontierjs/cli is not in this release, so its scaffold pins stay behind: ${pins}`)
  else if (moved.length && flag.dry)
    log.dry(`  Would raise ${moved.length} scaffold pin(s): ${pins}`)
  else if (moved.length) {
    writeFileSync(pinFile, text, 'utf8')
    execSync('git add core/app-config.js', { cwd: cliMember.dir })
    log.success(`  raised ${moved.length} scaffold pin(s) in core/app-config.js`)
  }
}

// A manifest whose version no longer matches the lock beside it fails
// `--frozen-lockfile` — in every image build, and in step 03's install of the
// release commit's checkout. Refreshed before the commit so the lock rides in it.
if (!flag.dry) {
  const lockRoot = repo || wsRoot
  try {
    execSync('bun install --lockfile-only', { cwd: lockRoot, stdio: 'inherit' })
  } catch (err) {
    throw new Error(`Could not refresh the lockfile in ${lockRoot} — the release commit would fail every frozen install: ${err.message}`)
  }
}

$.config.released = planned.map(({ dir, path, pkg, newVersion }) =>
  ({ dir, path, name: pkg.name, newVersion }))

if (flag.dry) {
  log.dry(`  Would commit ${planned.length} manifest(s); the tags wait for a green CI run`)
  const tags = $.config.released.map(({ name, newVersion }) => releaseTag(name, newVersion))
  $.config.graded = repo
    ? [{ cwd: repo, sha: git(repo, 'rev-parse HEAD'), tags }]
    : $.config.released.map(({ dir, name, newVersion }) => ({ cwd: dir, sha: git(dir, 'rev-parse HEAD'), tags: [releaseTag(name, newVersion)] }))
  return
}

// ─── the snapshots the bump just invalidated ──────────────────────────────────
//
// A version is a fact about the workspace, and committed snapshots state facts
// about the workspace — `exports.snapshot.md` carries the peer ranges naming a
// sibling, both atlas pages carry every package's version. A release commit
// that bumps and does not regenerate them is stale the moment it is written,
// and the `snapshots` phase runs in the pre-push hook: the push is refused
// AFTER the packages are on the registry, which is the one ordering this
// pipeline cannot recover from by re-running.
//
// Regenerated here because there is no moment between the bump and the commit
// that a person is standing in. Single-repo only — a multi-repo workspace
// commits per package, and a root snapshot belongs to none of them.
const { checkSnapshots } = await import(new URL('file://' + global.fliRoot + '/core/snapshots.js'))

if (repo) {
  const snapshotFiles = (cwd) =>
    execSync('git status --porcelain -- .', { cwd, encoding: 'utf8' })
      .split('\n').filter(Boolean).map(l => l.slice(3).trim())
      .filter(f => /\.snapshot\./.test(f))

  // Step 01's rule is that an unrelated edit in the working tree is not part of
  // this release, and a snapshot somebody is mid-way through regenerating for
  // their own reasons is exactly that — named and left alone rather than
  // absorbed into a commit about versions.
  const alreadyEdited = new Set(snapshotFiles(repo))

  const snaps = await checkSnapshots({ root: repo, write: true })
  if (snaps.failed) {
    const broken = snaps.results.filter(r => !r.ok).map(r => r.file).join(', ')
    throw new Error(`Could not regenerate ${snaps.failed} snapshot(s): ${broken} — nothing published`)
  }

  const moved = snapshotFiles(repo).filter(f => !alreadyEdited.has(f))
  for (const f of moved) execSync(`git add ${JSON.stringify(f)}`, { cwd: repo })

  if (moved.length)         log.success(`  regenerated ${moved.length} snapshot(s): ${moved.join(', ')}`)
  if (alreadyEdited.size)   log.warn(`  left alone, already edited: ${[...alreadyEdited].join(', ')}`)
}

const released = $.config.released

if (repo) {
  // One repo, one commit. Staging is per manifest — an unrelated edit sitting
  // in the working tree is not part of this release.
  for (const { path } of released) execSync(`git add ${path}/package.json`, { cwd: repo })
  execSync('git add --ignore-errors -- bun.lock', { cwd: repo })
  // An untagged bump is already committed: only what the snapshots regenerated
  // at HEAD needs a commit, and nothing staged means HEAD is the release commit.
  const nothing = $.config.retag && !git(repo, 'diff --cached --name-only')
  if (!nothing) execSync(`git commit -m ${JSON.stringify(releaseSubject(released))}`, { cwd: repo, stdio: 'inherit' })
  $.config.graded = [{ cwd: repo, sha: git(repo, 'rev-parse HEAD'), tags: released.map(({ name, newVersion }) => releaseTag(name, newVersion)) }]
} else {
  $.config.graded = []
  for (const { dir, name, newVersion } of released) {
    const tag = releaseTag(name, newVersion)
    execSync('git add package.json', { cwd: dir })
    if ($.config.retag && !git(dir, 'diff --cached --name-only')) { $.config.graded.push({ cwd: dir, sha: git(dir, 'rev-parse HEAD'), tags: [tag] }); continue }
    execSync(`git commit -m ${JSON.stringify(`chore(release): ${tag}`)}`, { cwd: dir })
    $.config.graded.push({ cwd: dir, sha: git(dir, 'rev-parse HEAD'), tags: [tag] })
  }
}
log.success(`  committed ${$.config.graded.length} release commit(s) -- tags wait for CI`)
```
