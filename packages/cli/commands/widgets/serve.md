---
title: widgets:serve
description: Build the widgets and serve them as the origin a host page links to
alias: widgets-serve
examples:
  - fli widgets:serve
  - fli widgets:serve --port 8300
flags:
  port:
    char: p
    type: string
    description: Port to serve on (8300 = dev / widgetServe / project 0)
    defaultValue: '8300'
---

The same static server `widgets/deploy/` runs: `Access-Control-Allow-Origin`,
because the host page is on another origin by definition, and a cache answer per
file kind, because the entry's URL was pasted into somebody's CMS and cannot
change. Local and deployed answer alike, which is the only way a header is
tested at all.

```js
context.exec({
  command: `bunx sierra widgets --config config/sierra.config.js --serve --port ${flag.port || 8300}`,
  cwd:     context.paths.widgets,
  dry:     flag.dry,
})
```
