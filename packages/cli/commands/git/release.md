---
title: git:release
description: Create a git tag, generate changelog, and push to remote
alias: gr
examples:
  - fli gr
  - fli gr v1.2.0
  - fli gr --no-changelog
  - fli gr --dry
args:
  -
    name: tag
    description: Tag name (e.g. v1.2.0) — defaults to version in package.json
    defaultValue: ''
flags:
  no-changelog:
    type: boolean
    description: Skip changelog generation
    defaultValue: false
  no-push:
    type: boolean
    description: Create tag locally without pushing
    defaultValue: false
  message:
    char: m
    type: string
    description: Tag annotation message
    defaultValue: ''
---

<script>
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

const getPkgVersion = (root) => {
  try { return 'v' + JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version }
  catch { return null }
}

const tagExists = (tag, cwd) => {
  try { execSync(`git rev-parse ${tag}`, { cwd, stdio: 'ignore' }); return true }
  catch { return false }
}
</script>

```js
const root    = context.paths.root
const tagName = arg.tag || getPkgVersion(root)

if (!tagName) {
  log.error('No tag specified and no package.json version found')
  return
}

if (tagExists(tagName, root)) {
  log.error(`Tag ${tagName} already exists`)
  return
}

const message = flag.message || tagName
log.info(`Creating release: ${tagName}`)

// ─── Changelog ───────────────────────────────────────────────────────────────
if (!flag['no-changelog']) {
  if (flag.dry) {
    log.dry('Would run: git:changelog')
  } else {
    try {
      execSync(`node ${global.fliRoot}/bin/fli.js changelog --output CHANGELOG.md`, {
        cwd: root, stdio: 'inherit'
      })
    } catch (err) {
      log.warn(`Changelog generation failed: ${err.message} — continuing`)
    }
  }
}

// ─── Git tag ─────────────────────────────────────────────────────────────────
const tagCmd = `git tag -a ${tagName} -m "${message}"`
log.info(`Tagging: ${tagCmd}`)

if (flag.dry) {
  log.dry(`Would run: ${tagCmd}`)
  if (!flag['no-push']) log.dry(`Would run: git push && git push --tags`)
  return
}

execSync(tagCmd, { cwd: root, stdio: 'inherit' })
log.success(`Created tag ${tagName}`)

// ─── Push ────────────────────────────────────────────────────────────────────
if (!flag['no-push']) {
  execSync('git push', { cwd: root, stdio: 'inherit' })
  execSync('git push --tags', { cwd: root, stdio: 'inherit' })
  log.success(`Pushed ${tagName} to remote`)
}
```
