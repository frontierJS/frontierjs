---
title: site:serve
description: Serve the built site from dist/client/
alias: serve
examples:
  - fli serve
  - fli site:serve --port 5000
flags:
  port:
    char: p
    type: number
    description: Port to serve on
    defaultValue: 3000
---

```js
const sitePath = `${context.paths.site}/dist/client/`
context.exec({ command: `npx serve ${sitePath} -p ${flag.port}`, dry: flag.dry })
```
