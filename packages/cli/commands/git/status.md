---
title: git:status
description: Show a clean git status summary
alias: gs
examples:
  - fli gs
  - fli git:status --short
flags:
  short:
    char: s
    type: boolean
    description: One-line format
    defaultValue: false
---

```js
const cmd = flag.short ? 'git status -s' : 'git status'
context.exec({ command: cmd, dry: flag.dry })
```
