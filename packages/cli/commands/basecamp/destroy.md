---
title: basecamp:destroy
description: Destroy a droplet fli basecamp:create made
requires:
  - DIGITALOCEAN_TOKEN: https://cloud.digitalocean.com/account/api/tokens/new  Pick Full Access
effects: destroys a droplet at DigitalOcean and everything on its disk
confirm: human
examples:
  - fli basecamp:destroy 512345678
  - fli basecamp:destroy
args:
  -
    name: id
    description: The droplet id fli basecamp:create printed; with none, pick from the list
---

Refuses any droplet `fli basecamp:create` did not make: the token reaches every
droplet at the account, and a fleet machine Basecamp made is destroyed in
Basecamp, which also retires its row. Refuses one that is not powered off,
too — `fli basecamp:stop` first, so a box still serving is never one mistyped
id away from gone.

With no id it lists the Basecamp hosts that are off and asks which. The pick
still goes through the same refusal, so a list read a moment ago cannot widen
it.

```js
let id = String(arg.id ?? '').trim()

if (!id) {
  const found = await runProvision({ action: 'list' })
  if (found.error) { log.error(found.error); process.exitCode = 1; return }
  const hosts = found.machines.filter(m => !m.serverId)
  const ours  = hosts.filter(m => m.status === 'off')
  if (!hosts.length) { echo('No Basecamp host fli basecamp:create made is at this account'); return }
  if (!ours.length) {
    echo('None is powered off. fli basecamp:stop <id> first:')
    echo.lines(hosts.map(m => machineLine(m, chalk)), { indent: 2 })
    return
  }
  if (!process.stdin.isTTY) {
    log.error('Which droplet? fli basecamp:destroy <id>')
    echo.lines(ours.map(m => machineLine(m, chalk)), { indent: 2 })
    process.exitCode = 1; return
  }

  echo.lines(ours.map((m, i) => `${i + 1}) ${machineLine(m, chalk)}`), { indent: 2 })
  const answer = (await tty.line(`Destroy which? [1-${ours.length}, Enter to cancel] › `)).trim()
  if (!answer) { echo('Nothing destroyed'); return }
  const picked = ours[Number(answer) - 1]
  if (!/^\d+$/.test(answer) || !picked) { log.error(`No row ${answer}`); process.exitCode = 1; return }
  id = picked.id
}

const done = await runProvision({ action: 'destroy', id })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
log.success(`Destroyed droplet ${done.destroyed}`)
```
