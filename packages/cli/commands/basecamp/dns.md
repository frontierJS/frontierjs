---
title: basecamp:dns
description: Point Basecamp's hostname at its box at Cloudflare, in a record Basecamp's own edge reads as its own
effects: writes one DNS record at Cloudflare, and with --proxied a Configuration Rule for that host
requires:
  - CLOUDFLARE_TOKEN: https://dash.cloudflare.com/profile/api-tokens  Create Token, the Edit zone DNS template, then add Zone / Zone / Read
examples:
  - fli basecamp:dns 203.0.113.7
  - fli basecamp:dns 203.0.113.7 --host ops.example.com
  - fli basecamp:dns 203.0.113.7 --proxied
args:
  -
    name: ip
    description: The box's address, as fli basecamp:create printed it
flags:
  host:
    type: string
    description: The hostname (default the web.domain in packages/basecamp/frontier.config.js)
    defaultValue: ''
  proxied:
    type: boolean
    description: Put the host behind Cloudflare's proxy, Full (strict) for this host first
    defaultValue: false
---

Writes `A <host> → <ip>`, DNS-only unless `--proxied`, through Basecamp's own Cloudflare
connector, run from this checkout as `fli basecamp:create` runs a cloud's compute one.
The record carries Basecamp's fleet mark in its comment, so Basecamp manages it
later rather than refusing it as somebody else's. A rerun moves the record to
the new address; a record somebody made by hand at that name is refused, never
overwritten.

`fli basecamp:create` and `basecamp:install` make this same write once Basecamp is
up; this command is for a box whose record could not be written then.

`--proxied` is the flip those two offer once HTTPS answers (`FJS-D1380`): a
Configuration Rule sets Full (strict) for this hostname alone, then the record
turns proxied. The zone's own SSL mode is never changed — it covers every other
host in the zone. The token needs *Zone › Config Rules › Edit* for it. Without
the flag a rerun keeps whatever the record holds.

The zone is the longest one the token opens that the hostname ends with. A
first run at a terminal with no `CLOUDFLARE_TOKEN` opens the token page and
takes the paste. The token is the connector's, not `cf`'s login that `fli
cf:dns` runs on, because the box's own Basecamp writes with it later.

```js
const ip = String(arg.ip ?? '').trim()
if (!ip) { log.error('Pass the address: fli basecamp:dns <ip>'); process.exitCode = 1; return }

const host = flag.host || await webDomain()
if (!host) { log.error('No hostname: pass --host, or set deploy.web.domain in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }

if (flag.dry) { log.dry(`A ${host} → ${ip}, ${flag.proxied ? 'proxied, Full (strict) for this host' : 'proxy state kept'}, marked basecamp`); return }

const done = await hostRecord({ host, ip, ...(flag.proxied ? { proxied: true } : {}) })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
log.success(`${done.host} → ${done.ip} in ${done.zone}, ${done.proxied ? 'behind the proxy, Full (strict) for this host' : 'DNS-only'}`)
```
