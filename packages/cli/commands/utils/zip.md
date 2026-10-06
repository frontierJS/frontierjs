---
title: utils:zip
description: Run the project npm run zip script
alias: zip
examples:
  - fli zip
  - fli zip --dry
---

```js
$.exec({ command: `npm run zip --prefix ${$.paths.root}`, dry: flag.dry })
```
