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
args:
  -
    name: bump
    description: "Version bump: patch | minor | major | prerelease"
    defaultValue: patch
flags:
  filter:
    char: f
    type: string
    description: Only publish packages matching this name
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
  changed-only:
    type: boolean
    description: Only publish packages with uncommitted git changes
    defaultValue: false
  affected:
    char: a
    type: boolean
    description: Only publish packages changed since their last git tag
    defaultValue: false
---

<script>
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
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

// git helpers available via context.git
</script>

Bump versions and publish selected workspace packages in sequence.
Each package gets its own git commit and tag.

```js
const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace path provided'); return }
let packages = getPackages(wsRoot)

if (!packages.length) {
  log.error(`No packages found in ${wsRoot}/packages/`)
  return
}

// Filter
if (flag.filter) {
  const filters = Array.isArray(flag.filter) ? flag.filter : [flag.filter]
  packages = packages.filter(({ pkg, folder }) =>
    filters.some(f => pkg.name.includes(f) || folder.includes(f))
  )
}

// Changed only (uncommitted)
if (flag['changed-only']) {
  packages = packages.filter(({ dir }) => context.git.isDirty(dir))
  if (!packages.length) {
    log.info('No packages with uncommitted changes — nothing to publish')
    return
  }
}

// Affected (changes since last git tag — the publish-ready check)
if (flag.affected) {
  const before = packages.length
  packages = packages.filter(({ dir }) => context.git.isAffected(dir))
  log.info(`--affected: ${packages.length} of ${before} package(s) have changes since last tag`)
  if (!packages.length) {
    log.info('All packages are up to date — nothing to publish')
    return
  }
}

log.info(`Publishing ${packages.length} package(s)`)
log.info(`Bump:   ${arg.bump}`)
log.info(`Tag:    ${flag.tag}`)
echo('')
for (const { pkg } of packages) log.info(`  ${pkg.name}@${pkg.version}`)
echo('')

context.config.wsRoot   = wsRoot
context.config.packages = packages
context.config.bump     = arg.bump
context.config.tag      = flag.tag
context.config.otp      = flag.otp
context.config.results  = []
context.config.startTime = Date.now()
```
