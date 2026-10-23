---
title: basecamp:stop
description: Power off a droplet fli basecamp:create made, so basecamp:destroy will take it
requires:
  - DIGITALOCEAN_TOKEN: https://cloud.digitalocean.com/account/api/tokens/new  Pick Full Access
effects: powers off a droplet at DigitalOcean; whatever it serves goes down
confirm: human
examples:
  - fli basecamp:stop 512345678
  - fli basecamp:stop
args:
  -
    name: id
    description: The droplet id fli basecamp:create printed; with none, pick from the list
---

The first of the two hands on a destroy: `fli basecamp:destroy` refuses a
droplet that is not off, so a box still serving is never one mistyped id away
from gone. This cuts the power — a hard stop, not a shutdown asked of the OS —
and waits up to a minute for DigitalOcean to report it `off`. The disk is kept
and it still bills; power it back on at DigitalOcean, or destroy it.

Refuses the same droplets destroy does: one `fli basecamp:create` did not make, and a
fleet machine Basecamp made, which is powered off in Basecamp. With no id it
lists the Basecamp hosts still on and asks which.

```js
let id = String(arg.id ?? '').trim()

if (!id) {
  const found = await runProvision({ action: 'list' })
  if (found.error) { log.error(found.error); process.exitCode = 1; return }
  const on = found.machines.filter(m => !m.serverId && m.status !== 'off')
  if (!on.length) { echo('No Basecamp host fli basecamp:create made is powered on'); return }
  if (!process.stdin.isTTY) {
    log.error('Which droplet? fli basecamp:stop <id>')
    echo.lines(on.map(m => machineLine(m, chalk)), { indent: 2 })
    process.exitCode = 1; return
  }

  echo.lines(on.map((m, i) => `${i + 1}) ${machineLine(m, chalk)}`), { indent: 2 })
  const answer = (await tty.line(`Power off which? [1-${on.length}, Enter to cancel] › `)).trim()
  if (!answer) { echo('Nothing powered off'); return }
  const picked = on[Number(answer) - 1]
  if (!/^\d+$/.test(answer) || !picked) { log.error(`No row ${answer}`); process.exitCode = 1; return }
  id = picked.id
}

const done = await runProvision({ action: 'off', id })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
if (done.pending) { log.warn(`Droplet ${done.off} was asked to power off and is not off yet — fli basecamp shows when it is`); return }
log.success(`Droplet ${done.off} is off. To remove it: fli basecamp:destroy ${done.off}`)
```
