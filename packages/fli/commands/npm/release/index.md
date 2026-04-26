---
title: npm:release
description: Full release pipeline — test, bump version, build, publish, git tag, push
alias: release
examples:
  - fli release patch
  - fli release minor
  - fli release major
  - fli release patch --tag beta
  - fli release minor --no-build
  - fli release patch --dry
args:
  -
    name: bump
    description: "Version bump: patch | minor | major | prepatch | preminor | premajor | prerelease"
    defaultValue: patch
flags:
  tag:
    char: t
    type: string
    description: npm dist-tag (default is latest)
    defaultValue: latest
  no-build:
    type: boolean
    description: Skip the build step
    defaultValue: false
  no-test:
    type: boolean
    description: Skip the test step
    defaultValue: false
  preid:
    type: string
    description: Prerelease identifier (e.g. beta, rc, alpha)
    defaultValue: ''
  otp:
    char: o
    type: string
    description: npm 2FA one-time password
    defaultValue: ''
---

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'
const getPkg = (root) => {
  try { return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) }
  catch { return {} }
}
</script>

Full release pipeline. Steps run in sequence:

1. **test** — runs `npm test` (skippable with `--no-test`)
2. **build** — runs `npm run build` if the script exists (skippable with `--no-build`)
3. **version** — bumps `package.json` and creates a git commit + tag
4. **publish** — publishes to npm with the specified tag
5. **push** — `git push` + `git push --tags`

```js
const root  = context.paths.root
const pkg   = getPkg(root)

if (!pkg.name || !pkg.version) {
  log.error('No valid package.json found')
  return
}

log.info(`Package:  ${pkg.name}@${pkg.version}`)
log.info(`Bump:     ${arg.bump}${flag.preid ? `-${flag.preid}` : ''}`)
log.info(`Tag:      ${flag.tag}`)

// Share state across steps
context.config.root    = root
context.config.pkg     = pkg
context.config.bump    = arg.bump
context.config.tag     = flag.tag
context.config.preid   = flag.preid
context.config.otp     = flag.otp
context.config.noBuild = flag['no-build']
context.config.noTest  = flag['no-test']
context.config.startTime = Date.now()
```
