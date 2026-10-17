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
  machine.run(`command -v sudo >/dev/null 2>&1 || sudo() { "$@"; }
sudo /usr/local/sbin/outpost-uninstall`)
  log.success(`  Outpost removed → ${host}`)
  log.info('    sudo outpost-uninstall --purge on the box removes the apps it placed, Docker and Caddy')
} catch (err) {
  log.error(`outpost-uninstall failed on ${host}: ${String(err.stdout ?? err.message).trim().split('\n').pop()}`)
  $.config.abort = true
}
```
