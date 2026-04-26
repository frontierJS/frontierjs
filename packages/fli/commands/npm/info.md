---
title: npm:info
description: Show registry metadata for a package
alias: ninfo
examples:
  - fli ninfo lodash
  - fli ninfo my-package
  - fli ninfo my-package --versions
  - fli ninfo my-package --field dist-tags
args:
  -
    name: package
    description: Package name to look up
    required: true
flags:
  versions:
    char: v
    type: boolean
    description: List all published versions
    defaultValue: false
  field:
    char: f
    type: string
    description: Show a specific metadata field (e.g. dist-tags, keywords, license)
    defaultValue: ''
---

```js
const field = flag.versions ? 'versions' : flag.field || ''
const cmd   = `npm info ${arg.package} ${field}`.trim()
context.exec({ command: cmd, dry: flag.dry })
```
