---
title: 05-extras
description: Download extra DB files (ela.prod only)
skip: "!context.config.isElaProd"
optional: true
---

```js
const { server, serverPath, apiPath } = context.config
context.exec({ command: `scp ${server}:${serverPath}/api/attom.db ${apiPath}/.`, dry: flag.dry })
context.exec({ command: `scp ${server}:${serverPath}/api/ss.db ${apiPath}/.`, dry: flag.dry })
log.success('Extra DBs downloaded')
```
