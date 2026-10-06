---
title: browser:captain
description: Open the CapRover captain dashboard from $DEV_CAPTAIN
alias: captain
examples:
  - fli captain
  - fli captain --dry
---

```js
const url = $.env.DEV_CAPTAIN
if (!url) { log.error('$DEV_CAPTAIN is not set in your .env'); return }
const browser = $.env.BROWSER || 'xdg-open'
$.exec({ command: `${browser} ${url} &`, dry: flag.dry })
```
