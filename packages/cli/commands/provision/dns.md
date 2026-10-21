---
title: provision:dns
description: Point Basecamp's hostname at its box at Cloudflare, in a record Basecamp's own edge reads as its own
effects: writes one DNS record at Cloudflare
examples:
  - fli provision:dns 203.0.113.7
  - fli provision:dns 203.0.113.7 --host ops.example.com
args:
  -
    name: ip
    description: The box's address, as fli provision printed it
flags:
  host:
    type: string
    description: The hostname (default the web.domain in packages/basecamp/frontier.config.js)
    defaultValue: ''
---

Writes `A <host> → <ip>`, DNS-only, through Basecamp's own Cloudflare
connector, run from this checkout as `fli provision` runs its DigitalOcean one.
The record carries Basecamp's fleet mark in its comment, so Basecamp manages it
later rather than refusing it as somebody else's. A rerun moves the record to
the new address; a record somebody made by hand at that name is refused, never
overwritten.

The zone is the longest one the token opens that the hostname ends with. A
first run at a terminal with no `CLOUDFLARE_TOKEN` opens the token page and
takes the paste, as `fli cf:dns` does.

```js
const ip = String(arg.ip ?? '').trim()
if (!ip) { log.error('Pass the address: fli provision:dns <ip>'); process.exitCode = 1; return }

const host = flag.host || await webDomain()
if (!host) { log.error('No hostname: pass --host, or set deploy.web.domain in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }

if (!await cloudflareToken({ interactive: !!process.stdin.isTTY, write: flag.dry !== true, say: (t) => log.error(t) })) {
  process.exitCode = 1
  return
}

if (flag.dry) { log.dry(`A ${host} → ${ip}, DNS-only, marked basecamp`); return }

const done = await hostRecord({ host, ip })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
log.success(`${done.host} → ${done.ip} in ${done.zone}, DNS-only`)
```
