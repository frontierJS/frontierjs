---
title: 01-fails
optional: true
---

```js
context.config.ran.push('01')
throw new Error('intentional failure')
```
