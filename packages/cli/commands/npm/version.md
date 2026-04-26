---
title: npm:version
description: Bump the package version (patch, minor, major, or explicit)
alias: version
examples:
  - fli version patch
  - fli version minor
  - fli version major
  - fli version 2.1.0
  - fli version prerelease --preid beta
  - fli version patch --no-git
  - fli version patch --dry
args:
  -
    name: bump
    description: "patch | minor | major | prepatch | preminor | premajor | prerelease | x.y.z"
    defaultValue: patch
flags:
  preid:
    type: string
    description: Prerelease identifier (e.g. alpha, beta, rc)
    defaultValue: ''
  no-git:
    type: boolean
    description: Skip git commit and tag
    defaultValue: false
---

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'

const getVersion = (root) => {
  try {
    return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  } catch { return 'unknown' }
}
</script>

Bump the version in `package.json` using `npm version`. By default also
creates a git commit and tag — pass `--no-git` to skip that.

```js
const root    = context.paths.root
const before  = getVersion(root)
const preid   = flag.preid ? `--preid=${flag.preid}` : ''
const gitFlag = flag['no-git'] ? '--no-git-tag-version' : ''
const cmd     = `npm version ${arg.bump} ${preid} ${gitFlag} --prefix ${root}`.trim().replace(/\s+/g, ' ')

log.info(`Current version: ${before}`)
log.info(`Bump: ${arg.bump}${flag.preid ? ` (${flag.preid})` : ''}`)

if (flag.dry) {
  log.dry(`Would run: ${cmd}`)
  return
}

context.exec({ command: cmd })
const after = getVersion(root)
log.success(`${before} → ${after}`)
if (!flag['no-git']) log.info('Git commit and tag created')
```
