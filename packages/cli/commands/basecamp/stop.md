---
title: basecamp:stop
description: Power off a box fli basecamp:create made, so basecamp:destroy will take it
effects: powers off a box at its cloud; whatever it serves goes down
confirm: human
examples:
  - fli basecamp:stop 512345678
  - fli basecamp:stop
args:
  -
    name: id
    description: The box id fli basecamp:create printed; with none, pick from the list
flags:
  cloud:
    type: string
    description: The cloud the box is at, by kind; found by its id otherwise
    defaultValue: ''
---

The first of the two hands on a destroy: `fli basecamp:destroy` refuses a
box that is not off, so a box still serving is never one mistyped id away
from gone. This cuts the power — a hard stop, not a shutdown asked of the OS —
and waits up to a minute for the cloud to report it `off`. The disk is kept
and it still bills; power it back on in the cloud's console, or destroy it.

The id is looked up at every cloud whose token is stored; one at two clouds
needs `--cloud`. Refuses the same boxes destroy does: one `fli basecamp:create` did not make, and a
fleet machine Basecamp made, which is powered off in Basecamp. With no id it
lists the Basecamp hosts still on and asks which.

```js
let id = String(arg.id ?? '').trim()

const read = await cloudsToRead({ cloud: flag.cloud, interactive: !!process.stdin.isTTY, tty, chalk, say: (t) => log.warn(t) })
if (read.error) { log.error(read.error); process.exitCode = 1; return }
const found = await listBoxes(read.clouds)
if (found.error) { log.error(found.error); process.exitCode = 1; return }
let cloud = ''

if (!id) {
  const on = found.machines.filter(m => !m.serverId && m.status !== 'off')
  if (!on.length) { echo('No Basecamp host fli basecamp:create made is powered on'); return }
  if (!process.stdin.isTTY) {
    log.error('Which box? fli basecamp:stop <id>')
    echo.lines(on.map(m => machineLine(m, chalk)), { indent: 2 })
    process.exitCode = 1; return
  }

  echo.lines(on.map((m, i) => `${i + 1}) ${machineLine(m, chalk)}`), { indent: 2 })
  const answer = (await tty.line(`Power off which? [1-${on.length}, Enter to cancel] › `)).trim()
  if (!answer) { echo('Nothing powered off'); return }
  const picked = on[Number(answer) - 1]
  if (!/^\d+$/.test(answer) || !picked) { log.error(`No row ${answer}`); process.exitCode = 1; return }
  id = String(picked.id)
  cloud = picked.cloud
} else {
  const at = cloudOf(id, found.machines, read.clouds)
  if (at.error) { log.error(at.error); process.exitCode = 1; return }
  cloud = at.cloud
}

const done = await runProvision({ cloud, action: 'off', id })
if (done.error) { log.error(done.error); process.exitCode = 1; return }
if (done.pending) { log.warn(`Box ${done.off} was asked to power off and is not off yet — fli basecamp shows when it is`); return }
log.success(`Box ${done.off} is off at ${cloudLabel(cloud)}`)
echo(`  To remove it: ${chalk.red(`fli basecamp:destroy ${done.off}`)}`)
```
