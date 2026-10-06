---
title: 01-test
description: Run the test suite
skip: "$.config.noTest"
optional: false
---

```js
log.info('Running tests...')
$.exec({ command: `npm test --prefix ${$.config.root}`, dry: flag.dry })
log.success('Tests passed')
```
