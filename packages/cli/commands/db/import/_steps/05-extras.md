---
title: 05-extras
description: Download extra DB files (ela.prod only)
skip: "!$.config.isElaProd"
optional: true
---

```js
const { server, serverPath, apiPath } = $.config
$.exec({ command: `scp ${server}:${serverPath}/api/attom.db ${apiPath}/.`, dry: flag.dry })
$.exec({ command: `scp ${server}:${serverPath}/api/ss.db ${apiPath}/.`, dry: flag.dry })
if (!flag.dry) log.success('Extra DBs downloaded')
```
