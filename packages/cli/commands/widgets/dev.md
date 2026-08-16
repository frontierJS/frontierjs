---
title: widgets:dev
description: Start the widget surface's dev server
alias: widgets-dev
examples:
  - fli widgets:dev
  - fli widgets:dev --port 8200
flags:
  port:
    char: p
    type: string
    description: Override the dev port (8200 = dev / widgetDev / project 0)
    defaultValue: ''
---

`widgets/index.html` is the harness a widget is written against. What PROVES one
is a host page in `widgets/test/` loading the built script — this server is the
writing loop, not the proof.

```js
const port = flag.port ? `WIDGET_PORT=${flag.port} ` : ''
context.exec({
  command: `${port}bunx vite -c config/vite.config.js`,
  cwd:     context.paths.widgets,
  dry:     flag.dry,
})
```
