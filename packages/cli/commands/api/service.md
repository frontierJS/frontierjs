---
title: api:service
description: Scaffold a Junction service file — alias for make:service
examples:
  - fli api:service Lead
  - fli api:service Invoice --open
args:
  -
    name: model
    description: Model name (PascalCase)
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open the created file in editor
    defaultValue: false
---

```js
context.exec({
  command: `fli make:service ${arg.model}${flag.open ? ' --open' : ''}${flag.dry ? ' --dry' : ''}`
})
```
