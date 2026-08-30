---
title: deploy:unlock
description: Drop a deploy lock left behind by a run that died
examples:
  - fli deploy:unlock
  - fli deploy:unlock --production
  - fli deploy:unlock --force
flags:
  production:
    type: boolean
    description: The production server
    defaultValue: false
  stage:
    type: boolean
    description: The staging server
    defaultValue: false
  force:
    type: boolean
    description: Drop it without asking
    defaultValue: false
---

Drops the lock and nothing else. It does not settle the journal, so a transition
the dead run left `running` stays resumable — `fli deploy --resume` is the other
way out and the one to reach for first, because it continues that transition
rather than opening a second.

```js
const target = resolveTarget(flag, context.git)

const frontierConfig = await loadFrontierConfig(context.paths.root)
const deployConf     = frontierConfig?.deploy

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js')
  context.config.abort = true
  return
}

const { lockPath, parseLock, describeLock, releaseScript } =
  await import(new URL('file://' + global.fliRoot + '/core/lock.js'))

const targetConf = deployConf[target] ?? {}
const server = targetConf.server ?? deployConf.server
const user   = targetConf.user   ?? deployConf.user ?? 'deploy'
const path   = targetConf.path   ?? deployConf.path
const host   = `${user}@${server}`

const machine  = machineFor(context, host, path, deployConf.transport)
const lockFile = lockPath(path)

// A lock is one file; reading it and removing it are two commands and the run
// that holds it may finish between them. That is the right race to lose — the
// second command removes a file the first said was there and nothing else uses
// it, where the alternative is removing one this command never showed anybody.
let body = ''
try { body = machine.capture(`cat ${lockFile} 2>/dev/null || true`) }
catch (err) {
  log.error(`Cannot read ${host} — ${err.message}`)
  context.config.abort = true
  return
}

const held = parseLock(body)
if (!held) {
  log.success(`No lock on ${machine.describe()} — ${lockFile} is clear`)
  return
}

log.warn(`Lock on ${machine.describe()}`)
for (const line of describeLock(held).lines) log.info(`  ${line}`)
log.info('')

if (!flag.force) {
  log.info('  fli deploy --resume         continue that run — the journal knows how far it got')
  log.info('  fli deploy:unlock --force   drop it and start over')
  return
}

machine.run(releaseScript(lockFile))
log.success(`Dropped ${lockFile}`)
log.info('  The journal is untouched — a transition that run left open is still resumable.')
```
