---
title: utils:tunnel
description: Run a configured cloudflared tunnel
alias: tunnel
examples:
  - fli tunnel
  - fli tunnel my-tunnel-name
  - fli tunnel --dry
args:
  -
    name: name
    description: Tunnel name configured in ~/.cloudflared/
    defaultValue: local-dev
---

```js
context.exec({ command: `cloudflared tunnel run ${arg.name}`, dry: flag.dry })
```
