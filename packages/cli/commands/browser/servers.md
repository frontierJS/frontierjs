---
title: browser:servers
description: Open the server management panel from $SERVERS_URL
alias: servers
examples:
  - fli servers
  - fli browser:servers --dry
flags:
  url:
    char: u
    type: string
    description: Override the default servers URL
    defaultValue: ''
---

```js
const url = flag.url || context.env.SERVERS_URL
if (!url) { log.error('$SERVERS_URL is not set — use --url or add it to .env'); return }
const browser = context.env.BROWSER || 'xdg-open'
context.exec({ command: `${browser} ${url} &`, dry: flag.dry })
```
