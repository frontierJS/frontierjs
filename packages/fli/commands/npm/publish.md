---
title: npm:publish
description: Publish the package to npm
alias: pub
examples:
  - fli pub
  - fli pub --tag beta
  - fli pub --tag next --otp 123456
  - fli pub --access public
  - fli pub --dry
flags:
  tag:
    char: t
    type: string
    description: Dist-tag to publish under (default is latest)
    defaultValue: latest
  otp:
    char: o
    type: string
    description: One-time password for 2FA-protected accounts
    defaultValue: ''
  access:
    char: a
    type: string
    description: "Package access: public or restricted"
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

```js
const root = context.paths.root
const pkg  = getPkg(root)

if (!pkg.name || !pkg.version) {
  log.error('No package.json found or missing name/version')
  return
}

const parts = [`npm publish --prefix ${root}`]
if (flag.tag && flag.tag !== 'latest') parts.push(`--tag ${flag.tag}`)
if (flag.otp)    parts.push(`--otp ${flag.otp}`)
if (flag.access) parts.push(`--access ${flag.access}`)

const cmd = parts.join(' ')

log.info(`Package: ${pkg.name}@${pkg.version}`)
log.info(`Tag:     ${flag.tag}`)
if (flag.access) log.info(`Access:  ${flag.access}`)

if (flag.dry) {
  log.dry(`Would run: ${cmd}`)
  return
}

context.exec({ command: cmd })
log.success(`Published ${pkg.name}@${pkg.version} → ${flag.tag}`)
```
