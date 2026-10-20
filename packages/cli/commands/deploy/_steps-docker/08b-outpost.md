---
title: 08b-outpost
description: Enroll the API's box in the app's own fleet — a Basecamp's deploy block says outpost true
optional: true
skip: "!$.config.doApi || !$.flag.outpost || $.config.deployConf.outpost !== true || $.flag.dry"
---

The box a Basecamp runs on is the first place an app can go, and `fli deploy`
already left it the Caddy Outpost writes routes into (`FJS-D598`). What it
lacks is the Outpost, and this step installs it (`FJS-D1191`): the app's own
`api/src/core/enroll-host.ts`, run in the new container, finds or makes the host's
Server row and mints its token, and the install command it answers runs on the
host. `--no-outpost` skips it for one run.

After the web release, because the install fetches `install.sh` from the app's
public URL. Every failure warns: the release is live by now.

Then, installed now or enrolled before, the box's `outpost.env` is made to name
the database directory and the env file this deploy mounts, which is what the
Outpost reads `hub.db-mode` and `hub.env-mode` from (`FJS-D1241`), and the
secrets directory's ENCRYPTION_KEY, which `hub.env-mode` grades too. An enrolled
box never reruns `install.sh`, so this step is the one place they are written,
and the Outpost restarts only when a line changed.

```js
if ($.config.abort) return

const { appId, deployConf } = $.config
const { host, path }        = $.config.api
const machine               = machineFor($, host, path)

// A root login on a box with no sudo installed runs the same scripts through a
// function of that name.
const SUDO = 'command -v sudo >/dev/null 2>&1 || sudo() { "$@"; }'
let installed = false

// The script's last stdout line is its whole answer. A failed exec carries it
// in the error's stdout, and an image older than the script answers nothing.
const lastJson = (out) => {
  try { return JSON.parse(String(out ?? '').trim().split('\n').pop()) } catch { return null }
}

let answer
try {
  answer = lastJson(machine.capture(`docker exec ${apiContainer(appId, deployConf)} bun api/src/core/enroll-host.ts`))
} catch (err) {
  answer = lastJson(err.stdout) ?? { error: err.message.split('\n')[0] }
}

if (!answer)            log.warn('Outpost not enrolled: api/src/core/enroll-host.ts answered nothing — pass --no-outpost to stop trying')
else if (answer.error)  log.warn(`Outpost not enrolled: ${answer.error}`)
else if (answer.skip)   log.info(`Outpost not enrolled: ${answer.skip}`)
else if (answer.enrolled) log.info('Outpost: this box is in the fleet already')
else {
  // The command is written for a person with sudo.
  const script = `${SUDO}\n${answer.command}`
  try {
    machine.run(script)
    log.success('Outpost installed — the box joins the fleet at its first heartbeat')
    installed = true
  } catch (err) {
    // The attributed message quotes the script, and the script holds a live
    // single-use token; the journal records what is logged here.
    const said = String(err.stdout ?? '').trim().split('\n').slice(-3).join(' · ')
    log.warn(`Outpost install failed on ${host}${said ? `: ${said}` : ''} — the Servers page issues a fresh command`)
  }
}

if (answer?.enrolled || installed) {
  const sq    = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
  const lines = [
    `OUTPOST_HOST_DB_PATH=${apiFiles(deployConf, path).dbDir}`,
    `OUTPOST_HOST_ENV_PATH=${apiFiles(deployConf, path).envFile}`,
    `OUTPOST_HOST_KEY_PATH=${apiFiles(deployConf, path).secretsDir}/ENCRYPTION_KEY`,
  ]
  // Prints `unchanged`, `written` or `no-env`; the lines are always written
  // in this order, so the grep is compared as one string.
  const script = [
    SUDO,
    'F=/etc/basecamp/outpost.env',
    'sudo test -f "$F" || { echo no-env; exit 0; }',
    `WANT=$(printf '%s\\n' ${lines.map(sq).join(' ')})`,
    `HAVE=$(sudo grep -E '^OUTPOST_HOST_(DB|ENV|KEY)_PATH=' "$F" || true)`,
    '[ "$WANT" = "$HAVE" ] && { echo unchanged; exit 0; }',
    `sudo sed -i -E '/^OUTPOST_HOST_(DB|ENV|KEY)_PATH=/d' "$F"`,
    `printf '%s\\n' ${lines.map(sq).join(' ')} | sudo tee -a "$F" >/dev/null`,
    'sudo systemctl restart outpost.service',
    'echo written',
  ].join('\n')
  try {
    const said = String(machine.capture(script) ?? '').trim().split('\n').pop()
    if (said === 'written')     log.info('Outpost: told where the database and env file are, and restarted')
    else if (said === 'no-env') log.warn('Outpost: no /etc/basecamp/outpost.env on this box — /hub/security/ cannot grade its database or env file')
  } catch (err) {
    log.warn(`Outpost: the database and env file paths were not written — ${err.message.split('\n')[0]}`)
  }
}
```
