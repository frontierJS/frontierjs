---
title: npm:outdated
description: Show outdated dependencies
alias: outdated
examples:
  - fli outdated
  - fli outdated --global
  - fli outdated --json
flags:
  global:
    char: g
    type: boolean
    description: Check global packages instead
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

```js
const parts = ['npm outdated']
if (flag.global) parts.push('--global')
if (flag.json)   parts.push('--json')
else             parts.push('--prefix', context.paths.root)
context.exec({ command: parts.join(' '), dry: flag.dry })
```
