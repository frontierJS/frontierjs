---
title: npm:whoami
description: Show the currently logged-in npm user
alias: whoami
examples:
  - fli whoami
  - fli whoami --registry https://registry.npmjs.org
flags:
  registry:
    char: r
    type: string
    description: Check against a specific registry
    defaultValue: ''
---

```js
const parts = ['npm whoami']
if (flag.registry) parts.push(`--registry ${flag.registry}`)
context.exec({ command: parts.join(' '), dry: flag.dry })
```
