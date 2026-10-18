---
title: deploy:retire
description: Take an app off its server — container, images, Caddy routes, Outpost, and the deploy root with its database
effects: deletes the app, its database and its routes from the server
confirm: human
examples:
  - fli deploy:retire
  - fli deploy:retire --production
  - fli deploy:retire --production --keep-data
flags:
  production:
    type: boolean
    description: Retire production (overrides branch detection)
    defaultValue: false
  stage:
    type: boolean
    description: Retire staging
    defaultValue: false
  keep-data:
    type: boolean
    description: Leave the database directory and the env file in place
    defaultValue: false
  outpost:
    type: boolean
    description: "Run the box's outpost-uninstall, where the deploy block says outpost: true"
    defaultValue: true
steps: _steps-retire
---

```js
const target     = resolveTarget(flag, $.git)
const deployConf = await deployConfFor($, flag, log)

if (!deployConf?.server) {
  log.error('No deploy block found in frontier.config.js — there is no server to retire from')
  $.config.abort = true
  return
}

const api = resolveSide(deployConf, target, 'api')
const web = resolveSide(deployConf, target, 'web')
if (!api) {
  log.error(`Cannot resolve a server and path for the api side on target: ${target}`)
  $.config.abort = true
  return
}

$.config.stepsDir   = '_steps-retire'
$.config.target     = target
$.config.deployConf = deployConf
$.config.api        = api
$.config.sides      = distinctHosts([api, web].filter(Boolean))
$.config.hosts      = $.config.sides
$.config.appId      = deployConf.app_id ?? deployConf.path.split('/').pop()
$.config.dbDir      = apiFiles(deployConf, api.path).dbDir
$.config.envFile    = apiFiles(deployConf, api.path).envFile
$.config.startTime  = Date.now()

log.info(`Retiring ${$.config.appId} from ${target}`)
```

## What goes

The inverse of `fli deploy:setup` and `fli deploy`, for one app:

- this app's routes in the machine's Caddy, the pause guard with them;
- the Outpost, by the box's own `outpost-uninstall`, where the deploy block
  says `outpost: true` — the inverse of `08b-outpost`. Bare, so the Docker and
  Caddy other apps share stay; `sudo outpost-uninstall --purge` on the box is
  the rest. The box's firewall goes with it, and preflight names each running
  container that then answers from outside on a port it never declared.
  `--no-outpost` leaves it;
- the API container, the one a deploy left `_replaced`, and every image of the
  app;
- the deploy root on every machine a side lives on — source, web releases, the
  journal, the lock — and the database directory and the env file, which a
  deploy block may put outside it. `--keep-data` leaves those two.

What stays is what `deploy:setup` put on the machine for every app: Docker,
Caddy, bun, rsync, sqlite3, litestream and fli. The run ends by listing each
with the command that removes it, for the last app off a box. A Litestream
process an operator started against this app's database is named and not
stopped.

## Who says yes

It deletes a production database, so a person confirms each run: at a
terminal by typing the app's id, anywhere else with `--approved` once a
person has approved that exact command line. Nothing is backed up first:
copy the database off the box, or pass `--keep-data`.
