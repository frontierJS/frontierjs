---
title: 08b-outpost
description: Enroll the API's box in the app's own fleet — a Basecamp's deploy block says outpost true
optional: true
skip: "!$.config.doApi || !$.flag.outpost || $.config.deployConf.outpost !== true || $.flag.dry"
---

The box a Basecamp runs on is the first place an app can go, and `fli deploy`
already left it the Caddy Outpost writes routes into (`FJS-D598`). What it
lacks is the Outpost, and this step installs it (`FJS-D1191`): the app's own
`api/enroll-host.ts`, run in the new container, finds or makes the host's
Server row and mints its token, and the install command it answers runs on the
host. `--no-outpost` skips it for one run.

After the web release, because the install fetches `install.sh` from the app's
public URL. Every failure warns: the release is live by now.

```js
if ($.config.abort) return

const { appId, deployConf } = $.config
const { host, path }        = $.config.api
const machine               = machineFor($, host, path)

// The script's last stdout line is its whole answer. A failed exec carries it
// in the error's stdout, and an image older than the script answers nothing.
const lastJson = (out) => {
  try { return JSON.parse(String(out ?? '').trim().split('\n').pop()) } catch { return null }
}

let answer
try {
  answer = lastJson(machine.capture(`docker exec ${apiContainer(appId, deployConf)} bun api/enroll-host.ts`))
} catch (err) {
  answer = lastJson(err.stdout) ?? { error: err.message.split('\n')[0] }
}

if (!answer)            log.warn('Outpost not enrolled: api/enroll-host.ts answered nothing — pass --no-outpost to stop trying')
else if (answer.error)  log.warn(`Outpost not enrolled: ${answer.error}`)
else if (answer.skip)   log.info(`Outpost not enrolled: ${answer.skip}`)
else if (answer.enrolled) log.info('Outpost: this box is in the fleet already')
else {
  // The command is written for a person with sudo. A root login on a box with
  // no sudo installed runs the same pipeline through a function of that name.
  const script = `command -v sudo >/dev/null 2>&1 || sudo() { "$@"; }\n${answer.command}`
  try {
    machine.run(script)
    log.success('Outpost installed — the box joins the fleet at its first heartbeat')
  } catch (err) {
    // The attributed message quotes the script, and the script holds a live
    // single-use token; the journal records what is logged here.
    const said = String(err.stdout ?? '').trim().split('\n').slice(-3).join(' · ')
    log.warn(`Outpost install failed on ${host}${said ? `: ${said}` : ''} — the Servers page issues a fresh command`)
  }
}
```
