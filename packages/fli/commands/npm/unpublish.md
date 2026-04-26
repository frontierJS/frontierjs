---
title: npm:unpublish
description: Unpublish a specific version from npm (use with care)
alias: unpub
examples:
  - fli unpub my-package@1.0.0
  - fli unpub my-package@1.0.0 --dry
args:
  -
    name: package
    description: Package and version to unpublish (name@version)
    required: true
flags:
  force:
    char: f
    type: boolean
    description: Skip confirmation check
    defaultValue: false
---

```js
if (!arg.package.includes('@') || arg.package.startsWith('@') && arg.package.split('@').length < 3) {
  log.error('Specify the full package@version — e.g. my-package@1.2.3')
  log.warn('npm unpublish is permanent and limited to 72 hours after publish')
  return
}

log.warn(`You are about to unpublish: ${arg.package}`)
log.warn('This is irreversible and only works within 72 hours of publishing')

if (flag.dry) {
  log.dry(`Would run: npm unpublish ${arg.package} --force`)
  return
}

if (!flag.force) {
  const confirm = await question(`Type the package name to confirm (${arg.package.split('@')[0]}): `)
  if (confirm.trim() !== arg.package.split('@')[0]) {
    log.error('Confirmation did not match — aborting')
    return
  }
}

context.exec({ command: `npm unpublish ${arg.package} --force` })
log.success(`Unpublished ${arg.package}`)
```
