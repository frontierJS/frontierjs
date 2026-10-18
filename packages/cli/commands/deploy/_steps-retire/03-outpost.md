---
title: 03-outpost
description: Run the box's outpost-uninstall, the inverse of 08b-outpost
skip: "!$.config.outpostPresent"
---

```js
if ($.config.abort) return

const { host, path } = $.config.api
const machine = machineFor($, host, path)

// Bare, never --purge: Docker and Caddy are this pipeline's too, and every
// other app on the box stands on them. A root login on a box with no sudo runs
// the same line through a function of that name, as 08b-outpost does.
try {
  const said = String(machine.run(`command -v sudo >/dev/null 2>&1 || sudo() { "$@"; }
sudo /usr/local/sbin/outpost-uninstall`) ?? '')
  log.success(`  Outpost removed → ${host}`)
  log.info('    sudo outpost-uninstall --purge on the box removes the apps it placed, Docker and Caddy')
  // The run's output is held, and the uninstall's own list is where the
  // firewall going and the Basecamp Server row left behind are said.
  const at = said.indexOf('Left on purpose')
  if (at >= 0) for (const line of said.slice(at).trimEnd().split('\n')) echo(`    ${line}`)
} catch (err) {
  log.error(`outpost-uninstall failed on ${host}: ${String(err.stdout ?? err.message).trim().split('\n').pop()}`)
  $.config.abort = true
}
```
