---
title: deploy:outpost
description: Enroll the running API's box in the app's own fleet, with no release
examples:
  - fli deploy:outpost
  - fli deploy:outpost --server bct
  - fli deploy:outpost --production
flags:
  production:
    type: boolean
    description: Target production server
    defaultValue: false
  stage:
    type: boolean
    description: Target staging server
    defaultValue: false
---

`fli deploy`'s `08b-outpost` step on its own, against the container already
serving — for a deploy block saying `outpost: true` (`FJS-D1191`). A fresh
Basecamp has no workspace until `/setup`, so the deploy that installed it
answered *no workspace yet*; `fli provision:install` runs this once the admin
is made, and so can a person, from the app's directory.

A box already in the fleet is answered as such and only its `outpost.env` paths
are brought up to date. Exits 0 on a skip, which says why; 1 on a failure.

```js
const target     = resolveTarget(flag, $.git)
const deployConf = await deployConfFor($, flag, log)

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js')
  $.config.abort = true
  return
}
if (deployConf.outpost !== true) {
  log.error(`The deploy block does not say outpost: true, so this app's box is not one of its fleet's`)
  $.config.abort = true
  return
}

const api = resolveSide(deployConf, target, 'api')
if (!api) {
  log.error(`Cannot resolve a server and path for the api side on target: ${target}`)
  $.config.abort = true
  return
}

const { host, path } = api
const appId   = deployConf.app_id ?? path.split('/').pop()
const machine = machineFor($, host, path, deployConf.transport)

if (!machine.reach()) {
  log.error(`Cannot reach ${host}`)
  $.config.abort = true
  return
}

log.info(`Enrolling ${host} in ${appId}'s fleet`)
const { outcome } = enrollOutpost(machine, { appId, deployConf, path, host, log })
if (outcome === 'failed') process.exitCode = 1
```
