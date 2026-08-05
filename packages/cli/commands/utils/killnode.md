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
context.exec({ command: 'killall bun', dry: flag.dry })
```
