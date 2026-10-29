---
title: server:list
alias: server
description: List the boxes fli server:create made, with the id server:destroy takes
flags:
  cloud:
    type: string
    description: The cloud to read, by kind; every one with a stored token otherwise
    defaultValue: ''
  hosts:
    type: boolean
    description: Look each box's hostname up at Cloudflare; --no-hosts skips the slow part of the list
    defaultValue: true
examples:
  - fli server
  - fli server --no-hosts
  - fli server:create --yes --name box1
---

Every box carrying the `basecamp` mark, at every cloud whose token is stored.
One with nothing on it reads `bare`; one Basecamp is installed on reads
`Basecamp host`; one enrolled in a fleet names its server, because `fli
server:destroy` refuses it — as it refuses any box whose status is not `off`.

With a `CLOUDFLARE_TOKEN` each row ends in the hostname whose A record points
at the box, which `fli basecamp:open` opens; without one, or with `--no-hosts`,
the rows name none. The hostnames are one sweep of every zone the token opens,
which is most of the time the list takes.

```js
const read = await cloudsToRead({ cloud: flag.cloud, interactive: !!process.stdin.isTTY, tty, chalk, say: (t) => log.warn(t) })
if (read.error) { log.error(read.error); process.exitCode = 1; return }
const done = await listBoxes(read.clouds)
if (done.error) { log.error(done.error); process.exitCode = 1; return }

if (!done.machines.length) { echo(`No box fli server:create made is at ${read.clouds.map(cloudLabel).join(' or ')}`); return }
echo.lines((flag.hosts ? await withHosts(done.machines) : done.machines).map(m => machineLine(m, chalk)), { indent: 2 })
```
