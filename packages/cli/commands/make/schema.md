---
title: make:schema
description: Alias for make:model — append a model block to schema.lite
alias: mkschema
examples:
  - fli mkschema Car
  - fli mkschema Invoice --service
args:
  -
    name: model
    description: Model name (PascalCase)
    required: true
flags:
  service:
    char: s
    type: boolean
    description: Also scaffold the Junction service file
    defaultValue: false
  open:
    char: o
    type: boolean
    description: Open created files in editor after scaffolding
    defaultValue: false
---

```js
// Delegates to make:model — same thing in FJS
log.info(`Delegating to make:model ${arg.model}...`)
context.exec({
  command: `${context.fli} make:model ${arg.model}${flag.service ? ' --service' : ''}${flag.open ? ' --open' : ''}${flag.dry ? ' --dry' : ''}`
})
```
