---
title: utils:check-deps
description: Check for outdated npm dependencies (npm-check-updates)
alias: check-deps
examples:
  - fli check-deps
  - fli check-deps --update
flags:
  update:
    char: u
    type: boolean
    description: Update package.json with latest versions
    defaultValue: false
---

```js
const cmd = `npx --yes npm-check-updates${flag.update ? ' -u' : ''}`
context.exec({ command: cmd, dry: flag.dry })
```
