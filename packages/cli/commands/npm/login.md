---
title: npm:login
description: Log in to an npm registry
alias: npm-login
examples:
  - fli npm-login
  - fli npm-login --registry https://registry.npmjs.org
  - fli npm-login --scope @mycompany
flags:
  registry:
    char: r
    type: string
    description: Registry URL to log in to
    defaultValue: ''
  scope:
    char: s
    type: string
    description: Scope to associate with the registry (e.g. @myorg)
    defaultValue: ''
---

```js
const parts = ['npm login']
if (flag.registry) parts.push(`--registry ${flag.registry}`)
if (flag.scope)    parts.push(`--scope ${flag.scope}`)
context.exec({ command: parts.join(' '), dry: flag.dry })
```
