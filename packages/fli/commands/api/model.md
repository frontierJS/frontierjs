---
title: api:model
description: Append a model to schema.lite — alias for make:model
examples:
  - fli api:model Client
  - fli api:model Invoice --open
args:
  -
    name: model
    description: Model name (PascalCase)
    required: true
flags:
  open:
    char: o
    type: boolean
    description: Open schema.lite in editor after appending
    defaultValue: false
---

```js
context.exec({
  command: `fli make:model ${arg.model}${flag.open ? ' --open' : ''}${flag.dry ? ' --dry' : ''}`
})
```
