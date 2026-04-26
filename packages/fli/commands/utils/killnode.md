---
title: utils:killnode
description: Kill all running Node processes
alias: kill
examples:
  - fli kill
  - fli killnode
  - fli kill --dry
---

```js
context.exec({ command: 'killall node', dry: flag.dry })
```
