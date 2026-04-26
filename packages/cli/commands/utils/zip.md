---
title: utils:zip
description: Run the project npm run zip script
alias: zip
examples:
  - fli zip
  - fli zip --dry
---

```js
context.exec({ command: `npm run zip --prefix ${context.paths.root}`, dry: flag.dry })
```
