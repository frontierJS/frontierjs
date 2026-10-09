---
title: dev:web
description: Start the web app dev server
alias: web-dev
examples:
  - fli dev:web
  - fli dev:web --test
flags:
  test:
    char: t
    type: boolean
    description: Run with NODE_ENV=test
    defaultValue: false
---

```js
const env = flag.test ? 'NODE_ENV=test ' : ''
$.exec({ command: `${env}npm run dev --prefix=${$.paths.web}`, dry: flag.dry })
```
