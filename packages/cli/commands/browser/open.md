---
title: browser:open
description: Open a URL in the configured browser
alias: open
examples:
  - fli open https://example.com
  - fli browser:open https://example.com --dry
args:
  -
    name: url
    description: URL to open
    required: true
---

```js
const browser = context.env.BROWSER || 'xdg-open'
context.exec({ command: `${browser} "${arg.url}"`, dry: flag.dry })
```
