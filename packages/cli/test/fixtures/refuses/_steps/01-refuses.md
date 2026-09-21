---
title: 01-refuses
---

```js
context.config.ran.push('01')
log.error('Env check: 1 key(s) missing')
// A refusal: the flag and a return, no throw. This is the shape seven of the
// deploy pipeline's nine refusal sites use (`FJS-589`).
context.config.abort = true
```
