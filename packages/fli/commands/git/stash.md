---
title: git:stash
description: Stash, pop, or list work in progress
alias: gstash
examples:
  - fli gstash
  - fli gstash --pop
  - fli gstash --list
  - fli gstash --message "WIP: auth work"
flags:
  pop:
    char: p
    type: boolean
    description: Pop the most recent stash
    defaultValue: false
  list:
    char: l
    type: boolean
    description: List all stashes
    defaultValue: false
  message:
    char: m
    type: string
    description: Stash message
    defaultValue: ''
---

```js
if (flag.list) { context.exec({ command: 'git stash list', dry: flag.dry }); return }
if (flag.pop)  { context.exec({ command: 'git stash pop',  dry: flag.dry }); return }
const msg = flag.message ? `save "${flag.message}"` : ''
context.exec({ command: `git stash ${msg}`.trim(), dry: flag.dry })
```
