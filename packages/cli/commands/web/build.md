---
title: web:build
description: Build the web app for production
alias: web-build
examples:
  - fli web:build
  - fli web:build --dry
---

```js
$.exec({
  command: `NODE_ENV=production npm run build --prefix ${$.paths.web}`,
  dry: flag.dry
})
```
