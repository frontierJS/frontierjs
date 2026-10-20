---
title: provision:destroy
description: Destroy a droplet fli provision made
effects: destroys a droplet at DigitalOcean and everything on its disk
confirm: human
examples:
  - fli provision:destroy 512345678
args:
  -
    name: id
    description: The droplet id fli provision printed
---

Refuses any droplet `fli provision` did not make: the token reaches every
droplet at the account, and a fleet machine Basecamp made is destroyed in
Basecamp, which also retires its row.

```js
const id = String(arg.id ?? '').trim()
if (!id) { log.error('Which droplet? fli provision:destroy <id>'); return }

const done = await runProvision({ action: 'destroy', id })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
log.success(`Destroyed droplet ${done.destroyed}`)
```
