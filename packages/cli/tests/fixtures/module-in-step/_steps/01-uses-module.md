---
title: 01-uses-module
---

```js
// distinctHosts is defined in commands/deploy/_module.md and nowhere else.
// Steps were compiled with an EMPTY module script, so this threw
// "distinctHosts is not defined" while the orchestrator beside it was fine.
const hosts = distinctHosts([{ host: 'a@b', path: '/x' }, { host: 'a@b', path: '/x' }])
log.success(`step reached the module: ${hosts.length} host`)
```
