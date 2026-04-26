---
title: git:push
description: Push current branch to origin
alias: gp
examples:
  - fli gp
  - fli gp --tags
  - fli gp --force
  - fli gp --dry
flags:
  tags:
    char: t
    type: boolean
    description: Push tags as well
    defaultValue: false
  force:
    char: f
    type: boolean
    description: Force push (use with care)
    defaultValue: false
  set-upstream:
    char: u
    type: boolean
    description: Set upstream tracking branch
    defaultValue: false
---


```js
const branch = context.git.branch()
const parts  = ['git push']
if (flag['set-upstream']) parts.push(`--set-upstream origin ${branch}`)
if (flag.force)           parts.push('--force')

log.info(`Pushing ${branch}...`)
context.exec({ command: parts.join(' '), dry: flag.dry })
if (flag.tags) context.exec({ command: 'git push --tags', dry: flag.dry })
```
