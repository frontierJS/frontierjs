---
title: git:pull
description: Pull latest changes for the current branch
alias: gpl
examples:
  - fli gpl
  - fli gpl --rebase
flags:
  rebase:
    char: r
    type: boolean
    description: Pull with rebase instead of merge
    defaultValue: false
---

```js
const cmd = flag.rebase ? 'git pull --rebase' : 'git pull'
context.exec({ command: cmd, dry: flag.dry })
```
