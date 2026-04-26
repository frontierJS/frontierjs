---
title: browser:live
description: Open the live site URL from $LIVE_SITE_URL
alias: live
examples:
  - fli live
  - fli browser:live --dry
---

```js
const url = context.env.LIVE_SITE_URL
if (!url) { log.error('$LIVE_SITE_URL is not set in your .env'); return }
const browser = context.env.BROWSER || 'xdg-open'
context.exec({ command: `${browser} ${url}`, dry: flag.dry })
```
