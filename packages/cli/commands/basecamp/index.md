---
title: basecamp:list
alias: basecamp
description: List the droplets fli basecamp:create made, with the id basecamp:destroy takes
requires:
  - DIGITALOCEAN_TOKEN: https://cloud.digitalocean.com/account/api/tokens/new  Pick Full Access
examples:
  - fli basecamp
  - fli basecamp:create --yes --domain ops.example.com --name ops --admin you@example.com
---

Every droplet at the account carrying the `basecamp` tag. The one
`fli basecamp:create` made reads `Basecamp host`; one Basecamp made as a fleet
machine names its server, because `fli basecamp:destroy` refuses it — as it
refuses any droplet whose status is not `off`.

The whole box in one run is `fli basecamp:create --yes --domain <host>`: the
droplet, the install, the DNS record, the first admin (`--admin`, else `ME`)
and the Outpost enrollment.

```js
const done = await runProvision({ action: 'list' })
if (done.error) { log.error(done.error); process.exitCode = 1; return }

if (!done.machines.length) { echo('No droplet fli basecamp:create made is at this account'); return }
echo.lines(done.machines.map(m => machineLine(m, chalk)), { indent: 2 })
```
