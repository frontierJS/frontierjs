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
    description: Only bump packages matching this name
    defaultValue: ''
  affected:
    char: a
    type: boolean
    description: Only bump packages changed since their last git tag
    defaultValue: false
  no-commit:
    type: boolean
    description: Bump package.json files but skip the git commit and tag
    defaultValue: false
---

<script>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

const getPackages = (wsRoot) => {
  const pkgsDir = resolve(wsRoot, 'packages')
  if (!existsSync(pkgsDir)) return []
  return readdirSync(pkgsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const dir = resolve(pkgsDir, d.name)
      try {
        const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
        return { dir, pkg, folder: d.name }
      } catch { return null }
    }).filter(Boolean)
}

const bumpVersion = (version, bump) => {
  const [major, minor, patch] = version.replace(/[^0-9.]/g, '').split('.').map(Number)
  if (bump === 'major')      return `${major + 1}.0.0`
  if (bump === 'minor')      return `${major}.${minor + 1}.0`
  if (bump === 'prerelease') return `${major}.${minor}.${patch}-pre.${Date.now()}`
  return `${major}.${minor}.${patch + 1}`  // patch
}
</script>

Bumps `package.json` versions and creates a git commit + tag per package.
Does not publish — run `ws:pub` or `npm:publish` after reviewing the bump.
Use `--no-commit` to only write the version files without any git operations.

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
let packages = getPackages(wsRoot)

if (!packages.length) {
  log.error(`No packages found in ${wsRoot}/packages/`)
  return
}

if (flag.filter) {
  const filters = Array.isArray(flag.filter) ? flag.filter : [flag.filter]
  packages = packages.filter(({ pkg, folder }) =>
    filters.some(f => pkg.name.includes(f) || folder.includes(f))
  )
}

if (flag.affected) {
  const before = packages.length
  packages = packages.filter(({ dir }) => context.git.isAffected(dir))
  log.info(`--affected: ${packages.length} of ${before} package(s) have changes`)
  if (!packages.length) { log.info('Nothing to bump'); return }
}

// Preview
echo('')
for (const { pkg } of packages) {
  const next = bumpVersion(pkg.version, arg.bump)
  echo(`  ${pkg.name}  ${pkg.version}  →  ${next}`)
}
echo('')

if (flag.dry) return

for (const { dir, pkg } of packages) {
  const next = bumpVersion(pkg.version, arg.bump)
  const pkgPath = resolve(dir, 'package.json')
  const raw = JSON.parse(readFileSync(pkgPath, 'utf8'))
  raw.version = next
  writeFileSync(pkgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  log.success(`${pkg.name}  ${pkg.version} → ${next}`)

  if (!flag['no-commit']) {
    execSync(`git add package.json`, { cwd: dir })
    execSync(`git commit -m "chore(release): ${pkg.name}@${next}"`, { cwd: dir })
    execSync(`git tag ${pkg.name}@${next}`, { cwd: dir })
    log.info(`  tagged ${pkg.name}@${next}`)
  }
}

log.success(`Bumped ${packages.length} package(s) — run \`fli ws:pub\` to publish`)
```
