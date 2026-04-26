---
title: npm:tag
description: Add, remove, or list npm dist-tags
alias: tag
examples:
  - fli tag my-package@1.2.0 latest
  - fli tag my-package@2.0.0-beta.1 next
  - fli tag my-package --list
  - fli tag my-package latest --remove
  - fli tag --dry
args:
  -
    name: package
    description: Package name (or name@version to set a tag)
    required: true
  -
    name: tag
    description: Tag name to add
flags:
  remove:
    char: r
    type: boolean
    description: Remove the specified tag instead of adding it
    defaultValue: false
  list:
    char: l
    type: boolean
    description: List all dist-tags for the package
    defaultValue: false
---

```js
if (flag.list) {
  context.exec({ command: `npm dist-tag ls ${arg.package}`, dry: flag.dry })
  return
}

if (flag.remove) {
  if (!arg.tag) { log.error('Specify a tag name to remove'); return }
  log.info(`Removing tag "${arg.tag}" from ${arg.package}`)
  context.exec({ command: `npm dist-tag rm ${arg.package} ${arg.tag}`, dry: flag.dry })
  return
}

if (!arg.tag) { log.error('Specify a tag — e.g. fli tag my-pkg@1.0.0 latest'); return }
if (!arg.package.includes('@')) { log.error('Include a version — e.g. my-pkg@1.0.0'); return }

log.info(`Setting ${arg.package} → ${arg.tag}`)
context.exec({ command: `npm dist-tag add ${arg.package} ${arg.tag}`, dry: flag.dry })
if (!flag.dry) log.success(`Tagged ${arg.package} as ${arg.tag}`)
```
