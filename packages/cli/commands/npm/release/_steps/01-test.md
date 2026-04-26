---
title: 01-test
description: Run the test suite
skip: "context.config.noTest"
optional: false
---

```js
log.info('Running tests...')
context.exec({ command: `npm test --prefix ${context.config.root}`, dry: flag.dry })
log.success('Tests passed')
```
