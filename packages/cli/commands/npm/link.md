---
title: npm:link
description: Link a local package for development or link a dependency to a local package
alias: npm-link
examples:
  - fli npm-link
  - fli npm-link my-local-package
  - fli npm-link --unlink my-local-package
  - fli npm-link --dry
args:
  -
    name: package
    description: Package name to link (omit to link the current package globally)
    defaultValue: ''
flags:
  unlink:
    char: u
    type: boolean
    description: Unlink instead of link
    defaultValue: false
---

```js
const root = context.paths.root

if (flag.unlink) {
  const cmd = arg.package
    ? `npm unlink ${arg.package} --prefix ${root}`
    : `npm unlink --prefix ${root}`
  log.info(`Unlinking ${arg.package || 'current package'}`)
  context.exec({ command: cmd, dry: flag.dry })
  return
}

const cmd = arg.package
  ? `npm link ${arg.package} --prefix ${root}`
  : `npm link --prefix ${root}`

log.info(arg.package ? `Linking ${arg.package} into current project` : 'Linking current package globally')
context.exec({ command: cmd, dry: flag.dry })
if (!flag.dry) log.success('Linked')
```
