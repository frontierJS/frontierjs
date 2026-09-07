---
title: 00-preflight
description: Every reason this release must not go to npm, before a version is spent
---

<script>
import { resolve } from 'path'
</script>

```js
const { planned, members } = context.config
if (!planned?.length) return

const { dirtyPackages, peerDrift, publishOrder, publishRefusals, formatRefusals } =
  await import(new URL('file://' + global.fliRoot + '/core/publish-preflight.js'))

const dirty  = dirtyPackages(planned.map(p => ({ name: p.pkg.name, dir: p.dir })),
                             (name, dir) => context.git.pkgState(name, dir))
const drift  = peerDrift((members ?? []).map(m => ({ name: m.pkg.name, pkg: m.pkg })), planned.map(p => ({ name: p.pkg.name, newVersion: p.newVersion })))
const sorted = publishOrder(planned.map(p => ({ ...p, name: p.pkg.name })))

const refusals = publishRefusals({
  dirty, drift, cycles: sorted.cycles,
  force: { dirty: flag['allow-dirty'], peers: flag['allow-peer-drift'] },
})

if (refusals.length) for (const line of formatRefusals(refusals)) log.info(line)

if (refusals.some(r => !r.note)) {
  // `abort`, not a throw: the runtime exits non-zero, skips the rest and still
  // runs any teardown, and nothing has been versioned yet — so the recovery is
  // to fix what is named and run the same command again.
  context.config.abort = true
  return
}

// The order is the product of this step even when nothing refused. A dependency
// published second resolves for nobody in the window between the two.
context.config.planned = sorted.order

if (!refusals.length) {
  const names = sorted.order.map(p => p.pkg.name.replace('@frontierjs/', '')).join(' → ')
  log.success(`  preflight clear — ${planned.length} package(s), publishing ${names}`)
}
```
