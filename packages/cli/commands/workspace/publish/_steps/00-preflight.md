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
  context.config.prompts?.close()
  return
}

// The order is the product of this step even when nothing refused. A dependency
// published second resolves for nobody in the window between the two.
context.config.planned = sorted.order

// The last stop before a version is spent. Asked HERE rather than at the end of
// the command file because the refusals above are the thing being approved, and
// the note-only ones — a peer range that could not be decided — are exactly the
// kind a person reads and then chooses to accept.
const { interactive, prompts } = context.config
if (interactive && !flag.dry) {
  const names = sorted.order.map(p => p.pkg.name.replace('@frontierjs/', '')).join(' → ')
  echo('')
  log.info(`  Next: write ${sorted.order.length} version(s), refresh the lockfile, commit and tag.`)
  log.info(`  Publish order: ${names}`)
  if (!await prompts.confirm('  Version and commit now?', { default: true })) {
    log.info('  Stopped — nothing versioned, nothing published')
    prompts.close()
    context.config.abort = true
    return
  }
}

if (!refusals.length) {
  const names = sorted.order.map(p => p.pkg.name.replace('@frontierjs/', '')).join(' → ')
  log.success(`  preflight clear — ${planned.length} package(s), publishing ${names}`)
}
```
