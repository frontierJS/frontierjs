---
title: workspace:version
description: Bump versions across workspace packages without publishing
alias: ws:version
examples:
  - fli ws:version patch
  - fli ws:version minor --affected
  - fli ws:version major --filter fli
  - fli ws:version patch --dry
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
    description: Only bump packages matching this name
    defaultValue: ''
  affected:
    char: a
    type: boolean
    description: Only bump packages changed since their own release tag
    defaultValue: false
  private:
    type: boolean
    description: Include packages marked private in package.json
    defaultValue: false
  no-commit:
    type: boolean
    description: Bump package.json files but skip the git commit and tag
    defaultValue: false
---

<script>
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'
</script>

Bumps `package.json` versions and tags each released package `<name>@<version>`.
Does not publish — run `ws:pub` or `npm:publish` after reviewing the bump.
In a single-repo monorepo the whole bump is ONE commit; in a multi-repo
workspace each package is committed in its own repo.
Use `--no-commit` to only write the version files.

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

// A private package never reaches a registry, so bumping it only adds a tag
// nothing will ever resolve. Opt back in with --private.
if (!flag.private) {
  const skipped = packages.filter(({ pkg }) => pkg.private)
  packages = packages.filter(({ pkg }) => !pkg.private)
  for (const { pkg } of skipped) log.info(`  skipping ${pkg.name} (private)`)
}

if (flag.affected) {
  const before = packages.length
  packages = packages.filter(({ dir, pkg }) => context.git.pkgState(pkg.name, dir).affected)
  log.info(`--affected: ${packages.length} of ${before} package(s) have changes since their own tag`)
}

if (!packages.length) { log.info('Nothing to bump'); return }

const planned = packages.map(p => ({ ...p, newVersion: bumpVersion(p.pkg.version, arg.bump) }))

echo('')
for (const { pkg, newVersion } of planned) {
  echo(`  ${pkg.name}  ${pkg.version}  →  ${newVersion}`)
}
echo('')

if (flag.dry) return

for (const { dir, pkg, newVersion } of planned) {
  const pkgPath = resolve(dir, 'package.json')
  const raw = JSON.parse(readFileSync(pkgPath, 'utf8'))
  raw.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  log.success(`${pkg.name}  ${pkg.version} → ${newVersion}`)
}

if (flag['no-commit']) {
  log.success(`Bumped ${planned.length} package(s) — nothing committed`)
  return
}

const repo     = context.wsRepo(all)
const released = planned.map(({ pkg, newVersion }) => ({ name: pkg.name, newVersion }))

if (repo) {
  // One repo, one commit. Stage only the manifests this run wrote — an
  // unrelated edit sitting in the tree is not part of the release.
  for (const { path } of planned) execSync(`git add ${path}/package.json`, { cwd: repo })
  execSync(`git commit -m ${JSON.stringify(releaseSubject(released))}`, { cwd: repo, stdio: 'inherit' })
  for (const { name, newVersion } of released) {
    execSync(`git tag ${releaseTag(name, newVersion)}`, { cwd: repo })
    log.info(`  tagged ${releaseTag(name, newVersion)}`)
  }
} else {
  for (const { dir, pkg, newVersion } of planned) {
    const tag = releaseTag(pkg.name, newVersion)
    execSync('git add package.json', { cwd: dir })
    execSync(`git commit -m ${JSON.stringify(`chore(release): ${tag}`)}`, { cwd: dir })
    execSync(`git tag ${tag}`, { cwd: dir })
    log.info(`  tagged ${tag}`)
  }
}

log.success(`Bumped ${planned.length} package(s) — run \`fli ws:pub\` to publish`)
```
