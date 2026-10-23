---
title: provision:list
description: List the droplets fli provision made, with the id provision:destroy takes
examples:
  - fli provision:list
---

Every droplet at the account carrying the `basecamp` tag. The one `fli
provision` made reads `Basecamp host`; one Basecamp made as a fleet machine
names its server, because `fli provision:destroy` refuses it — as it refuses
any droplet whose status is not `off`.

```js
const done = await runProvision({ action: 'list' })
if (done.error) { log.error(done.error); process.exitCode = 1; return }

if (!done.machines.length) { echo('No droplet fli provision made is at this account'); return }
echo.lines(done.machines.map(m => machineLine(m, chalk)), { indent: 2 })
```
