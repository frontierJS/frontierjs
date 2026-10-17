---
title: 06-cleanup
description: Release the lock where its root still exists, and list what is left to remove by hand
runOnAbort: true
---

```js
// A root 05-files removed took its lock with it; releasing it there would
// write into a directory that is gone.
if ($.config.lockAcquired && !$.config.filesRemoved) await releaseLocks($, $.config.hosts ?? [])
$.config.lockAcquired = false

if ($.config.abort) return

const { appId, target, outpostPresent } = $.config
const elapsed = ((Date.now() - $.config.startTime) / 1000).toFixed(1)
log.success(`Retired ${appId} from ${target} in ${elapsed}s`)
if ($.flag['keep-data']) log.info(`  ${$.config.dbDir} and ${$.config.envFile} are still on the server`)

// What deploy:setup put on the machine for EVERY app. Removing it here would
// take the box out from under the next app; listed, so the last app off a box
// is a copy-paste away from a clean one.
echo('')
echo('  Left on the box for its other apps — remove by hand if this was the last:')
echo(outpostPresent
  ? '    docker, caddy    sudo outpost-uninstall --purge   (also every other container and volume)'
  : '    docker, caddy    sudo apt-get purge docker-ce docker-ce-cli containerd.io caddy')
echo('    fli              sudo BUN_INSTALL=/usr/local bun remove -g @frontierjs/cli')
echo('    bun, litestream  sudo rm /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/litestream')
echo('    sqlite3, unzip   sudo apt-get purge sqlite3 unzip   (rsync too, unless the image shipped it)')
```
