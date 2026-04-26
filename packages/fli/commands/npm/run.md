---
title: npm:run
description: Run an npm script from package.json
alias: nr
examples:
  - fli nr build
  - fli nr test
  - fli nr dev
  - fli nr -- build --watch
args:
  -
    name: script
    description: Script name to run
    required: true
    variadic: true
---

```js
const root = context.paths.root
context.exec({ command: `npm run ${arg.script} --prefix ${root}`, dry: flag.dry })
```
