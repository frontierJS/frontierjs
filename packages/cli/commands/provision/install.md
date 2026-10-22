---
title: provision:install
description: Install Basecamp on a box that already answers ssh, from any directory
effects: installs docker, caddy and Basecamp on the box over ssh
examples:
  - fli provision:install root@203.0.113.7 --domain ops.example.com
  - fli provision:install ops --admin you@example.com
args:
  -
    name: server
    description: "The box: an alias from ~/.ssh/config, or user@host"
flags:
  domain:
    type: string
    description: Basecamp's hostname (default the web.domain in packages/basecamp/frontier.config.js)
    defaultValue: ''
  admin:
    type: string
    description: Make this email Basecamp's first admin once it is up (asked at a terminal)
    defaultValue: ''
---

The install half of `fli provision`, for a box that already exists — one an
earlier `fli provision` bought, or one made by hand. It runs
`fli deploy:setup --auto-install` and then `fli deploy` in `packages/basecamp`, with the box as
`--server` and the hostname as `--domain`, so it works from any directory and
writes nothing into `frontier.config.js`. Those two are the only deploy values
asked for: every other one in Basecamp's deploy block is what its Dockerfile
already answers.

`--admin <email>` then makes the first admin through Basecamp's own
`POST /setup`, over ssh on the box, so no DNS is needed yet. At a terminal the
email is asked when not passed and the password asked hidden; Enter, or no
terminal, generates one and prints it once.

A rerun on the same box is a redeploy: `deploy:setup` installs only what is
missing and `POST /setup` refuses a second admin.

```js
const dest = String(arg.server ?? '').trim()
if (!dest) { log.error('Pass the box: fli provision:install <ssh alias or user@host>'); process.exitCode = 1; return }

const configured = (await webDomain()) || ''
const asked = flag.domain || configured
if (!asked) {
  log.error(`Installing needs Basecamp's hostname: Caddy routes by it and fetches its certificate. Pass --domain`)
  process.exitCode = 1
  return
}
const domain = await hostnameOf(asked)
if (!domain) {
  log.error(`"${asked}" is not a hostname: letters, digits, dots and dashes`)
  process.exitCode = 1
  return
}

let admin = flag.admin
let password = ''
if (process.stdin.isTTY && !admin) {
  const { resolve } = await import('node:path')
  const { createPrompts } = await import(resolve(global.fliRoot, 'core/prompt.js'))
  const p = createPrompts()
  admin = (await p.ask('Email for its first admin (Enter: make one at /setup in the browser) › ')).trim()
  p.close()
}
if (admin && !EMAIL.test(admin)) {
  log.error(`"${admin}" is not an email address`)
  process.exitCode = 1
  return
}
if (admin && process.stdin.isTTY) password = await tty.secret(`Password for ${admin} (Enter generates one)`)

log.info(`Installing Basecamp on ${dest} as ${domain}`)
const failed = await ringZero(dest, domain)
if (failed) {
  log.error(`fli ${failed.argv.join(' ')} exited ${failed.status}. Fix what it said and run this again`)
  process.exitCode = failed.status || 1
  return
}
log.success(`Basecamp is on ${dest}`)

// The record needs an address; an alias names none, so the line says where it goes.
const host = dest.split('@').pop()
const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : '<ip>'
const named = domain === configured ? '' : ` --domain ${domain}`
echo`
  Point ${domain} at it (DNS-only, so Caddy's certificate is what the browser sees):
    fli provision:dns ${ip}${domain === configured ? '' : ` --host ${domain}`}

  A later deploy, from packages/basecamp:
    fli deploy --server ${dest}${named}
`

const workspace = ip === '<ip>' ? host : 'basecamp'
if (admin && !await makeAdmin({ dest, workspace, admin, password, log, echo })) process.exitCode = 1
```
