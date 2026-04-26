---
title: npm:audit
description: Run a security audit on installed dependencies
alias: audit
examples:
  - fli audit
  - fli audit --fix
  - fli audit --production
flags:
  fix:
    type: boolean
    description: Automatically fix vulnerabilities where possible
    defaultValue: false
  production:
    type: boolean
    description: Only audit production dependencies
    defaultValue: false
  json:
    type: boolean
    description: Output as JSON
    defaultValue: false
---

```js
const parts = ['npm audit']
if (flag.fix)        parts.push('fix')
if (flag.production) parts.push('--only=prod')
if (flag.json)       parts.push('--json')
parts.push(`--prefix ${context.paths.root}`)
context.exec({ command: parts.join(' '), dry: flag.dry })
```
