---
title: dev:widgets
description: Start the widget surface's dev server
alias: widgets-dev
examples:
  - fli dev:widgets
  - fli dev:widgets --port 8200
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

<script>
import { resolve } from 'path'
</script>

```js
const port = flag.port ? `WIDGET_PORT=${flag.port} ` : ''
const { viteCommand } = await import(resolve(global.fliRoot, 'core/scaffold/surface.js'))
$.exec({
  command: `${port}${viteCommand()}`,
  cwd:     $.paths.widgets,
  dry:     flag.dry,
})
```
