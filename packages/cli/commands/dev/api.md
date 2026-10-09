---
title: dev:api
description: Start the API dev server
alias: api-dev
examples:
  - fli dev:api
  - fli dev:api --test
flags:
  test:
    char: t
    type: boolean
    description: Run with NODE_ENV=test
    defaultValue: false
---

```js
const env = flag.test ? 'NODE_ENV=test ' : ''
$.exec({ command: `cd ${$.paths.api} && ${env}npm run dev`, dry: flag.dry })
```
