---
title: 08b-outpost
description: Enroll the API's box in the app's own fleet — a Basecamp's deploy block says outpost true
optional: true
skip: "!$.config.doApi || !$.flag.outpost || $.config.deployConf.outpost !== true || $.flag.dry"
---

The box a Basecamp runs on is the first place an app can go, and `fli deploy`
already left it the Caddy Outpost writes routes into (`FJS-D598`). What it
lacks is the Outpost, and this step installs it (`FJS-D1191`): the app's own
`api/src/domain/host/enroll-host.ts`, run in the new container, finds or makes the host's
Server row and mints its token, and the install command it answers runs on the
host. `--no-outpost` skips it for one run.

After the web release, because the install fetches `install.sh` from the app's
public URL. The work is `enrollOutpost` in `_module.md`, which `fli
deploy:outpost` runs alone.

```js
if ($.config.abort) return

const { appId, deployConf } = $.config
const { host, path }        = $.config.api
enrollOutpost(machineFor($, host, path), { appId, deployConf, path, host, log })
```
