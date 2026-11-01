---
title: 01b-ci
description: Grade the release commit in a checkout of it, before any tag exists
---

<script>
import { existsSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
</script>

```js
const { graded, released, resume } = $.config
if (!released?.length) return

// A release in flight was graded before its tag was written, so a tagged
// resume has nothing to run.
if (resume) { log.info('  CI: skipped -- these tags were written after a green run'); return }

const { withCheckout } = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
const { fliTmpRoot }   = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))
const scratch = join(fliTmpRoot(global.fliRoot), 'publish-ci', String($.config.startTime))

// The full tier, in a checkout of the release sha rather than the working tree:
// a push is the one thing that cannot be taken back once npm has the package,
// and the graded bytes must be the ones the tag will name whatever lands in the
// main tree meanwhile (`FJS-D1720`, `FJS-D1721`).
//
// `deploy --source npm` grades the PUBLISHED framework, and the bump just
// raised the scaffold's pins to versions no host holds yet, so ci.mjs skips
// that branch by name and `04-verify-assets` grades it after publish
// (`FJS-D1726`).
for (const { cwd, sha } of graded) {
  const ci = join(cwd, 'scripts/ci.mjs')
  if (!existsSync(ci)) {
    log.warn(`  CI: no scripts/ci.mjs in ${cwd} -- nothing gates ${sha.slice(0, 12)}`)
    continue
  }
  if (flag.dry) {
    log.dry(`  Would run the full CI in a checkout of ${sha.slice(0, 12)} (${cwd}): bun install --frozen-lockfile, then node scripts/ci.mjs`)
    log.dry('  Its deploy phase skips `--source npm` by name: the bumped pins are on no host until this release ships')
    continue
  }
  log.info(`  CI: full run on ${sha.slice(0, 12)} -- a checkout of it, not the working tree`)
  const status = withCheckout({ repo: cwd, sha, scratch }, tree =>
    spawnSync('node', ['scripts/ci.mjs'], { cwd: tree, stdio: 'inherit' }).status)
  if (status !== 0) {
    log.error(`  CI failed on ${sha.slice(0, 12)} -- nothing tagged, nothing pushed`)
    log.error('  Commit the fix and run `fli ws:pub` again: the release commit is kept and tagged once a run is green')
    throw new Error(`CI failed on ${sha.slice(0, 12)}`)
  }
  log.success(`  CI green on ${sha.slice(0, 12)}`)
}
```
