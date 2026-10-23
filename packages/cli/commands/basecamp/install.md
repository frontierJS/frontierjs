---
title: basecamp:install
description: Install Basecamp on a box that already answers ssh, from any directory
effects: installs docker, caddy and Basecamp on the box over ssh, and writes its DNS record at Cloudflare
examples:
  - fli basecamp:install root@203.0.113.7 --domain ops.example.com
  - fli basecamp:install ops --admin you@example.com
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
  outpost:
    type: boolean
    description: Enroll the box in Basecamp's own fleet, so apps can run beside it (asked at a terminal)
    defaultValue: true
---

The install half of `fli basecamp:create`, for a box that already exists — one an
earlier `fli basecamp:create` bought, or one made by hand. It runs
`fli deploy:setup --auto-install` and then `fli deploy` in `packages/basecamp`, with the box as
`--server` and the hostname as `--domain`, so it works from any directory and
writes nothing into `frontier.config.js`. Those two are the only deploy values
asked for: every other one in Basecamp's deploy block is what its Dockerfile
already answers.

`--admin <email>` then makes the first admin through Basecamp's own
`POST /setup`, over ssh on the box, so no DNS is needed yet. At a terminal the
email is asked when not passed and the password asked hidden; Enter, or no
terminal, generates one and prints it once.

Once Basecamp is up the run points the hostname at the box — `fli
basecamp:dns`'s write, DNS-only, under the fleet's mark — at the address ssh
resolves the box to, so an alias works. The token is checked before the install:
one that opens no zone holding the hostname refuses before anything is
installed. With no `CLOUDFLARE_TOKEN` a terminal takes the paste, and a run with
no terminal warns, installs, and prints the `fli basecamp:dns` line instead.

A rerun on the same box is a redeploy: `deploy:setup` installs only what is
missing, the record is moved to the box's address if it changed, and
`POST /setup` refuses a second admin.

The box is also asked to be an Outpost — a machine of the fleet this Basecamp
runs, so apps can run beside it. Yes by default; `--no-outpost` leaves it out
and skips the question. The enrollment runs last, as `fli deploy:outpost`,
because it files the box under the workspace `POST /setup` makes. With no admin
made it says so, and the Servers page's *Use this Basecamp server* does it later.

```js
const dest = String(arg.server ?? '').trim()
if (!dest) { log.error('Pass the box: fli basecamp:install <ssh alias or user@host>'); process.exitCode = 1; return }

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

const asking = !!process.stdin.isTTY
const question = (q, hint) => `${chalk.cyan('?')} ${chalk.bold(q)}${hint ? chalk.dim(`  ${hint}`) : ''}`
const ask = async (q, hint) => (await tty.line(`${question(q, hint)}\n  ${chalk.cyan('›')}`)).trim()
const row = (label, value) => echo(`  ${chalk.dim(label.padEnd(9))} ${value}`)

if (asking) echo(`\n  ${chalk.bold('fli basecamp:install')}  ${chalk.dim(`Basecamp on ${dest}`)}\n`)

// tty.line, not prompt.js: a readline closed on this stdin leaves the secret
// after it echoing, with an Enter that never arrives.
let admin = flag.admin
let password = ''
if (asking && !admin) admin = await askAdmin(ask)
if (admin && !EMAIL.test(admin)) {
  log.error(`"${admin}" is not an email address`)
  process.exitCode = 1
  return
}
if (admin && asking) password = await tty.secret(`${question(`Password for ${admin}`, 'Enter generates one')}\n  ${chalk.cyan('›')}`)

const yes = async (q) => await tty.keys(question(q), { y: 'yes', n: 'no' }) === 'y'
const outpost = flag.outpost && (!asking || await yes(OUTPOST_QUESTION))

const refused = await zoneRefusal({ domain, log, echo, chalk })
if (refused) {
  log.error(`${refused}. Nothing was installed`)
  process.exitCode = 1
  return
}

if (asking) {
  echo('')
  row('box', chalk.bold(dest))
  row('hostname', domain)
  row('admin', admin ? `${admin} ${chalk.dim(password ? '' : '— password generated')}` : chalk.dim('none — make one at /setup'))
  row('outpost', outpost ? `yes ${chalk.dim('— fli deploy:outpost once the admin is made')}` : chalk.dim('no'))
  echo('')
}

log.info(`Installing Basecamp on ${dest} as ${domain}`)
const failed = await ringZero(dest, domain, (step, n, of) => echo(`\n  ${chalk.cyan(`${n}/${of}`)} ${chalk.bold(`fli ${step.argv[0]}`)}  ${chalk.dim(step.what)}\n`))
if (failed) {
  log.error(`fli ${failed.argv.join(' ')} exited ${failed.status}. Fix what it said and run this again`)
  process.exitCode = failed.status || 1
  return
}
log.success(`Basecamp is on ${dest}`)

const record = await pointHost({ host: domain, ip: await boxAddress(dest), configured, log })
if (!record || !await offerProxy({ record, configured, log, yes: asking && yes })) process.exitCode = 1

const named = domain === configured ? '' : ` --domain ${domain}`
echo`
  A later deploy, from packages/basecamp:
    fli deploy --server ${dest}${named}
`

// An alias names the workspace after the box; a bare address has no name to give.
const host = dest.split('@').pop()
const workspace = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? 'basecamp' : host
if (admin && !await makeAdmin({ dest, workspace, admin, password, log, echo })) process.exitCode = 1
if (outpost && !await joinFleet(dest)) process.exitCode = 1
```
