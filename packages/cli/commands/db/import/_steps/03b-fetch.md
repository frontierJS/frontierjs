---
title: 03b-fetch
description: Fetch the App's newest bucket archive through Basecamp
skip: "!$.config.viaBasecamp"
---

```js
const got = await pullThroughBasecamp({ $, flag, log, echo, chalk }, $.config.appId)
if (!got && !flag.dry) { $.config.abort = true; return }
$.config.archive = got
```
