---
title: basecamp:list
alias: basecamp
description: List the boxes fli basecamp:create made, with the id basecamp:destroy takes
flags:
  cloud:
    type: string
    description: The cloud to read, by kind; every one with a stored token otherwise
    defaultValue: ''
examples:
  - fli basecamp
  - fli basecamp:create --yes --domain ops.example.com --name ops --admin you@example.com
---

Every box carrying the `basecamp` mark, at every cloud whose token is stored.
The one `fli basecamp:create` made reads `Basecamp host`; one Basecamp made as
a fleet machine names its server, because `fli basecamp:destroy` refuses it —
as it refuses any box whose status is not `off`.

The whole box in one run is `fli basecamp:create --yes --domain <host>`: the
box, the install, the DNS record, the first admin (`--admin`, else `ME`)
and the Outpost enrollment.

With a `CLOUDFLARE_TOKEN` each row ends in the hostname whose A record points
at the box, which `fli basecamp:open` opens; without one the rows name none.

```js
const read = await cloudsToRead({ cloud: flag.cloud, interactive: !!process.stdin.isTTY, tty, chalk, say: (t) => log.warn(t) })
if (read.error) { log.error(read.error); process.exitCode = 1; return }
const done = await listBoxes(read.clouds)
if (done.error) { log.error(done.error); process.exitCode = 1; return }

if (!done.machines.length) { echo(`No box fli basecamp:create made is at ${read.clouds.map(cloudLabel).join(' or ')}`); return }
echo.lines((await withHosts(done.machines)).map(m => machineLine(m, chalk)), { indent: 2 })
```
