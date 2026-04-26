---
title: web:dev
description: Start the web app dev server
alias: web-dev
examples:
  - fli web:dev
  - fli web:dev --test
flags:
  test:
    char: t
    type: boolean
    description: Run with NODE_ENV=test
    defaultValue: false
---

```js
const env = flag.test ? 'NODE_ENV=test ' : ''
context.exec({ command: `${env}npm run dev --prefix=${context.paths.web}`, dry: flag.dry })
```
