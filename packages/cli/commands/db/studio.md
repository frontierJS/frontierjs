---
title: db:studio
description: Open Litestone Studio in the browser
alias: studio
examples:
  - fli studio
  - fli studio --port 8502
flags:
  port:
    char: p
    type: number
    description: Port to run Studio on
    defaultValue: 8502
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

log.info(`Starting Litestone Studio on http://localhost:${flag.port}`)
await context.stream({
  command: `${litestone(context)} studio --schema ${schema} --port ${flag.port}`
})
```
