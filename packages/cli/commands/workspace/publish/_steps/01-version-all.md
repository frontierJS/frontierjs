---
title: 01-version-all
description: Write the new versions, then commit and tag them
---

<script>
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'
</script>

```js
const { planned, repo, wsRoot, releaseTag, releaseSubject } = context.config
if (!planned?.length) { log.info('No packages to version'); return }

for (const { dir, pkg, newVersion } of planned) {
  log.info(`  ${pkg.name}: ${pkg.version} → ${newVersion}`)
  if (flag.dry) continue
  const pkgPath = resolve(dir, 'package.json')
  const raw = JSON.parse(readFileSync(pkgPath, 'utf8'))
  raw.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
}

// bun rewrites a `workspace:*` dependency from the LOCKFILE, not from the
// sibling's manifest — so a lockfile still holding the pre-bump versions pins
// every dependent to a version this run just bumped away and will never
// publish. Refresh it here, before step 02 packs anything.
if (!flag.dry) {
  const lockRoot = repo || wsRoot
  try {
    execSync('bun install --lockfile-only', { cwd: lockRoot, stdio: 'inherit' })
  } catch (err) {
    throw new Error(`Could not refresh the lockfile in ${lockRoot} — publishing now would pin siblings to unpublished versions: ${err.message}`)
  }
}

context.config.released = planned.map(({ dir, path, pkg, newVersion }) =>
  ({ dir, path, name: pkg.name, newVersion }))

if (flag.dry) {
  log.dry(`  Would commit ${planned.length} manifest(s) and tag each package`)
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

  const snaps = checkSnapshots({ root: repo, write: true })
  if (snaps.failed) {
    const broken = snaps.results.filter(r => !r.ok).map(r => r.file).join(', ')
    throw new Error(`Could not regenerate ${snaps.failed} snapshot(s): ${broken} — nothing published`)
  }

  const moved = snapshotFiles(repo).filter(f => !alreadyEdited.has(f))
  for (const f of moved) execSync(`git add ${JSON.stringify(f)}`, { cwd: repo })

  if (moved.length)         log.success(`  regenerated ${moved.length} snapshot(s): ${moved.join(', ')}`)
  if (alreadyEdited.size)   log.warn(`  left alone, already edited: ${[...alreadyEdited].join(', ')}`)
}

const released = context.config.released

if (repo) {
  // One repo, one commit. Staging is per manifest — an unrelated edit sitting
  // in the working tree is not part of this release.
  for (const { path } of released) execSync(`git add ${path}/package.json`, { cwd: repo })
  // The refreshed lockfile belongs to the release: a manifest whose version no
  // longer matches the lock beside it fails `--frozen-lockfile` in every image
  // build.
  execSync('git add --ignore-errors -- bun.lock', { cwd: repo })
  execSync(`git commit -m ${JSON.stringify(releaseSubject(released))}`, { cwd: repo, stdio: 'inherit' })
  for (const { name, newVersion } of released) {
    execSync(`git tag ${releaseTag(name, newVersion)}`, { cwd: repo })
    log.success(`  tagged ${releaseTag(name, newVersion)}`)
  }
} else {
  for (const { dir, name, newVersion } of released) {
    const tag = releaseTag(name, newVersion)
    execSync('git add package.json', { cwd: dir })
    execSync(`git commit -m ${JSON.stringify(`chore(release): ${tag}`)}`, { cwd: dir })
    execSync(`git tag ${tag}`, { cwd: dir })
    log.success(`  tagged ${tag}`)
  }
}
```
