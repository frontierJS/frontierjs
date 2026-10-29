---
title: basecamp:open
description: Open Basecamp in the browser, at the hostname whose A record points at its box
examples:
  - fli basecamp:open
  - fli basecamp:open 512345678
args:
  -
    name: id
    description: A box id fli server printed; with none, the Basecamp host
flags:
  cloud:
    type: string
    description: The cloud the box is at, by kind; every one with a stored token otherwise
    defaultValue: ''
---

The hostname is found the way `fli server` finds it: the A record at
Cloudflare pointing at the box's address, its reserved IP first. Nothing else
holds it — Basecamp's config names no domain. A first run at a terminal with no
`CLOUDFLARE_TOKEN` asks for one, as `fli basecamp:dns` does.

```js
const read = await cloudsToRead({ cloud: flag.cloud, interactive: !!process.stdin.isTTY, tty, chalk, say: (t) => log.warn(t) })
if (read.error) { log.error(read.error); process.exitCode = 1; return }
const found = await listBoxes(read.clouds)
if (found.error) { log.error(found.error); process.exitCode = 1; return }

const id = String(arg.id ?? '').trim()
const at = read.clouds.map(cloudLabel).join(' or ')
const target = id ? found.machines.find(m => String(m.id) === id) : found.machines.find(m => !m.serverId)
if (!target) { log.error(id ? `No box ${id} fli server:create made is at ${at}` : `No Basecamp host fli server:create made is at ${at}`); process.exitCode = 1; return }

if (!await cloudflareToken({ interactive: !!process.stdin.isTTY, write: !flag.dry, say: (t) => log.warn(t) })) {
  log.error('The hostname is read off its Cloudflare record: set CLOUDFLARE_TOKEN'); process.exitCode = 1; return
}
const [named] = await withHosts([target])
if (!named.host) { log.error(`No A record at Cloudflare points at ${target.reservedIp ?? target.ip}. Write one: fli basecamp:dns ${target.reservedIp ?? target.ip}`); process.exitCode = 1; return }

const url = `https://${named.host}`
if (flag.dry) { log.dry(`open ${url}`); return }
const { resolve } = await import('node:path')
const { openUrl } = await import(resolve(global.fliRoot, 'core/open-url.js'))
openUrl(url)
log.success(`Opened ${url}`)
```
